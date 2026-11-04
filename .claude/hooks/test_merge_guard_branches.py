#!/usr/bin/env python3
"""
Проверка merge-guard: защищённые ветки — не только main/master, но и основная ветка remote (refs/remotes/<r>/HEAD; у
tAIBE это board-agents, блокер M0 роли 2 на #40) и `protected` из .claude/merge-guard(.local).json. git push, gh api,
GraphQL, curl, код python, GitHub MCP.

Запуск: python3 -I .claude/hooks/test_merge_guard_branches.py  (только эти проверки; все — test_merge_guard.py)
"""
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import merge_guard_git as mgit  # noqa: E402
import merge_guard_identity as identity  # noqa: E402
from merge_guard_testkit import D9, TMP, bash, check, failures, finish, repo_on, run  # noqa: E402

SAVED_ROOT = identity.MAIN_ROOT
NO_CONF = TMP / "branches-no-conf"
(NO_CONF / ".claude").mkdir(parents=True)
identity.MAIN_ROOT = NO_CONF  # без добавок из файла: защита только от main/master и origin/HEAD


def git(d, *args):
    return subprocess.run(["git", "-C", str(d), *args], check=True, capture_output=True, text=True).stdout.strip()


def taibe_like(branch):
    """Клон, у которого origin/HEAD → origin/board-agents, как у tAIBE (без сети: ссылки ставятся руками)."""
    d = repo_on(branch, prefix="taibe-")
    git(d, "remote", "add", "origin", "https://example.invalid/tAIBE.git")
    git(d, "update-ref", "refs/remotes/origin/board-agents", git(d, "rev-parse", "HEAD"))
    git(d, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/board-agents")
    return d


on_fix, on_ba, plain = taibe_like("fix/a"), taibe_like("board-agents"), repo_on("fix/a", prefix="plain-")

# --- git push: основная ветка remote ---
bash("M0: push HEAD:board-agents", "git push origin HEAD:board-agents", True, cwd=on_fix)
bash("M0: push fix/a:board-agents", "git push origin fix/a:board-agents", True, cwd=on_fix)
bash("M0: push в refs/heads/board-agents", "git push origin +HEAD:refs/heads/board-agents", True, cwd=on_fix)
bash("M0: push --delete board-agents", "git push origin --delete board-agents", True, cwd=on_fix)
bash("M0: голый push с board-agents", "git push", True, cwd=on_ba)
bash("M0: push origin HEAD с board-agents", "git push origin HEAD", True, cwd=on_ba)
bash("M0: push -C в tAIBE", f"git -C {on_fix} push origin HEAD:board-agents", True)
bash("M0: завести remote.push в board-agents", "git config remote.origin.push HEAD:refs/heads/board-agents", True,
     cwd=on_fix)
bash("main по-прежнему защищён", "git push origin HEAD:main", True, cwd=on_fix)
bash("своя ветка — проход", "git push -u origin fix/a", False, cwd=on_fix)
bash("похожее имя — проход", "git push origin HEAD:board-agents-old", False, cwd=on_fix)
bash("Контроль в board-agents — проход", "git push origin HEAD:board-agents", False, cwd=on_fix, who=D9)
bash("без origin/HEAD board-agents не основная", "git push origin HEAD:board-agents", False, cwd=plain)

# --- gh api, GraphQL, curl, python: та же ветка ---
bash("M0: api PATCH ref board-agents", "gh api -X PATCH repos/o/r/git/refs/heads/board-agents -f sha=x", True,
     cwd=on_fix)
bash("api PATCH своей ветки", "gh api -X PATCH repos/o/r/git/refs/heads/fix/a -f sha=x", False, cwd=on_fix)
bash("M0: api защита board-agents", "gh api -X PUT repos/o/r/branches/board-agents/protection", True, cwd=on_fix)
bash("M0: api contents в board-agents", "gh api -X PUT repos/o/r/contents/a.md -f branch=board-agents -f message=x",
     True, cwd=on_fix)
bash("api contents в свою ветку", "gh api -X PUT repos/o/r/contents/a.md -f branch=fix/a -f message=x", False, cwd=on_fix)
bash("M0: graphql createCommitOnBranch",
     "gh api graphql -f query='mutation{createCommitOnBranch(input:{branch:{branchName:\"board-agents\"}}){commit{oid}}}'",
     True, cwd=on_fix)
bash("M0: curl PATCH ref", "curl -X PATCH https://api.github.com/repos/o/r/git/refs/heads/board-agents -d '{}'", True,
     cwd=on_fix)
bash("curl PATCH своей ветки", "curl -X PATCH https://api.github.com/repos/o/r/git/refs/heads/fix/a -d '{}'", False,
     cwd=on_fix)
bash("M0: python subprocess push", "python3 -c \"import subprocess; subprocess.run(['git','push','origin','HEAD:board-agents'])\"",
     True, cwd=on_fix)
bash("python push --all в кавычках", "python3 -c \"import subprocess; subprocess.run(['git','push','--all'])\"", True)
bash("python push своей ветки", "python3 -c \"import subprocess; subprocess.run(['git','push','origin','fix/a'])\"",
     False, cwd=on_fix)

# --- GitHub MCP ---
check("M0: MCP push_files в board-agents", run("mcp__github__push_files", {"branch": "board-agents"}, cwd=on_fix), True)
check("MCP push_files в свою ветку", run("mcp__github__push_files", {"branch": "fix/a"}, cwd=on_fix), False)

# --- `protected` из файла: на случай, если origin/HEAD не задан ---
conf = TMP / "branches-conf"
(conf / ".claude").mkdir(parents=True)
identity.MAIN_ROOT = conf
(conf / ".claude" / "merge-guard.json").write_text(json.dumps({"control": [], "protected": ["refs/heads/board-agents"]}))
bash("protected из общего файла", "git push origin HEAD:board-agents", True, cwd=plain)
(conf / ".claude" / "merge-guard.local.json").write_text(json.dumps({"control": ["x"], "protected": ["release"]}))
bash("локальный файл добавляет, а не заменяет: board-agents", "git push origin HEAD:board-agents", True, cwd=plain)
bash("локальный файл добавляет: release", "git push origin HEAD:release", True, cwd=plain)
(conf / ".claude" / "merge-guard.local.json").write_text('{"protected": "release"')
if identity.load_protected(conf) != {"board-agents"}:
    failures.append("load_protected: испорченный локальный файл не должен ни добавлять, ни снимать общий список")
(conf / ".claude" / "merge-guard.json").write_text(json.dumps({"protected": "board-agents"}))
if identity.load_protected(conf):
    failures.append("load_protected: protected не списком — без добавок")
identity.MAIN_ROOT = NO_CONF

# --- бюджет git исчерпан — ветка считается защищённой ---
mgit.start_budget()
mgit._deadline[0] = time.monotonic() - 1
if not mgit.is_protected("fix/a", str(on_fix)) or not mgit.mentions_protected("fix/a", str(on_fix)):
    failures.append("GitTimeout: is_protected/mentions_protected должны отвечать «да»")
mgit.start_budget()

identity.MAIN_ROOT = SAVED_ROOT

if __name__ == "__main__":
    finish(" — защищённые ветки")
