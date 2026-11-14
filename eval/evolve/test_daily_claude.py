#!/usr/bin/env python3
"""Claude-only judges (owner decision 06.11, council of three lenses): candidate order, routing of every
`claude:<model>` id, the JSON answer check, real tokens, item-major judging under the night's budget, pending
artifacts and state, no local model / gateway code, the `abJudgeClaude` switch and its owner file. Fake judges only:
no test starts Claude, a gateway or a model.
Run: python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'"""
import glob
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
import daily_steps as steps  # noqa: E402
import judges as judging  # noqa: E402
import quality  # noqa: E402
import resources  # noqa: E402
from test_daily import CASES, NEW, OLD, judge  # noqa: E402

SONNET, HAIKU, OPUS = judging.CLAUDE_CANDIDATES


def cli_answer(text='reasoning\nTIE', model='claude-sonnet-5-5', tokens=2000, rc=0, stderr='', is_error=False):
    data = {'result': text, 'is_error': is_error,
            'modelUsage': {model: {'inputTokens': tokens - 100, 'outputTokens': 100}}}
    return lambda cmd, **kw: subprocess.CompletedProcess(cmd, rc, json.dumps(data), stderr)


class CandidatesTest(unittest.TestCase):
    def test_order_and_switch(self):  # rule 1, rule 10
        self.assertEqual(judging.candidates(True), ['claude:claude-sonnet-5-5', 'claude:claude-haiku-5-5',
                                                    'claude:claude-opus-5-5'])
        self.assertEqual(judging.candidates(False), [])

    def test_the_first_two_that_pass_judge(self):  # rule 1
        calls = {SONNET: judge(), HAIKU: lambda s, u: 'X', OPUS: judge()}
        passed, rows = judging.select(judging.candidates(True), calls.get, CASES, NEW)
        self.assertEqual(passed, [SONNET, OPUS])  # opus is the fallback when haiku fails
        calls[HAIKU] = judge()
        passed, rows = judging.select(judging.candidates(True), calls.get, CASES, NEW)
        self.assertEqual((passed, len(rows)), ([SONNET, HAIKU], 2))  # opus is never asked

    def test_only_claude_ids_are_accepted(self):  # owner rule: no local models
        args = mock.Mock(judges='claude:claude-sonnet-5-5,local/qwen2.5:7b', factory=None)
        names, why = daily.judge_names(args, HERE)
        self.assertEqual(names, [])
        self.assertIn('local/qwen2.5:7b', why)


class RoutingAndCallTest(unittest.TestCase):
    def test_every_claude_id_goes_to_claude_call(self):  # rule 2
        seen = []
        with mock.patch.object(judging.subprocess, 'run', lambda cmd, **kw: seen.append(cmd) or
                               cli_answer(model='claude-haiku-5-5')(cmd, **kw)):
            daily.judge_factory(resources.Budget())(HAIKU)(None, 'prompt')
        self.assertEqual(seen[0][seen[0].index('--model') + 1], 'claude-haiku-5-5')
        self.assertEqual(seen[0][seen[0].index('--output-format') + 1], 'json')
        with self.assertRaises(ValueError):
            daily.judge_factory(resources.Budget())('local/glm4:latest')

    def test_wrong_model_quota_error_and_empty_are_unavailable(self):  # rule 3
        for name, run in (('wrong model', cli_answer(model='claude-haiku-5-5')),
                          ('quota at exit 0', cli_answer(text="You've hit your limit · resets 4am")),
                          ('quota in stderr', cli_answer(stderr="You've hit your limit")),
                          ('quota at exit 1', cli_answer(text='', rc=1, stderr='usage limit reached')),
                          ('error result', cli_answer(is_error=True)),
                          ('empty answer', cli_answer(text=''))):
            with self.subTest(name), mock.patch.object(judging.subprocess, 'run', run):
                with self.assertRaises(OSError):
                    judging.claude_call(resources.Budget(), SONNET.split(':')[1])(None, 'prompt')
        # a reasoning that mentions a quota and ends with a verdict is an answer
        with mock.patch.object(judging.subprocess, 'run', cli_answer(text='the skill has a quota rule\nX')):
            self.assertEqual(judging.claude_call(resources.Budget())(None, 'p'), 'the skill has a quota rule\nX')

    def test_a_judge_that_fails_is_insufficient_never_brak(self):  # rule 3
        with mock.patch.object(judging.subprocess, 'run', cli_answer(model='claude-haiku-5-5')):
            judged = quality.judge_artifact(judging.claude_call(resources.Budget()), CASES, OLD, NEW)
        self.assertIn('unavailable', judged)
        self.assertEqual(quality.evaluate(judged)[0], 'insufficient')

    def test_real_tokens_are_charged(self):  # rule 3, rule 7
        budget = resources.Budget()
        with mock.patch.object(judging.subprocess, 'run', cli_answer(tokens=5000)):
            judging.claude_call(budget)(None, 'short prompt')
        self.assertEqual((budget.calls, budget.tokens), (1, 5000))
        self.assertEqual(budget.overhead, 5000 - budget.estimated)  # the real call was larger than its estimate
        self.assertEqual(budget.report()['usage'], {'input': 4900, 'output': 100, 'cache_read': 0, 'cache_write': 0})
        self.assertEqual((resources.JUDGE_MAX_CALLS, resources.JUDGE_MAX_TOKENS, resources.MAX_ARTIFACTS),
                         (160, 1_200_000, 2))

    def test_usage_without_model_usage_comes_from_usage(self):
        data = {'usage': {'input_tokens': 10, 'output_tokens': 2, 'cache_read_input_tokens': 300,
                          'cache_creation_input_tokens': 40}}
        self.assertEqual(judging.usage_split(data), {'input': 10, 'output': 2, 'cache_read': 300, 'cache_write': 40})
        self.assertEqual(sum(judging.usage_split(None).values()), 0)

    def test_the_excess_per_call_is_added_not_multiplied(self):  # SE-49, replay of 14.11
        budget = resources.Budget()
        for _ in range(24):                  # calibration of two judges: estimate 4023, real 7969 a call
            budget.charge(7969, 4023)
        budget.charge(5488, 1542)            # the smallest call of the night: real/estimate = 3.56
        budget.charge(1100, 1000)            # a later call with a small excess does not lower the largest one
        self.assertEqual(budget.overhead, 3946)
        # successor-handoff: 56 calls, 777952 tokens estimated (log of 14.11). With the excess added it fits the
        # night; a ratio of 3.56 would have asked 2.77M tokens of a 1.2M ceiling.
        self.assertTrue(budget.covers(56, 777952))
        self.assertFalse(budget.covers(80, 839280))  # infra/ai-council/CLAUDE.md still does not fit
        self.assertFalse(budget.covers(136, 0))      # and the call ceiling holds as before


def item(path, text_a=OLD, text_b=NEW, cases_file=None):
    return {'target': 'taibe', 'path': path, 'a': '1', 'b': '2', 'b_blob': 'blob-' + path, 'text_a': text_a,
            'text_b': text_b, 'cases': cases_file}


class JudgingTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cases = os.path.join(self.dir, 'c.jsonl')
        with open(self.cases, 'w', encoding='utf-8') as f:
            f.write(''.join(json.dumps(c) + '\n' for c in CASES))
        self.log = mock.patch.object(daily, 'log', lambda *a: None)
        self.log.start()

    def tearDown(self):
        self.log.stop()
        shutil.rmtree(self.dir)

    def test_item_major_and_the_artifact_limit(self):  # rule 4, rule 7
        order = []

        def factory(name):
            honest = judge()
            return lambda s, u: order.append(name) or honest(s, u)
        items = [item('p%d' % i, cases_file=self.cases) for i in range(3)]
        verdicts, pending = daily.judge(items, [SONNET, HAIKU], factory, resources.Budget(), float('inf'))
        self.assertEqual([v['path'] for v in verdicts], ['p0', 'p1'])
        self.assertEqual([p['path'] for p in pending], ['p2'])  # MAX_ARTIFACTS = 2
        last_sonnet = len(order) - 1 - order[::-1].index(SONNET)
        self.assertGreater(last_sonnet, order.index(HAIKU))  # item-major: sonnet judges p1 after haiku judged p0
        half = order.count(SONNET) // 2
        self.assertEqual(order[:half], [SONNET] * half)  # p0: sonnet's calls, then haiku's, before p1
        self.assertTrue(all(v['status'] == 'accepted' for v in verdicts), [v['reasons'] for v in verdicts])

    def test_an_artifact_starts_only_if_the_budget_covers_all_judges(self):  # rule 4, rule 5
        calls, tokens = daily.item_cost(item('p0', cases_file=self.cases), 2)
        tight = resources.Budget(calls=calls - 1)
        made = []
        verdicts, pending = daily.judge([item('p0', cases_file=self.cases)], [SONNET, HAIKU],
                                        lambda n: made.append(n) or judge(), tight, float('inf'))
        self.assertEqual((verdicts, [p['path'] for p in pending]), ([], ['p0']))
        roomy = resources.Budget(calls=calls, tokens=tokens)
        verdicts, pending = daily.judge([item('p0', cases_file=self.cases)], [SONNET, HAIKU], lambda n: judge(),
                                        roomy, float('inf'))
        self.assertEqual((len(verdicts), pending), (1, []))


class NightTest(unittest.TestCase):
    """cmd_run end to end on a temporary repository, with fake judges and no card, gateway or model."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.state = tempfile.mkdtemp()
        git = lambda *a: subprocess.run(['git', '-C', self.root, *a], check=True, capture_output=True,  # noqa: E731
                                        text=True).stdout.strip()
        git('init', '-q')
        git('config', 'user.email', 't@t')
        git('config', 'user.name', 't')
        self.git = git
        self.write('.claude/skills/grill-task/SKILL.md', OLD)
        self.write('cases/grill-task.jsonl', ''.join(json.dumps(c) + '\n' for c in CASES))
        git('add', '.')
        git('commit', '-qm', 'v1')
        self.since = git('rev-parse', 'HEAD')
        self.write('.claude/skills/grill-task/SKILL.md', NEW)
        git('commit', '-qam', 'v2')
        self.head = git('rev-parse', 'HEAD')
        self.patches = [mock.patch.object(daily, 'log', lambda *a: None),
                        mock.patch.object(steps, 'STATE_DIR', self.state),
                        mock.patch.object(daily, 'switch', lambda *a: True),
                        mock.patch.object(daily.g, 'main_repo', lambda p: self.root),
                        mock.patch.object(daily.g, 'refresh_worktree', lambda *a: self.head),
                        mock.patch.object(daily.g, 'since_day_ago', lambda *a: self.since),
                        mock.patch.object(steps, 'layer_metrics', lambda wt: {}),
                        mock.patch.object(steps, 'post_card', lambda line: 'not posted (test)')]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.root)
        shutil.rmtree(self.state)

    def write(self, rel, text):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)

    def run_night(self, factory, judges='claude:claude-sonnet-5-5,claude:claude-haiku-5-5'):
        verdicts = os.path.join(self.state, 'verdicts.jsonl')
        argv = ['run', '--target', 'taibe', '--cases', os.path.join(self.root, 'cases'), '--verdicts', verdicts,
                '--worktree', '.', '--calibration-cases', os.path.join(self.root, 'cases/grill-task.jsonl'),
                '--no-card', '--no-pr'] + (['--judges', judges] if judges else [])
        with mock.patch.object(daily, 'print', lambda *a, **k: None, create=True):
            daily.main(argv, factory=factory)
        lines = []
        if os.path.isfile(verdicts):
            with open(verdicts, encoding='utf-8') as f:
                lines = [json.loads(ln) for ln in f]
        with open(os.path.join(self.state, 'state.json'), encoding='utf-8') as f:
            return lines, json.load(f)['taibe']

    def test_two_passing_judges_judge_and_the_state_moves(self):  # rules 1, 4, 5
        lines, state = self.run_night(lambda n: judge())
        self.assertEqual([v['status'] for v in lines], ['accepted'])
        self.assertEqual((state['rev'], state['pending']), (self.head, []))
        lines2, _ = self.run_night(lambda n: judge())
        self.assertEqual(len(lines2), 1)  # judged at this version already: not judged again

    def test_fewer_than_two_judges_keep_the_artifact_pending(self):  # rule 5
        factory = lambda n: judge() if n == SONNET else (lambda s, u: 'X')  # noqa: E731
        lines, state = self.run_night(factory)
        self.assertEqual([v['status'] for v in lines], ['insufficient'])
        self.assertIn('no judge', lines[0]['reasons'][0])
        self.assertEqual(state['rev'], self.since)  # not moved to head
        self.assertEqual([p['path'] for p in state['pending']], ['.claude/skills/grill-task/SKILL.md'])

    def test_switch_off_judges_nothing_and_keeps_the_state(self):  # rule 10
        made = []
        with mock.patch.object(steps, 'claude_judges_on', lambda root=None: False):
            lines, state = self.run_night(lambda n: made.append(n) or judge(), judges=None)
        self.assertEqual((made, lines, state['rev']), ([], [], self.since))


class SwitchTest(unittest.TestCase):
    def test_claude_judges_need_the_board_or_the_owner_file(self):  # rule 10
        path = os.path.join(tempfile.mkdtemp(), 'abJudgeClaude.on')
        with mock.patch.object(steps, 'closed_switch', lambda name, root=None: False), \
                mock.patch.dict(os.environ, {'TAIBE_PIPELINE': ''}):
            self.assertFalse(steps.claude_judges_on(override=path))
            open(path, 'w').close()
            self.assertTrue(steps.claude_judges_on(override=path))
            with mock.patch.dict(os.environ, {'TAIBE_PIPELINE': 'abJudgeClaude=off'}):
                self.assertFalse(steps.claude_judges_on(override=path))
        with mock.patch.object(steps, 'closed_switch', lambda name, root=None: name == 'abJudgeClaude'):
            self.assertTrue(steps.claude_judges_on(override=path + '.missing'))

    def test_an_unreadable_setting_is_off(self):  # rule 10
        sys.path.insert(0, os.path.join(HERE, '..', '..', '.claude', 'scripts'))
        import pipeline_settings as ps
        with mock.patch.object(ps, 'load', side_effect=OSError('x')):
            self.assertFalse(steps.closed_switch('abJudgeClaude'))
        on = {'automation': True, 'toggles': dict(ps.defaults()['toggles'], abJudgeClaude=True)}
        with mock.patch.object(ps, 'load', lambda root: (on, 'defaults (no board settings known)')):
            self.assertFalse(steps.closed_switch('abJudgeClaude'))


class NoLocalModelsTest(unittest.TestCase):
    def test_no_code_starts_ollama_or_the_gateway(self):  # rule 6, owner rule
        start = re.compile(r"""['"]open['"],\s*['"]-ga|ollama['"],\s*['"]serve|llm-gateway\.sh['"]?\)?,\s*"""
                           r"""['"]start|Popen\(|/api/generate|keep_alive""")
        for path in glob.glob(os.path.join(HERE, '*.py')) + glob.glob(os.path.join(HERE, '*.sh')):
            if os.path.basename(path).startswith('test_'):
                continue
            with open(path, encoding='utf-8') as f:
                text = f.read()
            with self.subTest(os.path.basename(path)):
                self.assertIsNone(start.search(text))
        for name in ('ensure_gateway', 'start_ollama', 'unload', 'stream_call', 'local_judges_allowed'):
            self.assertFalse(hasattr(steps, name), name)
        for name in ('ollama_tags', 'params_b'):
            self.assertFalse(hasattr(judging, name), name)
        for name in ('swap_share', 'fits', 'available_bytes', 'loaded'):  # rule 8: no swap or memory gate
            self.assertFalse(hasattr(resources, name), name)


if __name__ == '__main__':
    unittest.main()
