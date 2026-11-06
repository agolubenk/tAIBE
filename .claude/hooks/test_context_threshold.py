#!/usr/bin/env python3
"""Хук бюджета окна (context-threshold.py) и пусковой скрипт spawn_session.sh — без сети и без окон.

Правила бюджета (примеры владельца 06.11, окно 1M, сброс, learn) проверяет test_ctx_budget.py рядом с
ctx_budget.py; здесь — сам хук: модуль найден, границы задач, окно, текст передачи с абсолютными путями, гонки,
выключатель, состояние вне репозитория. Один файл для дома слоя и инстанса HR; unittest — годится и для discover.
Запуск: python3 -I .claude/hooks/test_context_threshold.py  (или python3 -m unittest discover -s .claude/hooks)
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
REPO = HOOKS.parents[1]
HOOK = HOOKS / "context-threshold.py"
KNOBS = ("SUCCESSOR_WINDOW_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "SUCCESSOR_AUTO", "T3_ROLE_KEY",
         "TAIBE_LINEAGE", "TAIBE_PIPELINE", "CTX_BUDGET_DIR", "CLAUDE_PROJECT_DIR", "ANTHROPIC_MODEL")


def load_hook():
    spec = importlib.util.spec_from_file_location("ct", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ct = load_hook()
cb, REL = ct.load_budget()


def line(kind, tokens, sidechain=False):
    usage = {"input_tokens": 2, "cache_read_input_tokens": tokens - 102, "cache_creation_input_tokens": 50,
             "output_tokens": 50}
    return json.dumps({"type": kind, "isSidechain": sidechain, "message": {"usage": usage}}) + "\n"


def bash(cmd):
    return {"tool_name": "Bash", "tool_input": {"command": cmd}}


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if k not in KNOBS}  # ручки из оболочки не меняют ожидания
    env.update(extra)
    return env


class BoundaryTest(unittest.TestCase):
    def test_module_found(self):
        self.assertIn(REL, ct.BUDGET_PATHS)

    def test_auto_boundaries(self):
        self.assertEqual(ct.auto_boundary(bash("git -C wt commit -m 'x'")), "commit")
        self.assertEqual(ct.auto_boundary(bash("git push && gh pr create --base main")), "pr")
        self.assertEqual(ct.auto_boundary({"tool_name": "mcp__hub__t-boards_1mcp_update_task_status"}), "card")
        self.assertIsNone(ct.auto_boundary(bash("git status && git log -1")))
        self.assertIsNone(ct.auto_boundary(bash("python3 x/ctx_budget.py next 'git commit' --size S")))


class TranscriptAndWindowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.saved = dict(os.environ)
        for knob in KNOBS:
            os.environ.pop(knob, None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved)
        self.tmp.cleanup()

    def test_last_answer_of_main_chain(self):
        tr = self.root / "t.jsonl"  # последний ответ основной цепочки, а не субагента и не реплика пользователя
        tr.write_text(line("assistant", 120_000) + line("assistant", 205_000) + line("assistant", 30_000, True)
                      + json.dumps({"type": "user", "message": {"content": "x"}}) + "\n", encoding="utf-8")
        self.assertEqual(cb.last_context_tokens(tr), 205_000)
        (self.root / "garbage.jsonl").write_text('{"usage": oops\n', encoding="utf-8")
        self.assertIsNone(cb.last_context_tokens(self.root / "garbage.jsonl"))

    def test_window_from_settings_and_env(self):
        (self.root / ".claude").mkdir()
        (self.root / ".claude/settings.local.json").write_text('{"autoCompactWindow": 300000}', encoding="utf-8")
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.root)
        self.assertEqual(cb.session_window()[0], 300_000)
        os.environ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = "250000"
        self.assertEqual(cb.session_window()[0], 250_000)
        os.environ["SUCCESSOR_WINDOW_TOKENS"] = "200000"
        self.assertEqual(cb.session_window()[0], 200_000)

    def test_cli_path_absolute_from_project_dir(self):
        os.environ["CLAUDE_PROJECT_DIR"] = str(REPO)
        self.assertEqual(ct.project_path(REL), str(REPO / REL))
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.root)  # там модуля нет — корень самого хука
        self.assertEqual(ct.project_path(REL), str(REPO / REL))
        self.assertTrue(Path(ct.project_path(REL)).is_absolute())


class HookRunTest(unittest.TestCase):
    """Хук целиком: окно 300K из settings.local, без params.json — W_eff 255,6K, H 4 %; 245K = 95,9 % ≥ 98,5 − 4 —
    страховка с шагами; тишина без прироста; выключатель; 6 параллельных вызовов — один текст."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".claude").mkdir()
        (self.root / ".claude/settings.local.json").write_text('{"autoCompactWindow": 300000}', encoding="utf-8")
        self.big = self.root / "big.jsonl"
        self.big.write_text(("x" * 30_000) + "\n" + line("assistant", 245_000), encoding="utf-8")
        self.budget = self.root / "budget"
        self.env = clean_env(CLAUDE_PROJECT_DIR=str(self.root), CTX_BUDGET_DIR=str(self.budget),
                             HOME=str(self.root / "home"))

    def tearDown(self):
        self.tmp.cleanup()

    def start(self, env=None):
        return subprocess.Popen([sys.executable, "-I", str(HOOK)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                text=True, env=env or self.env)

    def run_hook(self, sid, env=None, cwd=None):
        proc = subprocess.run([sys.executable, "-I", str(HOOK)], input=json.dumps(
            {"session_id": sid, "transcript_path": str(self.big)}), capture_output=True, text=True, timeout=20,
            env=env or self.env, cwd=cwd)
        self.assertEqual(proc.returncode, 0)
        return proc.stdout

    def test_handoff_text_once(self):
        first = self.run_hook("test-ct-a")
        for part in ("<successor-threshold>", "95,9 %", "По порядку", "spawn_session.sh --handoff"):
            self.assertIn(part, first)
        self.assertNotIn("80 %", first)
        cli = "python3 " + str(REPO / REL)  # абсолютный путь: из подпапки сессии тоже работает
        self.assertIn("`%s status`" % cli, json.loads(first)["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.run_hook("test-ct-a"), "")
        self.assertTrue((self.budget / "sessions" / "test-ct-a.json").is_file())
        self.assertFalse(any((REPO / ".claude/memory/session/successor").glob("test-ct-*")))

    def test_switch_off(self):
        self.assertEqual(self.run_hook("test-ct-b", env=dict(self.env, SUCCESSOR_AUTO="off")), "")
        self.assertIn("successor-threshold", self.run_hook("test-ct-b"))

    def test_parallel_calls_print_once(self):
        procs = [self.start() for _ in range(6)]
        outs = [pr.communicate(json.dumps({"session_id": "test-ct-c", "transcript_path": str(self.big)}),
                               timeout=20)[0] for pr in procs]
        self.assertEqual(sum("successor-threshold" in o for o in outs), 1)


def spawn_script():
    """В доме слоя — свой eval/tools; в инстансе HR — checkout tAIBE ($TAIBE_ROOT): ссылок на слой там нет с 05.11."""
    for cand in (REPO / "eval/tools/spawn_session.sh",
                 Path(os.environ.get("TAIBE_ROOT") or Path.home() / "Desktop/Development/tAIBE")
                 / "eval/tools/spawn_session.sh"):
        if cand.exists():
            return cand
    return None


@unittest.skipIf(spawn_script() is None, "нет spawn_session.sh (checkout tAIBE)")
class SpawnTest(unittest.TestCase):
    """spawn_session.sh: dry-run печатает пусковой скрипт, ничего не открывает."""

    def setUp(self):
        self.tmpd = tempfile.TemporaryDirectory()
        self.tmp = Path(self.tmpd.name)
        self.spawn = spawn_script()
        self.handoff = self.tmp / "handoff.md"
        self.handoff.write_text("# handoff\n", encoding="utf-8")
        (self.tmp / "eval/pipeline/genome").mkdir(parents=True)
        (self.tmp / "eval/pipeline/genome/release.json").write_text("{}", encoding="utf-8")
        (self.tmp / "roles").mkdir()
        (self.tmp / "roles/5-release.md").write_text("x", encoding="utf-8")

    def tearDown(self):
        self.tmpd.cleanup()

    def sh(self, *args, env=None, cwd_arg=True, cwd=None):
        pre = ["--cwd", str(self.tmp)] if cwd_arg else []
        return subprocess.run(["/bin/bash", str(self.spawn), *pre, "--dry-run", *args], capture_output=True,
                              text=True, timeout=10, env=env, cwd=cwd)

    def test_successor(self):
        r = self.sh("--handoff", str(self.handoff))
        self.assertEqual((r.returncode, "Наследник сессии" in r.stdout, "--settings" in r.stdout), (0, True, False))
        self.assertIn("; rm -rf '", r.stdout)  # пусковая папка удаляется после чтения текста
        r = self.sh("--handoff", str(self.handoff), "--role", "release")
        self.assertEqual((r.returncode, "ключ реестра release, роль 5, наследник" in r.stdout,
                          "genome/release.json" in r.stdout), (0, True, True))
        no_tmpdir = {k: v for k, v in os.environ.items() if k != "TMPDIR"}
        self.assertEqual(self.sh("--handoff", str(self.handoff), env=no_tmpdir).returncode, 0)
        r = self.sh("--handoff", str(self.handoff), cwd_arg=False, cwd=self.tmp)
        self.assertTrue("cd '%s'" % self.tmp.resolve() in r.stdout or "cd '%s'" % self.tmp in r.stdout)

    def test_launch_and_refusals(self):
        r = self.sh("--launch", "--role", "release", "--prompt-dir", str(self.tmp / "roles"))
        self.assertEqual((r.returncode, "Пусковой файл" in r.stdout), (0, True))
        self.assertEqual(self.sh("--handoff", str(self.handoff), "--role", "nope").returncode, 2)
        self.assertEqual(self.sh("--handoff", str(self.tmp / "missing.md")).returncode, 2)
        self.assertEqual(self.sh("--launch", "--role", "coord", "--prompt-dir", str(self.tmp / "roles")).returncode, 2)
        odd = self.tmp / "a\\b"
        odd.mkdir()
        r = subprocess.run(["/bin/bash", str(self.spawn), "--cwd", str(odd), "--dry-run", "--handoff",
                            str(self.handoff)], capture_output=True, text=True, timeout=10)
        self.assertEqual(r.returncode, 2)  # обратный слэш в пути — отказ
        r = subprocess.run(["/bin/bash", str(self.spawn), "--help"], capture_output=True, text=True, timeout=10)
        self.assertEqual((r.returncode, "set -euo" in r.stdout), (0, False))


if __name__ == "__main__":
    unittest.main()
