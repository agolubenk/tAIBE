"""Тесты spend.py и prices.py на синтетических транскриптах: python3 -I eval/tools/test_spend.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import prices  # noqa: E402
import spend  # noqa: E402

SINCE, UNTIL = datetime(2026, 11, 14, 0, 0), datetime(2026, 11, 15, 23, 59)
PROMPT = 'Сборка Т3, ключ реестра boards, роль 6. Пусковой файл: … Линия: r.37tl (поколение 1) — метка session.'


def ts(day, hour, minute=0):
    """ISO-время UTC для местного времени: дни и окно теста не зависят от пояса машины."""
    return datetime(2026, 11, day, hour, minute).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def user(text, day, hour, minute=0):
    return {'type': 'user', 'timestamp': ts(day, hour, minute), 'message': {'role': 'user', 'content': text}}


def call(rid, day, hour, minute=0, inp=0, write=0, read=0, out=100, w1h=0, model='claude-opus-5-5'):
    usage = {'input_tokens': inp, 'cache_creation_input_tokens': write, 'cache_read_input_tokens': read,
             'output_tokens': out, 'cache_creation': {'ephemeral_1h_input_tokens': w1h}}
    return {'type': 'assistant', 'timestamp': ts(day, hour, minute), 'requestId': rid,
            'message': {'id': 'msg-' + rid, 'model': model, 'usage': usage, 'content': []}}


def usd(*records):
    return sum(prices.call_usd(r['message']['usage'], r['message']['model']) for r in records)


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = cls.tmp.name
        cls.home = os.path.join(root, '.claude')
        cls.inst = os.path.join(root, 'instances')
        os.makedirs(cls.inst)
        for name, body in (('taibe.json', {'slug': 'taibe', 'repo_root': '/x/tAIBE'}),
                           ('hr-helper.json', {'slug': 'hr-helper', 'repo_root': '/x/HR_Helper-v2/'}),
                           ('_shared.json', {'slug': 'shared', 'repo_root': '/x'})):
            with open(os.path.join(cls.inst, name), 'w', encoding='utf-8') as f:
                json.dump(body, f)
        cls.a1 = call('a1', 15, 10, 1, inp=10, write=100_000)                 # холодный, ≤ 250K, первый
        cls.a2 = call('a2', 15, 10, 2, read=290_000, write=10_000, w1h=4_000)  # 250–500K
        cls.a3 = call('a3', 15, 10, 3, read=600_000)                          # 500K–1M
        cls.a4 = call('a4', 15, 10, 4, read=1_200_000)                        # > 1M
        cls.b1 = call('b1', 15, 10, 5, read=40_000, model='claude-haiku-5-5')  # субагент s1
        cls.c1 = call('c1', 14, 9, 30, read=50_000)                           # HR, без роли
        cls.d1 = call('d1', 15, 11, 0, read=200_000)                          # копия s1: только новый вызов
        cls.e1 = call('e1', 15, 12, 0, read=1_000)                            # -x-tAIBE2 — не продукт taibe
        compacted = 'This session is being continued from a previous conversation that ran out of context.'
        tool_result = {'type': 'user', 'timestamp': ts(15, 10, 6),
                       'message': {'content': [{'type': 'tool_result', 'content': compacted}]}}
        files = [
            ('-x-tAIBE-worktrees-fix-a/s1.jsonl',
             [user('<system-reminder>роль 9</system-reminder>', 15, 10), user(PROMPT, 15, 10), cls.a1, cls.a2,
              dict(cls.a2, message=dict(cls.a2['message'], content=[{'type': 'text', 'text': 'второй блок'}])),
              cls.a3, cls.a4, tool_result, user(compacted, 15, 10, 7), call('late', 16, 0, 30, read=10),
              call('synthetic', 15, 10, 8, model='<synthetic>')]),
            ('-x-tAIBE-worktrees-fix-a/s1/subagents/agent-x.jsonl', [user('Найди файл', 15, 10, 5), cls.b1]),
            ('-x-HR-Helper-v2-worktrees-fix-b/s2.jsonl', [user('Почини тест', 14, 9), cls.c1]),
            ('-x-tAIBE/s3.jsonl', [user(PROMPT, 15, 10), cls.a3, cls.d1]),
            ('-x-tAIBE2/s4.jsonl', [user('роль 2', 15, 12), cls.e1]),
            ('-y-other/s9.jsonl', [user(PROMPT, 15, 10), call('z1', 15, 10, read=9_000_000)]),
        ]
        stamp = datetime(2026, 11, 15, 12, 0).timestamp()
        for i, (rel, recs) in enumerate(files):
            path = os.path.join(cls.home, 'projects', rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write('не json\n' + ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in recs))
            os.utime(path, (stamp + 60 * i, stamp + 60 * i))   # порядок создания: оригинал s1 раньше копии s3
        cls.roll, cls.subagents = spend.scan(SINCE, UNTIL, home=cls.home, instances=cls.inst)
        cls.rep = spend.report(cls.roll, cls.subagents, SINCE, UNTIL)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()


class ScanTest(Fixture):
    def test_products_skip_shared_and_longest_first(self):
        self.assertEqual(spend.products(self.inst), [('-x-HR-Helper-v2', 'hr-helper'), ('-x-tAIBE', 'taibe')])

    def test_session_keys_and_stranger_dir_not_read(self):
        self.assertEqual(sorted(self.roll), [('s1', '2026-11-15'), ('s2', '2026-11-14'), ('s3', '2026-11-15'),
                                             ('s4', '2026-11-15')])
        self.assertEqual(self.rep['sessions'], 4)
        self.assertEqual(self.rep['subagents'], 1)
        self.assertEqual(self.rep['calls'], 8)

    def test_role_lineage_key_product_from_first_text_message(self):
        s1, s2, s4 = self.roll['s1', '2026-11-15'], self.roll['s2', '2026-11-14'], self.roll['s4', '2026-11-15']
        self.assertEqual((s1['role'], s1['lineage'], s1['key'], s1['product']), ('6', 'r.37tl', 'boards', 'taibe'))
        self.assertEqual((s2['role'], s2['lineage'], s2['product']), (spend.OTHER, None, 'hr-helper'))
        self.assertEqual((s4['role'], s4['product']), ('2', spend.OTHER))

    def test_session_counts_subagents_dedupe_window_and_synthetic(self):
        s1 = self.roll['s1', '2026-11-15']
        self.assertEqual(s1['calls'], 5)
        self.assertEqual(s1['subagent_calls'], 1)
        self.assertAlmostEqual(s1['subagent_usd'], usd(self.b1), places=12)
        self.assertAlmostEqual(s1['usd'], usd(self.a1, self.a2, self.a3, self.a4, self.b1), places=9)
        self.assertAlmostEqual(sum(s1['parts'].values()), s1['usd'], places=9)

    def test_copied_request_counts_once_where_it_was_made(self):
        s3 = self.roll['s3', '2026-11-15']
        self.assertEqual((s3['calls'], s3['first_ctx']), (1, 200_000))
        self.assertAlmostEqual(s3['usd'], usd(self.d1), places=9)

    def test_bands_cold_compaction_first_call(self):
        s1 = self.roll['s1', '2026-11-15']
        self.assertEqual({k: v['calls'] for k, v in s1['bands'].items()},
                         {'≤ 250K': 2, '250–500K': 1, '500K–1M': 1, '> 1M': 1})
        self.assertEqual((s1['cold'], s1['compactions'], s1['first_ctx']), (1, 1, 100_010))
        self.assertEqual(spend.band(250_000), '≤ 250K')
        self.assertEqual(spend.band(250_001), '250–500K')

    def test_report_groups_and_product_share(self):
        role6 = [g for g in self.rep['by_role'] if g['role'] == '6']
        self.assertEqual([(g['day'], g['product'], g['key'], g['sessions'], g['calls']) for g in role6],
                         [('2026-11-15', 'taibe', 'boards', 2, 6)])
        # контексты роли 6: 40K, 100K, 200K, 300K, 600K, 1,2M — медиана между 200K и 300K, p90 — шестой из шести
        self.assertEqual((role6[0]['ctx_median'], role6[0]['ctx_p90']), (250_000, 1_200_000))
        day15 = {g['product']: g for g in self.rep['by_product'] if g['day'] == '2026-11-15'}
        whole = usd(self.a1, self.a2, self.a3, self.a4, self.b1, self.d1, self.e1)
        self.assertAlmostEqual(day15['taibe']['share'], round((whole - usd(self.e1)) / whole, 4), places=4)
        self.assertEqual([g['share'] for g in self.rep['by_product'] if g['day'] == '2026-11-14'], [1.0])
        self.assertNotIn('ctx', self.rep['rollups'][0])

    def test_cli_report_and_json(self):
        out = os.path.join(self.tmp.name, 'out.json')
        p = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'spend.py'), '2026-11-14 00:00',
                            '2026-11-15 23:59', '--json', out, '--instances', self.inst],
                           env=dict(os.environ, HOME=self.tmp.name), capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('| 2026-11-15 | taibe | 6 | boards | 2 | 6 |', p.stdout)
        with open(out, encoding='utf-8') as f:
            self.assertEqual(json.load(f)['usd'], self.rep['usd'])
        bad = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'spend.py'), 'вчера'],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(bad.returncode, 2)
        self.assertIn('usage', bad.stderr)


class WindowTest(unittest.TestCase):
    def test_hours_and_explicit(self):
        self.assertEqual(spend.window(['--hours', '24'], now=datetime(2026, 11, 15, 12, 0, 30)),
                         (datetime(2026, 11, 14, 12, 0), datetime(2026, 11, 15, 12, 0), None, None))
        self.assertEqual(spend.window(['2026-11-14 00:00', '--json', 'o.json', '2026-11-15 23:59']),
                         (SINCE, UNTIL, 'o.json', None))

    def test_stats(self):
        self.assertEqual((spend.median([]), spend.median([1, 3]), spend.median([5, 1, 3])), (0, 2, 3))
        self.assertEqual((spend.p90([]), spend.p90(list(range(1, 11))), spend.p90([7])), (0, 9, 7))


class PricesTest(unittest.TestCase):
    U = {'input_tokens': 1_000, 'cache_creation_input_tokens': 30_000, 'cache_read_input_tokens': 200_000,
         'output_tokens': 2_000, 'cache_creation': {'ephemeral_1h_input_tokens': 10_000}}

    def test_lookup_order_and_default(self):
        self.assertEqual(prices.price('claude-opus-5-5'), (4, 20, 0.2))
        self.assertEqual(prices.price('claude-opus-5-20260101'), (5, 25, 0.5))
        self.assertEqual(prices.price('claude-fable-5-2'), (10, 50, 0.25))
        self.assertEqual(prices.price('кто-то'), prices.PRICES[prices.DEFAULT])
        self.assertEqual(prices.price(None), prices.PRICES[prices.DEFAULT])

    def test_call_usd_is_sum_of_parts_and_old_formula(self):
        cc = prices.call_cost(self.U, 'claude-opus-5-5')
        self.assertEqual(tuple(cc), prices.PARTS)
        self.assertAlmostEqual(sum(cc.values()), prices.call_usd(self.U, 'claude-opus-5-5'), places=12)
        pi, po, pr = 4, 20, 0.2   # формула budget.py до GL-1, бит в бит
        old = (1_000 * pi + 20_000 * 1.25 * pi + 10_000 * 2 * pi + 200_000 * pr + 2_000 * po) / 1e6
        self.assertEqual(prices.call_usd(self.U, 'claude-opus-5-5'), old)
        self.assertEqual(prices.context_tokens(self.U), 231_000)
        self.assertEqual(prices.call_usd({}, None), 0)


if __name__ == '__main__':
    unittest.main()
