"""TB-22 S22-3: skill_usage.py on a synthetic transcript — the numbers match a count by hand.

python3 -I eval/tools/test_skill_usage.py
"""
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import skill_usage as su  # noqa: E402

DAY = '2026-11-14'
SECRET = 'TRANSCRIPT-TEXT-MUST-NOT-LEAVE'


NOON = '2026-11-14T09:00:00Z'   # local day DAY at any offset from -9 h to +14 h


def call(tid, skill, out=100, cwd='', at=NOON):
    return {'type': 'assistant', 'timestamp': at, 'cwd': cwd,
            'message': {'usage': {'output_tokens': out},
                        'content': [{'type': 'text', 'text': SECRET},
                                    {'type': 'tool_use', 'id': tid, 'name': 'Skill', 'input': {'skill': skill}}]}}


def result(tid, error=False):
    return {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': tid, 'is_error': error,
                                                     'content': 'Launching skill'}]}}


def skill_text(path, body='x' * 350):
    return {'type': 'user', 'isMeta': True,
            'message': {'content': [{'type': 'text', 'text': su.BASE_DIR + path + '\n\n# skill\n' + body}]}}


def bash(tid):
    return {'type': 'assistant', 'timestamp': NOON, 'message': {
        'usage': {'output_tokens': 7}, 'content': [{'type': 'tool_use', 'id': tid, 'name': 'Bash', 'input': {}}]}}


def prompt(text='next'):
    return {'type': 'user', 'message': {'content': text}}


class Fixture:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = self.tmp.name
        self.repo = os.path.join(base, 'repo')
        self.other = os.path.join(base, 'other')
        for d in (self.repo, self.other, os.path.join(base, 'instances'), os.path.join(base, 'projects', 'p', 's1',
                                                                                         'subagents')):
            os.makedirs(d, exist_ok=True)
        for slug, root in (('taibe', self.repo), ('hr-helper', self.other)):
            with open(os.path.join(base, 'instances', slug + '.json'), 'w', encoding='utf-8') as f:
                json.dump({'slug': slug, 'repo_root': root}, f)
        with open(os.path.join(base, 'instances', '_shared.json'), 'w', encoding='utf-8') as f:
            json.dump({'default_product': 'hr-helper'}, f)
        self.root = base
        self.projects = os.path.join(base, 'projects')

    def write(self, rel, rows):
        path = os.path.join(self.projects, rel)
        with open(path, 'w', encoding='utf-8') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')
        return path


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        fx = self.fx
        grill = os.path.join(fx.repo, 'worktrees', 'fix', 'a', '.claude', 'skills', 'grill-task')
        handoff = os.path.join(fx.other, '.claude', 'skills', 'successor-handoff')
        fx.write('p/main.jsonl', [
            # 1: grill-task (taibe, via a worktree), loads its text; a Bash error later in the same turn
            call('t1', 'grill-task', out=100), result('t1'), skill_text(grill),
            bash('b1'), result('b1', error=True), prompt(),
            # the error after the prompt belongs to no skill
            bash('b2'), result('b2', error=True),
            # 2: successor-handoff (hr-helper), the launch fails, no text
            call('t2', 'successor-handoff', out=50, cwd=fx.other), result('t2', error=True), prompt(),
            # 3: a plugin skill — outside every product
            call('t3', 'claude-mem:do', out=10), result('t3'),
            skill_text('/Users/x/.claude/plugins/cache/claude-mem/skills/do'), prompt(),
            # a plugin skill whose launch fails in the product's folder is still not the product's skill
            call('t6', 'context-mode:ctx-stats', cwd=fx.repo), result('t6', error=True), prompt(),
            # 4: grill-task on another day — out of the window
            call('t4', 'grill-task', out=999, at='2026-11-01T09:00:00Z'),
            result('t4'), skill_text(grill), prompt(),
        ])
        # the same call t1 written again in a subagent file (a resume copy) counts once; t5 is new there
        fx.write('p/s1/subagents/agent-1.jsonl', [
            call('t1', 'grill-task', out=100), result('t1'), skill_text(grill),
            call('t5', 'grill-task', out=20), result('t5'), skill_text(grill, body='я' * 220), prompt(),
            # a directory-scoped skill: the entity is the loaded dir's name, not the name the call asked for
            call('t7', 'boards:review', out=5), result('t7'),
            skill_text(os.path.join(fx.repo, 'boards', '.claude', 'skills', 'review'), body=''),
        ])
        fx.write('p/none.jsonl', [prompt('no skills here'), bash('b9'), result('b9', error=True)])
        self.result = su.collect(days=3, projects=fx.projects, root=fx.root, now=datetime(2026, 11, 14, 18))

    def tearDown(self):
        self.fx.tmp.cleanup()

    def test_counts_match_a_count_by_hand(self):
        grill_dir = os.path.join(self.fx.repo, 'worktrees', 'fix', 'a', '.claude', 'skills', 'grill-task')
        loaded = [su.est_tokens(su.BASE_DIR + grill_dir + '\n\n# skill\n' + body) for body in ('x' * 350, 'я' * 220)]
        counts = self.result['counts']
        self.assertEqual(sorted(counts), [('hr-helper', 'successor-handoff', DAY), ('taibe', 'grill-task', DAY),
                                          ('taibe', 'review', DAY)])
        grill = counts[('taibe', 'grill-task', DAY)]
        self.assertEqual(grill['activations'], 2)                 # t1 once (two files) + t5; t4 out of the window
        self.assertEqual(grill['errors'], 1)                      # b1 in the turn of t1; b2 after the prompt is not
        self.assertEqual(grill['tokens'], 100 + loaded[0] + 20 + loaded[1])   # output of the call + loaded text
        self.assertEqual(counts[('hr-helper', 'successor-handoff', DAY)],
                         {'activations': 1, 'tokens': 50, 'errors': 1})   # a failed launch: by cwd, its error

    def test_plugin_skill_is_outside_and_not_sent(self):
        self.assertEqual(self.result['outside'], {'claude-mem:do': 1, 'context-mode:ctx-stats': 1})
        bodies = su.payloads(self.result['counts'], 'h1')
        self.assertEqual(sorted(bodies), ['hr-helper', 'taibe'])

    def test_payload_holds_counters_only(self):
        bodies = su.payloads(self.result['counts'], 'h1')
        wire = json.dumps(bodies)
        self.assertNotIn(SECRET, wire)
        self.assertNotIn('Launching', wire)
        self.assertNotIn(self.fx.root, wire)
        item = bodies['taibe']['days'][0]['items'][0]
        self.assertEqual(sorted(item), ['activations', 'errors', 'kind', 'name', 'tokens'])
        self.assertEqual(bodies['taibe']['host'], 'h1')
        self.assertEqual(bodies['taibe']['days'][0]['day'], DAY)

    def test_host_id_hides_the_machine_name(self):
        hid = su.host_id()
        self.assertRegex(hid, r'^[0-9a-f]{12}$')
        self.assertNotIn(__import__('socket').gethostname(), hid)


class Capture(http.server.BaseHTTPRequestHandler):
    got = []

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers['content-length']))
        Capture.got.append((self.path, self.headers['x-api-key'], json.loads(body)))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"stored": 1, "skipped": 0}')

    def log_message(self, *args):
        pass


class PostTest(unittest.TestCase):
    def test_post_goes_to_the_workspace_of_the_repo_and_repeats_identically(self):
        server = http.server.HTTPServer(('127.0.0.1', 0), Capture)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as tmp:
            repo, home = os.path.join(tmp, 'repo'), os.path.join(tmp, '.t-boards-notebook')
            os.makedirs(repo)
            os.makedirs(home)
            with open(os.path.join(home, 'config.json'), 'w', encoding='utf-8') as f:
                json.dump({'workspaceId': 'ws1', 'repoRoot': repo,
                           'baseUrl': 'http://127.0.0.1:%d/' % server.server_port}, f)
            with open(os.path.join(home, 'api_key'), 'w', encoding='utf-8') as f:
                f.write('k-1\n')
            counts = {('taibe', 'grill-task', DAY): {'activations': 2, 'tokens': 300, 'errors': 0}}
            bodies = su.payloads(counts, 'h1')
            homes = su.sync_homes(os.path.join(tmp, '.t-boards-notebook*'))
            roots = {'taibe': os.path.realpath(repo), 'hr-helper': os.path.join(tmp, 'nowhere')}
            Capture.got = []
            for _ in range(2):
                lines, failed = su.post(bodies, roots, homes)
                self.assertEqual(failed, 0, lines)
            self.assertEqual(len(Capture.got), 2)
            self.assertEqual(Capture.got[0], Capture.got[1])      # full counts, not deltas: a repeat replaces
            path, key, body = Capture.got[0]
            self.assertEqual((path, key), ('/api/ssr/ws1/usage', 'k-1'))
            self.assertEqual(body['days'][0]['items'][0]['activations'], 2)
            lines, failed = su.post(su.payloads({('hr-helper', 'x', DAY): counts[('taibe', 'grill-task', DAY)]},
                                                'h1'), roots, homes)
            self.assertEqual(failed, 1)
            self.assertIn('no sync home', lines[0])


if __name__ == '__main__':
    unittest.main()
