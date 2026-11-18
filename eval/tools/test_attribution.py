"""Тесты attribution.py на синтетических транскриптах: python3 -I eval/tools/test_attribution.py"""
import json
import os
import sys
import contextlib
import io
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timedelta
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

    def test_prefix_is_linear_and_matches_the_same(self):
        """Префикс `GH_PR_RE` не переходит через перевод строки (нит линзы backend #417 на f381b43e2: 8000 знаков
        `x=\\n` — 99 мс на прежнем `\\s*(?:\\w+=\\S*\\s+)*`)."""
        cases = [('x=1\ngh pr view 3', [('view', '3')]), ('FOO=a BAR= gh pr view 4', [('view', '4')]),
                 ('FOO=a;gh pr view 5', [('view', '5')]), ('A=b\tgh pr diff 6', [('diff', '6')]),
                 ('FOO=a\n  gh pr comment 7', [('comment', '7')]), ('echo FOO=a gh pr view 8', []),
                 ('FOO=a;b gh pr view 9', [])]  # в shell gh здесь — аргумент b: значение присваивания не идёт за `;`
        for text, want in cases:
            with self.subTest(text):
                self.assertEqual([m.group(1, 2) for m in at.GH_PR_RE.finditer(text)], want)
        started = time.perf_counter()
        self.assertEqual(list(at.GH_PR_RE.finditer('x=\n' * 8000)), [])
        self.assertLess(time.perf_counter() - started, 0.05)

    def test_pr_jq_scans_card_ids(self):
        self.assertIn('scan("\\\\b[a-z][a-z0-9]{23}\\\\b")', at.PR_JQ)


class TimelineTest(unittest.TestCase):
    def line(self, *events):
        tl = at.Timeline()
        for when, kind, value in events:
            tl.add(when, kind, value)
        return tl.build()

    def test_lens_window_from_first_open_inclusive_and_unclosed_dropped(self):
        """Проверка головы перед вердиктом (второй просмотр) окно не режет (Claude-линза #417 на fe4c5017c)."""
        tl = self.line((t(10), 'open', (None, 1)), (t(10, 5), 'open', (None, 1)), (t(10, 20), 'close', (None, 1)),
                       (t(11), 'open', (None, 2)))
        self.assertEqual([tl.lens(x) for x in (t(9, 59), t(10), t(10, 4), t(10, 20), t(10, 21), t(11, 30))],
                         [None, (None, 1), (None, 1), (None, 1), None, None])

    def test_views_further_than_gap_start_a_new_visit(self):
        """Заход — просмотры не дальше LENS_GAP (1 ч, включительно); без work_state, сессия только смотрит PR."""
        for second, want in ((t(11), (None, 1)), (t(11, 1), None)):
            with self.subTest(second):
                tl = self.line((t(10), 'open', (None, 1)), (second, 'open', (None, 1)), (t(11, 30), 'close', (None, 1)))
                self.assertEqual(tl.lens(t(10, 30)), want)

    def test_second_comment_or_review_extends_window(self):
        """N1: `gh pr comment 7` в 10:20 и `gh pr review 7` в 10:25 — вызовы между ними тоже на #7."""
        tl = self.line((t(10), 'open', (None, 7)), (t(10, 20), 'close', (None, 7)), (t(10, 25), 'close', (None, 7)))
        self.assertEqual([tl.lens(x) for x in (t(10, 22), t(10, 25), t(10, 26))], [(None, 7), (None, 7), None])

    def test_late_second_comment_does_not_extend_window(self):
        """Claude-линза #417 на 7b681968d, N1: view 9:00, comment 9:05, comment 15:00 — окно не 9:05–15:00."""
        tl = self.line((t(9), 'open', (None, 7)), (t(9, 5), 'close', (None, 7)), (t(15), 'close', (None, 7)))
        self.assertEqual([tl.lens(x) for x in (t(9, 3), t(12), t(15))], [(None, 7), None, None])

    def test_verdict_chain_measured_from_first_verdict(self):
        """Claude-линза #417 на 3dd65fab0, G6: view 9:00, comment 9:05, 10:00, 10:55, 11:50 — окно 9:00–10:00, не 11:50."""
        tl = self.line((t(9), 'open', (None, 7)), *[(t(h, m), 'close', (None, 7)) for h, m in
                                                    ((9, 5), (10, 0), (10, 55), (11, 50))])
        self.assertEqual([tl.lens(x) for x in (t(9, 30), t(10), t(10, 30), t(11, 30))], [(None, 7), (None, 7), None, None])

    def test_other_work_between_verdicts_does_not_extend_window(self):
        """G7: view 7 в 10:00, comment 10:01, work_state на ветке #202 в 10:05, comment 7 в 10:59 — 10:30 не на #7.
        То же, если между вердиктами — событие другого PR (окно #8 10:10–10:20)."""
        state = (t(10, 5), 'state', (None, 'fix/se74-nerve-lens-names'))
        other_pr = [(t(10, 10), 'open', (None, 8)), (t(10, 20), 'close', (None, 8))]
        for name, mid in (('state', [state]), ('другой PR', other_pr), ('state без карточки и ветки', None)):
            with self.subTest(name):
                tl = self.line((t(10), 'open', (None, 7)), (t(10, 1), 'close', (None, 7)),
                               *(mid or [(t(10, 5), 'state', (None, None))]), (t(10, 59), 'close', (None, 7)))
                self.assertEqual(tl.lens(t(10, 30)), None if mid else (None, 7))

    def test_equal_windows_with_and_without_repo_sort(self):
        """Два окна с равными началом и концом, repo у одного None — без TypeError (Claude-линза #417, N3); при
        равенстве — окно, закрытое позже по порядку событий."""
        tl = self.line((t(10), 'open', (REPO, 3)), (t(10), 'open', (None, 3)), (t(10, 9), 'close', (REPO, 3)),
                       (t(10, 9), 'close', (None, 3)))
        self.assertEqual(tl.lens(t(10, 5)), (None, 3))

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
        return lg.target(parent.build(own, lg.leads), when, REPO)

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

    def test_work_state_between_close_views_starts_new_visit(self):
        """Claude-линза #417 на 3dd65fab0, B1: view #377 в 8:00, work_state на ветке #202 в 8:10, view #377 в 8:55,
        comment в 9:30 — разрыв меньше часа, но работа 8:10–8:55 — на #202. Первый заход без вердикта отброшен: 8:05 —
        «не отнесено», как строка 1 таблицы до state."""
        events = [(t(8), 'open', (None, 377)), (t(8, 10), 'state', (None, 'fix/se74-nerve-lens-names')),
                  (t(8, 55), 'open', (None, 377)), (t(9, 30), 'close', (None, 377))]
        self.assertEqual([self.target(events, w) for w in (t(8, 5), t(8, 30), t(9))],
                         [at.UNATTRIBUTED, ('pr', REPO, 202), ('pr', REPO, 377)])

    def test_head_check_before_verdict_keeps_lens_window(self):
        """Claude-линза #417 на fe4c5017c: work_state 9:00, просмотр #377 в 10:00, чтение файлов, проверка головы в 10:29,
        комментарий в 10:30 — чтение 10:03–10:28 на #377, не на ветку work_state."""
        events = [(t(9), 'state', (None, 'fix/se74-nerve-lens-names')), (t(10), 'open', (None, 377)),
                  (t(10, 29), 'open', (None, 377)), (t(10, 30), 'close', (None, 377))]
        self.assertEqual(self.target(events, t(10, 15)), ('pr', REPO, 377))
        self.assertEqual(self.target(events, t(10, 31)), ('pr', REPO, 202))

    def test_lens_table_of_claude_lens_on_7b681968d(self):
        """Таблица Claude-линзы #417 на 7b681968d: строка — набор событий и ответы в 10:05 и 10:20 (строка 4 — в 11:00).
        X — work_state на ветке #202; своя карточка — карточка и ветка #377."""
        view, comment = (lambda h, m=0: (t(h, m), 'open', (None, 377))), (lambda h, m=0: (t(h, m), 'close', (None, 377)))
        other = lambda h, m=0: (t(h, m), 'state', (None, 'fix/se74-nerve-lens-names'))  # noqa: E731
        own = lambda h, m=0: (t(h, m), 'state', (CARD2, 'fix/se122-qa-anchor'))  # noqa: E731
        lens, x = ('pr', REPO, 377), ('pr', REPO, 202)
        rows = [
            ('1: старый просмотр, state другой карточки, новый заход', [view(8), other(9), view(10), comment(10, 30)],
             (), [(t(9, 30), x), (t(10, 5), lens), (t(10, 20), lens)]),
            ('2: проверка головы перед вердиктом', [view(10), view(10, 29), comment(10, 30)], (),
             [(t(10, 5), lens), (t(10, 20), lens)]),
            ('3: state своей карточки посреди линзы', [view(10), own(10, 10), comment(10, 30)], (),
             [(t(10, 5), lens), (t(10, 20), lens)]),
            ('3: state другой карточки посреди линзы', [view(10), other(10, 10), comment(10, 30)], (),
             [(t(10, 5), lens), (t(10, 20), lens)]),
            ('4: взгляд утром, работа над X, вердикт без просмотра', [view(8), other(9), comment(13, 30)], (),
             [(t(11), x), (t(13, 10), x)]),
            ('5: просмотр субагента, state родителя, вердикт родителя', [other(10, 10), comment(10, 30)], [view(10, 5)],
             [(t(10, 5), lens), (t(10, 20), lens)]),
            ('5: просмотр субагента, state родителя, вердикт субагента', [other(10, 10)], [view(10, 5), comment(10, 30)],
             [(t(10, 5), lens), (t(10, 20), lens)]),
        ]
        for name, events, sub, want in rows:
            with self.subTest(name):
                self.assertEqual([(w, self.target(events, w, sub)) for w, _ in want], want)

    def test_state_of_own_pr_or_no_pr_keeps_visit(self):
        """N1 Claude-линзы #417 на 9c9e59d32 — строки 2 и 3 таблицы вместе: просмотр #377 в 10:00, work_state в 10:10,
        проверка головы в 10:29, вердикт в 10:30. State своего PR и ветка без PR и без карточки (`board-agents`) —
        не другая работа: вся линза на #377. State другого PR или карточки без PR режет заход: 10:05 «не отнесено»."""
        # Репозиторий захода — как у Ledger.record: `gh pr` без -R идёт в репозиторий продукта записи.
        view, comment = (lambda h, m=0: (t(h, m), 'open', (REPO, 377))), (lambda h, m=0: (t(h, m), 'close', (REPO, 377)))
        lens = ('pr', REPO, 377)
        rows = [('своя карточка и ветка', (CARD2, 'fix/se122-qa-anchor'), lens, lens),
                ('своя карточка без ветки', (CARD2, None), lens, lens),
                ('board-agents', (None, 'board-agents'), lens, lens),
                ('ветка другого PR', (None, 'fix/se74-nerve-lens-names'), at.UNATTRIBUTED, ('pr', REPO, 202)),
                ('карточка без PR', ('abcdefghijklmnopqrstuvwx', None), at.UNATTRIBUTED,
                 ('task', 'abcdefghijklmnopqrstuvwx'))]
        for name, state, at_5, at_20 in rows:
            with self.subTest(name):
                events = [view(10), (t(10, 10), 'state', state), view(10, 29), comment(10, 30)]
                self.assertEqual([self.target(events, w) for w in (t(10, 5), t(10, 20), t(10, 30))],
                                 [at_5, at_20, lens])

    def test_state_of_own_pr_keeps_verdict_extension(self):
        """G7 с N1: вердикт #377 в 10:01, state своего PR или `board-agents` в 10:05, второй вердикт в 10:59 — 10:30
        на #377; state ветки другого PR — нет."""
        for state, want in (((CARD2, 'fix/se122-qa-anchor'), ('pr', REPO, 377)), ((None, 'board-agents'), ('pr', REPO, 377)),
                            ((None, 'fix/se74-nerve-lens-names'), ('pr', REPO, 202))):
            with self.subTest(state):
                events = [(t(10), 'open', (REPO, 377)), (t(10, 1), 'close', (REPO, 377)), (t(10, 5), 'state', state),
                          (t(10, 59), 'close', (REPO, 377))]
                self.assertEqual(self.target(events, t(10, 30)), want)

    def test_resolve_passes_leads_to_session_and_subagent(self):
        """N1 и в свёртке resolve(): `board-agents` посреди линзы не режет заход ни сессии, ни её субагента."""
        lg = ledger()
        lg.lines[('s', None)] = at.Timeline()
        for e in ((t(10), 'open', (REPO, 377)), (t(10, 10), 'state', (None, 'board-agents')),
                  (t(10, 29), 'open', (REPO, 377)), (t(10, 30), 'close', (REPO, 377))):
            lg.lines[('s', None)].add(*e)
        lg.lines[('s', 'a.jsonl')] = at.Timeline()
        lg.calls = [('s', None, t(10, 5), 'taibe', 1.0), ('s', 'a.jsonl', t(10, 6), 'taibe', 2.0)]
        self.assertEqual(lg.resolve(), {('pr', REPO, 377): {'calls': 2, 'usd': 3.0}})

    def test_unattributed_label_is_the_nerve_label(self):
        """Одна подпись с долей окна Нерва (budget.SHARE_LABELS): ключ `unattributed`, в отчёте «не отнесено»."""
        self.assertEqual(at.label(at.UNATTRIBUTED), 'не отнесено')
        out = at.text(at.rows({at.UNATTRIBUTED: {'calls': 1, 'usd': 1.0}}), 1.0)
        self.assertIn('не отнесено 100%', out)
        self.assertNotIn('unattributed', out)

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


class MergedTest(unittest.TestCase):
    def test_merged_in_half_open_window(self):
        """Знаменатель «$ на влитый PR»: PR, влитые в [с, по); #150 влит 13.11 10:00Z."""
        at_merge = at.tr.local_time('2026-11-13T10:00:00Z')
        self.assertEqual(at.merged(PRS, at_merge, at_merge + timedelta(hours=1)), {REPO: 1})
        self.assertEqual(at.merged(PRS, at_merge - timedelta(hours=1), at_merge), {REPO: 0})

    def test_cli_writes_merged_and_per_pr(self):
        with tempfile.TemporaryDirectory() as tmp:
            prs, out = os.path.join(tmp, 'prs.json'), os.path.join(tmp, 'out.json')
            with open(prs, 'w', encoding='utf-8') as f:
                json.dump(PRS, f)
            p = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'spend.py'), '2026-11-13 00:00',
                                '2026-11-14 00:00', '--attribution', '--prs', prs, '--json', out],
                               env=dict(os.environ, HOME=tmp), capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn('Влито PR в окне: 1; $ на влитый PR: 0.00.', p.stdout)
            with open(out, encoding='utf-8') as f:
                self.assertEqual(json.load(f)['merged'], {REPO: 1})


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
