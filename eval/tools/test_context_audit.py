"""context_audit.py --all: every dir of the instance and its subagents; --product: the dirs of one product (SE-73);
one count per request, the cause of each cold
call and the generation cost by window size (d-f63b-economy-0711, item 4). Fake HOME, fixture transcripts.

Run: python3 -I eval/tools/test_context_audit.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, 'context_audit.py')
CONFIG = os.path.join(HERE, '..', 'nerve', 'config.json')
T0 = datetime.now(timezone.utc) - timedelta(hours=3)


def project_dir(root):
    return re.sub(r'[^A-Za-z0-9]', '-', root)


def call(rid, minute, ctx, write, tools=(), out=100):
    """One answer: `write` tokens of cache write out of `ctx`, the rest read from cache."""
    content = [{'type': 'tool_use', 'id': 'tu-' + rid + str(i), 'name': n, 'input': inp} for i, (n, inp) in
               enumerate(tools)]
    return {'type': 'assistant', 'requestId': rid, 'timestamp': (T0 + timedelta(minutes=minute)).isoformat(),
            'message': {'id': 'm-' + rid, 'model': 'claude-opus-5-5', 'content': content,
                        'usage': {'input_tokens': 0, 'cache_creation_input_tokens': write,
                                  'cache_creation': {'ephemeral_1h_input_tokens': write},
                                  'cache_read_input_tokens': ctx - write, 'output_tokens': out}}}


def attachment(kind, minute):
    return {'type': 'attachment', 'timestamp': (T0 + timedelta(minutes=minute)).isoformat(),
            'attachment': {'type': kind}}


def prompt(text, minute):
    return {'type': 'user', 'timestamp': (T0 + timedelta(minutes=minute)).isoformat(),
            'message': {'role': 'user', 'content': text}}


MAIN = [
    prompt('Наследник сессии. Handoff: x', 0),
    call('r1', 0, 60_000, 40_000),                                                      # start
    call('r2', 1, 70_000, 5_000, [('ToolSearch', {'query': 'select:Monitor'}),
                                  ('Bash', {'command': 'python3 -I eval/tools/lineage.py ack'})]),
    attachment('deferred_tools_record', 2),
    call('r3', 2, 400_000, 390_000),                                                    # ToolSearch
    call('r4', 75, 410_000, 400_000),                                                   # pause ≥ 60 min
    attachment('deferred_tools_record', 76),
    call('r5', 76, 420_000, 410_000),                                                   # record without ToolSearch
    attachment('mcp_instructions_delta', 77),
    call('r6', 77, 430_000, 420_000),                                                   # tool set change
    call('r7', 78, 440_000, 1_000, [('Write', {'file_path': '/x/handoff/2026-11-07/boards/HANDOFF-r.md',
                                               'content': 'x'})]),
    call('r8', 79, 450_000, 1_000),
]
FORK = [prompt('Продолжи', 0), call('r1', 0, 60_000, 40_000), call('f1', 80, 100_000, 1_000)]
SUB = [prompt('scout', 0), call('s1', 3, 40_000, 35_000)]


class ContextAuditAllTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(CONFIG, encoding='utf-8') as f:
            cfg = json.load(f)
        cls.tmp = tempfile.TemporaryDirectory()
        home = cls.tmp.name
        projects = os.path.join(home, '.claude', 'projects')
        layer = project_dir(os.path.dirname(cfg['layer_home'].rstrip('/')))
        host_wt = project_dir(cfg['repo_root']) + '-worktrees-fix-x'
        files = {os.path.join(projects, layer, 'a.jsonl'): MAIN,
                 os.path.join(projects, host_wt, 'b.jsonl'): FORK,
                 os.path.join(projects, layer, 'a', 'subagents', 'agent-1.jsonl'): SUB,
                 os.path.join(projects, '-Users-someone-else', 'c.jsonl'): MAIN}
        for path, rows in files.items():
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n')
        out = os.path.join(home, 'out.json')
        env = dict(os.environ, HOME=home)
        cls.res = subprocess.run([sys.executable, '-I', TOOL, '--hours', '24', '--all', '--json', out],
                                 capture_output=True, text=True, env=env, timeout=60)
        with open(out, encoding='utf-8') as f:
            cls.data = json.load(f)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_runs(self):
        self.assertEqual(self.res.returncode, 0, self.res.stderr)
        self.assertIn('8. Поколение по окну', self.res.stdout)

    def test_every_instance_dir_and_subagents_once_per_request(self):
        self.assertEqual((self.data['sessions'], self.data['subagents']), (2, 1))  # the stranger's dir is not read
        self.assertEqual(sorted(self.data['base']), [60_000, 100_000])  # section 6: main sessions only (fork: f1)
        self.assertEqual(self.data['calls'], 8 + 1 + 1)     # r1 of the fork is the same request

    def test_cold_causes(self):
        cold = {k: v['n'] for k, v in self.data['cold'].items()}
        self.assertEqual(cold, {'старт': 2, 'ToolSearch': 1, 'пауза ≥ 60 мин': 1,
                                'запись отложенных без ToolSearch': 1, 'смена набора инструментов': 1})

    def test_generation_by_window(self):
        bands = self.data['generations']
        self.assertEqual(set(bands), {'≤ 250K', '250–500K'})
        big = bands['250–500K']
        self.assertEqual((big['sessions'], big['with_handoff']), (1, 1))
        calls = [sum(v for v in [
            c['message']['usage']['cache_creation_input_tokens'] * 2 * 4,
            c['message']['usage']['cache_read_input_tokens'] * 0.2,
            c['message']['usage']['output_tokens'] * 20]) / 1e6 for c in MAIN if c['type'] == 'assistant']
        share = (sum(calls[:2]) + sum(calls[6:])) / sum(calls)   # intake r1–r2, outtake r7–r8
        self.assertAlmostEqual(big['handoff_share'], round(share, 3), places=3)
        self.assertEqual(big['life_min'], 79.0)
        self.assertEqual(bands['≤ 250K']['with_handoff'], 0)   # the fork has no ack and no handoff write


class ContextAuditProductTest(unittest.TestCase):
    """SE-73: --product <slug> reads the dirs of one product from instances/ — its checkout and worktrees — not the
    neighbour with a longer name, not a scratchpad dir that only mentions the path, not the other product."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.join(HERE, '..', 'nerve'))
        import products
        _shared, known = products.load()
        taibe, hr = project_dir(known['taibe']['repo_root']), project_dir(known['hr-helper']['repo_root'])
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = cls.tmp.name
        projects = os.path.join(cls.home, '.claude', 'projects')
        team = [prompt('Сборка Т3, ключ реестра boards, роль 6.', 0), call('t1', 1, 50_000, 40_000)]
        cls.own = [taibe, taibe + '-worktrees-feature-x']
        files = {os.path.join(projects, taibe, 'a.jsonl'): team,
                 os.path.join(projects, taibe + '-worktrees-feature-x', 'b.jsonl'): team,
                 os.path.join(projects, taibe, 'a', 'subagents', 'agent-1.jsonl'): SUB,
                 os.path.join(projects, taibe + 'x', 'c.jsonl'): team,                       # a longer neighbour
                 os.path.join(projects, '-private-tmp-claude-501-' + taibe + '-1-scratchpad', 'd.jsonl'): team,
                 os.path.join(projects, hr, 'e.jsonl'): team}
        for path, rows in files.items():
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def audit(self, *flags):
        out = os.path.join(self.home, 'out.json')
        res = subprocess.run([sys.executable, '-I', TOOL, '--hours', '24', '--json', out, *flags],
                             capture_output=True, text=True, env=dict(os.environ, HOME=self.home), timeout=60)
        data = None
        if res.returncode == 0:
            with open(out, encoding='utf-8') as f:
                data = json.load(f)
        return res, data

    def test_only_the_product_dirs(self):
        res, data = self.audit('--product', 'taibe')
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual((data['product'], data['dirs']), ('taibe', sorted(self.own)))
        self.assertEqual((data['sessions'], data['subagents'], data['calls']), (2, 0, 2))
        first = res.stdout.splitlines()[0]
        self.assertTrue(first.startswith('Продукт taibe: папок 2 — '), first)
        self.assertIn(self.own[1], first)

    def test_all_adds_the_product_subagents(self):
        res, data = self.audit('--product', 'taibe', '--all')
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual((data['sessions'], data['subagents']), (2, 1))

    def test_without_the_flag_nothing_changes(self):
        res, data = self.audit()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertNotIn('product', data)
        self.assertFalse(res.stdout.startswith('Продукт'))
        self.assertEqual(data['sessions'], 1)                    # the HR team dir, as before

    def test_unknown_product(self):
        res, _ = self.audit('--product', 'nope')
        self.assertNotEqual(res.returncode, 0)
        self.assertIn('нет продукта «nope»', res.stderr)
        self.assertIn('taibe', res.stderr)


class HandoffMarkersTest(unittest.TestCase):
    """Review of #105: live sessions had a commit message with «lineage.py ack» (intake 80 %) and a grep or a dry run
    of spawn_session.sh (outtake 57–79 %); lowercase handoff files were missed."""

    def marks(self, *tools):
        gen = cg.new_generation()
        for name, inp in tools:
            gen['calls'].append(1.0)
            cg.note_tool(gen, name, inp)
        gen['t0'] = gen['t1'] = T0
        return cg.finish(gen)

    def test_intake_is_a_command_not_a_mention(self):
        for cmd in ('python3 -I /a/eval/tools/lineage.py ack', 'cd /a && python3 eval/tools/lineage.py ack',
                    'TAIBE_LINEAGE=x python3 -I lineage.py ack'):
            with self.subTest(cmd):
                self.assertEqual(self.marks(('Bash', {'command': 'ls'}), ('Bash', {'command': cmd}))['intake'], 1)
        for cmd in ('git commit -m "accept handoff; then lineage.py ack"', 'grep -n "lineage.py ack" SKILL.md',
                    'echo run lineage.py ack'):
            with self.subTest(cmd):
                self.assertIsNone(self.marks(('Bash', {'command': cmd}))['intake'])

    def test_outtake_markers(self):
        spawn = ('Bash', {'command': 'bash eval/tools/spawn_session.sh --handoff /h/handoff/x.md'})
        quiet = [('Bash', {'command': 'bash eval/tools/spawn_session.sh --handoff /h/x.md --dry-run'}),
                 ('Bash', {'command': "sed -n 1,9p spawn_session.sh | grep -E 'x|--handoff'"}),
                 ('Write', {'file_path': '/a/.claude/skills/successor-handoff/SKILL.md'}),
                 ('Write', {'file_path': '/a/docs/notes.md'})]
        for tool in quiet:
            with self.subTest(tool):
                self.assertIsNone(self.marks(tool)['out_from'])
        for path in ('/p/handoff/2026-11-07/boards/HANDOFF-r.md', '/p/handoff/hl8l/handoff-hl8l-21.md',
                     '/p/state/coord-r.ab-handoff.md'):
            with self.subTest(path):
                self.assertEqual(self.marks(('Bash', {'command': 'ls'}), ('Write', {'file_path': path}))['out_from'], 1)
        self.assertEqual(self.marks(spawn)['out_from'], 0)

    def test_outtake_starts_after_the_last_unit_of_work(self):
        write = ('Write', {'file_path': '/p/handoff/HANDOFF-a.md'})
        gen = self.marks(write, ('Bash', {'command': 'cd /w && git commit -qm fix'}), write,
                         ('Bash', {'command': 'bash spawn_session.sh --handoff /p/handoff/HANDOFF-a.md'}))
        self.assertEqual(gen['out_from'], 2)
        self.assertEqual(self.marks(write, ('Bash', {'command': 'git push -q origin x'}))['out_from'], 0)


sys.path.insert(0, HERE)
import context_gen as cg  # noqa: E402

if __name__ == '__main__':
    unittest.main()
