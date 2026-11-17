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

    def test_hook_uses_entry_fallback(self):
        src = (HERE / "pre-tool-use-merge-guard.py").read_text("utf-8")
        self.assertIn("from merge_guard_entry import FALLBACK, failure_reason", src)
        self.assertLessEqual(len(src.splitlines()), 500)


if __name__ == "__main__":
    unittest.main()
