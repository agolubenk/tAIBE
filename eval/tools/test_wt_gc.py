# -*- coding: utf-8 -*-
"""OPS-52: уборка worktree после мёржа — на настоящем git во временной папке (origin — голый репозиторий)."""
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wt_gc  # noqa: E402


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


class WtGcTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.origin = os.path.join(self.tmp, "origin.git")
        self.repo = os.path.join(self.tmp, "repo")
        git(self.tmp, "init", "-q", "--bare", "-b", "main", self.origin)
        git(self.tmp, "clone", "-q", self.origin, self.repo)
        for k, v in (("user.email", "t@example.com"), ("user.name", "t"), ("commit.gpgsign", "false")):
            git(self.repo, "config", k, v)
        open(os.path.join(self.repo, "a.txt"), "w").write("a\n")
        git(self.repo, "add", "a.txt")
        git(self.repo, "commit", "-q", "-m", "init")
        git(self.repo, "push", "-q", "origin", "main")

    def wt(self, branch, push=True, extra_commit=False):
        path = os.path.join(self.repo, "worktrees", branch)
        git(self.repo, "worktree", "add", "-q", "-b", branch, path)
        open(os.path.join(path, f"{branch.replace('/', '_')}.txt"), "w").write("x\n")
        git(path, "add", ".")
        git(path, "commit", "-q", "-m", branch)
        if push:
            git(path, "push", "-q", "origin", branch)
        if extra_commit:
            open(os.path.join(path, "later.txt"), "w").write("y\n")
            git(path, "add", ".")
            git(path, "commit", "-q", "-m", "после пуша")
        return path

    def test_clean_pushed_worktree_is_removed_and_branch_stays(self):
        path = self.wt("fix/done")
        # Игнорируемое (node_modules) не мешает и уходит вместе с копией.
        open(os.path.join(self.repo, ".git", "info", "exclude"), "a").write("node_modules/\n")
        os.makedirs(os.path.join(path, "node_modules", "x"))
        res = wt_gc.gc_branch(self.repo, "fix/done", cwds=set(), refs={})
        self.assertEqual([r["removed"] for r in res], [True])
        self.assertFalse(os.path.exists(path))
        out = subprocess.run(["git", "branch", "--list", "fix/done"], cwd=self.repo, capture_output=True, text=True).stdout
        self.assertIn("fix/done", out)

    def test_dirty_unpushed_busy_are_kept_with_reason(self):
        dirty = self.wt("fix/dirty")
        open(os.path.join(dirty, "a.txt"), "w").write("правка\n")
        self.wt("fix/local", push=False)
        self.wt("fix/after", extra_commit=True)
        busy = self.wt("fix/busy")
        reasons = {}
        for b in ("fix/dirty", "fix/local", "fix/after", "fix/busy"):
            (r,) = wt_gc.gc_branch(self.repo, b, cwds={os.path.join(busy, "apps")}, refs={})
            self.assertFalse(r["removed"], b)
            reasons[b] = r["reason"]
        self.assertIn("незакоммиченные", reasons["fix/dirty"])
        self.assertIn("нет на remote", reasons["fix/local"])
        self.assertIn("нет на remote", reasons["fix/after"])
        self.assertIn("процесс", reasons["fix/busy"])
        self.assertTrue(os.path.isdir(dirty) and os.path.isdir(busy))

    def test_branch_without_worktree_and_untracked_file(self):
        self.assertEqual(wt_gc.gc_branch(self.repo, "fix/none", cwds=set(), refs={}), [])
        path = self.wt("fix/untracked")
        open(os.path.join(path, "notes.md"), "w").write("черновик\n")
        (r,) = wt_gc.gc_branch(self.repo, "fix/untracked", cwds=set(), refs={})
        self.assertFalse(r["removed"])
        self.assertTrue(os.path.exists(os.path.join(path, "notes.md")))

    def test_worktree_with_external_consumer_is_kept(self):
        """13.11: ссылки агентов opencode вели в влитой worktree — после его удаления ревью встало."""
        path = self.wt("feature/agents")
        os.makedirs(os.path.join(path, "agents"))
        open(os.path.join(path, "agents", "a.md"), "w").write("x\n")
        git(path, "add", ".")
        git(path, "commit", "-q", "-m", "agents")
        git(path, "push", "-q", "origin", "feature/agents")
        home = tempfile.mkdtemp()
        os.makedirs(os.path.join(home, "cfg", "opencode", "agents"))
        os.symlink(os.path.join(path, "agents", "a.md"), os.path.join(home, "cfg", "opencode", "agents", "a.md"))
        old = wt_gc.CONSUMER_LINK_DIRS, wt_gc.CONSUMER_FILE_GLOBS
        self.addCleanup(lambda: (setattr(wt_gc, "CONSUMER_LINK_DIRS", old[0]), setattr(wt_gc, "CONSUMER_FILE_GLOBS", old[1])))
        wt_gc.CONSUMER_LINK_DIRS = (os.path.join(home, "cfg"),)
        plist = os.path.join(home, "job.plist")
        wt_gc.CONSUMER_FILE_GLOBS = (plist,)
        (r,) = wt_gc.gc_branch(self.repo, "feature/agents", cwds=set())
        self.assertFalse(r["removed"])
        self.assertIn("ссылается", r["reason"])
        # Задача launchd с путём внутрь worktree — тоже потребитель.
        os.remove(os.path.join(home, "cfg", "opencode", "agents", "a.md"))
        open(plist, "w").write(f"<string>{os.path.realpath(path)}/eval/run.py</string>\n")
        (r,) = wt_gc.gc_branch(self.repo, "feature/agents", cwds=set())
        self.assertIn("job.plist", r["reason"])
        os.remove(plist)
        self.assertTrue(wt_gc.gc_branch(self.repo, "feature/agents", cwds=set())[0]["removed"])

    def test_limit(self):
        old = wt_gc.LIMIT
        self.addCleanup(setattr, wt_gc, "LIMIT", old)
        wt_gc.LIMIT = 2
        self.wt("f/1")
        self.assertIsNone(wt_gc.limit_text(self.repo))
        self.wt("f/2")
        self.assertEqual(wt_gc.count(self.repo), 2)
        self.assertIn("Предел worktree продукта — 2", wt_gc.limit_text(self.repo) or "")
        self.assertEqual(wt_gc.main(["wt_gc.py", "check-limit", self.repo]), 3)


if __name__ == "__main__":
    unittest.main()
