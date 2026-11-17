# -*- coding: utf-8 -*-
"""Источник Нерва «GitHub»: открытые PR репозитория, головы, вердикты линз, кворум, «влит» и «закрыт».

Вынесен из sources.py: с постраничным списком тот перерос 500 строк. Команды gh идут через sources.run — одна
точка подмены в тестах.
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import quorum
import sources
import wt_sweep
from journal import DIGEST, NERVOUS

GH_LIMIT = 1000        # не больше 1000 открытых PR за проход
# headRefName, baseRefName, isCrossRepository — уборка worktree после мёржа (OPS-52): ветка и база PR из этого репозитория.
GH_FIELDS = "number,headRefOid,updatedAt,createdAt,title,headRefName,baseRefName,isCrossRepository"
GH_NEW_PER_PASS = 20   # новых для Нерва PR за проход: догон не задерживает очередь владельца на минуты
NO_CHECKS_AFTER = 1800  # с после головы без единой проверки — событие координатору (SE-126)
NO_CHECKS_EVERY = 900   # с: дальше такой PR перечитывается раз в 15 мин, а не каждый проход
FAILED_CI_EVERY = 300   # с: CI упал при собранных линзах — проверки раз в 5 мин: повтор job зеленеет на той же голове
STALE_PASSES = 5        # проходов подряд с чужой головой в gh pr view — одно событие координатору (SE-134)
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
# SE-153: state.github.closed {номер: время} — снятые с учёта PR для digest.fresh. Сутки: дайджест копит события
# всю ночь (выдаёт только в дневной фазе), за 2 ч ночной pr.changes закрытого PR ушёл бы утром.
GONE_KEEP = timedelta(hours=24)


def _gh_list(repo):
    """Все открытые PR одним `gh pr list --json` (GraphQL, только нужные поля) — в форме REST, которую ждёт проход.
    SE-119: REST-список отдавал все поля PR — 3,45 МБ JSON (~400 КБ gzip) на 165 открытых PR tAIBE, и почти каждый
    проход целиком: etag первой страницы меняет каждый push (pushed_at репозитория). Тот же список так — 46 КБ (15 КБ
    gzip). Условного запроса у GraphQL нет: список читается каждый проход. До SE-114 читалась одна страница из 50 —
    старые PR выпадали из списка и считались закрытыми."""
    code, out, err = sources.run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", str(GH_LIMIT),
                                  "--json", GH_FIELDS])
    if code != 0:
        raise RuntimeError(f"gh pr list {repo}: {err.strip()[:200]}")
    # PR из форка — не наша ветка, даже при том же имени: ветки для уборки worktree нет.
    return [{"number": d["number"], "title": d.get("title") or "", "updated_at": d["updatedAt"],
             "created_at": d.get("createdAt") or "", "head": {"sha": d["headRefOid"]},
             "branch": "" if d.get("isCrossRepository") else (d.get("headRefName") or ""),
             "base": d.get("baseRefName") or ""} for d in json.loads(out)]


def _gh_comments(repo, n):
    code, out, err = sources.run(["gh", "api", f"repos/{repo}/issues/{n}/comments?per_page=100"])
    if code != 0:
        raise RuntimeError(f"gh comments #{n}: {err.strip()[:200]}")
    return json.loads(out)


class StaleHead(Exception):
    """gh pr view отдал не ту голову, что список прохода: push между запросами. Проверки новой головы не пишутся к
    старой — PR разберёт следующий проход по новому списку (SE-131 N1)."""

    def __init__(self, n, got, listed):
        super().__init__(f"#{n}: в gh голова {str(got)[:9]}, в списке {listed[:9]}")
        self.got, self.listed = str(got), listed


def _gh_pr(repo, n, fields, head=None):
    # --repo обязателен: без него gh берёт репозиторий из рабочей папки демона (tAIBE), а не из конфига (SE-40).
    code, out, err = sources.run(["gh", "pr", "view", str(n), "--repo", repo, "--json",
                                  fields + (",headRefOid" if head else "")])
    if code != 0:
        raise RuntimeError(f"gh pr view {repo}#{n}: {err.strip()[:200]}")
    d = json.loads(out)
    if head and d.get("headRefOid") != head:
        raise StaleHead(n, d.get("headRefOid"), head)
    checks = [c.get("conclusion") or c.get("status") or c.get("state") for c in d.get("statusCheckRollup") or []]
    return d, [f["path"] for f in d.get("files") or []], checks


def _gh_view(repo, n):
    d, files, checks = _gh_pr(repo, n, "files,statusCheckRollup,state,mergedAt,closedAt")
    return files, checks, d.get("state"), d.get("mergedAt"), d.get("closedAt")


def _gh_checks(repo, n, head):
    """Только статусы проверок головы — перечитать CI без списка файлов и тела PR (SE-123)."""
    return _gh_pr(repo, n, "statusCheckRollup", head)[2]


def _gh_author_view(repo, n, head):
    """Файлы, проверки и тело PR — для автора (SE-121) и вердиктов тела (SE-50). Без файлов тело читается в _check_pr
    при изменении PR на той же голове, но не на перепроверке CI: PR без изменений тела не менял."""
    d, files, checks = _gh_pr(repo, n, "files,statusCheckRollup,body", head)
    return files, checks, d.get("body") or ""


# rev 2 (SE-40): состояние rev 1 могло застрять — PR без author/checks и влитые PR в prs. При первом проходе
# нового кода etag сбрасывается: полный список разбирает их заново.
# rev 3: все страницы списка. PR, созданные до перехода, впервые увиденные Нервом, — догон: без «открыт».
# Граница перехода — самое позднее updated известных PR (SE-120), см. _backfill_since.
GH_STATE_REV = 3


def _gh_closed(ctx, repo, known, open_now, fails, gone):
    """PR, которых нет в списке открытых: «влит» или «закрыт» — по самому PR. Открытый PR (список неполон — потолок
    GH_LIMIT или неполный ответ gh с кодом 0) остаётся в prs без события. Ключ — с временем мёржа или закрытия: ложное «закрыт» rev 2 не прячет
    настоящее, а закрытие после переоткрытия — новое событие. Снятый PR — в gone {номер: время} (SE-153)."""
    for n in [k for k in known if k not in open_now]:
        try:
            _, _, state, merged, closed = _gh_view(repo, int(n))
        except Exception as e:  # noqa: BLE001 — PR остаётся в prs, повтор на следующем проходе
            fails.append(f"#{n}: {e}")
            continue
        if state == "OPEN":
            continue
        word = "влит" if merged else "закрыт"
        ctx.emit(f"gh:closed:{n}:{merged or closed or state}", "pr.closed", DIGEST, ["coord"], f"#{n} {word}",
                 "github")
        if merged and known[n].get("branch"):
            _gc_worktree(ctx, n, known[n]["branch"], known[n].get("head", ""), known[n].get("base", ""))
        del known[n]
        gone[n] = ctx.now.strftime("%Y-%m-%dT%H:%M:%SZ")


def _prune_gone(gone, now):
    """SE-153: память о снятых PR — не дольше GONE_KEEP; запись с битым временем уходит."""
    for n in list(gone):
        at = sources._ts(gone[n]) if isinstance(gone[n], str) else None
        if at is None or now - at > GONE_KEEP:
            del gone[n]


WT_GC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "wt_gc.py")


def _gc_worktree(ctx, n, branch, head="", base=""):
    """OPS-52 (решение владельца 13.11 «после мёржа»): worktree влитой ветки удаляется, если копия чистая, всё на
    remote и в ней никто не работает (eval/tools/wt_gc.py). Удалён — запись в журнал без доставки; оставлен —
    координатору с причиной. Сбой уборки не мешает проходу GitHub: PR уже снят, повтор — `wt_gc.py sweep`."""
    try:
        cmd = [sys.executable, "-I", WT_GC, "branch", ctx.cfg["repo_root"], branch, "--json"]
        # Голова и база PR: worktree удаляется, только если его HEAD — голова влитого PR, а база — основная ветка.
        cmd += (["--head", head] if head else []) + (["--base", base] if base else [])
        code, out, err = sources.run(cmd, timeout=300)
        res = json.loads(out) if code == 0 and out else None
    except Exception as e:  # noqa: BLE001 — таймаут или сбой разбора: только запись
        code, res, err = 1, None, str(e)
    if res is None:
        # Сбой — координатору: повтора нет (PR уже снят), worktree занимает место в пределе, пока его не уберёт sweep.
        ctx.emit(f"wt:gc:{n}", "wt.gc", DIGEST, ["coord"],
                 f"#{n}: уборка worktree {branch} не удалась: {(err or '')[:120]} — wt_gc.py sweep", "github")
        return
    for r in res:
        if r["removed"]:
            ctx.emit(f"wt:gc:{n}:{r['path']}", "wt.gc", DIGEST, [], f"#{n}: worktree {r['path']} удалён", "github")
        else:
            ctx.emit(f"wt:gc:{n}:{r['path']}", "wt.gc", DIGEST, ["coord"],
                     f"#{n} влит, worktree {r['path']} оставлен — {r['reason']}", "github")


def _backfill_since(known):
    """Граница догона при смене ревизии — самое позднее updated известных PR, не позже текущего момента; без них —
    сейчас. Старый процесс видел список не раньше этого updated: PR, открытый в паузе перезапуска, создан позже и
    получает «открыт», а давний PR, впервые увиденный новым кодом, — нет. Раньше граница была стартом нового
    процесса, и PR из паузы шёл молча (SE-120)."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    seen = [u for u in (p.get("updated") or "" for p in known.values()) if ISO_RE.match(u)]
    return min(max(seen), now) if seen else now


def _iso_now(ctx):
    return ctx.now.strftime("%Y-%m-%dT%H:%M:%SZ")


def _no_checks(ctx, p):
    """SE-126: у головы нет ни одной проверки дольше NO_CHECKS_AFTER — у PR CI нет (фильтры `paths` workflow: у HR
    они у всех, 8 из 40 последних мёржей HR без проверок). До этого пустой список — CI ещё не стартовал (pending).
    Отсчёт — от первой встречи головы: новая голова сбрасывает его в _check_pr."""
    if p.get("checks"):
        return False
    since = sources._ts(p.setdefault("head_at", _iso_now(ctx))) or ctx.now
    return (ctx.now - since).total_seconds() >= NO_CHECKS_AFTER


def _quorum_checks(ctx, p):
    """Проверки для кворума: голова без проверок дольше NO_CHECKS_AFTER — маркер NONE (`quorum.ci_state` → none)."""
    return ["NONE"] if _no_checks(ctx, p) else (p.get("checks") or [])


def _stale(ctx, n, p, e):
    """SE-134: gh pr view STALE_PASSES проходов подряд отдаёт не ту голову, что список, — PR не разбирается, и без
    события этого не видит никто. Одно событие координатору на голову списка; удачный разбор обнуляет счёт."""
    head, count = p.get("stale") or ("", 0)
    count = count + 1 if head == e.listed else 1
    p["stale"] = [e.listed, count]
    if count >= STALE_PASSES:
        ctx.emit(f"gh:stale:{n}:{e.listed}", "pr.stale", DIGEST, ["coord"],
                 f"#{n}: {STALE_PASSES} проходов подряд gh pr view отдаёт голову {e.got[:9]}, а список — "
                 f"{e.listed[:9]}; PR не разбирается", "github")


def _recheck_ci(ctx, n, p):
    """PR ждёт только CI: сначала статус проверок, комментарии — когда CI доехал. Пока CI идёт, комментарии не
    читаются: у большого PR это десятки КБ за проход (#292 — 54 КБ). Новый вердикт меняет updated PR — его разбирает
    основной путь прохода."""
    slow = _no_checks(ctx, p)
    # Упавший CI ждёт повтора job (Контроль, gh run rerun): голова та же, PR не меняется. Без чтения кворум после
    # зелёного повтора не пришёл бы до новой головы; каждый проход — до 5 760 gh pr view в сутки на PR (SE-86)
    failed = not slow and quorum.ci_state(p.get("checks") or []) == "failure"
    if slow or failed:
        # CI у PR нет: перечитывать раз в NO_CHECKS_EVERY, а не каждый проход (до 1 440 gh pr view в сутки на PR) —
        # только чтобы заметить проверки, если их всё же запустят
        last = sources._ts(p.get("ci_at"))
        if last and (ctx.now - last).total_seconds() < (NO_CHECKS_EVERY if slow else FAILED_CI_EVERY):
            return
    checks = _gh_checks(ctx.cfg["github"]["repo"], n, p["head"])
    p.pop("stale", None)
    if slow or failed:
        p["ci_at"] = _iso_now(ctx)   # после удачного чтения: сбой gh повторяется следующим проходом, а не через 15 мин
    p["checks"] = checks
    ci = quorum.ci_state(_quorum_checks(ctx, p))
    if ci == "pending" or (ci == "failure" and failed) or (ci == "none" and p.get("none_head") == p["head"]):
        # провал и до чтения: pr.ci_failed на этой голове уже ушёл (gh:cifail) — комментарии не читаются.
        # «CI: none» уже разобран на этой голове: комментарии не перечитываются раз в 15 мин (HR #774 — 23 КБ)
        return
    _check_pr(ctx, n, p, p["head"], viewed=True)
    if ci == "none":
        p["none_head"] = p["head"]   # после разбора: упавшее чтение комментариев не теряет кворум «CI: none»


def poll_github(ctx):
    g = ctx.cfg["github"]
    st = ctx.state.setdefault("github", {"prs": {}})
    if st.get("rev") != GH_STATE_REV:
        st["rev"] = GH_STATE_REV
        st["backfill"] = _backfill_since(st["prs"])
    st.pop("etag", None)   # etag REST-страницы (rev 1–3); у gh pr list его нет — SE-119
    prs = _gh_list(g["repo"])
    known = st["prs"]
    fails = []
    open_now, fresh, reread, stale = set(), 0, 0, False
    for pr in prs:
        n = pr["number"]
        open_now.add(str(n))
        if str(n) not in known:
            if fresh >= GH_NEW_PER_PASS:
                continue   # следующий проход: список читается целиком каждый раз
            fresh += 1
        p = known.setdefault(str(n), {"head": "", "updated": "", "seen": [], "changes_by": []})
        if pr.get("branch"):
            p["branch"], p["base"] = pr["branch"], pr.get("base", "")   # до проверки «не менялся»: и у давних PR
        # «author» — признак разобранного PR: в rev 1 head и updated писались до сбоя _gh_view (SE-40).
        if p["updated"] == pr["updated_at"] and p["head"] == pr["head"]["sha"] and "author" in p:
            if "body_verdicts" not in p and reread < GH_NEW_PER_PASS:
                reread += 1   # разобран до SE-50: тело читается один раз, не больше 20 PR за проход
            else:
                if p.get("await_ci"):
                    # CI доезжает, не меняя PR: кворум, ждущий только CI, перепроверяется каждый проход. Раньше — только
                    # на ответе 304, а его почти не было (etag менял каждый push). Сбой — повтор: await_ci не снят.
                    try:
                        _recheck_ci(ctx, n, p)
                    except StaleHead as e:
                        stale = True
                        _stale(ctx, n, p, e)   # новую голову разберёт следующий проход
                    except Exception as e:  # noqa: BLE001 — один PR не обрывает проход
                        fails.append(f"#{n}: {e}")
                continue
        if not p["head"] and pr.get("created_at", "") >= st.get("backfill", ""):
            ctx.emit(f"gh:new:{n}", "pr.new", DIGEST, ["coord"], f"#{n} открыт: {pr['title'][:80]}", "github")
        elif p["head"] != pr["head"]["sha"] and p.get("changes_by"):
            team = ctx.cfg["team"]["roles"]
            roles = sorted({r for r in (quorum.role_of_lens(l, g["lens_roles"], team) for l in p["changes_by"]) if r})
            ctx.emit(f"gh:newhead:{n}:{pr['head']['sha']}", "pr.newhead", DIGEST, roles or ["coord"],
                     f"#{n}: новая голова {pr['head']['sha'][:9]} после changes ({', '.join(p['changes_by'])})",
                     "github")
        try:
            _check_pr(ctx, n, p, pr["head"]["sha"])
        except StaleHead as e:
            stale = True
            _stale(ctx, n, p, e)
            continue   # updated не пишется: следующий проход разберёт PR по новой голове
        except Exception as e:  # noqa: BLE001 — один PR не обрывает проход
            fails.append(f"#{n}: {e}")
            continue
        p.pop("stale", None)
        p["updated"] = pr["updated_at"]  # только после разбора: упавший PR не считается увиденным
    gone = st.setdefault("closed", {})
    for n in open_now:
        gone.pop(n, None)   # переоткрыт: его pr.changes снова сверяются по prs (или выдаются, если PR ещё не разобран)
    _gh_closed(ctx, g["repo"], known, open_now, fails, gone)
    _prune_gone(gone, ctx.now)
    # Догон окончен, только если список полон: открытый известный PR вне списка (пустой или частичный ответ gh с
    # кодом 0) оставил бы следующие проходы без границы — каждый давний PR пошёл бы «открыт» (SE-123). Пустой список
    # догон не кончает и при пустом known: без открытых PR граница никому не мешает (Контроль #393). И только на
    # проходе без новых для Нерва PR (отложенные потолком — тоже новые): частичный список на свежем состоянии
    # содержит все известные, а давний PR из недочитанной части пошёл бы «открыт» — список подтверждает второе
    # чтение (SE-131). И не на проходе со StaleHead: такой PR не разобран, и после конца догона пошёл бы «открыт»
    # (Claude #397, п. 2).
    if not fails and not fresh and not stale and open_now and open_now >= set(known):
        st.pop("backfill", None)   # дальше каждый новый PR — «открыт»
    wt_sweep.poll(ctx, {pr["branch"] for pr in prs if pr.get("branch")})   # раз в час, OPS-81; сбой — внутри
    _raise_fails(fails)


def _raise_fails(fails):
    if fails:
        raise RuntimeError(f"PR с ошибкой: {len(fails)}; " + "; ".join(fails))


def _check_pr(ctx, n, p, head, viewed=False):
    """Разбор PR: комментарии, вердикты, кворум. viewed — проверки только что прочитаны (_recheck_ci)."""
    g = ctx.cfg["github"]
    head_changed = p["head"] != head
    comments = _gh_comments(g["repo"], n)
    roles, body = ctx.cfg["team"]["roles"], None
    # Пустой список перечитывается: CI регистрируется позже push, и старый [] через 30 мин дал бы ложный «CI: none»
    # «author_line» нет у PR, разобранных до SE-121: одно чтение тела, когда PR изменится
    if head_changed or "author_line" not in p or not (p.get("checks") or viewed):
        files, checks, body = _gh_author_view(g["repo"], n, head)
        p["author"] = quorum.pr_author(body, files, g["path_roles"], roles)   # адресат changes
        p["checks"] = checks
    elif not viewed:
        # PR изменился на той же голове: тело — вердикты в нём (SE-50) и строка автора. Комментарии меняют PR каждый
        # проход, и _recheck_ci его не видит: CI pending или failure перечитывается тем же запросом (SE-123, SE-86).
        ci = quorum.ci_state(p["checks"]) in ("pending", "failure")
        d, _, checks = _gh_pr(g["repo"], n, "statusCheckRollup,body" if ci else "body", head)
        body, p["checks"] = d.get("body") or "", checks if ci else p["checks"]
    if body is not None:
        p["author_line"] = quorum.body_author(body, roles)   # автор для кворума — только строка
        p["author"] = p["author_line"] or p["author"]   # строка, дописанная без push, — и адресат changes
        p["body_verdicts"] = quorum.body_verdicts(body, g["lens_roles"], roles)
    if head_changed:
        p["head_at"] = _iso_now(ctx)   # отсчёт «нет проверок» (SE-126) — только от новой головы
        p.pop("ci_at", None)   # интервал перечитывания упавшего CI — от старой головы: новая читается сразу
    p["head"] = head  # после запросов: при сбое голова не считается увиденной
    said = []
    for c in comments:
        v = quorum.parse_verdict(c.get("body"), g["lens_roles"], roles)
        if not v:
            continue
        said.append(v)
        if v["verdict"] == "changes" and quorum.on_head(v["sha"], head):
            to = quorum.author_roles(p["author"], roles)   # с вторыми сессиями роли (#324)
            ctx.emit(f"gh:verdict:{c['id']}", "pr.changes", DIGEST, to,
                     f"#{n}: changes от «{v['lens']}» на {v['sha'][:9]}", "github", pr=n, sha=v["sha"], lens=v["lens"])
    # Строки тела (SE-50) — без pr.changes: тело пишет автор PR. Комментарий линзы на голову главнее её строки тела.
    verdicts = quorum.with_body(p.get("body_verdicts") or [], said, head)
    author = p["author_line"]
    ok, approved, changes, ci = quorum.quorum(verdicts, head, _quorum_checks(ctx, p), g["min_lenses"], author)
    own = quorum.author_approved(quorum.last_on_head(verdicts, head), author)
    p["changes_by"] = changes
    # CI нет (none) — ожидание не снимается: если проверки всё же запустят, кворум по ним — обычным правилом (SE-126).
    # failure — тоже: ждём повтора job, проверки раз в FAILED_CI_EVERY (SE-86)
    p["await_ci"] = len(approved) >= g["min_lenses"] and not changes and ci in ("pending", "none", "failure")
    note = f"; approve автора {author} не засчитан" if own else ""
    if own and not changes and len(approved) + 1 == g["min_lenses"]:
        # кворум ждёт только из-за approve автора: Контроль видит причину один раз на голову (SE-121)
        ctx.emit(f"gh:own:{n}:{head}", "pr.own", DIGEST, g["quorum_to"],
                 f"#{n}: approve автора {author} на {head[:9]} не засчитан — линз {len(approved)}/{g['min_lenses']}",
                 "github")
    if ok and ci == "none":
        ctx.emit(f"gh:quorum:{n}:{head}:none", "pr.quorum", NERVOUS, g["quorum_to"],
                 f"#{n} собран: approve {', '.join(approved)} на {head[:9]}, CI: none (проверок нет "
                 f"{NO_CHECKS_AFTER // 60} мин){note}", "github")
        ctx.emit(f"gh:nochecks:{n}:{head}", "pr.nochecks", DIGEST, ["coord"],
                 f"#{n}: кворум без CI — у головы {head[:9]} нет ни одной проверки {NO_CHECKS_AFTER // 60} мин "
                 f"(PR вне фильтров paths?); Контроль решает по «CI: none»", "github")
    elif ok:
        ctx.emit(f"gh:quorum:{n}:{head}", "pr.quorum", NERVOUS, g["quorum_to"],
                 f"#{n} собран: approve {', '.join(approved)} на {head[:9]}, CI {ci}{note}", "github")
    elif ci == "failure" and len(approved) >= g["min_lenses"] and not changes:
        # линзы собраны, а CI упал: кворума нет, автору — один раз на голову, сразу (SE-86)
        ctx.emit(f"gh:cifail:{n}:{head}", "pr.ci_failed", NERVOUS,
                 quorum.author_roles(p["author"], ctx.cfg["team"]["roles"]),
                 f"#{n}: линзы собраны ({', '.join(approved)}), CI упал на {head[:9]} — кворума нет{note}", "github")
