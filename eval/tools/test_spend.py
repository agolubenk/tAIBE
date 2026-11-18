"""Тесты spend.py и prices.py на синтетических транскриптах: python3 -I eval/tools/test_spend.py"""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import prices  # noqa: E402
import spend  # noqa: E402
import budget  # noqa: E402 — eval/nerve, путь добавил spend.py

SINCE, UNTIL = datetime(2026, 11, 14, 0, 0), datetime(2026, 11, 15, 23, 59)
PROMPT = 'Сборка Т3, ключ реестра boards, роль 6. Пусковой файл: … Линия: r.37tl (поколение 1) — метка session.'
ROOTS = {'taibe': '/x/tAIBE', 'hr-helper': '/x/HR_Helper-v2/'}
K1, K2 = ('s1', '2026-11-15', 'taibe'), ('s2', '2026-11-14', 'hr-helper')
K3, K4 = ('s3', '2026-11-15', 'taibe'), ('s4', '2026-11-15', spend.UNATTRIBUTED)


def ts(day, hour, minute=0):
    """ISO-время UTC для местного времени: дни и окно теста не зависят от пояса машины."""
    return datetime(2026, 11, day, hour, minute).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def user(text, day, hour, minute=0):
    return {'type': 'user', 'timestamp': ts(day, hour, minute), 'message': {'role': 'user', 'content': text}}


def call(rid, day, hour, minute=0, inp=0, write=0, read=0, out=100, w1h=0, model='claude-opus-5-5', cwd=None):
    usage = {'input_tokens': inp, 'cache_creation_input_tokens': write, 'cache_read_input_tokens': read,
             'output_tokens': out, 'cache_creation': {'ephemeral_1h_input_tokens': w1h}}
    rec = {'type': 'assistant', 'timestamp': ts(day, hour, minute), 'requestId': rid,
           'message': {'id': 'msg-' + rid, 'model': model, 'usage': usage, 'content': []}}
    return dict(rec, cwd=cwd) if cwd else rec


def usd(*records):
    return sum(prices.call_usd(r['message']['usage'], r['message']['model']) for r in records)


def write_instances(inst):
    os.makedirs(inst)
    for slug, root in ROOTS.items():
        with open(os.path.join(inst, slug + '.json'), 'w', encoding='utf-8') as f:
            json.dump({'slug': slug, 'repo_root': root}, f)
    with open(os.path.join(inst, '_shared.json'), 'w', encoding='utf-8') as f:
        json.dump({'slug': 'shared', 'repo_root': '/x'}, f)


def write_files(home, files, stamp):
    """Транскрипты по порядку создания: оригинал раньше копии (время изменения растёт на минуту)."""
    for i, (rel, recs) in enumerate(files):
        path = os.path.join(home, 'projects', rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write('не json\n' + ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in recs))
        os.utime(path, (stamp + 60 * i, stamp + 60 * i))


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = cls.tmp.name
        cls.home = os.path.join(root, '.claude')
        cls.inst = os.path.join(root, 'instances')
        write_instances(cls.inst)
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
        write_files(cls.home, files, datetime(2026, 11, 15, 12, 0).timestamp())   # оригинал s1 раньше копии s3
        cls.roll, cls.subagents = spend.scan(SINCE, UNTIL, home=cls.home, instances=cls.inst)
        cls.rep = spend.report(cls.roll, cls.subagents, SINCE, UNTIL)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()


class ScanTest(Fixture):
    def test_roots_skip_shared(self):
        self.assertEqual(spend.roots(self.inst), ROOTS)

    def test_session_keys_and_stranger_dir_not_read(self):
        self.assertEqual(sorted(self.roll), sorted([K1, K2, K3, K4]))
        self.assertEqual(self.rep['sessions'], 4)
        self.assertEqual(self.rep['subagents'], 1)
        self.assertEqual(self.rep['calls'], 8)

    def test_role_lineage_key_product_from_first_text_message(self):
        s1, s2, s4 = self.roll[K1], self.roll[K2], self.roll[K4]
        self.assertEqual((s1['role'], s1['lineage'], s1['key'], s1['product']), ('6', 'r.37tl', 'boards', 'taibe'))
        self.assertEqual((s2['role'], s2['lineage'], s2['product']), (spend.OTHER, None, 'hr-helper'))
        self.assertEqual((s4['role'], s4['product']), ('2', spend.UNATTRIBUTED))   # -x-tAIBE2 — не папка tAIBE

    def test_session_counts_subagents_dedupe_window_and_synthetic(self):
        s1 = self.roll[K1]
        self.assertEqual(s1['calls'], 5)
        self.assertEqual(s1['subagent_calls'], 1)
        self.assertAlmostEqual(s1['subagent_usd'], usd(self.b1), places=12)
        self.assertAlmostEqual(s1['usd'], usd(self.a1, self.a2, self.a3, self.a4, self.b1), places=9)
        self.assertAlmostEqual(sum(s1['parts'].values()), s1['usd'], places=9)

    def test_copied_request_counts_once_where_it_was_made(self):
        s3 = self.roll[K3]
        self.assertEqual((s3['calls'], s3['first_ctx']), (1, 200_000))
        self.assertAlmostEqual(s3['usd'], usd(self.d1), places=9)

    def test_bands_cold_compaction_first_call(self):
        s1 = self.roll[K1]
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

    def test_report_totals_over_all_calls(self):
        """Строка дня (PR 3): медиана и p90 контекста — по всем вызовам окна, полосы — сумма свёрток."""
        ctx = [c for r in self.roll.values() for c in r['ctx']]
        self.assertEqual((self.rep['ctx_median'], self.rep['ctx_p90']), (spend.median(ctx), spend.p90(ctx)))
        self.assertGreater(len({spend.median(r['ctx']) for r in self.roll.values()}), 1)  # не медиана одной сессии
        self.assertEqual(sum(v['calls'] for v in self.rep['bands'].values()), self.rep['calls'])
        self.assertAlmostEqual(sum(v['usd'] for v in self.rep['bands'].values()), self.rep['usd'], places=3)
        self.assertEqual(list(self.rep['bands']), [name for _, name in spend.BANDS])
        roll = copy.deepcopy(self.roll)  # 20 вызовов: p90 — восемнадцатый, не максимум
        for r in roll.values():
            r['ctx'] = []
        next(iter(roll.values()))['ctx'] = [k * 10_000 for k in range(1, 21)]
        rep = spend.report(roll, 0, SINCE, UNTIL)
        self.assertEqual((rep['ctx_median'], rep['ctx_p90']), (105_000, 180_000))

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


class OneProductTest(unittest.TestCase):
    """Условие coord 15.11 13:30: продукт вызова — одна функция для доли окна Нерва (budget.Meter, SE-66) и spend.py.
    Сессия в папке tAIBE, у которой cwd — worktree, временная папка, соседняя папка и репо HR, делится одинаково."""

    def test_same_session_same_split_in_budget_and_spend(self):
        p = [call('p1', 15, 10, 1, read=100_000, cwd='/x/tAIBE/worktrees/fix/a'),
             call('p2', 15, 10, 2, read=50_000, cwd='/private/tmp/x'),            # нет корня — папка сессии
             call('p3', 15, 10, 3, read=70_000, cwd='/x/HR_Helper-v2/apps/api'),  # чужой репо — его продукт
             call('p4', 15, 10, 4, read=20_000, cwd='/x/tAIBE2'),                 # не под /x/tAIBE — папка сессии
             call('p5', 15, 10, 5, read=30_000, cwd='/x/HR_Helper-v2')]           # субагент в репо HR
        with tempfile.TemporaryDirectory() as root:
            home, inst = os.path.join(root, '.claude'), os.path.join(root, 'instances')
            write_instances(inst)
            write_files(home, [('-x-tAIBE-worktrees-fix-a/s5.jsonl', [user(PROMPT, 15, 10)] + p[:4]),
                               ('-x-tAIBE-worktrees-fix-a/s5/subagents/agent-y.jsonl', p[4:])],
                        datetime(2026, 11, 15, 12, 0).timestamp())
            roll, _ = spend.scan(SINCE, UNTIL, home=home, instances=inst)
            got = {g['product']: g['usd'] for g in spend.report(roll, 0, SINCE, UNTIL)['by_product']}
            now = datetime(2026, 11, 15, 12, 0).astimezone()
            meter = budget.Meter({}, products=budget.Products(spend.roots(inst)))
            meter.update(os.path.join(home, 'projects'), now)
            want = meter.by_product(now - timedelta(hours=5), now)
        self.assertEqual(sorted(got), ['hr-helper', 'taibe'])
        self.assertEqual(sorted(want), sorted(got))
        for slug in got:
            self.assertAlmostEqual(got[slug], want[slug], places=3)
        self.assertAlmostEqual(got['hr-helper'], round(usd(p[2], p[4]), 4), places=9)
        self.assertEqual({k[2] for k in roll if k[0] == 's5'}, {'taibe', 'hr-helper'})


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
