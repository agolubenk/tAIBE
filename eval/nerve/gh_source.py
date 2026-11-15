# -*- coding: utf-8 -*-
"""Источник Нерва «GitHub»: открытые PR репозитория, головы, вердикты линз, кворум, «влит» и «закрыт».

Вынесен из sources.py: с постраничным списком тот перерос 500 строк. Команды gh идут через sources.run — одна
точка подмены в тестах.
"""
import json
import re
from datetime import datetime, timezone

import quorum
import sources
from journal import DIGEST, NERVOUS

GH_LIMIT = 1000        # не больше 1000 открытых PR за проход
GH_FIELDS = "number,headRefOid,updatedAt,createdAt,title"
GH_NEW_PER_PASS = 20   # новых для Нерва PR за проход: догон не задерживает очередь владельца на минуты
NO_CHECKS_AFTER = 1800  # с после головы без единой проверки — событие координатору (SE-126)
NO_CHECKS_EVERY = 900   # с: дальше такой PR перечитывается раз в 15 мин, а не каждый проход
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


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
    return [{"number": d["number"], "title": d.get("title") or "", "updated_at": d["updatedAt"],
             "created_at": d.get("createdAt") or "", "head": {"sha": d["headRefOid"]}} for d in json.loads(out)]


def _gh_comments(repo, n):
    code, out, err = sources.run(["gh", "api", f"repos/{repo}/issues/{n}/comments?per_page=100"])
    if code != 0:
        raise RuntimeError(f"gh comments #{n}: {err.strip()[:200]}")
    return json.loads(out)


def _gh_view(repo, n):
    # --repo обязателен: без него gh берёт репозиторий из рабочей папки демона (tAIBE), а не из конфига (SE-40).
    code, out, err = sources.run(["gh", "pr", "view", str(n), "--repo", repo,
                          "--json", "files,statusCheckRollup,state,mergedAt,closedAt"])
    if code != 0:
        raise RuntimeError(f"gh pr view {repo}#{n}: {err.strip()[:200]}")
    d = json.loads(out)
    checks = [c.get("conclusion") or c.get("status") or c.get("state") for c in d.get("statusCheckRollup") or []]
    return [f["path"] for f in d.get("files") or []], checks, d.get("state"), d.get("mergedAt"), d.get("closedAt")


# rev 2 (SE-40): состояние rev 1 могло застрять — PR без author/checks и влитые PR в prs. При первом проходе
# нового кода etag сбрасывается: полный список разбирает их заново.
# rev 3: все страницы списка. PR, созданные до перехода, впервые увиденные Нервом, — догон: без «открыт».
# Граница перехода — самое позднее updated известных PR (SE-120), см. _backfill_since.
GH_STATE_REV = 3


def _gh_closed(ctx, repo, known, open_now, fails):
    """PR, которых нет в списке открытых: «влит» или «закрыт» — по самому PR. Открытый PR (список неполон — потолок
    страниц) остаётся в prs без события. Ключ — с временем мёржа или закрытия: ложное «закрыт» rev 2 не прячет
    настоящее, а закрытие после переоткрытия — новое событие."""
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
        del known[n]


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


def _recheck_ci(ctx, n, p):
    """PR ждёт только CI: сначала статус проверок, комментарии — когда CI доехал. Пока CI идёт, комментарии не
    читаются: у большого PR это десятки КБ за проход (#292 — 54 КБ). Новый вердикт меняет updated PR — его разбирает
    основной путь прохода."""
    if _no_checks(ctx, p):
        # CI у PR нет: перечитывать раз в NO_CHECKS_EVERY, а не каждый проход (до 1 440 gh pr view в сутки на PR) —
        # только чтобы заметить проверки, если их всё же запустят
        last = sources._ts(p.get("ci_at"))
        if last and (ctx.now - last).total_seconds() < NO_CHECKS_EVERY:
            return
        p["ci_at"] = _iso_now(ctx)
    _, checks, _, _, _ = _gh_view(ctx.cfg["github"]["repo"], n)
    p["checks"] = checks
    if quorum.ci_state(_quorum_checks(ctx, p)) != "pending":
        _check_pr(ctx, n, p, p["head"])


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
    open_now, fresh, deferred = set(), 0, 0
    for pr in prs:
        n = pr["number"]
        open_now.add(str(n))
        if str(n) not in known:
            if fresh >= GH_NEW_PER_PASS:
                deferred += 1   # следующий проход: список читается целиком каждый раз
                continue
            fresh += 1
        p = known.setdefault(str(n), {"head": "", "updated": "", "seen": [], "changes_by": []})
        # «author» — признак разобранного PR: в rev 1 head и updated писались до сбоя _gh_view (SE-40).
        if p["updated"] == pr["updated_at"] and p["head"] == pr["head"]["sha"] and "author" in p:
            if p.get("await_ci"):
                # CI доезжает, не меняя PR: кворум, ждущий только CI, перепроверяется каждый проход. Раньше — только
                # на ответе 304, а его почти не было (etag менял каждый push). Сбой — повтор: await_ci не снят.
                try:
                    _recheck_ci(ctx, n, p)
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
        except Exception as e:  # noqa: BLE001 — один PR не обрывает проход
            fails.append(f"#{n}: {e}")
            continue
        p["updated"] = pr["updated_at"]  # только после разбора: упавший PR не считается увиденным
    _gh_closed(ctx, g["repo"], known, open_now, fails)
    if not fails and not deferred:
        st.pop("backfill", None)   # догон окончен: дальше каждый новый PR — «открыт»
    _raise_fails(fails)


def _raise_fails(fails):
    if fails:
        raise RuntimeError(f"PR с ошибкой: {len(fails)}; " + "; ".join(fails))


def _check_pr(ctx, n, p, head):
    g = ctx.cfg["github"]
    head_changed = p["head"] != head
    comments = _gh_comments(g["repo"], n)
    if head_changed or "author" not in p:
        files, checks, _, _, _ = _gh_view(g["repo"], n)
        p["author"] = quorum.author_role(files, g["path_roles"])
        p["checks"] = checks
        p["head_at"] = _iso_now(ctx)   # отсчёт «нет проверок» (SE-126) — от новой головы
    p["head"] = head  # после запросов: при сбое голова не считается увиденной
    verdicts = []
    for c in comments:
        v = quorum.parse_verdict(c.get("body"), g["lens_roles"], ctx.cfg["team"]["roles"])
        if not v:
            continue
        verdicts.append(v)
        if v["verdict"] == "changes" and quorum.on_head(v["sha"], head):
            to = quorum.author_roles(p["author"], ctx.cfg["team"]["roles"])   # с вторыми сессиями роли (#324)
            ctx.emit(f"gh:verdict:{c['id']}", "pr.changes", DIGEST, to,
                     f"#{n}: changes от «{v['lens']}» на {v['sha'][:9]}", "github")
    ok, approved, changes, ci = quorum.quorum(verdicts, head, _quorum_checks(ctx, p), g["min_lenses"])
    p["changes_by"] = changes
    # CI нет (none) — ожидание не снимается: если проверки всё же запустят, кворум по ним — обычным правилом (SE-126)
    p["await_ci"] = len(approved) >= g["min_lenses"] and not changes and ci in ("pending", "none")
    if ok and ci == "none":
        ctx.emit(f"gh:quorum:{n}:{head}:none", "pr.quorum", NERVOUS, g["quorum_to"],
                 f"#{n} собран: approve {', '.join(approved)} на {head[:9]}, CI: none (проверок нет "
                 f"{NO_CHECKS_AFTER // 60} мин)", "github")
        ctx.emit(f"gh:nochecks:{n}:{head}", "pr.nochecks", DIGEST, ["coord"],
                 f"#{n}: кворум без CI — у головы {head[:9]} нет ни одной проверки {NO_CHECKS_AFTER // 60} мин "
                 f"(PR вне фильтров paths?); Контроль решает по «CI: none»", "github")
    elif ok:
        ctx.emit(f"gh:quorum:{n}:{head}", "pr.quorum", NERVOUS, g["quorum_to"],
                 f"#{n} собран: approve {', '.join(approved)} на {head[:9]}, CI {ci}", "github")
