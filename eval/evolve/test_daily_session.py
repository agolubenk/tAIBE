#!/usr/bin/env python3
"""SE-81: the night session writes runs/session-latest.json on every exit after it started — a timeout and a spent
quota also cost dollars, and the Nerve names such a session «без $» instead of dropping it. Fake session only: no test
starts Claude.
Run: python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'"""
import argparse
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
import daily_git as g  # noqa: E402
import daily_session as session  # noqa: E402
import daily_steps as steps  # noqa: E402

ARGS = argparse.Namespace(worktree='wt', dry_run=False, no_card=True)


class SessionRecordTest(unittest.TestCase):
    def setUp(self):
        self.root, self.state = tempfile.mkdtemp(), tempfile.mkdtemp()
        self.patches = [mock.patch.object(steps, 'STATE_DIR', self.state),
                        mock.patch.object(steps, 'log', lambda *a: None),
                        mock.patch.object(steps, 'switch', lambda *a, **k: True),
                        mock.patch.object(g, 'main_repo', lambda p: self.root),
                        mock.patch.object(session, 'build_input', lambda *a: {}),
                        mock.patch.object(session, 'session_command', lambda prompt: ['claude', '-p', prompt])]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.root)
        shutil.rmtree(self.state)

    def run_session(self, run):
        with mock.patch.object(session.subprocess, 'run', run):
            self.assertEqual(session.cmd_session(ARGS), 0)
        with open(os.path.join(self.state, 'runs', 'session-latest.json'), encoding='utf-8') as f:
            return json.load(f)

    def test_a_timeout_is_recorded_without_usd(self):
        def run(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, kw.get('timeout'))
        s = self.run_session(run)
        self.assertEqual((s['exit'], s['usd']), ('timeout', None))
        self.assertTrue(s['finished'].endswith('+00:00'))

    def test_a_spent_quota_is_recorded_with_the_usd_it_reports(self):
        out = json.dumps({'is_error': True, 'result': "You've hit your limit", 'total_cost_usd': 0.42})
        s = self.run_session(lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, out, ''))
        self.assertEqual((s['exit'], s['usd'], s['comment']), (1, 0.42, 'quota spent'))

    def test_a_finished_session_is_recorded_with_usd(self):
        out = json.dumps({'result': 'one line', 'total_cost_usd': 1.25})
        s = self.run_session(lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, out, ''))
        self.assertEqual((s['exit'], s['usd'], s['comment']), (0, 1.25, 'not posted: --no-card'))

    def test_automation_off_writes_nothing(self):
        with mock.patch.object(steps, 'switch', lambda *a, **k: False):
            self.assertEqual(session.cmd_session(ARGS), 0)
        self.assertFalse(os.path.exists(os.path.join(self.state, 'runs', 'session-latest.json')))


if __name__ == '__main__':
    unittest.main()
