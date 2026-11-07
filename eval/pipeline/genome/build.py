"""П1/П3/П4: role genomes from one table — genome/roles.json → genome/<role>.json.

The three hand-made genomes (author, coord, control) were copies of one another, and coord/control
excluded rule 90 — the law of the very team they belong to. Now the base lives once and every role
adds only its own deny list, skills and env. Generated files are for `claude --settings <file>`.

Run: python3 -I build.py [--check]   (--check: exit 1 if a generated file is stale, write nothing)
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.join(HERE, 'roles.json')


def main_checkout():
    """Genomes are launched from the main checkout, so hooks point there even when built in a worktree —
    otherwise `--check` is red in every worktree and a genome built there runs that worktree's reflex."""
    try:
        common = subprocess.run(['git', '-C', HERE, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                capture_output=True, text=True, check=True).stdout.strip()
        return os.path.dirname(common)
    except (OSError, subprocess.CalledProcessError):
        return os.path.normpath(os.path.join(HERE, '..', '..', '..'))


def instance():
    """Instance paths come from eval/nerve/config.json (the one home of instance paths, with .claude/rules):
    repo_root — the host checkout the team runs in, product_tree — where this tree sits in it (`supertick-eval`
    in the incubator instance, `eval` in the product home). Env GENOME_ROOT / GENOME_TREE override both; without
    config the genome is built for the checkout it lives in. layer_home (env GENOME_LAYER_HOME) — where the
    layer's eval tree lives when it is not inside the host (tAIBE's own checkout after the links in the host are
    removed, 05.11): hooks then run the layer's reflex from there, not through a link in the host."""
    cfg = {}
    try:
        with open(os.path.join(HERE, '..', '..', 'nerve', 'config.json'), encoding='utf-8') as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        pass
    root = os.environ.get('GENOME_ROOT') or cfg.get('repo_root') or main_checkout()
    tree = os.environ.get('GENOME_TREE') or cfg.get('product_tree') or os.path.basename(
        os.path.normpath(os.path.join(HERE, '..', '..')))
    layer = os.environ.get('GENOME_LAYER_HOME') or cfg.get('layer_home') or os.path.join(root, tree)
    return root, tree, layer


ROOT, TREE, LAYER_HOME = instance()
REFLEX = os.path.join(LAYER_HOME, 'pipeline', 'reflex')
LOCAL_REFLEX = os.path.normpath(os.path.join(HERE, '..', 'reflex'))


def hooks(python):
    now = f"/bin/sh {os.path.join(REFLEX, 'now.sh')}"
    antigen = f"{python} -I {os.path.join(REFLEX, 'antigen.py')}"
    return {
        'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': now}]}],
        'PreToolUse': [
            {'matcher': 'Write|SendMessage|mcp__owner-queue__.*', 'hooks': [{'type': 'command', 'command': now}]},
            {'matcher': 'Bash|Monitor|ToolSearch|ScheduleWakeup|mcp__owner-queue__.*',
             'hooks': [{'type': 'command', 'command': antigen}]},
        ],
    }


def genome(base, role):
    on = set(role.get('skills_on', []))
    overrides = {name: 'off' for name in base['skills_off'] if name not in on}
    overrides.update({name: 'name-only' for name in base['skills_name_only']})
    return {
        'enabledPlugins': dict(base['enabledPlugins']),
        'skillOverrides': overrides,
        'disableBundledSkills': True,
        'permissions': {'deny': base['deny'] + [d for d in role.get('deny', []) if d not in base['deny']]},
        'env': {**base['env'], **role.get('env', {})},
        'claudeMdExcludes': [x.replace('{root}', ROOT) for x in base['claudeMdExcludes']],
        'hooks': hooks(base['python']),
        'syncClaudeAiSkills': False,
        'skillListingMaxDescChars': 100,
    }


def build(table):
    return {name: genome(table['base'], role) for name, role in table['roles'].items()}


def main(argv):
    ap = argparse.ArgumentParser(prog='build')
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args(argv)
    with open(TABLE, encoding='utf-8') as f:
        table = json.load(f)
    stale = []
    for name, data in build(table).items():
        path = os.path.join(HERE, f'{name}.json')
        text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
        old = open(path, encoding='utf-8').read() if os.path.exists(path) else None
        if old == text:
            continue
        stale.append(path)
        if not args.check:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(text)
    for path in stale:
        print(('stale ' if args.check else 'wrote ') + path)
    return 1 if args.check and stale else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
