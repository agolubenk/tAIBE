"""Synthetic-data tests for the reflexes (П2, П5). No network, no real repo state.
Run: python3 -I -m unittest discover -s supertick-eval/pipeline/reflex -p 'test_*.py'
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import antigen  # noqa: E402
import handoff_read  # noqa: E402
import pr_state  # noqa: E402
import wt_state  # noqa: E402


class AntigenTest(unittest.TestCase):
    def setUp(self):
        self.table = antigen.load_table()
        self.state = tempfile.mkdtemp()

    def event(self, tool, payload, session='s1'):
        return {'session_id': session, 'tool_name': tool, 'tool_input': payload}

    def test_table_is_well_formed(self):
        ids = [row['id'] for row in self.table]
        self.assertEqual(len(ids), len(set(ids)))
        for row in self.table:
            self.assertTrue(row['lesson'])

    def test_field_unless_and_json_modes(self):
        """Per-row fire/quiet cases live in genome/test_antigens.py; here — the matcher itself on a synthetic table."""
        path = os.path.join(self.state, 'table.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump([{'id': 'cmd', 'tool': 'Bash', 'field': 'command', 'pattern': '^git push', 'unless': '--dry-run',
                        'lesson': 'x'},
                       {'id': 'json', 'tool': 'Bash', 'pattern': '"description"', 'lesson': 'y'}], f)
        table = antigen.load_table(path)
        got = lambda payload: [row['id'] for row in antigen.matches(table, 'Bash', payload)]  # noqa: E731
        self.assertEqual(got({'command': 'ls\ngit push origin x'}), ['cmd'])   # ^ is a line start in the command
        self.assertEqual(got({'command': 'git push --dry-run'}), [])           # unless drops the match
        self.assertEqual(got({'command': 'echo; git push', 'description': 'git push'}), ['json'])
        self.assertEqual(got({'command': ['git push']}), [])                   # a non-string field is silent

    def test_cases_from_data_fire_and_stay_quiet(self):
        # genome/antigen_cases.json: what each antigen fires on and stays quiet on, as data. The nightly evolution
        # session proposes antigens only this way (it writes no test code); this test reads the file as it is.
        path = os.path.join(os.path.dirname(antigen.TABLE), 'antigen_cases.json')
        with open(path, encoding='utf-8') as f:
            cases = json.load(f)
        ids = {row['id'] for row in self.table}
        for aid, own in cases.items():
            self.assertIn(aid, ids, 'cases for an unknown antigen')
            for case in own.get('fires', []):
                with self.subTest(aid, fires=case):
                    self.assertIn(aid, [r['id'] for r in antigen.matches(self.table, case['tool'], case['input'])])
            for case in own.get('quiet', []):
                with self.subTest(aid, quiet=case):
                    self.assertNotIn(aid, [r['id'] for r in antigen.matches(self.table, case['tool'], case['input'])])

    def test_quiet_commands_stay_silent(self):
        for command in ('git -C /a/b status', 'ls -la', 'echo "${R}:apps/x"', 'while read f; do :; done < list'):
            with self.subTest(command):
                self.assertEqual(antigen.matches(self.table, 'Bash', {'command': command}), [])

    def test_wrong_tool_does_not_match(self):
        self.assertEqual(antigen.matches(self.table, 'Read', {'file_path': '/x/git replay'}), [])

    def test_lesson_once_per_session(self):
        ev = self.event('Bash', {'command': 'git replay x'})
        first = antigen.respond(ev, self.state, self.table)
        self.assertEqual(first['hookSpecificOutput']['hookEventName'], 'PreToolUse')
        self.assertIn('git-replay', first['hookSpecificOutput']['additionalContext'])
        self.assertIsNone(antigen.respond(ev, self.state, self.table))
        other = antigen.respond(self.event('Bash', {'command': 'git replay x'}, 's2'), self.state, self.table)
        self.assertIsNotNone(other)

    def test_session_id_is_sanitised(self):
        path = antigen.state_file('../../etc/x', self.state)
        self.assertEqual(os.path.dirname(path), self.state)

    def test_hook_process_bad_input_is_silent(self):
        run = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'antigen.py')], input='not json',
                             capture_output=True, text=True)
        self.assertEqual((run.returncode, run.stdout), (0, ''))


class NowTest(unittest.TestCase):
    def run_now(self, payload):
        return subprocess.run(['/bin/sh', os.path.join(HERE, 'now.sh')], input=payload, capture_output=True, text=True)

    def test_hook_events_get_json(self):
        for event in ('PreToolUse', 'UserPromptSubmit'):
            with self.subTest(event):
                out = json.loads(self.run_now(json.dumps({'hook_event_name': event, 'prompt': 'x'})).stdout)
                self.assertEqual(out['hookSpecificOutput']['hookEventName'], event)
                self.assertRegex(out['hookSpecificOutput']['additionalContext'], r'^Сейчас \d\d:\d\d ')

    def test_other_input_gets_plain_text(self):
        self.assertRegex(self.run_now('').stdout, r'^Сейчас \d\d:\d\d ')


class PrStateTest(unittest.TestCase):
    def pr(self, **over):
        base = {'number': 7, 'state': 'OPEN', 'isDraft': False, 'headRefOid': 'abcdef1234567890',
                'mergeable': 'MERGEABLE', 'mergeStateStatus': 'CLEAN', 'reviewDecision': 'APPROVED',
                'statusCheckRollup': []}
        base.update(over)
        return base

    def test_green(self):
        rollup = [{'__typename': 'CheckRun', 'name': 'build', 'status': 'COMPLETED', 'conclusion': 'SUCCESS'},
                  {'__typename': 'StatusContext', 'context': 'deploy', 'state': 'SUCCESS'}]
        self.assertEqual(pr_state.format_pr(self.pr(statusCheckRollup=rollup)),
                         '#7 OPEN head abcdef123 · ci: 2 ok · review: approved · mergeable: MERGEABLE/CLEAN')

    def test_failures_and_pending_are_named(self):
        rollup = [{'__typename': 'CheckRun', 'name': 'build', 'status': 'COMPLETED', 'conclusion': 'FAILURE'},
                  {'__typename': 'CheckRun', 'name': 'e2e', 'status': 'IN_PROGRESS', 'conclusion': None},
                  {'__typename': 'StatusContext', 'context': 'lint', 'state': 'ERROR'}]
        line = pr_state.format_pr(self.pr(statusCheckRollup=rollup, reviewDecision='', isDraft=True,
                                          mergeStateStatus='UNKNOWN'))
        self.assertIn('OPEN draft', line)
        self.assertIn('ci: 0 ok, 2 fail (build, lint), 1 pending (e2e)', line)
        self.assertIn('review: none', line)
        self.assertTrue(line.endswith('mergeable: MERGEABLE'))

    def test_long_failure_list_is_cut(self):
        rollup = [{'__typename': 'CheckRun', 'name': f'c{i}', 'status': 'COMPLETED', 'conclusion': 'FAILURE'}
                  for i in range(5)]
        self.assertIn('5 fail (c0, c1, c2 +2)', pr_state.format_ci(rollup))

    def test_no_checks(self):
        self.assertEqual(pr_state.format_ci(None), 'ci: none')

    def test_bad_argument(self):
        self.assertEqual(pr_state.main(['abc']), 2)


class WtStateTest(unittest.TestCase):
    PORCELAIN = (
        'worktree /r/main\nHEAD 1111111111\nbranch refs/heads/main\n\n'
        'worktree /r/wt/fix\nHEAD 2222222222\nbranch refs/heads/fix/x\n\n'
        'worktree /tmp/wt9\nHEAD 3333333333\ndetached\nprunable gitdir file points to non-existent location\n\n'
    )

    def test_parse_worktrees(self):
        trees = wt_state.parse_worktrees(self.PORCELAIN)
        self.assertEqual([t['branch'] for t in trees], ['main', 'fix/x', ''])
        self.assertEqual([t['prunable'] for t in trees], [False, False, True])
        self.assertTrue(trees[2]['detached'])

    def test_parse_status(self):
        status = '# branch.oid 1111\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n' \
                 '1 .M N... 100644 100644 100644 a b x.ts\n? new.ts\n'
        self.assertEqual(wt_state.parse_status(status), (2, 2, 3, True))

    def test_format(self):
        tree = {'path': '/h/u/r', 'head': '1111111111', 'branch': 'main', 'detached': False}
        self.assertEqual(wt_state.format_tree(tree, (0, 1, 0, True), home='/h/u'), '~/r [main] 111111111 · dirty 0 · ↑1 ↓0')
        self.assertTrue(wt_state.format_tree(tree, (3, 0, 0, False)).endswith('dirty 3 · no upstream'))
        self.assertTrue(wt_state.format_tree(tree, None).endswith('status: unreadable'))

    def test_real_repo_smoke(self):
        repo = tempfile.mkdtemp()
        subprocess.run(['git', '-C', repo, 'init', '-q', '-b', 'main'], check=True)
        open(os.path.join(repo, 'a'), 'w').close()
        lines = wt_state.report(repo)
        self.assertEqual(len(lines), 1)
        self.assertIn('[main]', lines[0])
        self.assertIn('dirty 1', lines[0])


class HandoffReadTest(unittest.TestCase):
    def test_card_and_capsule(self):
        team, caps = tempfile.mkdtemp(), tempfile.mkdtemp()
        with open(os.path.join(team, 'TEAM-11-CONTROL.md'), 'w', encoding='utf-8') as f:
            f.write('# Контроль\n\nтекст\n\n## Мёрж\n\nправила\n')
        with open(os.path.join(caps, 'control.md'), 'w', encoding='utf-8') as f:
            f.write('Цель: влить #1\n')
        out = handoff_read.render('control', team, caps)
        self.assertIn('Цель: влить #1', out)
        self.assertIn('L1 # Контроль', out)
        self.assertIn('L5 ## Мёрж', out)
        self.assertNotIn('правила', out)

    def test_missing(self):
        out = handoff_read.render('nobody', tempfile.mkdtemp(), tempfile.mkdtemp())
        self.assertIn('capsule: none', out)
        self.assertIn("card: none for role 'nobody'", out)


if __name__ == '__main__':
    unittest.main()
