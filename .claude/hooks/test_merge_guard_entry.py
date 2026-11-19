#!/usr/bin/env python3
"""SE-168: сбой загрузки merge-guard (импорт модуля, синтаксис) — отказ при признаке защищённого действия, а не проход."""
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import merge_guard_entry as entry  # noqa: E402


def bash(command):
    return {"tool_name": "Bash", "tool_input": {"command": command}, "session_id": "0b3c2d1e-0000-4000-8000-000000000001"}


def run(data, hook):
    out = io.StringIO()
    old = sys.stdin
    sys.stdin = io.StringIO(json.dumps(data) if not isinstance(data, str) else data)
    try:
        with contextlib.redirect_stdout(out):
            entry.main(hook=hook)
    finally:
        sys.stdin = old
    text = out.getvalue().strip()
    return json.loads(text)["hookSpecificOutput"] if text else None


class BrokenHook(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def hook(self, body):
        path = Path(self.dir.name) / "pre-tool-use-merge-guard.py"
        path.write_text(body, "utf-8")
        return path

    def test_import_error_denies_protected_action(self):
        hook = self.hook("from merge_guard_missing import x\n")
        for cmd in ("git push origin board-agents", "gh pr merge 1", "echo x > .claude/hooks/a.py"):
            got = run(bash(cmd), hook)
            self.assertEqual(got and got["permissionDecision"], "deny", cmd)
            # ModuleNotFoundError — подкласс ImportError; в причине — класс и текст сбоя
            self.assertIn("ModuleNotFoundError", got["permissionDecisionReason"])
            self.assertIn("merge_guard_missing", got["permissionDecisionReason"])

    def test_syntax_error_and_exit_deny_too(self):
        for body in ("def (:\n", "raise SystemExit(1)\n"):
            got = run(bash("git push"), self.hook(body))
            self.assertEqual(got and got["permissionDecision"], "deny", body)

    def test_failure_inside_hook_main_denies(self):
        # хук загрузился, но упал его main() (линза boards N1)
        hook = self.hook("def main():\n    raise RuntimeError('main упал')\n")
        self.assertEqual(run(bash("gh pr merge 1"), hook)["permissionDecision"], "deny")
        self.assertIsNone(run(bash("ls"), hook))

    def test_plain_command_passes(self):
        # сбой хука не блокирует всё подряд — как сбой разбора в main() хука
        self.assertIsNone(run(bash("ls -la"), self.hook("raise ImportError('x')\n")))

    def test_merge_tool_denied_without_command(self):
        data = {"tool_name": "mcp__hub__github_1mcp_merge_pull_request", "tool_input": {"pull_number": 1}}
        self.assertEqual(run(data, self.hook("raise ImportError\n"))["permissionDecision"], "deny")

    def test_hook_gets_same_stdin(self):
        # N1 линзы Claude: хук получает тот же stdin — без `sys.stdin = io.StringIO(raw)` он решал бы `{}`
        hook = self.hook("import json, sys\ndef main():\n"
                         "    print(json.dumps({'hookSpecificOutput': {'echo': sys.stdin.read()}}))\n")
        data = bash("ls -la")
        self.assertEqual(json.loads(run(data, hook)["echo"]), data)

    def test_failure_path_covers_identity_classes(self):
        # B2 линзы Claude на #472: при сбое загрузки признак — весь замок; классы, которые хук решает по личности
        exc = ImportError("x")
        full = "a" * 40
        deny = [
            ("mcp__github__rerun_failed_jobs", {"run_id": 1}),
            ("mcp__hub__github_1mcp_run_workflow", {"workflow_id": "deploy.yml", "ref": "board-agents"}),
            ("mcp__github__push_files", {"branch": "board-agents"}),
            ("mcp__github__create_or_update_file", {"path": "a"}),
            ("mcp__hub__owner-queue_1mcp_oq_patch", {"collection": "items", "id": "m-472", "data": {"archived": True}}),
            ("mcp__owner-queue__oq_put", {"collection": "items", "id": "taibe-m-b7-1811", "data": {"title": "t"}}),
            ("mcp__owner-queue__oq_patch", {"collection": "items", "id": "d-1", "data": {"sha": full, "base": "main"}}),
            ("mcp__owner-queue__oq_put", {"collection": "items", "id": "x-1", "data": {"kind": "merge", "pr": 1}}),
            ("Bash", {"command": "gh api -X POST repos/o/r/merges -f base=board-agents -f head=f"}),
            ("Bash", {"command": "gh api -X POST repos/o/r/actions/runs/1/rerun"}),
            ("Bash", {"command": "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{})}'"}),
            ("Bash", {"command": "git -C /x \\\n  push origin HEAD:board-agents"}),
            ("Bash", {"command": "cd .claude && sed -i '' s/a/b/ hooks/merge_guard_home.py"}),
            ("Monitor", {"command": "gh\tpr\tmerge 5"}),
        ]
        for tool, inp in deny:
            with self.subTest(tool=tool, inp=inp):
                self.assertIsNotNone(entry.failure_reason({"tool_name": tool, "tool_input": inp}, exc))
        allow = [
            ("mcp__github__pull_request_read", {"pullNumber": 1}),
            ("mcp__owner-queue__oq_put", {"collection": "items", "id": "taibe-d-x-1811", "data": {"title": "t"}}),
            ("mcp__owner-queue__oq_put", {"collection": "work", "id": "w-m-1", "data": {"sha": full}}),
            ("Bash", {"command": "gh pr view 1"}),
        ]
        for tool, inp in allow:
            with self.subTest(tool=tool, inp=inp):
                self.assertIsNone(entry.failure_reason({"tool_name": tool, "tool_input": inp}, exc))

    def test_bad_json_and_non_object_input(self):
        hook = self.hook("raise ImportError\n")
        self.assertIsNone(run("{не json", hook))
        self.assertIsNone(run([1, 2], hook))


class RealHook(unittest.TestCase):
    def test_settings_run_entry(self):
        text = (HERE.parent / "settings.json").read_text("utf-8")
        self.assertIn(".claude/hooks/merge_guard_entry.py", text)
        self.assertNotIn("hooks/pre-tool-use-merge-guard.py", text)

    def test_entry_loads_hook_and_passes_stdin(self):
        # хук целый: вход отдаёт ему тот же stdin; безобидная команда — проход без вывода
        proc = subprocess.run([sys.executable, "-I", str(HERE / "merge_guard_entry.py")], input=json.dumps(bash("ls")),
                              capture_output=True, text=True, timeout=20)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, ""), proc.stderr)

    def test_entry_with_real_hook_denies_merge_from_role(self):
        # сквозной путь (линза backend на #472): вход + настоящий хук, мёрж PR из сессии не Контроля — отказ
        proc = subprocess.run([sys.executable, "-I", str(HERE / "merge_guard_entry.py")],
                              input=json.dumps(bash("gh pr merge 1 --squash")), capture_output=True, text=True,
                              timeout=20)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        got = json.loads(proc.stdout)["hookSpecificOutput"]
        self.assertEqual(got["permissionDecision"], "deny")
        self.assertNotIn("сбой хука", got["permissionDecisionReason"])  # решил хук по личности, а не путь сбоя

    def test_broken_home_module_does_not_break_entry(self):
        # B1 линзы Claude: шаблон модуля файлов ~ со встроенным флагом не роняет вход на уровне модуля
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(HERE / "merge_guard_entry.py", tmp)
            Path(tmp, "merge_guard_home.py").write_text("import re\nHOME_WRITE = re.compile('(?i)x')\n", "utf-8")
            Path(tmp, "pre-tool-use-merge-guard.py").write_text("raise ImportError('сломан')\n", "utf-8")
            proc = subprocess.run([sys.executable, "-I", str(Path(tmp, "merge_guard_entry.py"))],
                                  input=json.dumps(bash("gh pr merge 1")), capture_output=True, text=True, timeout=20)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_entry_fallback_covers_hook_fallback(self):
        # Хук держит свой FALLBACK (SE-98, SE-152); вход не должен быть уже: всё, что ловит хук, ловит и вход —
        # и с модулем файлов ~, и без него (HOME_SPARE).
        import importlib.util
        import re
        spec = importlib.util.spec_from_file_location("mg_hook_for_test", HERE / "pre-tool-use-merge-guard.py")
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        spare = entry.SPARE
        forms = ["gh pr merge 1", "GH  PR  MERGE 1", "git -C x push origin HEAD:main", "mergePullRequest(id: 1)",
                 "curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge", "gh workflow run d.yml", "gh run rerun 1",
                 "curl -X POST https://api.github.com/repos/o/r/dispatches", "cat .claude/rules/x.md",
                 "vi .CLAUDE/Hooks/a.py", "cp x .claude/settings.json", "rm .claude/merge-guard.json",
                 "echo x > ~/.claude/sessions/1.json", "ls ~/.claude/shell-snapshots", "cat ~/.claude/session-env/a"]
        import merge_guard_home
        forms += [f"echo x >> ~/{n}" for n in sorted(merge_guard_home.SHELL_INIT)]
        for form in forms:
            with self.subTest(form):
                self.assertTrue(hook.FALLBACK.search(form), "форма не ловится хуком — тест устарел")
                self.assertTrue(entry.FALLBACK.search(form))
                self.assertTrue(spare.search(form))
        for form in ("ls", "echo hi", "cat README.md", "git status", "gh pr view 1"):
            with self.subTest(form):
                self.assertIsNone(entry.FALLBACK.search(form))

    def test_hook_unchanged_and_in_limit(self):
        src = (HERE / "pre-tool-use-merge-guard.py").read_text("utf-8")
        self.assertNotIn("merge_guard_entry", src)  # хук не зависит от входа: вход грузит его, не наоборот
        self.assertLessEqual(len(src.splitlines()), 500)


if __name__ == "__main__":
    unittest.main()
