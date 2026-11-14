#!/usr/bin/env python3
"""queue_focus.py: the board's order on a synthetic queue and on the real plan files. Run: python3 -I <this file>"""
import glob
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import queue_focus as q  # noqa: E402

PLANS = sorted(glob.glob(os.path.join(HERE, '..', 'board', 'plan-*.json')))


def cards(*rows):
    return {r['key']: dict({'title': r['key'], 'status': 'to-do', 'priority': 'medium', '_project': ''}, **r)
            for r in rows}


class QueueFocusTest(unittest.TestCase):
    def keys(self, result, part='focus'):
        return [i['key'] for i in result[part]]

    def test_bugs_first_then_active_then_priority(self):
        got = q.focus(cards({'key': 'T-1', 'priority': 'high'}, {'key': 'T-2', 'status': 'in-progress', 'priority': 'low'},
                            {'key': 'E-1', 'kind': 'bug', 'priority': 'low'}, {'key': 'E-2', 'severity': 'critical'},
                            {'key': 'T-3', 'priority': 'low'}), wip=5)
        self.assertEqual(self.keys(got), ['E-2', 'E-1', 'T-2', 'T-1', 'T-3'])

    def test_out_of_focus(self):
        got = q.focus(cards({'key': 'A', 'status': 'done'}, {'key': 'B', 'halfBaked': True},
                            {'key': 'C', 'report': 'не строим'}, {'key': 'G'}, {'key': 'G-1', 'parent': 'G'},
                            {'key': 'L', 'status': 'Брёвна'}))
        self.assertEqual(self.keys(got), ['G-1'])  # the goal G has an open subtask — its leaf is the work
        self.assertEqual(got['skipped'], {'final': 2, 'halfBaked': 1, 'report': 1, 'container': 1, 'others': 0})
        idea_only = q.focus(cards({'key': 'G'}, {'key': 'G-1', 'parent': 'G', 'halfBaked': True}))
        self.assertEqual(self.keys(idea_only), ['G'])  # only a raw idea under it — the goal is still the work

    def test_blocked_and_unblocking(self):
        got = q.focus(cards({'key': 'A', 'blocks': ['B']}, {'key': 'B', 'blocks': ['C']}, {'key': 'C'},
                            {'key': 'D', 'priority': 'medium'}, {'key': 'E', 'blockedBy': ['Z']}))
        self.assertEqual(self.keys(got), ['A', 'D', 'E'])  # A unblocks 2 → before D; Z unknown → E not blocked
        self.assertEqual([(i['key'], i['blockedBy']) for i in got['blocked']], [('B', ['A']), ('C', ['B'])])
        done = q.focus(cards({'key': 'A', 'status': 'done', 'blocks': ['B']}, {'key': 'B'}))
        self.assertEqual(self.keys(done), ['B'])  # a closed blocker blocks nothing

    def test_session_sees_only_its_own_wip(self):
        board = cards({'key': 'A', 'status': 'in-progress', 'session': 'r.aa'},
                      {'key': 'B', 'status': 'in-progress', 'session': 'r.bb'},
                      {'key': 'C', 'status': 'in-progress', 'workState': {'session': 'r.aa.cc'}},
                      {'key': 'D', 'priority': 'high'})
        got = q.focus(board, wip=3, session='r.aa')
        self.assertEqual(self.keys(got), ['A', 'C', 'D'])  # own line incl. descendant; sibling's B is out
        self.assertEqual(got['skipped']['others'], 1)
        self.assertEqual(len(q.focus(board, wip=3)['focus']), 3)  # without a session: WIP 3 — finish first

    def test_long_chain_no_recursion_limit(self):
        chain = cards(*({'key': 'K%04d' % i, 'blocks': ['K%04d' % (i + 1)]} for i in range(3000)))
        self.assertEqual(q.unblocks(chain, 'K0000').__len__(), 2999)

    def test_wip_limit_stops_new_starts(self):
        got = q.focus(cards({'key': 'A', 'status': 'in-progress'}, {'key': 'B', 'status': 'на ревью'},
                            {'key': 'C', 'priority': 'high'}), wip=2)
        self.assertEqual(self.keys(got), ['A', 'B'])
        self.assertIn('новое не бери', got['note'])

    def test_export_list_shape(self):
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
            json.dump({'tasks': [{'ticketId': 'ОШИБКИ-3', 'title': 'x', 'status': 'открыто', 'priority': 'high',
                                  'project': 'Ошибки'}, {'ticketId': 'ЗАДАЧИ-9', 'title': 'y', 'status': 'в работе'}]}, f)
        try:
            got = q.focus(q.load([f.name]))
        finally:
            os.remove(f.name)
        self.assertEqual(self.keys(got), ['ОШИБКИ-3', 'ЗАДАЧИ-9'])
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
            json.dump([{'title': 'a', 'status': 'to-do'}, {'title': 'b', 'status': 'to-do'}], f)
        try:
            self.assertEqual(len(q.load([f.name])), 2)  # keyless cards do not overwrite each other
        finally:
            os.remove(f.name)
        self.assertTrue(got['focus'][0]['bug'])

    @unittest.skipUnless(PLANS, 'no plan files')
    def test_real_plans_compact(self):
        result = q.focus(q.load(PLANS))
        text = q.render(result)
        self.assertLessEqual(len(text), 2000)  # a focus fits a capsule (≤ 2K), not the whole queue
        keys = self.keys(result)
        self.assertFalse(any(k.startswith('GL-00') and k != 'GL-003' for k in keys))  # goals with leaves are out
        all_cards = q.load(PLANS)
        self.assertTrue(all(not all_cards[k].get('halfBaked') for k in keys))


def row(rid, cards=(), **data):
    return {'id': rid, 'data': dict({'status': 'planned', 'who': 'agent', 'cards': list(cards)}, **data)}


def card(key, st='to-do', k='task', s='medium', **extra):
    return dict({'key': key, 'ws': 'aiboards-eval', 't': key, 'k': k, 's': s, 'st': st}, **extra)


class PlanTest(unittest.TestCase):
    """SE-65 (F1): the next card comes from the product's plan rows, in row order, the board's law inside a row."""

    def test_rows_of_a_product_and_of_the_default_product(self):
        docs = [row('w-taibe-a'), row('w-n-high'), row('w-taibe-owner', who='owner'), row('w-taibe-b', status='blocked'),
                row('w-taibe-c', status='done'), {'id': 'w-taibe-focus-doc', 'data': {'kind': 'focus'}},
                row('track-x'), row('w-taibe-old', archived=True)]
        taibe = [r for r, _ in q.plan_rows(docs, 'taibe', 'hr-helper', ['hr-helper', 'taibe'])]
        hr = [r for r, _ in q.plan_rows(docs, 'hr-helper', 'hr-helper', ['hr-helper', 'taibe'])]
        self.assertEqual(taibe, ['w-taibe-a'])
        self.assertEqual(hr, ['w-n-high'])

    def test_rank_focus_order_first_then_plan_start_then_undated_last(self):
        rows = [('w-x-late', {'planStart': '2026-11-20'}), ('w-x-early', {'planStart': '2026-11-10'}),
                ('w-x-nodate', {}), ('w-x-picked', {'planStart': '2026-12-01'})]
        self.assertEqual([r for r, _ in q.rank_rows(rows, ['w-x-picked'])],
                         ['w-x-picked', 'w-x-early', 'w-x-late', 'w-x-nodate'])

    def test_next_skips_held_cards_takes_abandoned_first_and_a_card_once(self):
        rows = [('w-t-1', {'cards': [card('TB-1', st='in-progress'), card('TB-2', s='low'),
                                     card('TB-3', st='in-progress', mark='без аренды', c='Q-17'), card('TB-4', st='done')]}),
                ('w-t-2', {'cards': [card('TB-2'), card('SE-9', k='bug', s='high')]})]
        out = q.plan_next(rows)
        self.assertEqual([i['key'] for i in out], ['TB-3', 'TB-2', 'SE-9'])
        self.assertEqual([i['row'] for i in out], ['w-t-1', 'w-t-1', 'w-t-2'])
        self.assertIn('брошена', out[0]['why'])
        self.assertEqual(out[2]['why'], 'ошибка high')

    def test_grilling_waits_for_the_owner_and_p0_ranks_as_urgent(self):
        rows = [('w-t-1', {'cards': [card('TB-1', st='grilling', s='urgent'), card('APP-2', s='medium'),
                                     card('APP-1', s='p0')]})]
        self.assertEqual([i['key'] for i in q.plan_next(rows)], ['APP-1', 'APP-2'])

    def test_bug_before_task_inside_a_row_and_top_limit(self):
        rows = [('w-t-1', {'cards': [card('TB-%d' % n, s='urgent') for n in range(1, 7)] + [card('SE-1', k='bug', s='low')]})]
        out = q.plan_next(rows, top=3)
        self.assertEqual([i['key'] for i in out], ['SE-1', 'TB-1', 'TB-2'])

    def test_plan_reads_the_focus_doc_order_and_says_when_empty(self):
        docs = [row('w-taibe-a', [card('TB-1')], planStart='2026-11-01'), row('w-taibe-b', [card('TB-2')], planStart='2026-11-02'),
                {'id': 'focus-taibe', 'data': {'kind': 'focus', 'rows': ['w-taibe-b']}}]
        res = q.plan('taibe', root=os.path.join(HERE, '..', '..'), docs=docs)
        self.assertEqual([i['key'] for i in res['next']], ['TB-2', 'TB-1'])
        empty = q.plan('taibe', root=os.path.join(HERE, '..', '..'), docs=[row('w-taibe-a', [card('TB-1', st='done')])])
        self.assertIn('Не бери работу вне плана', q.render_plan(empty))


if __name__ == '__main__':
    unittest.main()
