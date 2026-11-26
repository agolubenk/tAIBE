#!/usr/bin/env python3
"""SE-171: emit, tap и status из linked worktree работают с состоянием основного checkout; run, once, NERVE_STATE_DIR
и папка, подменённая тестом, остаются как есть. Временный git-репозиторий с настоящим `git worktree add`.
Run: python3 -I -m unittest discover -s eval/nerve -p 'test_*.py'"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import state_io  # noqa: E402

SESSION_ENV = ("TAIBE_PRODUCT", "TAIBE_LINEAGE", "NERVE_STATE_DIR")


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, *args], check=True,
                   capture_output=True, text=True)


class SharedStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.main = os.path.realpath(os.path.join(self.tmp, "main"))
        code = os.path.join(self.main, "eval", "nerve")
        os.makedirs(code)
        for path in glob.glob(os.path.join(HERE, "*.py")) + [os.path.join(HERE, "config.json")]:
            if not os.path.basename(path).startswith("test_"):
                shutil.copy(path, code)
        os.makedirs(os.path.join(self.main, "eval", "tools"))      # budget.py берёт прайс из eval/tools (GL-1)
        shutil.copy(os.path.join(HERE, "..", "tools", "prices.py"), os.path.join(self.main, "eval", "tools"))
        git(self.tmp, "init", "-q", self.main)
        git(self.main, "add", ".")
        git(self.main, "commit", "-qm", "nerve")
        self.wt = os.path.join(self.main, "worktrees", "fix", "x")
        git(self.main, "worktree", "add", "-q", "--detach", self.wt)
        self.main_nerve, self.wt_nerve = code, os.path.join(self.wt, "eval", "nerve")
        env = mock.patch.dict(os.environ, {k: v for k, v in os.environ.items() if k not in SESSION_ENV}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def shared(self, cmd, here=None, state=None):
        here = here or self.wt_nerve
        return state_io.shared_state_dir(here, state or os.path.join(here, "state"), cmd)

    def test_emit_tap_status_from_a_worktree_use_the_main_state(self):
        self.assertEqual(state_io.main_checkout(self.wt_nerve), (self.main, self.wt))
        for cmd in ("emit", "tap", "status"):
            self.assertEqual(self.shared(cmd), os.path.join(self.main_nerve, "state"), cmd)

    def test_what_stays(self):
        own = os.path.join(self.wt_nerve, "state")
        self.assertEqual(self.shared("run"), own)            # a branch's daemon or pass is its own sandbox
        self.assertEqual(self.shared("once"), own)
        self.assertEqual(self.shared("emit", here=self.main_nerve), os.path.join(self.main_nerve, "state"))
        self.assertIsNone(state_io.main_checkout(self.main_nerve))   # .git is a folder: the main checkout
        set_by_test = os.path.join(self.tmp, "sandbox")
        self.assertEqual(self.shared("emit", state=set_by_test), set_by_test)   # mock.patch(nerve.STATE_DIR)
        with mock.patch.dict(os.environ, {"NERVE_STATE_DIR": own}):
            self.assertEqual(self.shared("emit"), own)

    def test_not_a_worktree(self):
        plain = os.path.join(self.tmp, "plain", "eval", "nerve")
        os.makedirs(plain)
        self.assertIsNone(state_io.main_checkout(plain))
        sub = os.path.join(self.tmp, "sub")                  # a submodule: .git file, no commondir
        os.makedirs(os.path.join(sub, "eval", "nerve"))
        os.makedirs(os.path.join(self.tmp, "modules", "sub"))
        with open(os.path.join(sub, ".git"), "w") as f:
            f.write("gitdir: ../modules/sub\n")
        self.assertIsNone(state_io.main_checkout(os.path.join(sub, "eval", "nerve")))
        with open(os.path.join(sub, ".git"), "w") as f:
            f.write("garbage\n")
        self.assertIsNone(state_io.main_checkout(os.path.join(sub, "eval", "nerve")))

    def test_main_without_the_folder_keeps_the_copy(self):
        shutil.rmtree(self.main_nerve)
        self.assertEqual(self.shared("emit"), os.path.join(self.wt_nerve, "state"))

    def test_emit_from_a_worktree_reaches_the_main_journal(self):
        """Приёмка карточки: emit из временного worktree попадает в журнал основного, копия пуста."""
        res = subprocess.run([sys.executable, "-I", os.path.join(self.wt_nerve, "nerve.py"), "emit", "coord", "hi"],
                             capture_output=True, text=True, cwd=self.wt, env=dict(os.environ), timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("записано: manual:", res.stdout)
        with open(os.path.join(self.main_nerve, "state", "journal.jsonl"), encoding="utf-8") as f:
            events = [json.loads(line) for line in f]
        self.assertEqual([(e["to"], e["text"]) for e in events], [(["coord"], "hi")])
        self.assertFalse(os.path.exists(os.path.join(self.wt_nerve, "state", "journal.jsonl")))


if __name__ == "__main__":
    unittest.main()
