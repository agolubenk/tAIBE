# -*- coding: utf-8 -*-
"""Уборка git worktree после мёржа (OPS-52, входящее владельца i-20261113-143043-ef29, решение «после мёржа» 13.11).

Работа по worktree влита в основную ветку — worktree удаляется; ветка остаётся (её удаляет мёрж на GitHub или Контроль).
Удаляется только безопасное — иначе worktree остаётся, а причина печатается:
- копия чистая (`git status --porcelain` пуст: ни правок, ни неотслеживаемых файлов);
- своих коммитов вне remote нет (HEAD есть в какой-нибудь ветке origin или в основной ветке);
- в worktree не работает процесс (cwd ни одного процесса не внутри);
- `git worktree remove` без `--force` — git сам откажет при грязной копии.
Игнорируемые файлы (node_modules, dist, .env-копии) удаляются вместе с копией: их источник — основной checkout или сборка.

Предел (решение владельца 13.11): не больше LIMIT worktree на продукт. `count` / `check-limit` — для `make wt-add` и хука.

    python3 -I eval/tools/wt_gc.py branch <repo_root> <branch> [--json]   # после мёржа PR этой ветки (Нерв)
    python3 -I eval/tools/wt_gc.py sweep <repo_root> [--dry-run] [--json] # все worktree с влитыми PR (gh)
    python3 -I eval/tools/wt_gc.py check-limit <repo_root>               # код 3 — предел достигнут
"""
import json
import os
import re
import subprocess
import sys

LIMIT = 10


def _run(cmd, cwd=None, timeout=120):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)


def worktrees(repo):
    """Связанные worktree репозитория (без основного checkout): [{path, branch, head, prunable}]."""
    code, out, _ = _run(["git", "worktree", "list", "--porcelain"], cwd=repo)
    if code:
        return []
    main = os.path.realpath(repo)
    res, cur = [], {}
    for line in out.splitlines() + [""]:
        if not line:
            if cur.get("worktree") and os.path.realpath(cur["worktree"]) != main:
                res.append({"path": cur["worktree"], "branch": cur.get("branch", "").replace("refs/heads/", ""),
                            "head": cur.get("HEAD", ""), "prunable": "prunable" in cur})
            cur = {}
            continue
        k, _, v = line.partition(" ")
        cur[k] = v or True
    return res


def busy_paths():
    """cwd всех процессов пользователя (lsof): worktree, где кто-то работает, не трогаем."""
    code, out, _ = _run(["lsof", "-a", "-d", "cwd", "-Fn"], timeout=60)
    return {l[1:] for l in out.splitlines() if l.startswith("n")} if not code or out else set()


def _inside(path, cwds):
    # git и lsof печатают настоящие пути (/private/var/…), а путь могли дать через ссылку (/var/…): сравниваем realpath.
    path = os.path.realpath(path)
    real = {os.path.realpath(c) for c in cwds}
    return any(c == path or c.startswith(path.rstrip("/") + "/") for c in real)


# Где живут внешние потребители worktree: ссылки (агенты opencode, бинарники) и задачи launchd. 13.11 уборка удалила
# worktree, из которого ставили агентов opencode, и ссылки в ~/.config/opencode/agents повисли — ревью встало.
CONSUMER_LINK_DIRS = ("~/.config", "~/.local/bin")
CONSUMER_FILE_GLOBS = ("~/Library/LaunchAgents/*.plist",)


def external_refs():
    """{цель: где ссылка} — ссылки и задачи launchd, которые смотрят в какой-нибудь worktree. Один проход на запуск."""
    import glob
    refs = {}
    for d in CONSUMER_LINK_DIRS:
        root = os.path.expanduser(d)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [x for x in dirnames if x not in ("node_modules", ".git")]
            for name in dirnames + filenames:
                f = os.path.join(dirpath, name)
                if os.path.islink(f):
                    target = os.path.realpath(f)
                    if "/worktrees/" in target:
                        refs[target] = f
    for pattern in CONSUMER_FILE_GLOBS:
        for f in glob.glob(os.path.expanduser(pattern)):
            try:
                text = open(f, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            for target in re.findall(r"""/[^\s<>"',;]*/worktrees/[^\s<>"',;]+""", text):
                refs[target] = f
    return refs


def _referenced(path, refs):
    path = os.path.realpath(path).rstrip("/") + "/"
    return next((src for target, src in refs.items() if (target.rstrip("/") + "/").startswith(path)), None)


def why_not(wt, cwds, refs=None):
    """Причина не удалять worktree или None — можно. Порядок — от дешёвых проверок к дорогим."""
    p = wt["path"]
    if not os.path.isdir(p):
        return "папки нет (git worktree prune)"
    if _inside(p, cwds):
        return "в нём работает процесс"
    src = _referenced(p, external_refs() if refs is None else refs)
    if src:
        return f"на него ссылается {src.replace(os.path.expanduser('~'), '~')}"
    code, out, err = _run(["git", "status", "--porcelain"], cwd=p)
    if code:
        return f"git status: {err[:120]}"
    if out:
        n = len(out.splitlines())
        return f"незакоммиченные изменения: {n}"
    code, out, _ = _run(["git", "branch", "-r", "--contains", "HEAD"], cwd=p)
    if code or not out:
        return "есть коммиты, которых нет на remote"
    return None


def remove(repo, wt, cwds, refs=None):
    reason = why_not(wt, cwds, refs)
    if reason:
        return {"path": wt["path"], "branch": wt["branch"], "removed": False, "reason": reason}
    code, _, err = _run(["git", "worktree", "remove", wt["path"]], cwd=repo, timeout=900)
    if code:
        return {"path": wt["path"], "branch": wt["branch"], "removed": False, "reason": f"git отказал: {err[:160]}"}
    return {"path": wt["path"], "branch": wt["branch"], "removed": True}


def gc_branch(repo, branch, cwds=None, refs=None):
    """После мёржа PR ветки branch: удалить её worktree, если это безопасно. [] — у ветки нет worktree."""
    mine = [wt for wt in worktrees(repo) if wt["branch"] == branch]
    if not mine:
        return []
    cwds = busy_paths() if cwds is None else cwds
    refs = external_refs() if refs is None else refs
    return [remove(repo, wt, cwds, refs) for wt in mine]


def merged_branches(repo, limit=300):
    """Ветки влитых PR репозитория (gh, репозиторий — по origin рабочей папки)."""
    code, out, _ = _run(["gh", "pr", "list", "--state", "merged", "--limit", str(limit), "--json", "headRefName"],
                        cwd=repo, timeout=120)
    if code:
        raise RuntimeError("gh pr list не ответил")
    return {p["headRefName"] for p in json.loads(out or "[]")}


def sweep(repo, dry_run=False):
    """Все worktree, чья ветка влита PR: удалить безопасные. Для пропущенных Нервом мёржей (демон стоял)."""
    merged = merged_branches(repo)
    cwds, refs = busy_paths(), external_refs()
    res = []
    for wt in worktrees(repo):
        if not wt["branch"] or wt["branch"] not in merged:
            continue
        if dry_run:
            reason = why_not(wt, cwds, refs)
            res.append({"path": wt["path"], "branch": wt["branch"], "removed": False, "reason": reason or "dry-run: удалился бы"})
        else:
            res.append(remove(repo, wt, cwds, refs))
    return res


def count(repo):
    return sum(1 for wt in worktrees(repo) if not wt["prunable"])


def limit_text(repo):
    """Отказ на пределе: сколько worktree и что с ними сделать."""
    n = count(repo)
    if n < LIMIT:
        return None
    return (f"Предел worktree продукта — {LIMIT} (решение владельца 13.11), сейчас {n}. Сначала закончите или "
            f"объедините работу: связанные задачи сектора — в одном worktree. Влитые удаляет "
            f"`python3 -I eval/tools/wt_gc.py sweep {repo}`; список — `git worktree list`.")


def main(argv):
    if len(argv) < 3 or argv[1] not in ("branch", "sweep", "check-limit", "count"):
        print(__doc__, file=sys.stderr)
        return 2
    cmd, repo = argv[1], argv[2]
    as_json = "--json" in argv
    if cmd == "count":
        print(count(repo))
        return 0
    if cmd == "check-limit":
        text = limit_text(repo)
        if text:
            print(text, file=sys.stderr)
            return 3
        return 0
    if cmd == "branch":
        if len(argv) < 4 or argv[3].startswith("--"):
            print("branch <repo_root> <branch>", file=sys.stderr)
            return 2
        res = gc_branch(repo, argv[3])
    else:
        res = sweep(repo, dry_run="--dry-run" in argv)
    if as_json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        for r in res:
            print(("удалён  " if r["removed"] else "оставлен ") + r["path"] + ("" if r["removed"] else f" — {r['reason']}"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
