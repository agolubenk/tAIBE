"""Тесты attribution.py на синтетических транскриптах: python3 -I eval/tools/test_attribution.py"""
import json
import os
import sys
import contextlib
import io
import tempfile
import unittest
from datetime import datetime
from unittest import mock

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
             [('state', (CARD, 'fix/a'))]),
            (tool('mcp__hub__t-boards_1mcp_forest_set_work_state', step='s'), [('state', (None, None))]),
            # gh pr — только в начале команды, не в тексте аргумента (backend #417, п. 4)
            (bash('python3 -I eval/nerve/nerve.py emit coord "verified: gh pr diff 163 --name-only"'), []),
            (bash("gh pr comment 9 --body 'см. gh pr view 5'"), [('close', (None, 9))]),
            (bash('cd w && gh pr view 5; x=$(gh pr diff 6 --name-only) | wc -l'), [('open', (None, 5)), ('open', (None, 6))]),
            (bash('for n in 1; do gh pr view 7; done\nGH_PAGER= gh pr review 8 --approve'),
             [('open', (None, 7)), ('close', (None, 8))]),
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

    def test_lens_window_from_last_open_inclusive_and_unclosed_dropped(self):
        """Окно — от последнего просмотра перед comment/review (Claude-линза #417, B1), границы включительно."""
        tl = self.line((t(10), 'open', (None, 1)), (t(10, 5), 'open', (None, 1)), (t(10, 20), 'close', (None, 1)),
                       (t(11), 'open', (None, 2)))
        self.assertEqual([tl.lens(x) for x in (t(10), t(10, 4), t(10, 5), t(10, 20), t(10, 21), t(11, 30))],
                         [None, None, (None, 1), (None, 1), None, None])

    def test_equal_windows_with_and_without_repo_sort(self):
        """Два окна с равными началом и концом, repo у одного None — без TypeError (Claude-линза #417, N3)."""
        tl = self.line((t(10), 'open', (REPO, 3)), (t(10), 'open', (None, 3)), (t(10, 9), 'close', (REPO, 3)),
                       (t(10, 9), 'close', (None, 3)))
        self.assertEqual(tl.lens(t(10, 5))[1], 3)

    def test_overlap_latest_opened_wins(self):
        tl = self.line((t(10), 'open', (None, 1)), (t(10, 10), 'open', (None, 2)), (t(10, 20), 'close', (None, 2)),
                       (t(10, 30), 'close', (None, 1)))
        self.assertEqual([tl.lens(x) for x in (t(10, 5), t(10, 15), t(10, 25))], [(None, 1), (None, 2), (None, 1)])

    def test_state_is_last_work_state(self):
        tl = self.line((t(10), 'state', (CARD, 'fix/a')), (t(11), 'state', (CARD, 'fix/b')))
        self.assertEqual([tl.state(x) for x in (t(9), t(10), t(11, 1))],
                         [(None, None), (CARD, 'fix/a'), (CARD, 'fix/b')])

    def test_parent_and_subagent_events_with_unlike_values_sort(self):
        """Равные (время, порядок, вид) у родителя и субагента, значения (None, N) и (репозиторий, N) — без TypeError
        (backend #417, п. 2); при равенстве родитель раньше."""
        parent, own = at.Timeline(), at.Timeline()
        parent.add(t(10), 'open', (None, 5))
        own.add(t(10), 'open', (REPO, 5))
        own.add(t(10, 5), 'close', (REPO, 5))
        self.assertEqual(parent.build(own).lens(t(10, 1)), (REPO, 5))

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
        state = [(t(9), 'state', (CARD, 'fix/se122-qa-anchor'))]
        self.assertEqual(self.target(lens + state, t(10, 10)), ('pr', REPO, 415), 'окно линзы первым')
        self.assertEqual(self.target(lens + state, t(11)), ('pr', REPO, 377), 'затем ветка')
        self.assertEqual(self.target([(t(9), 'state', (CARD, 'feat/none'))], t(11)),
                         ('pr', REPO, 202), 'затем PR с id карточки в теле')
        self.assertEqual(self.target([(t(9), 'state', ('abcdefghijklmnopqrstuvwx', None))], t(11)),
                         ('task', 'abcdefghijklmnopqrstuvwx'), 'затем только карточка')
        self.assertEqual(self.target([(t(9), 'lease', CARD2)], t(11)), ('task', CARD2), 'затем аренда')
        self.assertEqual(self.target([], t(11)), at.UNATTRIBUTED)

    def test_stale_view_does_not_hold_work_on_other_branch(self):
        """Claude-линза #417, B1: просмотр #377 утром, work_state на ветке #202, затем повторный просмотр и комментарий
        #377. Работа между ними — на #202, а не на #377."""
        events = [(t(8), 'open', (None, 377)), (t(9), 'state', (None, 'fix/se74-nerve-lens-names')),
                  (t(13), 'open', (None, 377)), (t(13, 30), 'close', (None, 377))]
        self.assertEqual(self.target(events, t(11)), ('pr', REPO, 202))
        self.assertEqual(self.target(events, t(13, 10)), ('pr', REPO, 377))

    def test_branch_prefers_open_pr(self):
        self.assertEqual(self.target([(t(9), 'state', (None, 'fix/se74-nerve-lens-names'))], t(11)), ('pr', REPO, 202))
        self.assertEqual(at.pick([{'number': 1, 'mergedAt': '2026-11-13T10:00:00Z'},
                                  {'number': 2, 'mergedAt': '2026-11-14T10:00:00Z'}], t(11)), 2)

    def test_lens_repo_flag_wins_over_call_product(self):
        hr = 'agolubenk/HR_Helper-v2'
        lens = [(t(10), 'open', (hr, 12)), (t(10, 30), 'close', (hr, 12))]
        self.assertEqual(self.target(lens, t(10, 10)), ('pr', hr, 12))

    def test_work_state_replaces_whole_state(self):
        """forest_set_work_state заменяет состояние целиком (backend #417, B1): новая карточка без ветки и state только
        со step не оставляют прежнюю ветку."""
        a, b = 'aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'
        lg = at.Ledger({'taibe': REPO}, {REPO: [{'number': 10, 'headRefName': 'fix/a', 'mergedAt': None, 'cards': [a]},
                                                {'number': 20, 'headRefName': 'fix/b', 'mergedAt': None, 'cards': [b]}]})
        first = tool('mcp__hub__t-boards_1mcp_forest_set_work_state', step='s', taskId=a, branch='fix/a')
        for then, want in ((tool('mcp__hub__t-boards_1mcp_forest_set_work_state', step='s', taskId=b), ('pr', REPO, 20)),
                           (tool('mcp__hub__t-boards_1mcp_forest_set_work_state', step='s'), at.UNATTRIBUTED)):
            with self.subTest(then['input']):
                tl = at.Timeline()
                for when, block in ((t(9), first), (t(10), then)):
                    for kind, value in at.block_events(block):
                        tl.add(when, kind, value)
                self.assertEqual(lg.target(at.Timeline().build(tl), t(11), REPO), want)

    def test_lens_without_repo_flag_closes_window_opened_with_it(self):
        """`gh pr view 7 -R <репозиторий продукта>` и `gh pr comment 7` — одно окно (backend #417, п. 3)."""
        lg = ledger()
        lg.record('s', 'p', False, act('r1', 10, 0, bash(f'gh pr view 7 -R {REPO}')), t(10), 'taibe')
        lg.record('s', 'p', False, act('r2', 10, 10, bash('gh pr comment 7 --body-file x')), t(10, 10), 'taibe')
        lg.call('s', 'p', False, t(10, 5), 'taibe', 1.0)
        self.assertEqual(lg.resolve(), {('pr', REPO, 7): {'calls': 1, 'usd': 1.0}})

    def test_pr_list_at_limit_warns(self):
        done = mock.Mock(returncode=0, stdout=json.dumps([{'number': n} for n in range(at.PR_LIMIT)]), stderr='')
        err = io.StringIO()
        with mock.patch.object(at.subprocess, 'run', return_value=done), contextlib.redirect_stderr(err):
            self.assertEqual(len(at.load_prs({'taibe': REPO})[REPO]), at.PR_LIMIT)
        self.assertIn(f'предел --limit {at.PR_LIMIT}', err.getvalue())

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
