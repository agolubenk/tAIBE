#!/usr/bin/env python3
"""infra/checks on a synthetic repository: each check finds its defect, fixtures are warnings, the allowlist works.
Run: python3 -I infra/checks/test_checks.py"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run  # noqa: E402
import secrets_scan  # noqa: E402

# TB-136: one corpus for both rule sets; boards/packages/redact/src/index.test.ts reads the same file.
CORPUS = os.path.join(HERE, '..', '..', 'boards', 'packages', 'redact', 'fixtures', 'secrets-corpus.json')

# Fake values assembled at runtime, so this file itself holds no key-shaped literal.
GH = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'
AWS = 'AK' + 'IA' + 'Q3R4ND0M7Z5RXK2W'


def write(root, rel, text, mode='w'):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode, **({} if 'b' in mode else {'encoding': 'utf-8', 'newline': ''})) as f:
        f.write(text)


class ChecksTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.git('init', '-q')

    def tearDown(self):
        shutil.rmtree(self.root)

    def git(self, *args):
        subprocess.run(['git', '-C', self.root, *args], check=True, capture_output=True)

    def findings(self, only='secrets,hygiene,data,syntax', base=None):
        self.git('add', '-A')
        found, _ = run.collect(self.root, tuple(only.split(',')), base)
        return {(f.check, f.level, f.path, f.message.split(':')[0]) for f in found}

    def test_secrets_real_vs_fixture_vs_placeholder(self):
        write(self.root, 'src/config.ts', 'const token = "%s";\nconst id = "%s";\n' % (GH, AWS))
        write(self.root, 'src/app.test.ts', 'const token = "%s";\n' % GH)
        write(self.root, 'src/ok.ts', 'const url = "postgresql://user:${PASSWORD}@db/x";\n'
                                       'const k = "%s"; // checks: allow-secret\n'
                                       'password = "changeme-please-123"\n' % GH)
        write(self.root, 'src/literal.py', 'api_key = "Zq8fK2mP9xL4vB7nR1tY"\n')
        got = self.findings('secrets')
        self.assertIn(('secrets', 'error', 'src/config.ts', 'github-token'), got)
        self.assertIn(('secrets', 'error', 'src/config.ts', 'aws-access-key'), got)
        self.assertIn(('secrets', 'warning', 'src/app.test.ts', 'github-token'), got)
        self.assertIn(('secrets', 'error', 'src/literal.py', 'literal api_key'), got)
        self.assertFalse(any(p == 'src/ok.ts' for _, _, p, _ in got))

    def test_secrets_shared_corpus(self):
        with open(CORPUS, encoding='utf-8') as f:
            cases = json.load(f)['cases']
        self.assertGreaterEqual(len(cases), 30)
        for case in cases:
            with self.subTest(case['id']):
                text = case['before'] + ''.join(case['value']) + case['after']
                found = secrets_scan.scan_text('src/corpus.txt', text)
                self.assertIn(case['scan'], {f.message.split(':')[0] for f in found if f.level == 'error'})
        with open(CORPUS, encoding='utf-8') as f:
            self.assertEqual(secrets_scan.scan_text('src/corpus.json', f.read()), [], 'the corpus file is key-shaped')

    def test_secrets_code_and_placeholders_stay_quiet(self):
        quiet = [
            'apiKey: options.apiKey,', 'api_key: z.string(),', 'access_token = settings.accessToken',
            'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'T_BOARDS_API_KEY=$T_BOARDS_API_KEY',
            'POSTGRES_PASSWORD: your_secure_password_here', '- Password: `kaneo_password` (change this!)',
            '"password": "パスワードを入力してください"', 'hdr = f"Authorization: Bearer {self.token()}\\n"',
            'import { Route as LayoutAuthenticatedWorkspaceSlugTaskTicketIdChar123TitleChar125RouteImport }',
            '`http://localhost:5173/dashboard/workspace/' + 'Ab3dE5fG7hJ9kL1mN3pQ5r/project/St7uV9wX1yZ3aB5cD7eF9g/'
            'task/Hj2kL4mN6pQ8rS0tU2vW4x`',
        ]
        for line in quiet:
            with self.subTest(line):
                self.assertEqual(secrets_scan.scan_line(line), [])

    def test_hygiene(self):
        write(self.root, '.env', 'A=1\n')
        write(self.root, '.env.example', 'A=\n')
        write(self.root, 'a.md', 'text\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n')
        write(self.root, 'run.sh', '#!/bin/bash\r\necho hi\r\n')
        write(self.root, 'big.bin', b'\1' * 1_100_000, 'wb')
        write(self.root, 'src/long.ts', 'x\n' * 10)
        self.git('add', '-A')
        self.git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
        write(self.root, 'src/long.ts', 'let x = 1;\n' * 600)
        self.git('add', '-A')
        self.git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'grow')
        got = self.findings('hygiene', base='HEAD~1')
        self.assertIn(('hygiene', 'error', '.env', 'must not be in git (01-base'), got)
        self.assertFalse(any(p == '.env.example' for _, _, p, _ in got))
        self.assertIn(('hygiene', 'error', 'a.md', 'merge conflict marker'), got)
        self.assertIn(('hygiene', 'error', 'run.sh', 'CRLF line endings break the interpreter line'), got)
        self.assertTrue(any(p == 'big.bin' and m.startswith('file is') for _, _, p, m in got))
        self.assertIn(('hygiene', 'warning', 'src/long.ts', '601 lines (> 500)'), got)

    def test_data(self):
        write(self.root, 'bad.json', '{"a": 1,}')
        write(self.root, 'tsconfig.json', '{ // comments are fine here\n}')
        write(self.root, 'log.jsonl', '{"a": 1}\nnot json\n')
        write(self.root, 'eval/board/plan-1.json', json.dumps({'projects': [{'key': 'P', 'cards': [
            {'key': 'A-1', 'status': 'to-do', 'priority': 'high', 'parent': 'A-2'},
            {'key': 'A-2', 'status': 'to-do', 'priority': 'high', 'parent': 'A-1'},
            {'key': 'A-3', 'status': 'later', 'priority': 'high', 'blocks': ['Z-9', 'TB-1']}]}]}))
        write(self.root, 'eval/data/decisions.jsonl', '{"id": "d-1", "q": "q", "a": "", "source": "s", "date": "x"}\n')
        journal = {'entries': [{'idx': 0, 'when': 200, 'tag': '0000_a'}, {'idx': 1, 'when': 100, 'tag': '0001_b'}]}
        write(self.root, 'boards/apps/api/drizzle/meta/_journal.json', json.dumps(journal))
        write(self.root, 'boards/apps/api/drizzle/meta/0000_snapshot.json', '{}')
        write(self.root, 'boards/apps/api/drizzle/0000_a.sql', 'select 1;')
        write(self.root, 'boards/apps/api/drizzle/0002_orphan.sql', 'select 1;')
        got = self.findings('data')
        paths = {(p, m) for _, level, p, m in got if level == 'error'}
        self.assertIn(('bad.json', 'invalid JSON'), paths)
        self.assertNotIn(('tsconfig.json', 'invalid JSON'), paths)
        self.assertIn(('log.jsonl', 'invalid JSON line'), paths)
        plan = {m for p, m in paths if p == 'eval/board/plan-1.json'}
        self.assertTrue({'subtask cycle through A-1', 'A-3 points to unknown card Z-9'} <= plan)
        self.assertIn('A-3', plan)  # unknown status 'later'
        self.assertNotIn('A-3 points to unknown card TB-1', plan)  # seed cards live on the board
        self.assertIn(('eval/data/decisions.jsonl', 'missing a'), paths)
        journal_msgs = {m for p, m in paths if p.endswith('_journal.json')}
        self.assertIn('0001_b', journal_msgs)  # `when` went backwards / no .sql
        self.assertIn(('boards/apps/api/drizzle/0002_orphan.sql', 'migration is not in the journal — it never runs'),
                      paths)

    def test_syntax(self):
        write(self.root, 'ok.py', 'x = 1\n')
        write(self.root, 'bad.py', 'def f(:\n')
        write(self.root, 'bad.sh', '#!/bin/bash\nif then fi\n')
        got = self.findings('syntax')
        self.assertIn(('syntax', 'error', 'bad.py', 'python'), got)
        self.assertIn(('syntax', 'error', 'bad.sh', 'bash -n'), got)
        self.assertFalse(any(p == 'ok.py' for _, _, p, _ in got))

    def test_allowlist_and_exit_code(self):
        write(self.root, 'a.zip', b'PK', 'wb')
        self.git('add', '-A')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(run.main(['--root', self.root, '--only', 'hygiene']), 1)
            write(self.root, 'infra/checks/allow.txt', '# published download\nhygiene  a.zip\n')
            self.assertEqual(run.main(['--root', self.root, '--only', 'hygiene']), 0)


if __name__ == '__main__':
    unittest.main()
