#!/usr/bin/env python3
"""release_status.py — таблица выпуска (R4-PLAN Ф1.6): PR · голова · база · влит ли · линзы на этой голове ·
m-пункты очереди по уже влитым PR. Только stdlib; вердикты линз разбирает eval/nerve/quorum.py (тот же формат,
что у кворума Нерва).

    python3 -I eval/tools/release_status.py --repo owner/repo [--limit 30] [--oq items.json] [--min-lenses 3]
    python3 -I eval/tools/release_status.py --pulls pulls.json --comments comments.json [--oq items.json]  # офлайн

Источники: `gh api repos/<repo>/pulls?state=all` и `.../issues/<n>/comments` (или файлы с тем же JSON — для
разбора прошлого дня и тестов); `--oq` — выгрузка очереди владельца (список документов `{id, data:{kind, title,
body, status|done}}`, как отдаёт `oq_list items`). m-пункт относится к PR, если в id, заголовке или тексте есть
`#<номер>` или `m-<номер>`.
Выход: таблица и сводка «что сделать» — головы без нужного числа линз, открытые m-пункты по влитым PR. Код 0.
"""
import argparse
import json
import os
import re
import subprocess
import sys

NERVE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "nerve")
sys.path.insert(0, NERVE)
import quorum  # noqa: E402


def team_config(path=os.path.join(NERVE, "config.json")):
    """(github.lens_roles, team.roles) инстанса — кто считается линзой, как у кворума Нерва (TB-84, #89)."""
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return [], ()
    return (cfg.get("github") or {}).get("lens_roles") or [], tuple((cfg.get("team") or {}).get("roles") or ())


def gh_json(args):
    p = subprocess.run(["gh", "api", *args], capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise RuntimeError(f"gh api {' '.join(args)}: {p.stderr.strip()[:200]}")
    return json.loads(p.stdout or "null")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def lenses_on_head(comments, head, lens_roles=None, team_roles=None):
    if lens_roles is None:
        lens_roles, team_roles = team_config()
    verdicts = [quorum.parse_verdict(c.get("body"), lens_roles, team_roles or ()) for c in comments]
    last = {}
    for v in verdicts:
        if v and quorum.on_head(v["sha"], head):
            last[v["lens"]] = v["verdict"]
    return last


def pr_refs(text):
    return {int(n) for n in re.findall(r"(?:#|\bm-)(\d+)\b", text or "")}


def is_open_item(doc):
    d = doc.get("data", doc)
    return not (d.get("done") or str(d.get("status", "")).lower() in ("done", "closed", "merged"))


def merge_items(oq_docs):
    out = []
    for doc in oq_docs or []:
        d = doc.get("data", doc)
        kind = d.get("kind") or ""
        if kind != "merge" and not str(doc.get("id", "")).startswith("m-"):
            continue
        refs = pr_refs(" ".join([str(doc.get("id", "")), d.get("title") or "", d.get("body") or ""]))
        out.append({"id": doc.get("id"), "open": is_open_item(doc), "prs": refs})
    return out


def build_rows(pulls, comments_by_pr, oq_docs, min_lenses):
    items = merge_items(oq_docs)
    rows, todo = [], []
    for pr in sorted(pulls, key=lambda p: -p["number"]):
        n = pr["number"]
        head = (pr.get("head") or {}).get("sha", "")
        base = (pr.get("base") or {}).get("ref", "")
        merged = bool(pr.get("merged_at"))
        lenses = lenses_on_head(comments_by_pr.get(n, []), head)
        approved = sorted(k for k, v in lenses.items() if v == "approve")
        changes = sorted(k for k, v in lenses.items() if v == "changes")
        open_m = [it["id"] for it in items if n in it["prs"] and it["open"]]
        state = "влит" if merged else pr.get("state", "?")
        rows.append((n, head[:9], base, state, len(approved), ",".join(changes) or "—", ",".join(open_m) or "—"))
        if merged and open_m:
            todo.append(f"закрыть {', '.join(open_m)}: PR #{n} уже влит")
        if not merged and pr.get("state") == "open" and (len(approved) < min_lenses or changes):
            need = f"changes от {', '.join(changes)}" if changes else f"линз {len(approved)}/{min_lenses}"
            todo.append(f"PR #{n} голова {head[:9]}: {need}")
    return rows, todo


def render(rows, todo):
    head = ("PR", "голова", "база", "состояние", "approve", "changes", "m-пункты")
    widths = [max(len(str(r[i])) for r in [head, *rows]) for i in range(len(head))]
    lines = ["  ".join(str(c).ljust(w) for c, w in zip(r, widths)) for r in [head, *rows]]
    lines.append("")
    lines.extend(["что сделать:"] + [f"- {t}" for t in todo] if todo else ["что сделать: ничего"])
    return "\n".join(lines)


def main(argv):
    ap = argparse.ArgumentParser(prog="release_status")
    ap.add_argument("--repo")
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--pulls", help="JSON списка PR (как /pulls?state=all)")
    ap.add_argument("--comments", help="JSON {номер: [комментарии]}")
    ap.add_argument("--oq", help="JSON пунктов очереди владельца")
    ap.add_argument("--min-lenses", type=int, default=3)
    a = ap.parse_args(argv)
    if a.pulls:
        pulls = load(a.pulls)
        comments = {int(k): v for k, v in (load(a.comments) if a.comments else {}).items()}
    elif a.repo:
        pulls = gh_json([f"repos/{a.repo}/pulls?state=all&per_page={min(a.limit, 100)}"])[: a.limit]
        comments = {p["number"]: gh_json([f"repos/{a.repo}/issues/{p['number']}/comments?per_page=100"])
                    for p in pulls}
    else:
        ap.error("нужен --repo или --pulls")
    oq_docs = load(a.oq) if a.oq else []
    if isinstance(oq_docs, dict):
        oq_docs = oq_docs.get("docs", [])
    print(render(*build_rows(pulls, comments, oq_docs, a.min_lenses)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
