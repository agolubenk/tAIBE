#!/usr/bin/env python3
"""Хук pre-tool-use-wt-deps.sh: гейт в worktree без своих зависимостей стоит, установка (OPS-54) проходит.

Временный репозиторий с папкой досок (pnpm-lock.yaml) и linked worktree без node_modules; хук получает JSON, как от
Claude Code. Без сети и без pnpm. Запуск: python3 -I .claude/hooks/test_wt_deps_hook.py
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "pre-tool-use-wt-deps.sh"


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", *args], cwd=cwd, check=True,
                   capture_output=True, text=True)


@unittest.skipIf(shutil.which("jq") is None or shutil.which("git") is None, "нужны jq и git")
class WtDepsHookTest(unittest.TestCase):
    def setUp(self):
        self.tmpd = tempfile.TemporaryDirectory()
        self.tmp = Path(self.tmpd.name).resolve()
        main = self.tmp / "main"
        (main / "boards").mkdir(parents=True)
        (main / "boards/pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
        (main / "boards/package.json").write_text("{}\n", encoding="utf-8")
        git(main, "init", "-q")
        git(main, "add", ".")
        git(main, "commit", "-q", "-m", "init")
        git(main, "worktree", "add", "-q", str(self.tmp / "wt"))
        self.main = main
        self.boards = self.tmp / "wt/boards"
        self.env = {k: v for k, v in os.environ.items() if k not in ("WT_DEPS_CHECK", "BOARDS_TREE")}

    def tearDown(self):
        self.tmpd.cleanup()

    def hook(self, command, cwd=None):
        data = json.dumps({"tool_input": {"command": command}, "cwd": str(cwd or self.boards)})
        r = subprocess.run(["bash", str(HOOK)], input=data, capture_output=True, text=True, timeout=20, env=self.env)
        return r.returncode, r.stderr

    def test_gate_stops_without_deps(self):
        rc, err = self.hook("pnpm test")
        self.assertEqual(rc, 2)
        self.assertIn("pnpm install --frozen-lockfile", err)
        self.assertIn("wt-deps.sh install", err)
        for cmd in ("pnpm run typecheck", "pnpm info react", "pnpm -C . lint"):
            self.assertEqual(self.hook(cmd)[0], 2, cmd)

    def test_install_passes(self):
        for cmd in ("pnpm install --frozen-lockfile", "pnpm i", "pnpm install",
                    f"pnpm -C {self.boards} install --frozen-lockfile", f"pnpm --dir={self.boards} i",
                    "pnpm install --frozen-lockfile && pnpm test"):
            self.assertEqual(self.hook(cmd), (0, ""), cmd)
        for cmd in (f"cd {self.boards} && pnpm install --frozen-lockfile",
                    f"(cd {self.boards} && pnpm install --frozen-lockfile)"):
            self.assertEqual(self.hook(cmd, cwd=self.tmp)[0], 0, cmd)

    def test_chain_after_failed_install_is_gated(self):
        for cmd in ("pnpm install; pnpm test", "pnpm install || pnpm test"):
            self.assertEqual(self.hook(cmd)[0], 2, cmd)

    def test_main_checkout_is_silent(self):
        self.assertEqual(self.hook("pnpm test", cwd=self.main / "boards"), (0, ""))


if __name__ == "__main__":
    unittest.main()
