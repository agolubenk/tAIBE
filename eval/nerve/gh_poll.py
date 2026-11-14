# -*- coding: utf-8 -*-
"""Источник Нерва «GitHub» (П7): открытые PR, вердикты линз, кворум. Вынесен из sources.py (SE-50: предел 500 строк).

gh вызывается через sources.run — тесты подменяют его там. Тексты PR и комментариев в журнал не попадают — только
номера, роли и SHA.
"""
import json
import re

import quorum
import sources
from journal import DIGEST, NERVOUS


def _gh_list(repo, etag):
    """Открытые PR с условным запросом. Возвращает (список | None при 304, новый etag)."""
    cmd = ["gh", "api", "-i", f"repos/{repo}/pulls?state=open&per_page=50"]
    if etag:
        cmd[2:2] = ["-H", f"If-None-Match: {etag}"]
    code, out, err = sources.run(cmd)
    head, _, body = out.partition("\r\n\r\n") if "\r\n\r\n" in out else out.partition("\n\n")
    if " 304 " in head.split("\n", 1)[0]:
        return None, etag
    if code != 0:
        raise RuntimeError(f"gh pulls: {(err or head).strip()[:200]}")
    m = re.search(r"(?im)^etag:\s*(.+?)\s*$", head)
    return json.loads(body), (m.group(1) if m else "")


def _gh_comments(repo, n):
    code, out, err = sources.run(["gh", "api", f"repos/{repo}/issues/{n}/comments?per_page=100"])
    if code != 0:
        raise RuntimeError(f"gh comments #{n}: {err.strip()[:200]}")
    return json.loads(out)


def _gh_view(repo, n):
    # --repo обязателен: без него gh берёт репозиторий из рабочей папки демона (tAIBE), а не из конфига (SE-40).
    code, out, err = sources.run(["gh", "pr", "view", str(n), "--repo", repo,
                          "--json", "files,statusCheckRollup,state,mergedAt"])
    if code != 0:
        raise RuntimeError(f"gh pr view {repo}#{n}: {err.strip()[:200]}")
    d = json.loads(out)
    checks = [c.get("conclusion") or c.get("status") or c.get("state") for c in d.get("statusCheckRollup") or []]
    return [f["path"] for f in d.get("files") or []], checks, d.get("state"), d.get("mergedAt")


_BODY_TIME_Q = ("query($o:String!,$r:String!,$n:Int!)"
                "{repository(owner:$o,name:$r){pullRequest(number:$n){lastEditedAt createdAt}}}")


def _gh_body_time(repo, n):
    """Время правки тела PR (SE-50): lastEditedAt, у неправленного — createdAt. updated_at списка не годится: его
    двигает каждый комментарий и пуш."""
    owner, name = repo.split("/", 1)
    code, out, err = sources.run(["gh", "api", "graphql", "-f", f"query={_BODY_TIME_Q}", "-f", f"o={owner}",
                                  "-f", f"r={name}", "-F", f"n={n}"])
    if code != 0:
        raise RuntimeError(f"gh body time {repo}#{n}: {err.strip()[:200]}")
    pr = json.loads(out)["data"]["repository"]["pullRequest"]
    return pr.get("lastEditedAt") or pr.get("createdAt") or ""


# rev 2 (SE-40): состояние rev 1 могло застрять — PR без author/checks и влитые PR в prs. rev 3 (SE-50): у PR нет
# вердиктов тела. При первом проходе нового кода etag сбрасывается: полный список разбирает их заново.
GH_STATE_REV = 3


def poll_github(ctx):
    g = ctx.cfg["github"]
    st = ctx.state.setdefault("github", {"etag": "", "prs": {}})
    if st.get("rev") != GH_STATE_REV:
        st["etag"], st["rev"] = "", GH_STATE_REV
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
    open_now = set()
    for pr in prs:
        n = pr["number"]
        open_now.add(str(n))
        p = known.setdefault(str(n), {"head": "", "updated": "", "seen": [], "changes_by": []})
        # «author» — признак разобранного PR: в rev 1 head и updated писались до сбоя _gh_view (SE-40).
        # «body_verdicts» — то же для тела PR (SE-50, rev 3).
        seen = "author" in p and "body_verdicts" in p
        if p["updated"] == pr["updated_at"] and p["head"] == pr["head"]["sha"] and seen:
            continue
        if not p["head"]:
            ctx.emit(f"gh:new:{n}", "pr.new", DIGEST, ["coord"], f"#{n} открыт: {pr['title'][:80]}", "github")
        elif p["head"] != pr["head"]["sha"] and p.get("changes_by"):
            team = ctx.cfg["team"]["roles"]
            roles = sorted({r for r in (quorum.role_of_lens(l, g["lens_roles"], team) for l in p["changes_by"]) if r})
            ctx.emit(f"gh:newhead:{n}:{pr['head']['sha']}", "pr.newhead", DIGEST, roles or ["coord"],
                     f"#{n}: новая голова {pr['head']['sha'][:9]} после changes ({', '.join(p['changes_by'])})",
                     "github")
        try:
            _check_pr(ctx, n, p, pr["head"]["sha"], body=pr.get("body") or "")
        except Exception as e:  # noqa: BLE001 — один PR не обрывает проход
            fails.append(f"#{n}: {e}")
            continue
        p["updated"] = pr["updated_at"]  # только после разбора: упавший PR не считается увиденным
    for n in [k for k in known if k not in open_now]:
        try:
            _, _, _, merged = _gh_view(g["repo"], int(n))
        except Exception as e:  # noqa: BLE001 — PR остаётся в prs, повтор на следующем проходе
            fails.append(f"#{n}: {e}")
            continue
        word = "влит" if merged else "закрыт"
        ctx.emit(f"gh:closed:{n}", "pr.closed", DIGEST, ["coord"], f"#{n} {word}", "github")
        del known[n]
    # etag — только после чистого прохода: иначе 304 спрячет недоразобранные PR до следующего изменения списка.
    st["etag"] = "" if fails else etag
    _raise_fails(fails)


def _raise_fails(fails):
    if fails:
        raise RuntimeError(f"PR с ошибкой: {len(fails)}; " + "; ".join(fails))


def _check_pr(ctx, n, p, head, refresh=False, body=None):
    g, roles = ctx.cfg["github"], ctx.cfg["team"]["roles"]
    head_changed = p["head"] != head
    comments = _gh_comments(g["repo"], n)
    if head_changed or refresh or "author" not in p:
        files, checks, _, _ = _gh_view(g["repo"], n)
        p["author"] = quorum.author_role(files, g["path_roles"])
        p["checks"] = checks
    p["head"] = head  # после запросов: при сбое голова не считается увиденной
    if body is not None:  # в 304-проходе тела нет — остаются вердикты тела из последнего полного списка (SE-50)
        p["body_verdicts"] = quorum.body_verdicts(body, g["lens_roles"], roles)
    said = []
    for c in comments:
        v = quorum.parse_verdict(c.get("body"), g["lens_roles"], roles)
        if not v:
            continue
        said.append(dict(v, at=c.get("created_at") or ""))
        if v["verdict"] == "changes" and quorum.on_head(v["sha"], head):
            ctx.emit(f"gh:verdict:{c['id']}", "pr.changes", DIGEST, [p["author"]],
                     f"#{n}: changes от «{v['lens']}» на {v['sha'][:9]}", "github")
    # Строки тела пишет автор PR, поэтому pr.changes о них не шлётся; в changes_by и в кворум они входят.
    verdicts = quorum.with_body(p.get("body_verdicts") or [], said, head, lambda: _gh_body_time(g["repo"], n))
    ok, approved, changes, ci = quorum.quorum(verdicts, head, p.get("checks") or [], g["min_lenses"])
    p["changes_by"] = changes
    p["await_ci"] = len(approved) >= g["min_lenses"] and not changes and ci == "pending"
    if ok:
        ctx.emit(f"gh:quorum:{n}:{head}", "pr.quorum", NERVOUS, g["quorum_to"],
                 f"#{n} собран: approve {', '.join(approved)} на {head[:9]}, CI {ci}", "github")
