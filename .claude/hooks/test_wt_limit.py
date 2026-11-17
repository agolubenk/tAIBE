# -*- coding: utf-8 -*-
"""OPS-52: хук pre-tool-use-wt-limit.sh — новый worktree сверх предела продукта останавливается (код 2), под пределом,
с обходом WT_LIMIT_CHECK=0 и вне git — молча (код 0). Предел задаётся WT_LIMIT=1 в окружении хука."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "pre-tool-use-wt-limit.sh")
ADD = " ".join(["git", "worktree", "add"])  # текст команды, которую проверяет хук


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


class WtLimitHookTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.repo = os.path.join(self.root, "repo")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q")
        for k, v in (("user.email", "t@example.com"), ("user.name", "t"), ("commit.gpgsign", "false")):
            git(self.repo, "config", k, v)
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "init")
        self.other = os.path.join(self.root, "other")
        os.makedirs(self.other)
        git(self.other, "init", "-q")

    def run_hook(self, command, cwd, **extra):
        env = {**os.environ, "WT_LIMIT": "1", **extra}
        env.pop("WT_LIMIT_CHECK", None)
        if "WT_LIMIT_ENFORCE_FROM" not in extra:
            env.pop("WT_LIMIT_ENFORCE_FROM", None)
        p = subprocess.run(["bash", HOOK], input=json.dumps({"tool_input": {"command": command}, "cwd": cwd}),
                           capture_output=True, text=True, env=env)
        self.last_stdout = p.stdout
        return p.returncode, p.stderr

    def test_over_limit_before_arming_warns_into_context(self):
        """Решение владельца 14.11 (B): продукт уже выше предела — команда идёт, модель получает предупреждение."""
        for w in ("w1", "w2"):
            git(self.repo, "worktree", "add", "-q", "-b", w, os.path.join(self.repo, w))
        self.assertEqual(self.run_hook(f"{ADD} w3", self.repo)[0], 0)
        ctx = json.loads(self.last_stdout)["hookSpecificOutput"]
        self.assertEqual(ctx["hookEventName"], "PreToolUse")
        self.assertIn("Предупреждение", ctx["additionalContext"])
        self.assertNotIn("permissionDecision", ctx)
        # Дата остановки наступила — отказ.
        self.assertEqual(self.run_hook(f"{ADD} w3", self.repo, WT_LIMIT_ENFORCE_FROM="2000-01-01")[0], 2)

    def test_under_limit_passes_and_at_limit_blocks(self):
        self.assertEqual(self.run_hook(f"{ADD} w1", self.repo)[0], 0)
        git(self.repo, "worktree", "add", "-q", "-b", "w1", os.path.join(self.repo, "w1"))
        code, err = self.run_hook(f"{ADD} w2", self.repo)
        self.assertEqual(code, 2)
        self.assertIn("Предел worktree продукта — 1", err)
        self.assertIn("только если владелец разрешил", err)
        # Из linked worktree считается тот же репозиторий; ведущий cd тоже учитывается.
        self.assertEqual(self.run_hook(f"{ADD} w2", os.path.join(self.repo, "w1"))[0], 2)
        self.assertEqual(self.run_hook(f"cd {self.repo} && {ADD} w2", self.root)[0], 2)
        self.assertEqual(self.run_hook(f"WT_LIMIT_CHECK=0 {ADD} w2", self.repo)[0], 0)
        # Текст обхода не в начале команды — не обход (ревью #178); два пробела между словами — та же команда.
        self.assertEqual(self.run_hook(f"{ADD} w2  # WT_LIMIT_CHECK=0", self.repo)[0], 2)
        self.assertEqual(self.run_hook(f"echo WT_LIMIT_CHECK=0; {ADD} w2", self.repo)[0], 2)
        self.assertEqual(self.run_hook("git worktree  add w2", self.repo)[0], 2)

    def test_git_dash_c_checks_the_named_repo(self):
        """Ревью #178: `git -C <repo> worktree add` из другого репозитория — предел репозитория из -C."""
        git(self.repo, "worktree", "add", "-q", "-b", "w1", os.path.join(self.repo, "w1"))
        self.assertEqual(self.run_hook(f"git -C {self.repo} worktree add w2", self.other)[0], 2)
        self.assertEqual(self.run_hook(f"git -C {self.other} worktree add w2", self.repo)[0], 0)

    def test_other_commands_and_no_repo_are_silent(self):
        git(self.repo, "worktree", "add", "-q", "-b", "w1", os.path.join(self.repo, "w1"))
        self.assertEqual(self.run_hook("git worktree list", self.repo)[0], 0)
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, ignore_errors=True)
        self.assertEqual(self.run_hook(f"{ADD} x", empty)[0], 0)


if __name__ == "__main__":
    unittest.main()
