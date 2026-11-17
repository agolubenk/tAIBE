"""П1/П3/П4: role genomes from one table — genome/roles.json → genome/<role>.json.

The three hand-made genomes (author, coord, control) were copies of one another, and coord/control
excluded rule 90 — the law of the very team they belong to. Now the base lives once and every role
adds only its own deny list, skills and env. Generated files are for `claude --settings <file>`.

Run: python3 -I build.py [--check] [--product SLUG]   (--check: exit 1 if a generated file is stale, write nothing)

Products (OPS-25): the default product of `instances/` keeps its genomes in genome/<role>.json, every other
product gets genome/<slug>/<role>.json with its own repo_root. Every genome sets env TAIBE_PRODUCT=<slug>: the
session's Bash and Monitor inherit it, so `nerve.py tap <role>` and spawn_session.sh know the product.

MCP servers (SE-79): a server that deny closes whole, and a server in instances/<slug>.json
genome.disabledMcpjsonServers, go to disabledMcpjsonServers — Claude Code then does not start it from .mcp.json.
"""

import argparse
import json
import os
import re
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


def hooks(python, reflex=None):
    reflex = reflex or REFLEX
    now = f"/bin/sh {os.path.join(reflex, 'now.sh')}"
    antigen = f"{python} -I {os.path.join(reflex, 'antigen.py')}"
    peer_gate = f"{python} -I {os.path.join(reflex, 'peer_gate.py')}"
    return {
        'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': now}]}],
        'PreToolUse': [
            {'matcher': 'Write|SendMessage|mcp__owner-queue__.*', 'hooks': [{'type': 'command', 'command': now}]},
            {'matcher': 'Bash|Monitor|ToolSearch|ScheduleWakeup|mcp__owner-queue__.*',
             'hooks': [{'type': 'command', 'command': antigen}]},
            # SE-41: every peer message wakes the recipient for a full turn — budget by the nerve's share5.
            {'matcher': 'SendMessage', 'hooks': [{'type': 'command', 'command': peer_gate}]},
        ],
    }


# SE-79: deny for a whole server closes its tools, but Claude Code still starts the server from .mcp.json — a process
# the role cannot use (about 1.9 GB on the Mac, 14.11). The genome turns such a server off. A name has no «__» inside:
# `mcp__hub__sentry*` is tools of the server hub, not a server.
WHOLE_SERVER = re.compile(r'^mcp__((?:[A-Za-z0-9-]|_(?!_))+)(?:__\*)?$')


def servers_off(deny, product_off=()):
    """Names for disabledMcpjsonServers: servers that deny closes whole, and servers the product turns off
    (instances/<slug>.json genome.disabledMcpjsonServers). A name that is not in .mcp.json does nothing: the key
    applies only to .mcp.json servers, so the build does not read .mcp.json (it is not in CI for other products).
    claude.ai connectors (`mcp__claude_ai_*`) are not .mcp.json servers: they are left out."""
    whole = {m.group(1) for d in deny for m in [WHOLE_SERVER.match(d)] if m and not m.group(1).startswith('claude_ai_')}
    return sorted(whole | set(product_off))


def genome(base, role, root=None, reflex=None, product=None, product_off=()):
    root = root or ROOT
    on = set(role.get('skills_on', []))
    overrides = {name: 'off' for name in base['skills_off'] if name not in on}
    overrides.update({name: 'name-only' for name in base['skills_name_only']})
    # SE-62: model and window travel with the genome (`claude --settings`), not with a CLAUDE_BIN wrapper outside git.
    window = {key: role.get(key, base.get(key)) for key in ('model', 'autoCompactWindow') if key in role or key in base}
    deny = base['deny'] + [d for d in role.get('deny', []) if d not in base['deny']]
    return {
        **window,
        'enabledPlugins': dict(base['enabledPlugins']),
        'skillOverrides': overrides,
        'disableBundledSkills': True,
        'permissions': {'deny': deny},
        'disabledMcpjsonServers': servers_off(deny, product_off),
        'env': {**base['env'], **role.get('env', {}), **({'TAIBE_PRODUCT': product} if product else {})},
        'claudeMdExcludes': [x.replace('{root}', root) for x in base['claudeMdExcludes']],
        'hooks': hooks(base['python'], reflex),
        'syncClaudeAiSkills': False,
        'skillListingMaxDescChars': 100,
    }


def build(table, root=None, reflex=None, product=None, product_off=()):
    return {name: genome(table['base'], role, root, reflex, product, product_off)
            for name, role in table['roles'].items()}


def product_off(cfg, slug):
    """genome.disabledMcpjsonServers of the product: a list of server names, or nothing."""
    off = (cfg.get('genome') or {}).get('disabledMcpjsonServers', [])
    if not isinstance(off, list) or not all(isinstance(x, str) and WHOLE_SERVER.match(f'mcp__{x}') for x in off):
        raise SystemExit(f'instances/{slug}.json: genome.disabledMcpjsonServers — a list of server names, got {off!r}')
    return tuple(off)


def products():
    """[(slug, out_dir, repo_root, reflex, product_off)] from instances/: the default product first, in genome/;
    others in genome/<slug>/. Without instances/ (a layer copy in a host) — one product from config.json, as before."""
    sys.path.insert(0, os.path.join(HERE, '..', '..', 'nerve'))
    if not os.path.isdir(os.path.join(HERE, '..', '..', '..', 'instances')):
        return [(None, HERE, ROOT, REFLEX, ())]   # a layer copy without instances/: the old single-product build
    import products as P                      # instances/ is there but broken — fail loudly, do not drop the env
    shared, items = P.load()
    default = shared['default_product']
    out = [(default, HERE, ROOT, REFLEX, product_off(P.config_for(default, shared, items), default))]
    for slug in sorted(items):
        if slug == default:
            continue
        cfg = P.config_for(slug, shared, items)
        layer = cfg.get('layer_home') or os.path.join(cfg['repo_root'], cfg['product_tree'])
        out.append((slug, os.path.join(HERE, slug), cfg['repo_root'], os.path.join(layer, 'pipeline', 'reflex'),
                    product_off(cfg, slug)))
    return out


def main(argv):
    ap = argparse.ArgumentParser(prog='build')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--product', help='only this product (slug from instances/)')
    args = ap.parse_args(argv)
    with open(TABLE, encoding='utf-8') as f:
        table = json.load(f)
    stale = []
    todo = [p for p in products() if not args.product or p[0] == args.product]
    if args.product and not todo:
        print(f'no product {args.product} in instances/', file=sys.stderr)
        return 2
    built = [(out, name, data) for slug, out, root, reflex, off in todo
             for name, data in build(table, root, reflex, slug, off).items()]
    for out, name, data in built:
        os.makedirs(out, exist_ok=True)
        path = os.path.join(out, f'{name}.json')
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
