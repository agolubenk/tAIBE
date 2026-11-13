#!/usr/bin/env python3
"""`nightly` order (SE-49): last night's PRs first, then the refresh, then the fresh cycle.

The merge at the end of a cycle meets its own fresh PR with CI still running («not green»), so a data PR could join
the base only after the next night's run: its cases were judged a night late, and its `supersedes` lines were not in
the refreshed worktree when the next merge read the verdicts. `nightly` now runs the merge step before the refresh.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import daily  # noqa: E402
import daily_git as g  # noqa: E402


class NetTimeoutTest(unittest.TestCase):
    """The step now runs under `run.lock` before the night's work: a hung network call must fail it, not hold the
    lock (LOCK_NB would refuse the next `nightly` and `cycle --force` until someone kills the process)."""

    def hang(self, cmd, **kw):
        self.seen.append((cmd[:2], kw.get('timeout')))
        raise subprocess.TimeoutExpired(cmd, kw.get('timeout'))

    def setUp(self):
        self.seen = []
        patcher = mock.patch.object(g.subprocess, 'run', self.hang)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_gh_fetch_and_push_give_up_after_the_timeout(self):
        with self.assertRaisesRegex(RuntimeError, 'no answer in 60 s'):
            g.gh('/repo', 'api', 'user')
        with self.assertRaisesRegex(RuntimeError, 'no answer in 60 s'):
            g.git('/repo', 'fetch', '--quiet', 'origin', 'board-agents', check=False)
        with self.assertRaisesRegex(RuntimeError, 'no answer in 60 s'):
            g.git('/repo', 'push', '--quiet', 'origin', 'abc:refs/heads/evolve/x')
        self.assertEqual(self.seen, [(['gh', 'api'], g.NET_TIMEOUT_S)] + [(['git', '-C'], g.NET_TIMEOUT_S)] * 2)

    def test_local_git_has_no_timeout(self):
        with self.assertRaises(subprocess.TimeoutExpired):  # the fake hangs; a local command gets no deadline
            g.git('/repo', 'rev-parse', 'HEAD')
        self.assertEqual(self.seen, [(['git', '-C'], None)])


class NightlyOrderTest(unittest.TestCase):
    def run_nightly(self, step_error=None):
        calls = []

        def first_step(args):
            calls.append('merge-step')
            if step_error:
                raise step_error

        def run(cmd, **kw):
            calls.append(cmd[3])
            return subprocess.CompletedProcess(cmd, 0)

        with mock.patch.object(daily, 'STATE_DIR', tempfile.mkdtemp()), \
                mock.patch.object(daily.g, 'main_repo', lambda *a: '/repo'), \
                mock.patch.object(daily, 'cmd_merge', first_step), \
                mock.patch.object(daily.g, 'refresh_worktree', lambda *a: calls.append('refresh')), \
                mock.patch.object(daily, 'log', lambda *a: calls.append('log')), \
                mock.patch.object(daily.subprocess, 'run', run):
            code = daily.main(['nightly', '--worktree', 'wt'])
        return code, calls

    def test_last_nights_prs_go_before_the_refresh(self):
        self.assertEqual(self.run_nightly(), (0, ['merge-step', 'refresh', 'cycle']))

    def test_a_failed_step_costs_nothing(self):
        self.assertEqual(self.run_nightly(RuntimeError('gh down')), (0, ['merge-step', 'log', 'refresh', 'cycle']))


class KeptSupersedesTest(unittest.TestCase):
    """A brak mark outlives the refresh: the session of night N writes `supersedes V` into the worktree, the data PR
    with it has not merged, night N+1 refreshes the worktree, and the revert PR of V must still not merge."""

    def merge_with(self, lines):
        path = os.path.join(self.dir, 'verdicts.jsonl')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(''.join(json.dumps(v) + '\n' for v in lines))
        got = []
        with mock.patch.object(daily.g, 'main_repo', lambda *a: '/repo'), \
                mock.patch.object(daily, 'merge_switch', lambda *a: True), \
                mock.patch.object(daily.g, 'merge_ready', lambda repo, base, verdicts, *a: got.append(verdicts) or []), \
                mock.patch('builtins.print'):
            daily.cmd_merge(argparse.Namespace(verdicts=path, dry_run=False))
        return got[0]

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        patcher = mock.patch.object(daily.steps, 'STATE_DIR', self.dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_mark_survives_the_refresh(self):
        base = [{'id': 'V', 'status': 'accepted'}]
        revert_pr = 'evolve: revert\n\nevolve-verdict: V\n'
        night_n = self.merge_with(base + [{'supersedes': 'V', 'status': 'brak'}])
        self.assertTrue(g.superseded(night_n, revert_pr))
        after_refresh = self.merge_with(base)  # checkout --force: the line is gone from the worktree
        self.assertTrue(g.superseded(after_refresh, revert_pr))
        self.assertFalse(g.superseded(after_refresh, 'evolve-verdict: W\n'))

    def test_no_mark_writes_nothing(self):
        self.merge_with([{'id': 'V', 'status': 'accepted'}])
        self.assertFalse(os.path.exists(os.path.join(self.dir, 'supersedes.json')))


if __name__ == '__main__':
    unittest.main()
