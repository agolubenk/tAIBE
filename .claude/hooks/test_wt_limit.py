# -*- coding: utf-8 -*-
"""OPS-52: хук pre-tool-use-wt-limit.sh — новый worktree сверх предела продукта останавливается (код 2), под пределом,
с обходом WT_LIMIT_CHECK=0 и вне git — молча (код 0). Предел подменяется через копию wt_gc.py с LIMIT = 1."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "pre-tool-use-wt-limit.sh")
WT_GC = os.path.join(HERE, "..", "..", "eval", "tools", "wt_gc.py")
ADD = " ".join(["git", "worktree", "add"])  # текст команды, которую проверяет хук


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


class WtLimitHookTest(unittest.TestCase):
    def setUp(self):
        # Раскладка «слоя»: <root>/.claude/hooks/<хук> и <root>/eval/tools/wt_gc.py с пределом 1.
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, ".claude", "hooks"))
        os.makedirs(os.path.join(self.root, "eval", "tools"))
        self.hook = os.path.join(self.root, ".claude", "hooks", "pre-tool-use-wt-limit.sh")
        shutil.copy(HOOK, self.hook)
        src = open(WT_GC, encoding="utf-8").read().replace("\nLIMIT = 10\n", "\nLIMIT = 1\n")
        open(os.path.join(self.root, "eval", "tools", "wt_gc.py"), "w", encoding="utf-8").write(src)
        self.repo = os.path.join(self.root, "repo")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q")
        for k, v in (("user.email", "t@example.com"), ("user.name", "t"), ("commit.gpgsign", "false")):
            git(self.repo, "config", k, v)
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "init")

    def run_hook(self, command, cwd):
        p = subprocess.run(["bash", self.hook], input=json.dumps({"tool_input": {"command": command}, "cwd": cwd}),
                           capture_output=True, text=True)
        return p.returncode, p.stderr

    def test_under_limit_passes_and_at_limit_blocks(self):
        self.assertEqual(self.run_hook(f"{ADD} w1", self.repo)[0], 0)
        git(self.repo, "worktree", "add", "-q", "-b", "w1", os.path.join(self.repo, "w1"))
        code, err = self.run_hook(f"{ADD} w2", self.repo)
        self.assertEqual(code, 2)
        self.assertIn("Предел worktree продукта — 1", err)
        # Из linked worktree считается тот же репозиторий; ведущий cd тоже учитывается.
        self.assertEqual(self.run_hook(f"{ADD} w2", os.path.join(self.repo, "w1"))[0], 2)
        self.assertEqual(self.run_hook(f"cd {self.repo} && {ADD} w2", self.root)[0], 2)
        self.assertEqual(self.run_hook(f"WT_LIMIT_CHECK=0 {ADD} w2", self.repo)[0], 0)

    def test_other_commands_and_no_repo_are_silent(self):
        git(self.repo, "worktree", "add", "-q", "-b", "w1", os.path.join(self.repo, "w1"))
        self.assertEqual(self.run_hook("git worktree list", self.repo)[0], 0)
        self.assertEqual(self.run_hook(f"{ADD} x", tempfile.mkdtemp())[0], 0)


if __name__ == "__main__":
    unittest.main()
