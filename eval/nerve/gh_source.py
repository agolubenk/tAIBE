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

GH_PAGE = 100          # PR на страницу списка — потолок GitHub
GH_PAGES = 10          # не больше 1000 открытых PR за проход
GH_NEW_PER_PASS = 20   # новых для Нерва PR за проход: догон не задерживает очередь владельца на минуты


def _gh_page(repo, page, etag=""):
    """Страница открытых PR, свежие сверху. Возвращает (список | None при 304, etag, есть ли следующая)."""
    cmd = ["gh", "api", "-i",
           f"repos/{repo}/pulls?state=open&sort=updated&direction=desc&per_page={GH_PAGE}&page={page}"]
    if etag:
        cmd[2:2] = ["-H", f"If-None-Match: {etag}"]
    code, out, err = sources.run(cmd)
    head, _, body = out.partition("\r\n\r\n") if "\r\n\r\n" in out else out.partition("\n\n")
    if " 304 " in head.split("\n", 1)[0]:
        return None, etag, False
    if code != 0:
        raise RuntimeError(f"gh pulls p{page}: {(err or head).strip()[:200]}")
    m = re.search(r"(?im)^etag:\s*(.+?)\s*$", head)
    return json.loads(body), (m.group(1) if m else ""), re.search(r'(?im)^link:.*rel="next"', head) is not None


def _gh_list(repo, etag):
    """Все открытые PR. Возвращает (список | None при 304, etag первой страницы). Условный запрос — только первой
    страницы: при sort=updated любое изменение открытого PR поднимает его наверх, поэтому 304 на ней — список не
    менялся; закрытие PR с дальних страниц увидит следующий полный проход. Раньше читалась одна страница из 50:
    при 161 открытом PR в tAIBE старые выпадали из списка, считались закрытыми, и их головы и кворум Нерв не видел."""
    prs, tag, more = _gh_page(repo, 1, etag)
    if prs is None:
        return None, etag
    page = 1
    while more and page < GH_PAGES:
        page += 1
        rest, _, more = _gh_page(repo, page)
        prs += rest
    return prs, tag


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


def poll_github(ctx):
    g = ctx.cfg["github"]
    st = ctx.state.setdefault("github", {"etag": "", "prs": {}})
    if st.get("rev") != GH_STATE_REV:
        st["etag"], st["rev"] = "", GH_STATE_REV
        st["backfill"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    prs, etag = _gh_list(g["repo"], st.get("etag", ""))
    known = st["prs"]
    fails = []
    if prs is None:
        # 304: список не менялся, но CI мог доехать у PR, ждущего только CI. Сбой — повтор на следующем проходе
        # сам (await_ci не снят), etag не трогаем.
        for n, p in known.items():
            if p.get("await_ci"):
                try:
                    _check_pr(ctx, int(n), p, p["head"], refresh=True)
                except Exception as e:  # noqa: BLE001 — один PR не обрывает проход
                    fails.append(f"#{n}: {e}")
        _raise_fails(fails)
        return
    open_now, fresh, deferred = set(), 0, 0
    for pr in prs:
        n = pr["number"]
        open_now.add(str(n))
        if str(n) not in known:
            if fresh >= GH_NEW_PER_PASS:
                deferred += 1   # следующий проход: etag не ставится, список полный
                continue
            fresh += 1
        p = known.setdefault(str(n), {"head": "", "updated": "", "seen": [], "changes_by": []})
        # «author» — признак разобранного PR: в rev 1 head и updated писались до сбоя _gh_view (SE-40).
        if p["updated"] == pr["updated_at"] and p["head"] == pr["head"]["sha"] and "author" in p:
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
    # etag — только после чистого и полного прохода: иначе 304 спрячет недоразобранные PR до изменения списка.
    st["etag"] = "" if fails or deferred else etag
    if not fails and not deferred:
        st.pop("backfill", None)   # догон окончен: дальше каждый новый PR — «открыт»
    _raise_fails(fails)


def _raise_fails(fails):
    if fails:
        raise RuntimeError(f"PR с ошибкой: {len(fails)}; " + "; ".join(fails))


def _check_pr(ctx, n, p, head, refresh=False):
    g = ctx.cfg["github"]
    head_changed = p["head"] != head
    comments = _gh_comments(g["repo"], n)
    if head_changed or refresh or "author" not in p:
        files, checks, _, _, _ = _gh_view(g["repo"], n)
        p["author"] = quorum.author_role(files, g["path_roles"])
        p["checks"] = checks
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
    ok, approved, changes, ci = quorum.quorum(verdicts, head, p.get("checks") or [], g["min_lenses"])
    p["changes_by"] = changes
    p["await_ci"] = len(approved) >= g["min_lenses"] and not changes and ci == "pending"
    if ok:
        ctx.emit(f"gh:quorum:{n}:{head}", "pr.quorum", NERVOUS, g["quorum_to"],
                 f"#{n} собран: approve {', '.join(approved)} на {head[:9]}, CI {ci}", "github")
