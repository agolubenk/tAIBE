"""The nightly context audit (d-f63b-economy-0711, item 4): `layer_metrics` runs the run worktree's context_audit.py
over the last 24 h, keeps the JSON in runs/ (30 nights) and reports money, cold causes and generations.

Run: python3 -I -m unittest discover -s eval/evolve -p 'test_daily_audit.py'
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import daily_steps as steps  # noqa: E402

STUB = '''import json, sys
args = sys.argv[1:]
assert args[:3] == ['--hours', '24', '--all'], args
json.dump({'total': 12.5, 'cold': {'ToolSearch': {'n': 2, 'usd': 3.14159}},
           'generations': {'> 500K': {'sessions': 1}}}, open(args[args.index('--json') + 1], 'w'))
'''


class NightlyContextAuditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.wt = os.path.join(self.tmp.name, 'wt')
        self.state = os.path.join(self.tmp.name, 'state')
        os.makedirs(os.path.join(self.wt, 'eval', 'tools'))
        patcher = mock.patch.object(steps, 'STATE_DIR', self.state)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_summary_and_file(self):
        with open(os.path.join(self.wt, 'eval', 'tools', 'context_audit.py'), 'w') as f:
            f.write(STUB)
        out = steps.context_audit(self.wt)
        self.assertEqual(out['exit'], 0)
        self.assertEqual(out['usd'], 12.5)
        self.assertEqual(out['cold'], {'ToolSearch': {'n': 2, 'usd': 3.14}})
        self.assertEqual(out['generations'], {'> 500K': {'sessions': 1}})
        with open(out['file'], encoding='utf-8') as f:
            self.assertEqual(json.load(f)['total'], 12.5)

    def test_keeps_thirty_nights(self):
        with open(os.path.join(self.wt, 'eval', 'tools', 'context_audit.py'), 'w') as f:
            f.write(STUB)
        runs = os.path.join(self.state, 'runs')
        os.makedirs(runs)
        for day in range(1, 41):
            open(os.path.join(runs, 'context-audit-202601%02d.json' % day if day < 32 else
                              'context-audit-202602%02d.json' % (day - 31)), 'w').close()
        steps.context_audit(self.wt)
        left = [n for n in os.listdir(runs) if n.startswith('context-audit-')]
        self.assertEqual(len(left), steps.AUDIT_KEEP)
        self.assertNotIn('context-audit-20260101.json', left)

    def test_a_failed_second_run_does_not_report_the_first(self):
        tools = os.path.join(self.wt, 'eval', 'tools', 'context_audit.py')
        with open(tools, 'w') as f:
            f.write(STUB)
        self.assertEqual(steps.context_audit(self.wt)['usd'], 12.5)
        with open(tools, 'w') as f:
            f.write('import sys; sys.exit("boom")')
        out = steps.context_audit(self.wt)
        self.assertNotIn('usd', out)
        self.assertEqual(steps.audit_line(out, 'd'), '')

    def test_timeout_does_not_break_the_night(self):
        with open(os.path.join(self.wt, 'eval', 'tools', 'context_audit.py'), 'w') as f:
            f.write(STUB)
        with mock.patch.object(steps.subprocess, 'run', side_effect=steps.subprocess.TimeoutExpired('x', 600)):
            out = steps.context_audit(self.wt)
        self.assertIsNone(out['exit'])
        self.assertIn('600', out['error'])

    def test_audit_line_for_the_card(self):
        audit = {'usd': 597.0, 'cold': {'ToolSearch': {'n': 42, 'usd': 73.0}, 'старт': {'n': 78, 'usd': 17.7}},
                 'generations': {'≤ 250K': {'handoff_share': 0.22, 'call_usd': 0.05, 'life_min': 21.0},
                                 '> 500K': {'handoff_share': None, 'call_usd': 0.139, 'life_min': 706.8}}}
        line = steps.audit_line(audit, '2026-11-08')
        self.assertEqual(line, 'контекст 2026-11-08, 24 ч: $597; холодные вызовы $91 (15 %), больше всего — '
                               'ToolSearch $73; окна: ≤ 250K — передача 22 %, ход $0.05, жизнь 21 мин; '
                               '> 500K — передача —, ход $0.14, жизнь 707 мин')
        import guard
        self.assertEqual(guard.scan(line), [])
        self.assertEqual(steps.audit_line({'usd': 3.0}, 'd'), 'контекст d, 24 ч: $3; холодные вызовы $0 (0 %); окна: —')
        for empty in (None, 'skipped: old revision', {'exit': 1, 'error': 'x'}, {'usd': 0}):
            self.assertEqual(steps.audit_line(empty, 'd'), '')

    def test_old_revision_and_failure(self):
        self.assertIn('skipped', steps.context_audit(self.wt))
        with open(os.path.join(self.wt, 'eval', 'tools', 'context_audit.py'), 'w') as f:
            f.write('import sys; sys.exit("boom")')
        out = steps.context_audit(self.wt)
        self.assertEqual(out['exit'], 1)
        self.assertIn('boom', out['error'])


if __name__ == '__main__':
    unittest.main()
