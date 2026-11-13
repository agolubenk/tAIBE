#!/usr/bin/env python3
"""`nightly` order (SE-49): last night's PRs first, then the refresh, then the fresh cycle.

The merge at the end of a cycle meets its own fresh PR with CI still running («not green»), so a data PR could join
the base only after the next night's run: its cases were judged a night late, and its `supersedes` lines were not in
the refreshed worktree when the next merge read the verdicts. `nightly` now runs the merge step before the refresh.
"""
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

    def test_gh_and_fetch_give_up_after_the_timeout(self):
        with self.assertRaisesRegex(RuntimeError, 'no answer in 60 s'):
            g.gh('/repo', 'api', 'user')
        with self.assertRaisesRegex(RuntimeError, 'no answer in 60 s'):
            g.git('/repo', 'fetch', '--quiet', 'origin', 'board-agents', check=False)
        self.assertEqual(self.seen, [(['gh', 'api'], g.NET_TIMEOUT_S), (['git', '-C'], g.NET_TIMEOUT_S)])

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


if __name__ == '__main__':
    unittest.main()
