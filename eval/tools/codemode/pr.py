"""Рецепт `pr <n>` (AC-1): голова, сводка проверок (pass / fail / pending) и вердикт каждой линзы на текущей голове.
Заменяет `gh pr view` + `gh pr checks` + чтение комментариев + `quorum.py`. Один вызов `gh pr view --json`.

Вердикты читает `eval/nerve/quorum.py` так же, как кворум Нерва: первая строка комментария и строки тела PR; комментарий
линзы на голову главнее её строки тела; approve автора (строка тела «роль N — автор») не считается (SE-121)."""
import os
import sys

from . import SourceDown, gh
from .net import ROOT

NERVE = os.path.join(ROOT, "eval", "nerve")
if NERVE not in sys.path:
    sys.path.append(NERVE)   # в конец: модули Нерва не подменяют stdlib
import products  # noqa: E402
import quorum  # noqa: E402

FIELDS = "number,title,state,isDraft,headRefOid,baseRefName,mergeable,body,statusCheckRollup,comments,labels"
NAMES = 4   # имён проверок в строке, остальные — «+N»


def config(product=None):
    """(slug, repo, lens_roles, team_roles, min_lenses) продукта: --product, иначе $TAIBE_PRODUCT, иначе продукт по
    умолчанию (`instances/_shared.json`)."""
    shared, prods = products.load()
    slug = product or os.environ.get("TAIBE_PRODUCT") or shared["default_product"]
    cfg = products.config_for(slug, shared, prods)
    g = cfg.get("github") or {}
    return (slug, g.get("repo"), g.get("lens_roles") or [], tuple((cfg.get("team") or {}).get("roles") or ()),
            int(g.get("min_lenses", 3)))


def fetch(n, repo, run=gh.run):
    d = run(["pr", "view", str(n), "--repo", repo, "--json", FIELDS])
    if not isinstance(d, dict) or not d.get("headRefOid"):
        raise SourceDown("gh", "схема ответа: нет headRefOid")
    return d


def _bucket(state):
    if state in quorum.CI_FAILED:
        return "fail"
    return "pass" if state in quorum.CI_OK else "pending"


def summarize(d, lens_roles, team_roles, min_lenses):
    head, body = d.get("headRefOid") or "", d.get("body") or ""
    checks = {"pass": [], "fail": [], "pending": []}
    states = []
    for c in d.get("statusCheckRollup") or []:
        state = str(c.get("conclusion") or c.get("status") or c.get("state") or "").upper()   # как gh_source
        states.append(state)
        checks[_bucket(state)].append(c.get("name") or c.get("context") or "?")
    said = [v for c in d.get("comments") or [] if (v := quorum.parse_verdict(c.get("body"), lens_roles, team_roles))]
    verdicts = quorum.with_body(quorum.body_verdicts(body, lens_roles, team_roles), said, head)
    last = quorum.last_on_head(verdicts, head)
    older = {v["lens"]: {"verdict": v["verdict"], "sha": v["sha"][:9]} for v in verdicts
             if not quorum.on_head(v["sha"], head)}
    author = quorum.body_author(body, team_roles)
    ok, approved, changes, ci = quorum.quorum(verdicts, head, states, min_lenses, author)
    return {"pr": d.get("number"), "title": (d.get("title") or "")[:80], "state": d.get("state"),
            "draft": bool(d.get("isDraft")), "head": head, "base": d.get("baseRefName"),
            "mergeable": d.get("mergeable"), "labels": [x.get("name") for x in d.get("labels") or []],
            "author": author, "ci": ci, "checks": checks, "on_head": dict(sorted(last.items())),
            "older": {k: v for k, v in sorted(older.items()) if k not in last},
            "approved": approved, "changes": changes, "min_lenses": min_lenses, "quorum": ok,
            "author_approve_dropped": quorum.author_approved(last, author)}


def _names(names):
    shown = ", ".join(names[:NAMES])
    return shown + (f" +{len(names) - NAMES}" if len(names) > NAMES else "")


def render(s):
    top = [f"PR #{s['pr']} {s['state']}" + (" черновик" if s["draft"] else ""), f"голова {s['head']}",
           f"в {s['base']}", str(s["mergeable"])]
    if s["labels"]:
        top.append("метки: " + ", ".join(s["labels"]))
    c = s["checks"]
    ci = f"CI {s['ci']}: pass {len(c['pass'])} · fail {len(c['fail'])} · pending {len(c['pending'])}"
    ci += "".join(f" · {k}: {_names(c[k])}" for k in ("fail", "pending") if c[k])
    lines = [" · ".join(top), s["title"], f"автор: {s['author'] or 'нет строки «роль N — автор»'}", ci,
             "на голове: " + (" · ".join(f"{k} {v}" for k, v in s["on_head"].items()) or "вердиктов нет")]
    if s["older"]:
        old = (f"{k} {v['verdict']}@{v['sha']}" for k, v in s["older"].items())
        lines.append("на старых головах: " + " · ".join(old))
    why = [f"approve {len(s['approved'])}/{s['min_lenses']}"]
    if s["changes"]:
        why.append("changes: " + ", ".join(s["changes"]))
    if s["ci"] not in ("ok", "none"):
        why.append(f"CI {s['ci']}")
    if s["author_approve_dropped"]:
        why.append(f"approve автора {s['author']} не засчитан")
    lines.append(("кворум: есть — " if s["quorum"] else "кворум: нет — ") + ", ".join(why))
    return "\n".join(lines)


def recipe(n, product=None, repo=None, run=gh.run):
    _, cfg_repo, lens_roles, team_roles, min_lenses = config(product)
    return summarize(fetch(n, repo or cfg_repo, run), lens_roles, team_roles, min_lenses)
