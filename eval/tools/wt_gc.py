# -*- coding: utf-8 -*-
"""Уборка git worktree после мёржа (OPS-52, входящее владельца i-20261113-143043-ef29, решение «после мёржа» 13.11).

Работа по worktree влита в основную ветку — worktree удаляется; ветка остаётся (её удаляет мёрж на GitHub или Контроль).
Удаляется только безопасное — иначе worktree остаётся, а причина печатается (любое сомнение — оставить):
- HEAD worktree — голова влитого PR (`--head`), а база PR — основная ветка репозитория (`--base`);
- копия чистая: ни правок, ни неотслеживаемых файлов, а игнорируемые — только из сборки и установки (node_modules,
  dist…) или копии файлов основного checkout (.env из .worktreeinclude). Состояние сессии (.ai/task/,
  .claude/memory/session/, CLAUDE.local.md, prototipes/, правленый .env) — повод оставить;
- своих коммитов вне remote нет (HEAD есть в какой-нибудь ветке origin);
- в worktree не работает процесс (lsof) и в нём не работали последний час (индекс и журнал HEAD worktree): сессия
  Claude между командами не держит cwd внутри, поэтому одного lsof мало. lsof не ответил — оставить;
- на worktree не ссылаются ссылки в ~/.config, ~/.local/bin и задачи launchd;
- `git worktree remove` без `--force` — git сам откажет при грязной или запертой (`git worktree lock`) копии.

Предел (решение владельца 13.11): не больше LIMIT worktree на продукт. `count` / `check-limit` — для `make wt-add` и хука.

    python3 -I eval/tools/wt_gc.py branch <repo_root> <branch> [--head SHA] [--base REF] [--json]  # Нерв после мёржа
    python3 -I eval/tools/wt_gc.py sweep <repo_root> [--dry-run] [--json]  # все worktree с влитыми PR (gh)
    python3 -I eval/tools/wt_gc.py check-limit <repo_root>                # код 3 — предел достигнут
"""
import json
import os
import plistlib
import re
import subprocess
import sys
import time

DEFAULT_LIMIT = 10


def _limit():
    """WT_LIMIT может только ужесточить предел (тесты, решение владельца); обход — WT_LIMIT_CHECK=0 по слову владельца."""
    try:
        return max(1, min(int(os.environ.get("WT_LIMIT") or DEFAULT_LIMIT), DEFAULT_LIMIT))
    except ValueError:
        return DEFAULT_LIMIT


LIMIT = _limit()
# Работа в worktree за это время — повод оставить его (сессия Claude продолжает связанную задачу в той же копии).
ACTIVE_S = 3600
# Игнорируемое, которое восстанавливается установкой или сборкой: с ним копию можно удалить.
REGEN = re.compile(r"(^|/)(node_modules|dist|build|out|\.turbo|\.next|\.vite|coverage|test-results|playwright-report|"
                   r"storybook-static|generated|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|\.cache|"
                   r"\.gradle|logs?)(/|$)|\.tsbuildinfo$|\.pyc$|\.log$|(^|/)\.DS_Store$|(^|/)\.eslintcache$")
CONSUMER_LINK_DIRS = ("~/.config", "~/.local/bin")
CONSUMER_FILE_GLOBS = ("~/Library/LaunchAgents/*.plist",)
CONSUMER_FILE_MAX = 1 << 20


class GitError(RuntimeError):
    pass


def _run(cmd, cwd=None, timeout=120):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)


def worktrees(repo):
    """Связанные worktree репозитория (без основного checkout): [{path, branch, head, prunable, git_dir}]."""
    code, out, err = _run(["git", "worktree", "list", "--porcelain"], cwd=repo)
    if code:
        raise GitError(f"git worktree list в {repo}: {err[:160]}")
    main = os.path.realpath(repo)
    res, cur = [], {}
    for line in out.splitlines() + [""]:
        if not line:
            if cur.get("worktree") and os.path.realpath(cur["worktree"]) != main:
                res.append({"path": cur["worktree"], "branch": str(cur.get("branch", "")).removeprefix("refs/heads/"),
                            "head": cur.get("HEAD", ""), "prunable": "prunable" in cur})
            cur = {}
            continue
        k, _, v = line.partition(" ")
        cur[k] = v or True
    return res


def busy_paths():
    """cwd всех процессов пользователя (lsof). None — lsof не ответил: тогда ничего не удаляем."""
    code, out, _ = _run(["lsof", "-a", "-d", "cwd", "-Fn"], timeout=60)
    if code and not out:
        return None
    return {l[1:] for l in out.splitlines() if l.startswith("n")}


def _real(cwds):
    """git и lsof печатают настоящие пути (/private/var/…), а путь могли дать через ссылку (/var/…): realpath — один раз."""
    return None if cwds is None else {os.path.realpath(c) for c in cwds}


def _inside(path, real_paths):
    path = os.path.realpath(path).rstrip("/") + "/"
    return any((c.rstrip("/") + "/").startswith(path) for c in real_paths)


def _plist_paths(f):
    """Строки-пути из plist (XML и бинарного): обход значений, без склейки байтов."""
    try:
        with open(f, "rb") as fh:
            data = plistlib.load(fh)
    except Exception:  # noqa: BLE001 — не plist: пропустить
        return []
    out, stack = [], [data]
    while stack:
        v = stack.pop()
        if isinstance(v, dict):
            stack.extend(v.values())
        elif isinstance(v, (list, tuple)):
            stack.extend(v)
        elif isinstance(v, str):
            out.extend(re.findall(r"""/[^\s<>"',;:]*/worktrees/[^\s<>"',;:]+""", v))
    return out


def external_refs():
    """{цель (realpath): где ссылка} — ссылки и задачи launchd, которые смотрят в какой-нибудь worktree."""
    import glob
    refs = {}
    for d in CONSUMER_LINK_DIRS:
        for dirpath, dirnames, filenames in os.walk(os.path.expanduser(d)):
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
                st = os.stat(f)
            except OSError:
                continue
            if not os.path.isfile(f) or st.st_size > CONSUMER_FILE_MAX:
                continue
            for target in _plist_paths(f):
                refs[os.path.realpath(target)] = f
    return refs


def _referenced(path, refs):
    path = os.path.realpath(path).rstrip("/") + "/"
    return next((src for target, src in refs.items() if (target.rstrip("/") + "/").startswith(path)), None)


def _git_dir(path):
    code, out, _ = _run(["git", "rev-parse", "--path-format=absolute", "--git-dir"], cwd=path)
    return out if not code else ""


def _active_recently(path, now=None):
    """Последнее изменение индекса или журнала HEAD worktree (служебная папка .git/worktrees/<id>) — секунды назад."""
    gd = _git_dir(path)
    if not gd:
        return 0
    stamps = [os.path.getmtime(p) for p in (os.path.join(gd, "index"), os.path.join(gd, "logs", "HEAD"))
              if os.path.exists(p)]
    return (now or time.time()) - max(stamps) if stamps else None


def _odd_ignored(path, repo):
    """Игнорируемые файлы, которые не восстановить: не из сборки и не копии файлов основного checkout."""
    code, out, err = _run(["git", "status", "--porcelain", "--ignored", "--untracked-files=normal"], cwd=path)
    if code:
        raise GitError(f"git status --ignored: {err[:120]}")
    odd = []
    for line in out.splitlines():
        if not line.startswith("!! "):
            continue
        rel = line[3:].strip('"')
        if REGEN.search(rel.rstrip("/")):
            continue
        src, dst = os.path.join(repo, rel), os.path.join(path, rel)
        if os.path.isfile(dst) and os.path.isfile(src):
            try:
                with open(src, "rb") as a, open(dst, "rb") as b:
                    if a.read() == b.read():
                        continue  # копия из основного checkout (.worktreeinclude)
            except OSError:
                pass
        odd.append(rel)
    return odd


def default_branch(repo):
    code, out, _ = _run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd=repo)
    return out.removeprefix("origin/") if not code else ""


def why_not(wt, repo, cwds, refs, head=None, base=None):
    """Причина не удалять worktree или None — можно. Порядок — от дешёвых проверок к дорогим."""
    p = wt["path"]
    if not os.path.isdir(p):
        return "папки нет (git worktree prune)"
    if head and wt["head"] != head:
        return f"HEAD {wt['head'][:9]} — не голова влитого PR ({head[:9]}): работа продолжилась или ветку взяли заново"
    if base is not None:
        main = default_branch(repo)
        if not main or base != main:
            return f"PR влит в {base or '?'}, а не в основную ветку {main or '?'}"
    if cwds is None:
        return "lsof не ответил — не видно, работает ли в нём процесс"
    if _inside(p, cwds):
        return "в нём работает процесс"
    age = _active_recently(p)
    if age is not None and age < ACTIVE_S:
        return f"в нём работали {int(age // 60)} мин назад"
    src = _referenced(p, refs)
    if src:
        return f"на него ссылается {src.replace(os.path.expanduser('~'), '~')}"
    code, out, err = _run(["git", "status", "--porcelain"], cwd=p)
    if code:
        return f"git status: {err[:120]}"
    if out:
        return f"незакоммиченные изменения: {len(out.splitlines())}"
    odd = _odd_ignored(p, repo)
    if odd:
        return "игнорируемые файлы не из сборки: " + ", ".join(odd[:3]) + (f" и ещё {len(odd) - 3}" if len(odd) > 3 else "")
    code, out, _ = _run(["git", "branch", "-r", "--contains", "HEAD"], cwd=p)
    if code or not out:
        return "есть коммиты, которых нет на remote"
    return None


def remove(repo, wt, cwds, refs, head=None, base=None):
    try:
        reason = why_not(wt, repo, cwds, refs, head, base)
    except GitError as e:
        reason = str(e)
    if reason:
        return {"path": wt["path"], "branch": wt["branch"], "removed": False, "reason": reason}
    # Бюджет меньше таймаута Нерва на весь вызов (300 с): иначе Нерв убьёт процесс посреди удаления.
    code, _, err = _run(["git", "worktree", "remove", wt["path"]], cwd=repo, timeout=240)
    if code:
        return {"path": wt["path"], "branch": wt["branch"], "removed": False, "reason": f"git отказал: {err[:160]}"}
    return {"path": wt["path"], "branch": wt["branch"], "removed": True}


def gc_branch(repo, branch, cwds=..., refs=None, head=None, base=None):
    """После мёржа PR ветки branch: удалить её worktree, если это безопасно. [] — у ветки нет worktree."""
    if not branch:
        raise ValueError("пустое имя ветки")
    mine = [wt for wt in worktrees(repo) if wt["branch"] == branch]
    if not mine:
        return []
    cwds = _real(busy_paths() if cwds is ... else cwds)
    refs = external_refs() if refs is None else refs
    return [remove(repo, wt, cwds, refs, head, base) for wt in mine]


def merged_prs(repo, limit=2000):
    """{ветка: (голова, база)} влитых PR из этого же репозитория (не из форков). Окно — последние limit мёржей."""
    code, out, err = _run(["gh", "pr", "list", "--state", "merged", "--limit", str(limit),
                           "--json", "headRefName,headRefOid,baseRefName,isCrossRepository"], cwd=repo, timeout=180)
    if code:
        raise RuntimeError(f"gh pr list не ответил: {err[:160]}")
    res = {}
    for p in json.loads(out or "[]"):
        if not p.get("isCrossRepository") and p["headRefName"] not in res:  # список — от свежих к старым
            res[p["headRefName"]] = (p["headRefOid"], p["baseRefName"])
    return res


def sweep(repo, dry_run=False):
    """Все worktree, чья ветка влита PR: удалить безопасные. Для пропущенных Нервом мёржей (демон стоял)."""
    merged = merged_prs(repo)
    cwds, refs = _real(busy_paths()), external_refs()
    res = []
    for wt in worktrees(repo):
        if not wt["branch"] or wt["branch"] not in merged:
            continue
        head, base = merged[wt["branch"]]
        if dry_run:
            try:
                reason = why_not(wt, repo, cwds, refs, head, base)
            except GitError as e:
                reason = str(e)
            res.append({"path": wt["path"], "branch": wt["branch"], "removed": False, "reason": reason or "dry-run: удалился бы"})
        else:
            res.append(remove(repo, wt, cwds, refs, head, base))
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


def _opt(argv, name):
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None


def main(argv):
    if len(argv) < 3 or argv[1] not in ("branch", "sweep", "check-limit", "count"):
        print(__doc__, file=sys.stderr)
        return 2
    cmd, repo = argv[1], argv[2]
    as_json = "--json" in argv
    try:
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
            if len(argv) < 4 or not argv[3] or argv[3].startswith("--"):
                print("branch <repo_root> <branch> [--head SHA] [--base REF]", file=sys.stderr)
                return 2
            res = gc_branch(repo, argv[3], head=_opt(argv, "--head"), base=_opt(argv, "--base"))
        else:
            res = sweep(repo, dry_run="--dry-run" in argv)
    except (GitError, RuntimeError) as e:
        print(f"wt_gc: {e}", file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps(res, ensure_ascii=False))
    elif not res:
        print(f"у ветки {argv[3]} нет worktree" if cmd == "branch" else "worktree с влитыми PR нет")
    else:
        for r in res:
            print(("удалён  " if r["removed"] else "оставлен ") + r["path"] + ("" if r["removed"] else f" — {r['reason']}"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
