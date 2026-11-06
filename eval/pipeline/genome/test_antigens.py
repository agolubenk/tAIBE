"""Every antigen in antigens.json has a command it must fire on and one it must stay quiet on.

Cases come from real calls of 30.10–06.11 (shapes only, no data) and from the restart ideas (IDEA-44, IDEA-45).
A new row without cases fails `test_every_row_has_cases`.
Run: python3 -I -m unittest discover -s eval/pipeline/genome -p 'test_*.py'
"""

import json
import os
import re
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'reflex'))
import antigen  # noqa: E402
import build  # noqa: E402

B = 'Bash'
PUT = 'mcp__owner-queue__oq_put'
GET = 'mcp__owner-queue__oq_get'
NOTION = 'mcp__hub__notion_1mcp_notion-create-comment'
EXT = '~/.vscode/extensions/anthropic.claude-code-2.1.311-darwin-arm64/claude -p x'


def bash(command):
    return (B, {'command': command, 'description': 'x'})


CASES = {
    'git-replay': {
        'fire': [bash('git replay --onto main topic')],
        'quiet': [bash('git log --oneline -1\necho replay done')],
    },
    'zsh-colon': {
        'fire': [bash('R=refs/remotes/pr/1; git show "$R:apps/x.ts"'), bash('git show $B:eval/nerve/config.json'),
                 bash('git show $t:src/setconf.c')],
        'quiet': [bash('git show "${R}:apps/x.ts"'), bash('git show "$R:infra/x.yml"'), bash('PATH=$PATH:/usr/bin')],
    },
    'zsh-split': {
        'fire': [bash('for f in $files; do echo $f; done'), bash('for p in ${P}\ndo ps -p $p; done')],
        'quiet': [bash('for f in $(git ls-files); do :; done'), bash('for f in ${=files}; do :; done'),
                  bash('for f in "$@"; do :; done'), bash('for d in $S/wt-1 $S/wt-2; do :; done')],
    },
    'zsh-glob': {
        'fire': [bash('grep -rn extraFields apps/api/src --include=*.ts | head'), bash('grep -r x --exclude-dir=*.cache .')],
        'quiet': [bash("grep -rn extraFields apps/api/src --include='*.ts'"), bash('grep -rn x "--include=*.sh" .'),
                  bash('ls $S/*.jsonl')],
    },
    'zsh-equals': {
        'fire': [bash('git log -1; echo ====; git status'), bash('echo =='), bash('ls && echo -n ===== x')],
        'quiet': [bash("echo '===='"), bash('echo "== $x"'), bash('[[ $a == b ]] && echo eq'),
                  bash('python3 -c "print(1 == 1)"'), bash('echo ---')],
    },
    'zsh-cmd-var': {
        'fire': [bash('G="git -C /a/b"; $G status'), bash('N="python3 -I eval/nerve/nerve.py emit"\n$N coord "x"'),
                 bash('S="git -C wt show origin/main:apps"; $S/src/a.ts')],
        'quiet': [bash('G=(git -C /a/b); $G status'), bash('PY=/usr/bin/python3; $PY x.py'),
                  bash('D="/a/b c"; ls "$D"'), bash('g(){ git -C "$W" "$@"; }; g status')],
    },
    'zsh-jq-glob': {
        'fire': [bash('gh pr view 1 --json headRefOid --jq .headRefOid[0:8]'), bash('cat a.json | jq .items[0]')],
        'quiet': [bash("gh pr view 1 --json headRefOid --jq '.headRefOid[0:8]'"), bash("jq '.items[0]' a.json"),
                  bash('gh pr view 1 --json state --jq .state')],
    },
    'unittest-isolated': {
        'fire': [bash('python3 -I -m unittest test_genome'), bash('cd eval/tools && python3 -I -m unittest -q test_lineage'),
                 bash('/usr/bin/python3 -I -m unittest eval/tools/test_spawn_session.py')],
        'quiet': [bash("python3 -I -m unittest discover -s eval/pipeline -p 'test_*.py'"),
                  bash('python3 -m unittest test_genome')],
    },
    'monitor-pipe': {
        'fire': [('Monitor', {'command': 'tail -f log | grep ERROR'})],
        'quiet': [('Monitor', {'command': 'tail -f log | grep --line-buffered ERROR'}),
                  ('Monitor', {'command': 'while true; do n=$(ps ax | grep -c claude); echo $n; sleep 60; done'}),
                  bash('tail -f log | grep ERROR')],
    },
    'mem-gate-pipe': {
        'fire': [bash('mem-gate.sh heavy | tail -1 && npm test')],
        'quiet': [bash('mem-gate.sh heavy && npm test')],
    },
    'git-worktree-cd': {
        'fire': [bash('cd worktrees/fix/x && git push'), bash('cd /a/worktrees/fix/x; git status'),
                 bash('cd /a/worktrees/fix/x\ngit add -A'), bash('cd .. && git push')],
        'quiet': [bash('cd /a/worktrees/fix/x && git status'), bash('git -C /a/worktrees/fix/x status'),
                  bash('cd .. && git log -1')],
    },
    'mutant-checkout': {
        'fire': [bash('git checkout -- src/a.ts'), bash('sed -i "" s/a/b/ f; run; git -C $W restore --source=HEAD -- f'),
                 bash("bash -c 'git checkout -- src/a.ts'"), bash('if x; then git restore --source=HEAD -- f; fi'),
                 bash('xargs -n1 git checkout -- < list'), bash("ssh host 'cd r && git checkout -- a'")],
        'quiet': [bash('git -C $W checkout -- docs/engineering/packages-manifest.md'), bash('git checkout -b feat/x'),
                  bash('echo "then use git checkout -- file"'), bash('grep -n "git checkout -- " notes.md')],
    },
    't-boards-vitest': {
        'fire': [bash('cd t-boards/apps/api && npx vitest run'), bash('cd ~/d/tAIBE/boards/apps/web && npx vitest run')],
        'quiet': [bash('cd apps/frontend && npx vitest run src/x')],
    },
    'vps-volume': {
        'fire': [bash('docker compose down -v'), bash('docker volume prune -f'),
                 (PUT, {'id': 's-x', 'cmd': 'docker compose -p tb down -v'})],
        'quiet': [bash('docker compose -p tb up -d\n/etc/wg/rules.sh down wg0; cp -a a b -v'), bash('docker compose down')],
    },
    'owner-s-command': {
        'fire': [(PUT, {'id': 's-x', 'cmd': 'echo'})],
        'quiet': [(PUT, {'id': 'm-1', 'body': 'x'})],
    },
    'oq-note-echo': {
        'fire': [(GET, {'id': 'c-tb-ui-check'}), ('mcp__owner-queue__oq_list', {'kind': 'checks'})],
        'quiet': [(GET, {'id': 'm-1'})],
    },
    'curl-hook': {
        'fire': [bash('curl -s http://x'), bash('x=$(curl -s -o /dev/null -w %{http_code} http://x)'),
                 bash("for u in a b; do cu''rl -s $u; done"), bash('time curl -sI http://x'),
                 bash('env -i HOME=/x curl -s http://x'), bash("ssh vps 'curl -s localhost:3000'"),
                 bash('sudo curl -o f http://x'), bash('bash -lc "curl -s http://x"')],
        'quiet': [bash('grep -nE "curl .*http" f.sh'), bash('echo "uses curl here"'), bash('brew install curl'),
                  bash('man curl')],
    },
    'git-history-rewrite': {
        'fire': [bash('git commit -q --amend -m x'), bash('git -C /w push -q --force-with-lease origin fix/a'),
                 bash('git push -f origin fix/a'), bash("bash -c 'git commit --amend --no-edit'")],
        'quiet': [bash('git commit -m x && git push origin fix/a'), bash('echo "git push --force"')],
    },
    'notion-comment': {
        'fire': [(NOTION, {'page_id': 'x', 'rich_text': []})],
        'quiet': [('mcp__hub__notion_1mcp_notion-fetch', {'id': 'x'})],
    },
    'stale-binary': {
        'fire': [bash(EXT)],
        'quiet': [bash('claude -p x')],
    },
    'pr-merge': {
        'fire': [bash('gh pr merge 445 --squash --match-head-commit abc'), bash('GH_TOKEN=x gh pr merge 1'),
                 bash('gh_token=x gh pr merge 1'), bash('bash -c "gh pr merge 1 --squash"'),
                 bash("ssh -i k host 'cd r && gh pr merge 1'"), bash('if ok; then gh pr merge 1; fi'),
                 bash('for n in 1 2; do gh pr merge $n; done'), bash('time gh pr merge 1'),
                 bash('echo 1 | xargs -I{} gh pr merge {}'), bash('sudo -u ci gh pr merge 1'),
                 bash('command gh pr merge 1'), bash('env GH_TOKEN=x gh pr merge 1'), bash('nohup gh pr merge 1 &'),
                 bash('x=$(gh pr merge 1)'), bash('gh -R o/r pr merge 1'), bash('ls\ngh pr merge 1'),
                 bash('true && gh pr merge 1'), bash('eval "gh pr merge 1"')],
        'quiet': [bash("printf 'gh pr merge 1\\n' > m.sh"), bash('gh pr view 445'), bash('x=1 # gh pr merge 1'),
                  bash('echo "gh pr merge"'), bash('grep -rn "gh pr merge" .claude/hooks'),
                  bash("git log --grep='gh pr merge'"), bash("cat <<'MD' > b.md\nМёрж: `gh pr merge 1` — только Контроль\nMD"),
                  bash("printf '| `gh pr merge 1` | 25 |\\n'")],
    },
}


def hook_matchers():
    for entry in build.hooks('python3')['PreToolUse']:
        if any(h['command'].endswith('antigen.py') for h in entry['hooks']):
            yield re.compile(entry['matcher'])


class AntigenCasesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.table = antigen.load_table()
        cls.rows = {row['id']: row for row in cls.table}

    def ids(self, tool, payload):
        return [row['id'] for row in antigen.matches(self.table, tool, payload)]

    def test_every_row_has_cases(self):
        self.assertEqual(sorted(self.rows), sorted(CASES))
        for aid, case in CASES.items():
            with self.subTest(aid):
                self.assertTrue(case['fire'] and case['quiet'])

    def test_fires(self):
        for aid, case in CASES.items():
            for tool, payload in case['fire']:
                with self.subTest(aid, payload=payload):
                    self.assertIn(aid, self.ids(tool, payload))

    def test_stays_quiet(self):
        for aid, case in CASES.items():
            for tool, payload in case['quiet']:
                with self.subTest(aid, payload=payload):
                    self.assertNotIn(aid, self.ids(tool, payload))

    def test_long_or_hostile_commands_stay_fast(self):
        """Review of #82: `A="x y z" ` × 8000 took 9.6 s (hook timeout 10 s). Whole table, 100 KB each, < 0.2 s."""
        units = ['A="x y z" ', '\n', 'a=;', 'a=`', 'compose down ', 'cd worktrees/', 'ssh -o ', 'G="git -C', 'git ',
                 'git commit ', 't-boards ', 'npx vitest ', '--include=', 'mem-gate.sh |', 'bash -c ', '$R:', 'echo =',
                 '| grep ', 'jq .', 'for x in ', 'python3 -I -m unittest ', 'x']
        for unit in units:
            cmd = (unit * (100000 // len(unit) + 1))[:100000]
            for tool in (B, 'Monitor'):
                with self.subTest(unit=unit, tool=tool):
                    t = time.perf_counter()
                    self.ids(tool, {'command': cmd})
                    self.assertLess(time.perf_counter() - t, 0.2)

    def test_only_head_of_a_huge_command_is_matched(self):
        self.assertIn('pr-merge', self.ids(B, {'command': 'gh pr merge 1' + ' ' * 30000}))
        self.assertNotIn('pr-merge', self.ids(B, {'command': ' ' * (antigen.MAX_TEXT + 1) + 'gh pr merge 1'}))

    def test_field_rows_ignore_description(self):
        self.assertEqual(self.ids(B, {'command': 'ls -la', 'description': 'curl the site; echo ===='}), [])

    def test_every_tool_reaches_the_hook(self):
        """A row whose tool the genome's antigen matcher does not cover would never fire."""
        matchers = list(hook_matchers())
        self.assertTrue(matchers)
        for aid, case in CASES.items():
            for tool, _ in case['fire']:
                with self.subTest(aid, tool=tool):
                    self.assertTrue(any(m.fullmatch(tool) for m in matchers))

    def test_rows_are_well_formed(self):
        for row in self.table:
            with self.subTest(row['id']):
                self.assertTrue(row['lesson'])
                self.assertLessEqual(len(row['lesson']), 420)
                self.assertIn(row.get('field', 'command'), ('command',))
                if 'dormant' in row:
                    self.assertTrue(row['dormant'].strip())

    def test_table_is_valid_json_list(self):
        with open(antigen.TABLE, encoding='utf-8') as f:
            self.assertIsInstance(json.load(f), list)


if __name__ == '__main__':
    unittest.main()
