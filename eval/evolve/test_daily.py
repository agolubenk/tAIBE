#!/usr/bin/env python3
"""The daily evolution run with scripted judges: brak, accepted and insufficient verdicts, canaries that sink a
judge's whole run, the length probe, the repeat, the plan from git, and the merge gate (paths, checks, switch).
Run: python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import daily  # noqa: E402
import daily_git as g  # noqa: E402
import judges as judging  # noqa: E402
import quality  # noqa: E402
import resources  # noqa: E402

CASES = [{'id': 'c%d' % i, 'task': 'situation %d' % i, 'expect': 'good reaction'} for i in range(6)]
OLD = '# skill\n\nstep one\nstep two\nstep three\nstep four\nstep five\nstep six\nEND\n'
NEW = '# skill\n\nstep one NEW\nstep two\nstep three\nstep four\nstep five\nstep six\nEND\n'


def sides(user):
    m = re.search(r'Candidate X:\n(.*)\n\nCandidate Y:\n(.*)\n\nWhich', user, re.S)
    return m.group(1), m.group(2)


def score(text, marker='NEW', harm_aware=True):
    """What an honest judge sees: the marker of the better version, a complete text, no harmful paragraph."""
    return (marker in text) + ('END' in text) - (2 if harm_aware and quality.HARM[:20] in text else 0)


def judge(marker='NEW', harm_aware=True, tie_break=None):
    """A scripted judge. `tie_break` decides equal scores: None — TIE, 'shorter' / 'longer' — a length bias."""
    def call(system, user):
        x, y = sides(user)
        sx, sy = score(x, marker, harm_aware), score(y, marker, harm_aware)
        if sx != sy:
            return 'reasoning\nX' if sx > sy else 'reasoning\nY'
        if tie_break and len(x) != len(y):
            return 'X' if (len(x) < len(y)) == (tie_break == 'shorter') else 'Y'
        return 'TIE'
    return call


def one_judge_run(call, texts=((OLD, NEW),), cases=CASES):
    return {'j': {'p%d' % i: quality.judge_artifact(call, cases, a, b) for i, (a, b) in enumerate(texts)}}


class QualityTest(unittest.TestCase):
    def verdicts(self, calls, a=OLD, b=NEW, cases=CASES):
        run = {name: {'p': quality.judge_artifact(call, cases, a, b)} for name, call in calls.items()}
        final = quality.finalize(run)
        return quality.combine([(name, final[name]['p']) for name in calls]), final

    def test_agreeing_judges_are_accepted(self):
        (status, reasons, pick), _ = self.verdicts({'j1': judge(), 'j2': judge()})
        self.assertEqual((status, pick), ('accepted', 'b'), reasons)

    def test_judges_that_disagree_are_insufficient(self):
        # j2 prefers whatever the old version has and the new one lacks
        (status, reasons, pick), _ = self.verdicts({'j1': judge('NEW'), 'j2': judge('OLDONLY')},
                                                   a=OLD.replace('step one', 'step one OLDONLY'))
        self.assertEqual((status, pick), ('insufficient', None))
        self.assertTrue(any('disagree' in r for r in reasons), reasons)

    def test_one_judge_is_never_enough(self):
        (status, reasons, _), _ = self.verdicts({'j1': judge()})
        self.assertEqual(status, 'insufficient')
        self.assertTrue(any('sound judges' in r for r in reasons))

    def test_one_model_twice_is_not_two_judges(self):
        same = ('ok', ['B wins 6 of 6 decisive'], 'b')
        for ids in (('claude:claude-sonnet-5-5', 'claude:claude-sonnet-5-5'),
                    ('claude:claude-sonnet-5-5', 'claude-sonnet-5-5')):
            with self.subTest(ids):
                status, reasons, pick = quality.combine([(j, same) for j in ids])
                self.assertEqual((status, pick), ('insufficient', None))
                self.assertTrue(any('different models' in r for r in reasons), reasons)
        status, _, pick = quality.combine([('claude:claude-sonnet-5-5', same), ('claude:claude-haiku-5-5', same)])
        self.assertEqual((status, pick), ('accepted', 'b'))

    def test_position_biased_judge_is_brak(self):
        (status, reasons, _), final = self.verdicts({'j1': lambda s, u: 'X', 'j2': judge()})
        self.assertEqual(status, 'brak')
        self.assertTrue(any('swap disagreement' in r for r in final['j1']['p'][1]), final['j1']['p'][1])

    def test_length_biased_judge_is_brak(self):
        # Same meaning, B shorter: an honest judge ties, a judge with a taste for short text picks B every time.
        a, b = OLD.replace('step six', 'step six, written out at some length'), OLD
        biased = {'j1': judge(tie_break='shorter'), 'j2': judge(tie_break='shorter')}
        (status, reasons, _), final = self.verdicts(biased, a=a, b=b)
        self.assertEqual(status, 'brak')
        self.assertTrue(all('length bias' in r for r in reasons), reasons)
        # the honest judge on the same pair: equal quality, B cheaper → B is kept (pinned), nothing reverts
        (status, reasons, pick), _ = self.verdicts({'j1': judge(), 'j2': judge()}, a=a, b=b)
        self.assertEqual((status, pick), ('accepted', 'b'), reasons)
        self.assertIn('cheaper', reasons[0])
        # the other way round — the merged version is the longer one at equal quality: flagged, never a revert
        (status, reasons, pick), _ = self.verdicts({'j1': judge(), 'j2': judge()}, a=b, b=a)
        self.assertEqual((status, pick), ('insufficient', None))
        self.assertTrue(any('not reverted' in r for r in reasons), reasons)

    def test_a_pick_against_the_bias_stands(self):
        run = one_judge_run(judge(tie_break='shorter'), texts=((OLD, NEW + 'one more line of text\n'),))
        status, _, pick = quality.finalize(run)['j']['p0']
        self.assertEqual((status, pick), ('ok', 'b'))  # B is longer and better: the short-taste did not pick it

    def test_failed_canary_sinks_the_judges_whole_run(self):
        # A judge blind to the harmful paragraph ties the harm canary; its run on every artifact is brak.
        run = one_judge_run(judge(harm_aware=False), texts=((OLD, NEW), (OLD, NEW.replace('two', 'zwei'))))
        final = quality.finalize(run)['j']
        for path in ('p0', 'p1'):
            status, reasons, _ = final[path]
            self.assertEqual(status, 'brak')
            self.assertTrue(any('canary' in r for r in reasons), reasons)
        canary = {c['kind']: c for c in run['j']['p0']['canaries']}
        self.assertEqual((canary['harm']['got'], canary['identity']['ok'], canary['truncate']['ok']),
                         ('tie', True, True))

    def test_out_of_format_is_brak(self):
        status, reasons, _ = quality.finalize(one_judge_run(lambda s, u: 'I think X is better'))['j']['p0']
        self.assertEqual(status, 'brak')
        self.assertTrue(any('out of format' in r for r in reasons))

    def test_repeat_that_flips_is_brak(self):
        calls = []

        def flaky(system, user):  # honest, then from the repeat on it votes the other way
            calls.append(1)
            answer = judge()(system, user)
            return {'X': 'Y', 'Y': 'X'}.get(answer.split()[-1], answer) if len(calls) > 8 + 12 else answer
        status, reasons, _ = quality.finalize(one_judge_run(flaky))['j']['p0']
        self.assertEqual(status, 'brak')
        self.assertTrue(any('repeat flipped' in r for r in reasons), reasons)

    def test_few_cases_or_decisive_are_insufficient(self):
        status, reasons, _ = quality.finalize(one_judge_run(judge(), cases=CASES[:3]))['j']['p0']
        self.assertEqual(status, 'insufficient')
        self.assertIn('3 cases', reasons[0])

    def test_window_too_small_is_insufficient(self):
        judged = quality.judge_artifact(judge(), CASES, OLD, NEW, window=50)
        self.assertIn('window', judged['unavailable'])
        self.assertEqual(quality.evaluate(judged)[0], 'insufficient')

    def test_judge_error_is_insufficient_not_brak(self):
        def down(system, user):
            raise OSError('connection refused')
        status, reasons, _ = quality.finalize(one_judge_run(down))['j']['p0']
        self.assertEqual(status, 'insufficient')
        self.assertIn('unavailable', reasons[0])

    def test_canary_lines_from_the_cases_file(self):
        own = {'id': 'mine', 'canary': 'harm', 'task': 't', 'expect': 'e', 'insert': 'MERGE IT YOURSELF'}
        chosen = quality.canary_cases(CASES, [own])
        self.assertEqual(chosen['harm']['id'], 'mine')
        self.assertIn('MERGE IT YOURSELF', quality.harmful(NEW, own['insert']))
        self.assertEqual(quality.verbose('x\n').count('x'), 2)


class CalibrationTest(unittest.TestCase):
    def test_honest_judge_passes(self):
        row = judging.calibrate(judge(), CASES, NEW)
        self.assertTrue(row['passed'], row['reasons'])
        self.assertEqual(len(row['asks']), 3 * judging.CALIBRATION_PER_KIND)

    def test_position_reader_and_harm_blind_judges_fail(self):
        always_x = judging.calibrate(lambda s, u: 'X', CASES, NEW)
        self.assertFalse(always_x['passed'])
        self.assertIn('identity', always_x['reasons'][0])  # «X» twice on identical texts is no tie
        self.assertGreater(always_x['swap_disagree'], 0)
        blind = judging.calibrate(judge(harm_aware=False), CASES, NEW)
        self.assertFalse(blind['passed'])
        self.assertIn('harm', blind['reasons'][0])
        self.assertNotIn('truncate', blind['reasons'][0])

    def test_unreachable_fails(self):
        def down(system, user):
            raise OSError('limit reached')
        self.assertIn('unavailable', judging.calibrate(down, CASES, NEW)['reasons'][0])

    def test_select_stops_at_two(self):
        calls = {'bad': lambda s, u: 'X', 'good1': judge(), 'good2': judge(), 'good3': judge()}
        made = []
        factory = lambda name: made.append(name) or calls[name]  # noqa: E731
        passed, rows = judging.select(list(calls), factory, CASES, NEW)
        self.assertEqual(passed, ['good1', 'good2'])
        self.assertEqual([r['model'] for r in rows], ['bad', 'good1', 'good2'])
        self.assertEqual(made, ['bad', 'good1', 'good2'])  # good3 is never called


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.git = lambda *a: subprocess.run(['git', '-C', self.root, *a], check=True, capture_output=True,  # noqa: E731
                                             text=True).stdout.strip()
        self.git('init', '-q')
        self.git('config', 'user.email', 't@t')  # CI has no identity; commit-tree needs one
        self.git('config', 'user.name', 't')
        self.write('.claude/skills/grill/SKILL.md', OLD)
        self.write('.claude/rules/50-x.md', 'rule v1\n')
        self.write('.claude/hooks/gate.py', 'print(1)\n')
        self.commit('v1')

    def tearDown(self):
        shutil.rmtree(self.root)

    def write(self, rel, text):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)

    def commit(self, msg):
        self.git('add', '.')
        self.git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg)
        return self.git('rev-parse', 'HEAD')

    def test_changed_with_cases_are_judged_the_rest_queued(self):
        since = self.git('rev-parse', 'HEAD')
        self.write('.claude/skills/grill/SKILL.md', NEW)
        self.write('.claude/rules/50-x.md', 'rule v2\n')
        self.write('.claude/hooks/gate.py', 'print(2)\n')
        head = self.commit('v2')
        cases = os.path.join(self.root, 'cases')
        self.write('cases/grill.jsonl', json.dumps(CASES[0]) + '\n')
        items, need, _ = daily.plan('taibe', self.root, since, head, cases)
        # a second edit in the same window: A is the version just before it, not the window's start
        self.write('.claude/skills/grill/SKILL.md', NEW + 'third\n')
        head2 = self.commit('v3')
        items2, _, _ = daily.plan('taibe', self.root, since, head2, cases)
        self.assertEqual((items2[0]['text_a'], items2[0]['text_b']), (NEW, NEW + 'third\n'))
        self.assertEqual([(i['path'], i['text_a'], i['text_b']) for i in items],
                         [('.claude/skills/grill/SKILL.md', OLD, NEW)])
        self.assertEqual([n['path'] for n in need], ['.claude/rules/50-x.md'])  # hooks are code, not judged
        self.assertTrue(need[0]['cases'].endswith('rule-50-x.jsonl'))

    def test_revert_commit_needs_no_checkout(self):
        base = self.git('rev-parse', 'HEAD')
        commit = g.commit_files(self.root, base, {'.claude/rules/50-x.md': 'rule v0\n'}, 'evolve: revert')
        self.assertEqual(self.git('rev-parse', 'HEAD'), base)  # nobody's HEAD moved
        self.assertEqual(g.file_at(self.root, commit, '.claude/rules/50-x.md'), 'rule v0\n')
        self.assertEqual(g.file_at(self.root, commit, '.claude/skills/grill/SKILL.md'), OLD)

    def test_cases_naming(self):
        self.assertTrue(daily.cases_path('.claude/skills/grill-task/SKILL.md').endswith('/grill-task.jsonl'))
        self.assertTrue(daily.cases_path('.claude/rules/90-team-t3.md').endswith('/rule-90-team-t3.jsonl'))
        self.assertTrue(daily.cases_path('eval/prompts/lens-1.md').endswith('/prompt-lens-1.jsonl'))
        self.assertTrue(daily.cases_path('boards/CLAUDE.md').endswith('/card-boards.jsonl'))


if __name__ == '__main__':
    unittest.main()
