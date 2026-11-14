# -*- coding: utf-8 -*-
"""OPS-52: уборка worktree после мёржа — на настоящем git во временной папке (origin — голый репозиторий)."""
import contextlib
import io
import json
import os
import plistlib
import shutil
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
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # Свежий worktree «активен» (индекс изменён секунды назад): проверка активности — в отдельном тесте.
        self.addCleanup(setattr, wt_gc, "ACTIVE_S", wt_gc.ACTIVE_S)
        wt_gc.ACTIVE_S = 0
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
        git(self.repo, "remote", "set-head", "origin", "main")  # основная ветка — как у живых репозиториев

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
        self.assertIn("незакоммиченные изменения: 1", r["reason"])
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
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
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
        # Путь через ссылку (/var/… вместо /private/var/…) — сравнение по realpath всё равно его узнаёт.
        with open(plist, "wb") as fh:
            plistlib.dump({"Label": "job", "ProgramArguments": ["python3", f"{path}/eval/run.py"]}, fh)
        (r,) = wt_gc.gc_branch(self.repo, "feature/agents", cwds=set())
        self.assertIn("job.plist", r["reason"])
        os.remove(plist)
        self.assertTrue(wt_gc.gc_branch(self.repo, "feature/agents", cwds=set())[0]["removed"])

    def test_branch_cli_json_is_the_contract_nerve_reads(self):
        """Ревью #178: Нерв разбирает stdout `branch --json` — проверяем настоящий вывод, а не рукописный JSON."""
        self.wt("fix/cli")
        old = wt_gc.busy_paths, wt_gc.external_refs
        self.addCleanup(lambda: (setattr(wt_gc, "busy_paths", old[0]), setattr(wt_gc, "external_refs", old[1])))
        wt_gc.busy_paths, wt_gc.external_refs = (lambda: set()), (lambda: {})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(wt_gc.main(["wt_gc.py", "branch", self.repo, "fix/cli", "--json"]), 0)
        (r,) = json.loads(out.getvalue())
        self.assertEqual((r["branch"], r["removed"]), ("fix/cli", True))
        self.assertTrue(r["path"].endswith("worktrees/fix/cli"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            wt_gc.main(["wt_gc.py", "branch", self.repo, "fix/cli"])
        self.assertIn("нет worktree", out.getvalue())

    def test_sweep_removes_only_merged_branches(self):
        """Ревью #178: чистая и запушенная, но не влитая ветка остаётся — влитость решает sweep по списку gh."""
        merged, open_ = self.wt("fix/merged"), self.wt("fix/open")
        old = wt_gc.merged_prs, wt_gc.busy_paths, wt_gc.external_refs
        self.addCleanup(lambda: (setattr(wt_gc, "merged_prs", old[0]), setattr(wt_gc, "busy_paths", old[1]),
                                 setattr(wt_gc, "external_refs", old[2])))
        heads = {b: subprocess.run(["git", "rev-parse", "HEAD"], cwd=p, capture_output=True, text=True).stdout.strip()
                 for b, p in (("fix/merged", merged), ("fix/open", open_))}
        wt_gc.merged_prs = lambda repo: {"fix/merged": (heads["fix/merged"], "main"), "fix/gone": ("0" * 40, "main")}
        wt_gc.busy_paths, wt_gc.external_refs = (lambda: set()), (lambda: {})
        dry = wt_gc.sweep(self.repo, dry_run=True)
        self.assertEqual([(r["branch"], r["removed"]) for r in dry], [("fix/merged", False)])
        self.assertTrue(os.path.isdir(merged))
        res = wt_gc.sweep(self.repo)
        self.assertEqual([(r["branch"], r["removed"]) for r in res], [("fix/merged", True)])
        self.assertFalse(os.path.exists(merged))
        self.assertTrue(os.path.isdir(open_))

    def test_session_state_head_base_lsof_and_activity_keep_the_worktree(self):
        """Ревью #178 (две линзы, major): игнорируемое состояние сессии, чужая голова или база, сбой lsof, работа
        в последний час — worktree остаётся. Копии файлов основного checkout и сборка — не мешают."""
        open(os.path.join(self.repo, ".git", "info", "exclude"), "a").write(".ai/\n.env\nnode_modules/\n")
        open(os.path.join(self.repo, ".env"), "w").write("A=1\n")
        path = self.wt("fix/state")
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=path, capture_output=True, text=True).stdout.strip()
        os.makedirs(os.path.join(path, "node_modules", "x"))
        open(os.path.join(path, ".env"), "w").write("A=1\n")  # копия основного checkout
        os.makedirs(os.path.join(path, ".ai", "task", "T-1"))
        open(os.path.join(path, ".ai", "task", "T-1", "brief.md"), "w").write("дело\n")
        (r,) = wt_gc.gc_branch(self.repo, "fix/state", cwds=set(), refs={}, head=head, base="main")
        self.assertIn("игнорируемые файлы не из сборки: .ai/", r["reason"])
        shutil.rmtree(os.path.join(path, ".ai"))
        open(os.path.join(path, ".env"), "w").write("A=2\n")  # правленый .env — не копия
        (r,) = wt_gc.gc_branch(self.repo, "fix/state", cwds=set(), refs={}, head=head, base="main")
        self.assertIn(".env", r["reason"])
        open(os.path.join(path, ".env"), "w").write("A=1\n")
        self.assertIn("не голова влитого PR", wt_gc.gc_branch(self.repo, "fix/state", cwds=set(), refs={}, head="1" * 40)[0]["reason"])
        self.assertIn("не в основную ветку main", wt_gc.gc_branch(self.repo, "fix/state", cwds=set(), refs={}, head=head, base="feature/x")[0]["reason"])
        self.assertIn("lsof не ответил", wt_gc.gc_branch(self.repo, "fix/state", cwds=None, refs={}, head=head)[0]["reason"])
        wt_gc.ACTIVE_S = 3600
        self.assertIn("работали", wt_gc.gc_branch(self.repo, "fix/state", cwds=set(), refs={}, head=head)[0]["reason"])
        wt_gc.ACTIVE_S = 0
        self.assertTrue(wt_gc.gc_branch(self.repo, "fix/state", cwds=set(), refs={}, head=head, base="main")[0]["removed"])

    def test_empty_branch_and_git_failure_are_errors(self):
        with self.assertRaises(ValueError):
            wt_gc.gc_branch(self.repo, "", cwds=set(), refs={})
        self.assertEqual(wt_gc.main(["wt_gc.py", "branch", self.repo, ""]), 2)
        self.assertEqual(wt_gc.main(["wt_gc.py", "branch", os.path.join(self.tmp, "нет"), "fix/x"]), 1)

    def _limit(self, n):
        old = wt_gc.LIMIT
        self.addCleanup(setattr, wt_gc, "LIMIT", old)
        wt_gc.LIMIT = n
        self.addCleanup(os.environ.pop, "WT_LIMIT_ENFORCE_FROM", None)
        os.environ.pop("WT_LIMIT_ENFORCE_FROM", None)
        return os.path.join(self.repo, ".git", wt_gc.ARMED_FILE)

    def test_limit_blocks_once_armed(self):
        """Ниже предела метка взводится; дальше предел останавливает и до ENFORCE_FROM."""
        armed = self._limit(2)
        self.wt("f/1")
        self.assertEqual(wt_gc.limit_text(self.repo, today="2026-11-14"), (None, None))
        self.assertTrue(os.path.exists(armed))
        self.wt("f/2")
        self.assertEqual(wt_gc.count(self.repo), 2)
        mode, text = wt_gc.limit_text(self.repo, today="2026-11-14")
        self.assertEqual(mode, "block")
        self.assertIn("Предел worktree продукта — 2", text)
        self.assertEqual(wt_gc.main(["wt_gc.py", "check-limit", self.repo]), 3)

    def test_limit_warns_until_date_or_drop(self):
        """Решение владельца 14.11 (B): продукт выше предела — предупреждение до ENFORCE_FROM или до спуска к пределу."""
        armed = self._limit(1)
        self.wt("f/1")
        self.wt("f/2")
        self.assertFalse(os.path.exists(armed))  # проверок не было: продукт сразу выше предела
        mode, text = wt_gc.limit_text(self.repo, today="2026-11-14")
        self.assertEqual(mode, "warn")
        self.assertIn("Предупреждение", text)
        self.assertIn("20.11", text)
        self.assertFalse(os.path.exists(armed))
        self.assertEqual(wt_gc.limit_text(self.repo, today=wt_gc.ENFORCE_FROM)[0], "block")
        # Переменная окружения только приближает дату остановки.
        os.environ["WT_LIMIT_ENFORCE_FROM"] = "2026-12-31"
        self.assertEqual(wt_gc.limit_text(self.repo, today="2026-11-14")[0], "warn")
        os.environ["WT_LIMIT_ENFORCE_FROM"] = "2026-11-01"
        self.assertEqual(wt_gc.main(["wt_gc.py", "check-limit", self.repo]), 3)
        del os.environ["WT_LIMIT_ENFORCE_FROM"]
        # Продукт спустился до предела — метка взведена, после роста — остановка.
        git(self.repo, "worktree", "remove", os.path.join(self.repo, "worktrees", "f/2"))
        self.assertEqual(wt_gc.limit_text(self.repo, today="2026-11-14")[0], "block")
        self.assertTrue(os.path.exists(armed))


if __name__ == "__main__":
    unittest.main()
