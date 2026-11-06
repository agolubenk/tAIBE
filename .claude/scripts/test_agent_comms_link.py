#!/usr/bin/env python3
"""agent-comms-link.sh: the user-level link points at the canon of the MAIN checkout, never at a worktree; --check
fails on a missing, foreign or dangling link; a regular file is never overwritten.
Run: python3 -I .claude/scripts/test_agent_comms_link.py"""
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'agent-comms-link.sh')
REL = os.path.join('.claude', 'rules', '00-agent-comms.md')


def git(cwd, *args):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
                        'GIT_COMMITTER_EMAIL': 't@t'})


class LinkTest(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.main = os.path.join(self.tmp, 'repo')
        os.makedirs(os.path.join(self.main, '.claude', 'scripts'))
        os.makedirs(os.path.join(self.main, '.claude', 'rules'))
        shutil.copy(SCRIPT, os.path.join(self.main, '.claude', 'scripts'))
        with open(os.path.join(self.main, REL), 'w') as f:
            f.write('# canon\n')
        git(self.main, 'init', '-q')
        git(self.main, 'add', '-A')
        git(self.main, 'commit', '-q', '-m', 'init')
        self.link = os.path.join(self.tmp, 'home', 'rules', '00-agent-comms.md')
        self.canon = os.path.join(self.main, REL)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_script(self, root, *args):
        return subprocess.run(['bash', os.path.join(root, '.claude', 'scripts', 'agent-comms-link.sh'), *args],
                              capture_output=True, text=True, env={**os.environ, 'AGENT_COMMS_LINK': self.link})

    def test_check_fails_without_link(self):
        self.assertEqual(self.run_script(self.main, '--check').returncode, 1)

    def test_install_then_check(self):
        self.assertEqual(self.run_script(self.main).returncode, 0)
        self.assertEqual(os.readlink(self.link), self.canon)
        self.assertEqual(self.run_script(self.main, '--check').returncode, 0)

    def test_worktree_links_to_main_checkout(self):
        wt = os.path.join(self.main, 'worktrees', 'feature', 'x')
        git(self.main, 'worktree', 'add', '-q', '-b', 'feature/x', wt)
        self.assertEqual(self.run_script(wt).returncode, 0)
        self.assertEqual(os.readlink(self.link), self.canon)

    def test_check_fails_on_foreign_and_dangling_link(self):
        os.makedirs(os.path.dirname(self.link))
        os.symlink(os.path.join(self.tmp, 'other.md'), self.link)
        self.assertEqual(self.run_script(self.main, '--check').returncode, 1)
        os.remove(self.link)
        self.assertEqual(self.run_script(self.main).returncode, 0)
        os.rename(self.canon, self.canon + '.gone')
        self.assertEqual(self.run_script(self.main, '--check').returncode, 1)

    def test_regular_file_is_not_overwritten(self):
        os.makedirs(os.path.dirname(self.link))
        with open(self.link, 'w') as f:
            f.write('mine\n')
        self.assertEqual(self.run_script(self.main).returncode, 1)
        with open(self.link) as f:
            self.assertEqual(f.read(), 'mine\n')


if __name__ == '__main__':
    unittest.main()
