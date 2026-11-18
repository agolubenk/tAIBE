"""The nightly GL-1 spend (plan v1.1 on the GL-1 card, PR 3): `layer_metrics` runs the run worktree's spend.py over
yesterday with attribution, keeps the JSON in spend/ (60 days), and `spend_nerve` sends the day's one line to the
tAIBE coordinator through the main checkout's Nerve.

Run: python3 -I -m unittest discover -s eval/evolve -p 'test_daily_spend.py'
"""
import datetime
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import daily  # noqa: E402
import daily_git as g  # noqa: E402
import daily_steps as steps  # noqa: E402
from test_daily_open_pr import RepoTest, fake_gh, pr_list  # noqa: E402

REPORT = {'usd': 1000.0, 'calls': 9000, 'sessions': 30, 'merged': {'agolubenk/tAIBE': 10, 'agolubenk/HR_Helper-v2': 15},
          'attribution': [{'kind': 'pr', 'usd': 560.0}, {'kind': 'pr', 'usd': 4.0}, {'kind': 'task', 'usd': 50.0},
                          {'kind': 'unattributed', 'usd': 386.0}],
          'by_product': [{'day': '2026-11-17', 'product': 'taibe', 'usd': 610.0},
                         {'day': '2026-11-17', 'product': 'hr-helper', 'usd': 370.0},
                         {'day': '2026-11-17', 'product': 'unattributed', 'usd': 20.0}],
          'bands': {'≤ 250K': {'calls': 1, 'usd': 700.0}, '250–500K': {'calls': 1, 'usd': 200.0},
                    '500K–1M': {'calls': 1, 'usd': 100.0}, '> 1M': {'calls': 0, 'usd': 0.0}},
          'ctx_median': 121_400, 'ctx_p90': 262_000}
FAIL_LINE = 'GL-1 расход 17.11: метрика не посчитана — %s; подробности — в отчёте ночи (runs/latest.json)'
LINE = ('GL-1 расход 17.11: $1000, вызовов 9000, сессий 30; $ на влитый PR — $40 (25 PR), цель ≈ $20; '
        'PR / карточки / не отнесено — 56 / 5 / 39 %; продукты: taibe 61 % · hr-helper 37 % · не отнесено 2 % '
        '(решение 60/40); контекст вызова — медиана 121K, p90 262K (справочно); '
        'доля $ по полосам окна ≤ 250K / 250–500K / 500K–1M / > 1M — 70 / 20 / 10 / 0 %')
STUB = '''import json, sys
args = sys.argv[1:]
open(sys.argv[0] + '.args', 'w').write(json.dumps(args))
PRE
json.dump(%s, open(args[args.index('--json') + 1], 'w'))
''' % json.dumps(REPORT, ensure_ascii=False)


class NightlySpendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.wt = os.path.join(self.tmp.name, 'wt')
        self.state = os.path.join(self.tmp.name, 'state')
        self.tool = os.path.join(self.wt, 'eval', 'tools', 'spend.py')
        os.makedirs(os.path.dirname(self.tool))
        patcher = mock.patch.object(steps, 'STATE_DIR', self.state)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_tool(self, pre='pass'):
        with open(self.tool, 'w', encoding='utf-8') as f:
            f.write(STUB.replace('PRE', pre))

    def test_yesterday_with_attribution_and_the_file_kept(self):
        self.write_tool()
        today = datetime.datetime(2026, 11, 18, 5, 0).astimezone()
        with mock.patch.object(steps, 'now', lambda: today):
            out = steps.spend_night(self.wt)
        path = os.path.join(self.state, 'spend', '2026-11-17.json')
        with open(self.tool + '.args', encoding='utf-8') as f:
            self.assertEqual(json.load(f), ['2026-11-17 00:00', '2026-11-18 00:00', '--attribution', '--json', path])
        self.assertEqual((out['exit'], out['file'], out['day'], out['usd'], out['merged'], out['per_pr']),
                         (0, path, '2026-11-17', 1000.0, 25, 40.0))
        self.assertEqual(out['targets'], {'pr': 0.564, 'task': 0.05, 'unattributed': 0.386})
        self.assertTrue(os.path.isfile(path))

    def test_keeps_the_last_sixty_days(self):
        self.write_tool()
        folder = os.path.join(self.state, 'spend')
        os.makedirs(folder)
        old = [os.path.join(folder, '2026-09-%02d.json' % d) for d in range(1, 31)] + \
              [os.path.join(folder, '2026-10-%02d.json' % d) for d in range(1, 32)]
        for p in old:
            open(p, 'w').close()
        steps.spend_night(self.wt, datetime.date(2026, 11, 17))
        kept = sorted(os.listdir(folder))
        self.assertEqual(len(kept), steps.SPEND_KEEP)
        self.assertEqual((kept[0], kept[-1]), ('2026-09-03.json', '2026-11-17.json'))

    def test_failure_and_missing_tool_do_not_raise(self):
        self.assertEqual(steps.spend_night(self.wt), {'skipped': 'eval/tools/spend.py is not in this revision'})
        self.write_tool('sys.exit(3)')
        out = steps.spend_night(self.wt, datetime.date(2026, 11, 17))
        self.assertEqual((out['exit'], out['day']), (3, '2026-11-17'))
        self.assertEqual(steps.spend_line(out), FAIL_LINE % 'сбой инструмента (exit 3)')  # #485, product
        self.assertEqual(steps.spend_line({'exit': None, 'error': 'timed out'}),
                         FAIL_LINE.replace('17.11', '—') % 'сбой инструмента')

    def test_layer_metrics_carries_the_spend(self):
        with mock.patch.object(steps, 'subprocess') as sp, \
                mock.patch.object(steps, 'context_audit', lambda wt: {}), \
                mock.patch.object(steps, 'spend_night', lambda wt: {'usd': 1.0}):
            sp.run.return_value = mock.Mock(stdout='не JSON', stderr='', returncode=1)
            sp.TimeoutExpired = TimeoutError
            self.assertEqual(steps.layer_metrics(self.wt)['spend'], {'usd': 1.0})

    def test_a_report_of_another_form_is_an_error_not_the_end_of_the_night(self):  # #478, Control N1
        forms = {'attribution without kind': dict(REPORT, attribution=[{'usd': 1.0}]),
                 'by_product without product': dict(REPORT, by_product=[{'usd': 1.0}]),
                 'merged as a list': dict(REPORT, merged=[1, 2]),
                 'ctx_median as text': dict(REPORT, ctx_median='12K'),  # #485 backend B1
                 'ctx_p90 as text': dict(REPORT, ctx_p90='262K'),
                 'ctx_median NaN': dict(REPORT, ctx_median=float('nan')),
                 'usd inf': dict(REPORT, usd=float('inf')),
                 'merged count as text': dict(REPORT, merged={'r': '3'}),
                 'usd as text': dict(REPORT, usd='1000'),
                 'a list': [REPORT]}
        for why, rep in forms.items():
            with self.subTest(why):
                with open(self.tool, 'w', encoding='utf-8') as f:
                    f.write('import json, sys\n'
                            'json.dump(json.loads(%r), open(sys.argv[sys.argv.index("--json") + 1], "w"))\n'
                            % json.dumps(rep))
                out = steps.spend_night(self.wt, datetime.date(2026, 11, 17))
                self.assertEqual((out['exit'], out['day']), (0, '2026-11-17'))
                self.assertIn('report of another form', out['error'])
                self.assertNotIn('usd', out)
                self.assertEqual(steps.spend_line(out), FAIL_LINE % 'отчёт другой формы')  # a line, no sum

    def test_one_metric_fails_alone(self):  # #478, Control N1: one failed metric never stops the night
        open(os.path.join(self.wt, 'eval', 'tools', 'ctx_budget.py'), 'w').close()
        answers = [mock.Mock(stdout='{"l1": 1}', stderr='', returncode=0), TimeoutError('dupes hung'),
                   OSError('no python')]
        with mock.patch.object(steps, 'subprocess') as sp, \
                mock.patch.object(steps, 'context_audit', lambda wt: {}), \
                mock.patch.object(steps, 'spend_night', lambda wt: {'usd': 1.0}):
            sp.TimeoutExpired = TimeoutError
            sp.run.side_effect = answers
            out = steps.layer_metrics(self.wt)
        self.assertIn('report of another form: AttributeError', out['catalog']['error'])
        self.assertEqual(out['dupes'], {'error': 'dupes hung'})
        self.assertEqual(out['ctx_budget'], {'exit': None, 'error': 'no python'})
        self.assertEqual(out['spend'], {'usd': 1.0})


class SpendLineTest(unittest.TestCase):
    def test_line(self):
        self.assertEqual(steps.spend_line(dict(steps.spend_summary(REPORT), day='2026-11-17')), LINE)

    def test_no_merged_pr_and_no_attribution(self):
        line = steps.spend_line(dict(steps.spend_summary(dict(REPORT, merged={}, attribution=[])), day='2026-11-17'))
        self.assertIn('$ на влитый PR — нет влитых PR, цель ≈ $20', line)
        self.assertIn('PR / карточки / не отнесено — 0 / 0 / 0 %', line)

    def test_no_money_no_line(self):
        for s in (None, {}, {'usd': 0}, steps.spend_summary({}), 'x'):
            with self.subTest(s):
                self.assertEqual(steps.spend_line(s), '')


class SpendNerveTest(unittest.TestCase):
    def setUp(self):
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        patcher = mock.patch.object(steps, 'STATE_DIR', state.name)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_emit_through_the_main_checkout(self):
        with tempfile.TemporaryDirectory() as repo:
            nerve = os.path.join(repo, 'eval', 'nerve', 'nerve.py')
            os.makedirs(os.path.dirname(nerve))
            with open(nerve, 'w', encoding='utf-8') as f:
                f.write('import json, os, sys\nopen(os.path.join(os.path.dirname(__file__), "argv"), "w")'
                        '.write(json.dumps([os.getcwd()] + sys.argv[1:]))\n')
            summary = dict(steps.spend_summary(REPORT), day='2026-11-17')
            self.assertEqual(steps.spend_nerve(repo, summary), 'emitted')
            with open(os.path.join(os.path.dirname(nerve), 'argv'), encoding='utf-8') as f:
                self.assertEqual(json.load(f), [os.path.realpath(repo), 'emit', '--product', 'taibe', '--kind',
                                                'report', 'coord', LINE])
            self.assertEqual(steps.spend_nerve(repo, summary), 'already sent for 2026-11-17')  # cycle --force
            with open(nerve, 'w', encoding='utf-8') as f:
                f.write('import sys\nprint("неизвестная роль", file=sys.stderr)\nsys.exit(2)\n')
            next_day = dict(summary, day='2026-11-18')
            self.assertEqual(steps.spend_nerve(repo, next_day), 'not emitted: неизвестная роль')
            self.assertEqual(steps.load_json('spend-sent.json', {}), {'day': '2026-11-17'})  # a failed day stays open

    def test_no_line_no_emit(self):
        with mock.patch.object(steps.subprocess, 'run') as run:
            self.assertEqual(steps.spend_nerve('/nowhere', None), 'no line')
            self.assertEqual(steps.spend_nerve('/nowhere', {'skipped': 'x'}), 'no line')
        run.assert_not_called()

    def test_a_failed_metric_line_then_the_numbers(self):  # #485, product: the failed night is not silence
        with tempfile.TemporaryDirectory() as repo:
            nerve = os.path.join(repo, 'eval', 'nerve', 'nerve.py')
            os.makedirs(os.path.dirname(nerve))
            with open(nerve, 'w', encoding='utf-8') as f:
                f.write('import json, os, sys\nwith open(os.path.join(os.path.dirname(__file__), "lines"), "a") as f:\n'
                        '    f.write(sys.argv[-1] + "\\n")\n')
            failed = {'exit': 0, 'day': '2026-11-17', 'error': 'report of another form: TypeError: x'}
            good = dict(steps.spend_summary(REPORT), day='2026-11-17')
            self.assertEqual([steps.spend_nerve(repo, s) for s in (failed, failed, good, good, failed)],
                             ['emitted'] + ['already sent for 2026-11-17'] + ['emitted'] +
                             ['already sent for 2026-11-17'] * 2)
            with open(os.path.join(os.path.dirname(nerve), 'lines'), encoding='utf-8') as f:
                self.assertEqual(f.read().splitlines(), [FAIL_LINE % 'отчёт другой формы', LINE])
            self.assertEqual(steps.load_json('spend-sent.json', {}), {'day': '2026-11-17'})


class NightEmitTest(RepoTest):
    """`run` sends the spend line through the main checkout, and not with --no-card or --dry-run."""

    def setUp(self):
        super().setUp()
        self.write('README.md', 'base\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        head, self.sent = self.git('rev-parse', 'HEAD'), []
        self.patches += [mock.patch.object(g, 'refresh_worktree', lambda *a: head),
                         mock.patch.object(g, 'since_day_ago', lambda *a: head),
                         mock.patch.object(steps, 'spend_nerve', lambda repo, s: self.sent.append((repo, s)) or 'sent')]
        for p in self.patches[-3:]:
            p.start()

    def night(self, *flags):
        argv = ['run', '--target', 'taibe', '--cases', os.path.join(self.root, 'cases'), '--worktree', '.',
                '--verdicts', os.path.join(self.state, 'verdicts.jsonl'), '--no-pr', '--keep-state',
                '--judges', 'claude:claude-sonnet-5-5,claude:claude-haiku-5-5', *flags]
        with mock.patch.object(g, 'gh', fake_gh(pr_list())), \
                mock.patch.object(daily, 'print', lambda *a, **k: None, create=True):
            daily.main(argv, factory=lambda n: None)
        return steps.load_json('runs/latest.json', {})

    def test_line_goes_out_only_without_no_card_and_dry_run(self):
        self.assertEqual(self.night().get('spend_nerve'), 'sent')
        self.assertEqual(self.sent, [(self.root, None)])  # layer_metrics is {} in RepoTest
        for flag in ('--no-card', '--dry-run'):
            with self.subTest(flag):
                self.assertNotIn('spend_nerve', self.night(flag))
        self.assertEqual(len(self.sent), 1)


if __name__ == '__main__':
    unittest.main()
