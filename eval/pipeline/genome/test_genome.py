"""Tests for build.py: every role keeps the tools its work needs and loads the team law."""

import json
import os
import re
import shlex
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402

with open(build.TABLE, encoding='utf-8') as f:
    TABLE = json.load(f)
GENOMES = build.build(TABLE)

# Tools without which a role cannot do its job (or the transition to t-boards stalls).
NEEDED = {
    'coord': ['mcp__owner-queue__oq_put', 'mcp__hub__t-boards_1mcp_forest_list_work_state',
              'mcp__hub__notion_1mcp_notion-fetch', 'CronCreate'],
    'plan': ['mcp__hub__t-boards_1mcp_create_task', 'mcp__hub__notion_1mcp_notion-fetch',
             'mcp__ai-council__council_plan'],
    'frontend': ['mcp__plugin_playwright_playwright__browser_navigate', 'mcp__serena__find_symbol'],
    'backend': ['mcp__postgres-readonly__execute_sql', 'mcp__serena__find_symbol'],
    'release': ['mcp__github__pull_request_read', 'mcp__docker__list_containers', 'mcp__hub__sentry_1mcp_search_issues'],
    'boards': ['mcp__hub__t-boards_1mcp_forest_set_card_meta', 'mcp__plugin_playwright_playwright__browser_navigate'],
}
EVERY_ROLE = ['mcp__hub__t-boards_1mcp_forest_set_work_state', 'mcp__plugin_claude-mem_mcp-search__work_state_write',
              'SendMessage', 'Bash']


def denied(genome, tool):
    for rule in genome['permissions']['deny']:
        pattern = '^' + re.escape(rule).replace(r'\*', '.*') + '($|__)'
        if re.match(pattern, tool):
            return rule
    return None


class GenomeTest(unittest.TestCase):
    def test_six_roles(self):
        self.assertEqual(sorted(GENOMES), sorted(NEEDED))

    def test_role_keeps_its_tools(self):
        for role, tools in NEEDED.items():
            for tool in tools + EVERY_ROLE:
                with self.subTest(role=role, tool=tool):
                    self.assertIsNone(denied(GENOMES[role], tool))

    def test_one_notion_only(self):
        for role, g in GENOMES.items():
            with self.subTest(role=role):
                self.assertEqual(denied(g, 'mcp__notion__notion-fetch'), 'mcp__notion')

    def test_team_law_loads(self):
        main_rule = os.path.join(build.ROOT, '.claude/rules/90-team-t3.md')
        for role, g in GENOMES.items():
            with self.subTest(role=role):
                self.assertFalse(any(x == main_rule or x.startswith(build.ROOT + '/**')
                                     for x in g['claudeMdExcludes']))

    def test_instance_paths_from_config(self):
        """roles.json carries no instance path: excludes are rendered from repo_root of eval/nerve/config.json."""
        with open(build.TABLE, encoding='utf-8') as f:
            self.assertNotIn('/Users/', f.read())
        for g in GENOMES.values():
            self.assertFalse(any('{root}' in x for x in g['claudeMdExcludes']))
            self.assertTrue(any(x.startswith(build.ROOT + '/worktrees/') for x in g['claudeMdExcludes']))

    def test_hook_commands_exist(self):
        """Reflex scripts exist in this tree (the instance path maps onto it); the interpreter is the instance's own."""
        for g in GENOMES.values():
            for group in g['hooks'].values():
                for entry in group:
                    for hook in entry['hooks']:
                        scripts = [p for p in shlex.split(hook['command']) if p.endswith(('.sh', '.py'))]
                        self.assertTrue(scripts, hook['command'])
                        for part in scripts:
                            self.assertTrue(part.startswith(build.REFLEX + os.sep), part)
                            local = os.path.join(build.LOCAL_REFLEX, os.path.relpath(part, build.REFLEX))
                            self.assertTrue(os.path.exists(local), local)

    def test_hooks_point_to_main_checkout(self):
        for role, g in GENOMES.items():
            for group in g['hooks'].values():
                for entry in group:
                    for hook in entry['hooks']:
                        with self.subTest(role=role):
                            self.assertNotIn('/worktrees/', hook['command'])

    def test_skills_on_are_not_off(self):
        for role, spec in TABLE['roles'].items():
            for skill in spec.get('skills_on', []):
                with self.subTest(role=role, skill=skill):
                    self.assertNotIn(skill, GENOMES[role]['skillOverrides'])
                    self.assertIn(skill, TABLE['base']['skills_off'])

    def test_effort_medium_only_for_coord(self):
        for role, g in GENOMES.items():
            with self.subTest(role=role):
                self.assertEqual(g['env'].get('CLAUDE_CODE_EFFORT_LEVEL') == 'medium', role == 'coord')


class ProductGenomeTest(unittest.TestCase):
    """OPS-25 Ф3: геном каждого продукта несёт TAIBE_PRODUCT и пути своего checkout."""

    def test_every_product_has_six_roles_with_its_env_and_root(self):
        for slug, out, root, _reflex in build.products():
            with self.subTest(product=slug):
                for role in NEEDED:
                    with open(os.path.join(out, f'{role}.json'), encoding='utf-8') as f:
                        g = json.load(f)
                    self.assertEqual(g['env'].get('TAIBE_PRODUCT'), slug)
                    rooted = [x for x in g['claudeMdExcludes'] if not x.startswith('/private/tmp/')]  # scratchpad — общий
                    self.assertTrue(rooted and all(x.startswith(root + '/') for x in rooted), rooted)

    def test_non_default_products_live_in_their_subfolder(self):
        rest = build.products()[1:]
        self.assertTrue(rest, 'instances/ has a second product')
        for slug, out, _root, _reflex in rest:
            self.assertEqual(out, os.path.join(build.HERE, slug))


if __name__ == '__main__':
    unittest.main()
