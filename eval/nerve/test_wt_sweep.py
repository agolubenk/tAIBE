"""OPS-81: повторная уборка worktree влитых PR раз в час — в проходе GitHub, по одному вызову wt_gc.py sweep."""
import json
import os
import sys
import tempfile
import unittest
from datetime import timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gh_source  # noqa: E402
import sources  # noqa: E402
import wt_sweep  # noqa: E402
from journal import read_from  # noqa: E402
from test_nerve import CFG, FakeCtx, FakeGh, _pr  # noqa: E402

SWEEP_CFG = dict(CFG, repo_root="/r", github=dict(CFG["github"], wt_sweep_minutes=60))


class Sweeper:
    """Подмена sources.run: wt_gc.py sweep отвечает ответами по очереди (список словарей или исключение)."""

    def __init__(self, *answers, gh=None):
        self.answers, self.calls, self.gh = list(answers), [], gh

    def __call__(self, cmd, timeout=None, **kw):
        if "wt_gc.py" not in " ".join(cmd):
            return self.gh(cmd, timeout=timeout, **kw)
        self.calls.append(cmd)
        a = self.answers.pop(0) if self.answers else []
        if isinstance(a, Exception):
            raise a
        return (0, json.dumps(a), "") if isinstance(a, list) else a


class SweepTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.ctx = FakeCtx(self.d)
        self.ctx.cfg = SWEEP_CFG
        run = sources.run
        self.addCleanup(setattr, sources, "run", run)

    def events(self):
        return [(r["key"], r["to"], r["text"]) for r in read_from(os.path.join(self.d, "j.jsonl"), 0)[0]]

    def sweep(self, run, after=timedelta(0), branches=()):
        sources.run = run
        self.ctx.now += after
        wt_sweep.poll(self.ctx, set(branches))

    def test_kept_for_fresh_work_is_removed_next_hour(self):
        """Приёмка 1: оставленный «работали N мин назад» уходит следующим проходом после окна в 1 ч."""
        kept = {"path": "/r/worktrees/fix/a", "branch": "fix/a", "removed": False, "reason": "в нём работали 5 мин назад",
                "pr": 7}
        run = Sweeper([kept], [dict(kept, removed=True)])
        self.sweep(run)
        self.sweep(run, timedelta(minutes=30))          # окно не прошло — вызова нет
        self.assertEqual(len(run.calls), 1)
        self.sweep(run, timedelta(minutes=31))
        self.assertEqual(len(run.calls), 2)
        self.assertEqual([(to, t) for _, to, t in self.events()], [
            (["coord"], "#7 влит, worktree /r/worktrees/fix/a оставлен — в нём работали 5 мин назад"),
            ([], "#7: worktree /r/worktrees/fix/a удалён повторной уборкой")])

    def test_kept_worktree_reaches_coord_once(self):
        """Приёмка 2: грязный и ушедший дальше головы worktree остаются; координатору одно событие, без повторов, и не
        второе после отказа сразу после мёржа (тот же ключ, что у gh_source._gc_worktree)."""
        self.ctx.emit("wt:gc:8:/r/worktrees/fix/b", "wt.gc", "digest", ["coord"], "#8 влит, … оставлен", "github")
        dirty = {"path": "/r/worktrees/fix/b", "branch": "fix/b", "removed": False, "reason": "незакоммиченные изменения: 2",
                 "pr": 8}
        ahead = {"path": "/r/worktrees/fix/c", "branch": "fix/c", "removed": False, "pr": 9,
                 "reason": "HEAD 1111111 — не голова влитого PR (2222222): работа продолжилась или ветку взяли заново"}
        run = Sweeper([dirty, ahead], [dirty, ahead], [dirty, ahead])
        for h in range(3):
            self.sweep(run, timedelta(hours=1) if h else timedelta(0))
        self.assertEqual(len(run.calls), 3)
        coord = [k for k, to, _ in self.events() if to == ["coord"]]
        self.assertEqual(coord, ["wt:gc:8:/r/worktrees/fix/b", "wt:gc:9:/r/worktrees/fix/c"])

    def test_command_skips_open_branches_and_bounds_the_pass(self):
        run = Sweeper([])
        self.sweep(run, branches={"fix/open", "feat/x"})
        (cmd,) = run.calls
        self.assertEqual(cmd[3:5], ["sweep", "/r"])
        self.assertEqual([cmd[i + 1] for i, a in enumerate(cmd) if a == "--skip"], ["feat/x", "fix/open"])
        self.assertIn("--budget", cmd)
        self.assertEqual(cmd[cmd.index("--limit") + 1], str(wt_sweep.LIMIT))

    def test_failure_reaches_coord_once_a_day_and_waits_an_hour(self):
        run = Sweeper(TimeoutError("300 s"), (1, "", "gh pr list не ответил"), [])
        self.sweep(run)
        self.sweep(run, timedelta(minutes=10))   # сбой тоже ставит время: повтор — через час
        self.assertEqual(len(run.calls), 1)
        self.sweep(run, timedelta(hours=1))
        self.assertEqual(len(run.calls), 2)
        fails = [t for k, to, t in self.events() if k.startswith("wt:sweep:fail:")]
        self.assertEqual(len(fails), 1)
        self.assertIn("300 s", fails[0])

    def test_off_without_repo_root_or_with_zero_or_bad_minutes(self):
        run = Sweeper([])
        off = [dict(SWEEP_CFG, github=dict(SWEEP_CFG["github"], wt_sweep_minutes=v)) for v in (0, "60", None, True, -5)]
        for cfg in off + [dict(SWEEP_CFG, repo_root="")]:
            self.ctx.cfg = cfg
            self.sweep(run)
        self.assertEqual(run.calls, [])

    def test_github_pass_passes_open_branches(self):
        """Проход GitHub зовёт уборку со списком веток открытых PR этого же прохода — без нового вызова gh."""
        gh = FakeGh([dict(_pr(470, "a" * 40), branch="fix/open", base="main"), _pr(471, "b" * 40)])
        run = Sweeper([], gh=gh)
        sources.run = run
        gh_source.poll_github(self.ctx)
        (cmd,) = run.calls
        self.assertEqual([cmd[i + 1] for i, a in enumerate(cmd) if a == "--skip"], ["fix/open"])
        self.assertTrue(all(c[0] == "gh" for c in gh.calls), "уборка идёт мимо FakeGh: своих вызовов gh в проходе нет")
        sources.run = Sweeper(gh=gh)
        gh_source.poll_github(self.ctx)          # тот же час — уборки нет
        self.assertEqual(sources.run.calls, [])


if __name__ == "__main__":
    unittest.main()
