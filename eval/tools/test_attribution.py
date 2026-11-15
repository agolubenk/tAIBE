"""Тесты attribution.py на синтетических транскриптах: python3 -I eval/tools/test_attribution.py"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import attribution as at  # noqa: E402
import spend  # noqa: E402
from test_spend import PROMPT, SINCE, UNTIL, call, ts, user, write_files, write_instances  # noqa: E402

REPO = 'agolubenk/tAIBE'
CARD, CARD2 = 'xrrcr55w2ft2tupp5jo2q5ug', 'dd5ye8swe6q98sk6dbur7t1o'
PRS = {REPO: [{'number': 202, 'headRefName': 'fix/se74-nerve-lens-names', 'mergedAt': None, 'cards': [CARD]},
              {'number': 150, 'headRefName': 'fix/se74-nerve-lens-names', 'mergedAt': '2026-11-13T10:00:00Z',
               'cards': []},
              {'number': 377, 'headRefName': 'fix/se122-qa-anchor', 'mergedAt': None, 'cards': [CARD2]}]}


def t(hour, minute=0):
    return datetime(2026, 11, 15, hour, minute)


def tool(name, **inp):
    return {'type': 'tool_use', 'id': 'tu', 'name': name, 'input': inp}


def act(rid, hour, minute, *blocks, cwd='/x/tAIBE/w'):
    """Вызов с блоками tool_use (один requestId)."""
    rec = call(rid, 15, hour, minute, inp=1000, out=100, cwd=cwd)
    rec['message']['content'] = list(blocks)
    return rec


def bash(cmd):
    return tool('Bash', command=cmd)


def ledger():
    return at.Ledger({'taibe': REPO, 'hr-helper': 'agolubenk/HR_Helper-v2'}, PRS)


class EventsTest(unittest.TestCase):
    def test_block_events(self):
        cases = [
            (bash('gh pr view 415 --json headRefOid && gh pr diff 415'), [('open', (None, 415))] * 2),
            (bash('gh pr comment #170 --body-file x.md'), [('close', (None, 170))]),
            (bash('gh pr review 12 -R agolubenk/HR_Helper-v2 --approve'), [('close', ('agolubenk/HR_Helper-v2', 12))]),
            (bash('gh pr view --repo=a/b 7'), []),          # номер — сразу после глагола
            (bash('gh pr list --state open; gh pr checks 9'), []),
            (tool('mcp__plugin_context-mode_context-mode__ctx_execute', language='shell', code='gh pr checkout 5'),
             [('open', (None, 5))]),
            (tool('mcp__plugin_context-mode_context-mode__ctx_batch_execute',
                  commands=[{'label': 'a', 'command': 'gh pr view 1'}, {'label': 'b'}, 'x']), [('open', (None, 1))]),
            (tool('mcp__hub__t-boards_1mcp_forest_set_work_state', step='s', taskId=CARD, branch='fix/a'),
             [('task', CARD), ('branch', 'fix/a')]),
            (tool('mcp__hub__t-boards_1mcp_forest_acquire_lease', taskId=CARD), [('lease', CARD)]),
            (tool('Read', file_path='gh pr view 3'), []),
        ]
        for block, want in cases:
            with self.subTest(block):
                self.assertEqual(at.block_events(block), want)

    def test_pr_jq_scans_card_ids(self):
        self.assertIn('scan("\\\\b[a-z][a-z0-9]{23}\\\\b")', at.PR_JQ)


class TimelineTest(unittest.TestCase):
    def line(self, *events):
        tl = at.Timeline()
        for when, kind, value in events:
            tl.add(when, kind, value)
        return tl.build()

    def test_lens_window_inclusive_and_unclosed_dropped(self):
        tl = self.line((t(10), 'open', (None, 1)), (t(10, 5), 'open', (None, 1)), (t(10, 20), 'close', (None, 1)),
                       (t(11), 'open', (None, 2)))
        self.assertEqual([tl.lens(x) for x in (t(9, 59), t(10), t(10, 20), t(10, 21), t(11, 30))],
                         [None, (None, 1), (None, 1), None, None])

    def test_overlap_latest_opened_wins(self):
        tl = self.line((t(10), 'open', (None, 1)), (t(10, 10), 'open', (None, 2)), (t(10, 20), 'close', (None, 2)),
                       (t(10, 30), 'close', (None, 1)))
        self.assertEqual([tl.lens(x) for x in (t(10, 5), t(10, 15), t(10, 25))], [(None, 1), (None, 2), (None, 1)])

    def test_state_is_last_work_state(self):
        tl = self.line((t(10), 'task', CARD), (t(10), 'branch', 'fix/a'), (t(11), 'branch', 'fix/b'))
        self.assertEqual([tl.state(x) for x in (t(9), t(10), t(11, 1))],
                         [(None, None), (CARD, 'fix/a'), (CARD, 'fix/b')])

    def test_lease_only_when_one_card(self):
        self.assertEqual(self.line((t(9), 'lease', CARD), (t(10), 'lease', CARD)).lease, CARD)
        self.assertIsNone(self.line((t(9), 'lease', CARD), (t(10), 'lease', CARD2)).lease)


class LedgerTest(unittest.TestCase):
    def target(self, events, when, sub_events=()):
        lg = ledger()
        lg.lines[('s', None)] = at.Timeline()
        for e in events:
            lg.lines[('s', None)].add(*e)
        own = at.Timeline()
        for e in sub_events:
            own.add(*e)
        parent = at.Timeline()
        parent.events = list(lg.lines[('s', None)].events)
        return lg.target(parent.build(own), when, REPO)

    def test_order(self):
        lens = [(t(10), 'open', (None, 415)), (t(10, 30), 'close', (None, 415))]
        state = [(t(9), 'task', CARD), (t(9), 'branch', 'fix/se122-qa-anchor')]
        self.assertEqual(self.target(lens + state, t(10, 10)), ('pr', REPO, 415), 'окно линзы первым')
        self.assertEqual(self.target(lens + state, t(11)), ('pr', REPO, 377), 'затем ветка')
        self.assertEqual(self.target([(t(9), 'task', CARD), (t(9), 'branch', 'feat/none')], t(11)),
                         ('pr', REPO, 202), 'затем PR с id карточки в теле')
        self.assertEqual(self.target([(t(9), 'task', 'abcdefghijklmnopqrstuvwx')], t(11)),
                         ('task', 'abcdefghijklmnopqrstuvwx'), 'затем только карточка')
        self.assertEqual(self.target([(t(9), 'lease', CARD2)], t(11)), ('task', CARD2), 'затем аренда')
        self.assertEqual(self.target([], t(11)), at.UNATTRIBUTED)

    def test_branch_prefers_open_pr(self):
        self.assertEqual(self.target([(t(9), 'branch', 'fix/se74-nerve-lens-names')], t(11)), ('pr', REPO, 202))
        self.assertEqual(at.pick([{'number': 1, 'mergedAt': '2026-11-13T10:00:00Z'},
                                  {'number': 2, 'mergedAt': '2026-11-14T10:00:00Z'}], t(11)), 2)

    def test_lens_repo_flag_wins_over_call_product(self):
        hr = 'agolubenk/HR_Helper-v2'
        lens = [(t(10), 'open', (hr, 12)), (t(10, 30), 'close', (hr, 12))]
        self.assertEqual(self.target(lens, t(10, 10)), ('pr', hr, 12))

    def test_subagent_sees_parent_events(self):
        parent = [(t(10), 'open', (None, 415)), (t(10, 30), 'close', (None, 415))]
        self.assertEqual(self.target(parent, t(10, 10)), ('pr', REPO, 415))
        self.assertEqual(self.target([], t(10, 10), sub_events=parent), ('pr', REPO, 415))


class ScanTest(unittest.TestCase):
    def test_scan_sink_end_to_end(self):
        """Время события — первая запись его requestId: вторая запись того же ответа (копия сессии) его не сдвигает;
        повтор вызова не считается второй раз; субагент берёт окно линзы родителя."""
        with tempfile.TemporaryDirectory() as tmp:
            inst = os.path.join(tmp, 'instances')
            write_instances(inst)
            for slug, repo in (('taibe', REPO), ('hr-helper', 'agolubenk/HR_Helper-v2')):
                path = os.path.join(inst, slug + '.json')
                with open(path, encoding='utf-8') as f:
                    d = json.load(f)
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(dict(d, github={'repo': repo}), f)
            home = os.path.join(tmp, 'home')
            main = [user(PROMPT, 15, 9),
                    act('r1', 10, 0, bash('gh pr view 415')),
                    act('r2', 10, 5),
                    act('r3', 10, 10, bash('gh pr comment 415 --body x')),
                    act('r4', 11, 0, tool('mcp__hub__t-boards_1mcp_forest_set_work_state', step='s', taskId=CARD2)),
                    act('r5', 12, 0)]
            sub = [act('q1', 10, 6)]
            copy = [act('r1', 13, 0, bash('gh pr view 415'))]
            proj = '-x-tAIBE-w'
            write_files(home, [(f'{proj}/s1.jsonl', main), (f'{proj}/s1/subagents/a.jsonl', sub),
                               (f'{proj}/s9.jsonl', [user(PROMPT, 15, 9)] + copy)],
                        datetime(2026, 11, 15, 14, 0).timestamp())
            lg = at.Ledger(at.repos(inst), PRS)
            roll, _ = spend.scan(SINCE, UNTIL, home=home, instances=inst, sink=lg)
            got = {at.label(k): v['calls'] for k, v in lg.resolve().items()}
            self.assertEqual(got, {f'{REPO}#415': 4, f'{REPO}#377': 2})
            self.assertEqual(sum(r['calls'] for r in roll.values()), 6)
            self.assertAlmostEqual(sum(v['usd'] for v in lg.resolve().values()), sum(r['usd'] for r in roll.values()))


if __name__ == '__main__':
    unittest.main()
