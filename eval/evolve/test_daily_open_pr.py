#!/usr/bin/env python3
"""SE-63: an open evolve data PR keeps its cases. Two runs in a row without the merge of the first PR — the second
gives the session no row whose cases the PR adds and publishes no such file; when the PR is merged or closed, the row
leaves the queue or is free again. GitHub that does not answer closes cases on doubt. Fake `gh` only: no test calls
GitHub, Claude or a model.
Run: python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import daily  # noqa: E402
import daily_git as g  # noqa: E402
import daily_session as session  # noqa: E402
import daily_steps as steps  # noqa: E402
from test_daily import CASES, NEW, OLD  # noqa: E402

CASES_TEXT = ''.join(json.dumps(c) + '\n' for c in CASES)
SKILL = '.claude/skills/new-skill/SKILL.md'


def pr_list(*prs):
    """A fake `gh pr list` answer: (number, branch, [paths])."""
    return json.dumps([{'number': n, 'headRefName': b, 'files': [{'path': p} for p in paths]} for n, b, paths in prs])


def fake_gh(*answers, calls=None):
    """A fake `gh`: one answer per call, the last one repeats; an exception answer is raised."""
    seen = calls if calls is not None else []

    def call(repo, *args, check=True):
        if args[:2] != ('pr', 'list'):
            raise AssertionError('only `gh pr list` is expected, got %s' % (args,))
        seen.append(args)
        answer = answers[min(len(seen), len(answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        return answer
    return call


class OpenDataCasesTest(unittest.TestCase):
    def test_only_cases_of_open_evolve_data_prs(self):
        answer = pr_list((128, 'evolve/data-2026-11-12', ['eval/evolve/cases/card-infra.jsonl']),
                         (124, 'evolve/data-2026-11-11', ['eval/evolve/cases/card-infra.jsonl',
                                                          'eval/evolve/cases/prompt-lens-2.jsonl',
                                                          'eval/evolve/verdicts.jsonl',
                                                          'eval/evolve/cases/sub/deep.jsonl']),
                         (130, 'evolve/antigens-2026-11-12', ['eval/evolve/cases/rule-x.jsonl']),
                         (131, 'fix/something', ['eval/evolve/cases/rule-y.jsonl']))
        with mock.patch.object(g, 'gh', fake_gh(answer)):
            found = g.open_data_cases('/repo', 'board-agents')
        # the oldest PR names the file; verdicts, nested paths, antigen and foreign branches do not count
        self.assertEqual(found, {'card-infra.jsonl': 124, 'prompt-lens-2.jsonl': 124})

    def test_github_that_does_not_answer_is_none_after_the_retries(self):
        for answer in (RuntimeError('gh pr list: HTTP 502'), OSError('no gh'), 'not json'):
            calls, pauses = [], []
            with mock.patch.object(g, 'gh', fake_gh(answer, calls=calls)):
                self.assertIsNone(g.open_data_cases('/repo', 'board-agents', sleep=pauses.append), answer)
            self.assertEqual((len(calls), pauses), (g.OPEN_PRS_TRIES, [g.OPEN_PRS_PAUSE_S] * (g.OPEN_PRS_TRIES - 1)))

    def test_one_failure_then_an_answer(self):
        calls, pauses = [], []
        answer = pr_list((124, 'evolve/data-2026-11-11', ['eval/evolve/cases/card-infra.jsonl']))
        with mock.patch.object(g, 'gh', fake_gh(RuntimeError('gh pr list: HTTP 502'), answer, calls=calls)):
            found = g.open_data_cases('/repo', 'board-agents', sleep=pauses.append)
        self.assertEqual((found, len(calls), len(pauses)), ({'card-infra.jsonl': 124}, 2, 1))

    def test_a_full_list_may_hide_a_pr(self):
        full = pr_list(*[(n, 'fix/x-%d' % n, []) for n in range(g.OPEN_PRS_LIMIT)])
        with mock.patch.object(g, 'gh', fake_gh(full)):
            self.assertIsNone(g.open_data_cases('/repo', 'board-agents', sleep=lambda s: None))


class RepoTest(unittest.TestCase):
    """A temporary repository as the run's worktree and a temporary state folder."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.state = tempfile.mkdtemp()
        self.git('init', '-q')
        self.git('config', 'user.email', 't@t')
        self.git('config', 'user.name', 't')
        self.patches = [mock.patch.object(daily, 'log', lambda *a: None),
                        mock.patch.object(steps, 'STATE_DIR', self.state),
                        mock.patch.object(daily, 'switch', lambda *a: True),
                        mock.patch.object(g, 'main_repo', lambda p: self.root),
                        mock.patch.object(steps, 'layer_metrics', lambda wt: {}),
                        mock.patch.object(steps, 'post_card', lambda line: 'not posted (test)'),
                        mock.patch.object(session.guard, 'incident_cut', lambda *a, **k: {}),
                        mock.patch.object(g, 'OPEN_PRS_PAUSE_S', 0)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.root)
        shutil.rmtree(self.state)

    def git(self, *args):
        return subprocess.run(['git', '-C', self.root, *args], check=True, capture_output=True,
                              text=True).stdout.strip()

    def write(self, rel, text):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)


class RunQueueTest(RepoTest):
    """`run` marks the queue row, the session does not get it, the summary names the PR."""

    def setUp(self):
        super().setUp()
        self.write(SKILL, OLD)
        self.git('add', '.')
        self.git('commit', '-qm', 'v1')
        self.since = self.git('rev-parse', 'HEAD')
        self.write(SKILL, NEW)
        self.git('commit', '-qam', 'v2')
        self.head = self.git('rev-parse', 'HEAD')
        self.patches += [mock.patch.object(g, 'refresh_worktree', lambda *a: self.head),
                         mock.patch.object(g, 'since_day_ago', lambda *a: self.since)]
        for p in self.patches[-2:]:
            p.start()

    def night(self, answer):
        argv = ['run', '--target', 'taibe', '--cases', os.path.join(self.root, 'cases'), '--worktree', '.',
                '--verdicts', os.path.join(self.state, 'verdicts.jsonl'), '--no-card', '--no-pr',
                '--judges', 'claude:claude-sonnet-5-5,claude:claude-haiku-5-5', '--keep-state']
        with mock.patch.object(g, 'gh', fake_gh(answer)), \
                mock.patch.object(daily, 'print', lambda *a, **k: None, create=True):
            daily.main(argv, factory=lambda n: None)
        report = steps.load_json('runs/latest.json', {})
        return report, session.build_input(self.root, report, 'origin/board-agents')['queue']

    def test_two_runs_without_the_merge(self):
        open_pr = pr_list((124, 'evolve/data-2026-11-11', ['eval/evolve/cases/new-skill.jsonl']))
        for night in (1, 2):  # the PR of night 1 is still open on night 2
            report, given = self.night(open_pr)
            self.assertEqual([q.get('waits') for q in report['queue']], ['PR #124'], night)
            self.assertEqual(given, [], night)
            self.assertIn('cases needed for 0 artifacts; cases of 1 wait for the merge of PR #124',
                          report['summary'])

    def test_a_closed_pr_frees_the_row(self):
        self.night(pr_list((124, 'evolve/data-2026-11-11', ['eval/evolve/cases/new-skill.jsonl'])))
        report, given = self.night(pr_list())  # closed without the merge (#128 on 12.11)
        self.assertEqual([q['path'] for q in given], [SKILL])
        self.assertNotIn('waits', report['queue'][0])
        self.assertTrue(report['summary'].endswith('cases needed for 1 artifacts'), report['summary'])

    def test_github_silent_gives_the_session_no_cases(self):
        report, given = self.night(RuntimeError('gh pr list: network'))
        self.assertEqual((given, report['queue'][0]['waits']), ([], daily.UNKNOWN_PRS))
        self.assertIn('GitHub did not list the open evolve PRs', report['summary'])


class PublishTest(RepoTest):
    """`publish` of the second run refuses the cases files that the first run's open PR adds."""

    WAITS = 'eval/evolve/cases/card-infra.jsonl'
    FREE = 'eval/evolve/cases/rule-07-worktrees.jsonl'

    def setUp(self):
        super().setUp()
        self.write('README.md', 'base\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        self.write(self.WAITS, CASES_TEXT)   # the session wrote it again
        self.write(self.FREE, CASES_TEXT)

    def publish(self, answer):
        out = []
        with mock.patch.object(g, 'gh', fake_gh(answer)), \
                mock.patch.object(session, 'print', lambda text, **k: out.append(text), create=True):
            daily.main(['publish', '--worktree', '.', '--dry-run'])
        return json.loads(out[0])

    def test_second_run_does_not_touch_the_first_prs_cases(self):
        rows = self.publish(pr_list((124, 'evolve/data-2026-11-11', [self.WAITS])))
        self.assertIn({'refused': self.WAITS, 'why': 'its cases wait for the merge of PR #124'}, rows)
        self.assertEqual([r['files'] for r in rows if 'would_open' in r], [[self.FREE]])

    def test_without_an_open_pr_both_are_published(self):
        rows = self.publish(pr_list())
        self.assertEqual([r['files'] for r in rows if 'would_open' in r], [sorted([self.FREE, self.WAITS])])

    def test_github_silent_publishes_no_cases(self):
        rows = self.publish(RuntimeError('gh pr list: network'))
        self.assertEqual(sorted(r['refused'] for r in rows if 'refused' in r), [self.WAITS, self.FREE])
        self.assertFalse([r for r in rows if 'would_open' in r])


if __name__ == '__main__':
    unittest.main()
