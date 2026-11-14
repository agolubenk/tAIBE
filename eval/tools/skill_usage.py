"""TB-22 S22-3 (R-061): skill usage per day from Claude Code transcripts — counters for the SSR registry.

usage: python3 -I eval/tools/skill_usage.py [--days 7] [--json] [--post] [--product <slug> ...]

Reads the transcripts of this Mac (`~/.claude/projects/*/*.jsonl` and `<sid>/subagents/*.jsonl`) and counts the
`Skill` tool calls the way `eval/tools/context_audit.py` counts them. Per skill and local day:
- activations — `Skill` calls (a call written in two files counts once, by its tool_use id);
- tokens — method v1: the estimate of the skill text loaded into the context (`eval/evolve/tokens.py`) plus the
  output tokens of the call that loaded it;
- errors — heuristic v1: `is_error` on the result of the `Skill` call plus tool errors after it in the same turn (up
  to the next prompt that is not a tool result).

The skill and its product: the skill text starts with «Base directory for this skill: <dir>». The product is the one
from `instances/` whose `repo_root` holds that dir (a worktree is inside its main checkout); the entity name is the
dir's name. A skill outside every product (a plugin skill) is counted in the summary and never sent. A slash command
typed by a person is not a `Skill` call and is not counted in v1.

--post sends the counters to tAI-Boards: `POST {baseUrl}/api/ssr/{workspace}/usage`, one request per workspace, with
the Mac sync key. The workspace of a product is the sync home (`~/.t-boards-notebook*/config.json`) whose `repoRoot`
is the product's `repo_root`; a home without `baseUrl` is not sent to. The body holds counters only — kind, name,
day, numbers and a host hash — never the transcript text (N-009). Each run sends the full counts of the last --days
days, so a repeated day replaces the stored counts and does not add to them.

--product <slug> (repeat it for more) — the products whose counters are sent and printed as JSON. By default, only
the product of this checkout (the `instances/` product whose `repo_root` holds this file: taibe in tAIBE). A team
does not write to another product's workspace: the counters of HR go out only by the HR coord's decision.
"""
import glob
import hashlib
import json
import os
import socket
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'eval', 'evolve'))
from tokens import est_tokens  # noqa: E402

PROJECTS = os.path.expanduser('~/.claude/projects')
HOMES = os.path.expanduser('~/.t-boards-notebook*')
BASE_DIR = 'Base directory for this skill: '
NEEDLE = b'"Skill"'   # a pre-filter: a file without it has no Skill call, with or without spaces in its JSON
POST_TIMEOUT = 60


def products(root=ROOT):
    """slug → real repo_root of every product in `instances/`."""
    out = {}
    for path in sorted(glob.glob(os.path.join(root, 'instances', '*.json'))):
        if os.path.basename(path).startswith('_'):
            continue
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        if data.get('repo_root'):
            out[data.get('slug') or os.path.basename(path)[:-5]] = os.path.realpath(data['repo_root'])
    return out


def product_of(path, roots):
    """The product whose repo_root holds the path (the longest root wins); None — outside every product."""
    real = os.path.realpath(path)
    hits = [(len(r), slug) for slug, r in roots.items() if real == r or real.startswith(r + os.sep)]
    return max(hits)[1] if hits else None


def transcripts(projects=PROJECTS, since=0.0):
    """Transcript files changed since the time (s): main sessions and subagents."""
    files = glob.glob(os.path.join(projects, '*', '*.jsonl')) + \
        glob.glob(os.path.join(projects, '*', '*', 'subagents', '*.jsonl'))
    return sorted(f for f in files if os.path.getmtime(f) >= since)


def local_day(stamp):
    try:
        return datetime.fromisoformat(str(stamp).replace('Z', '+00:00')).astimezone().strftime('%Y-%m-%d')
    except ValueError:
        return None


def _blocks(msg):
    content = (msg or {}).get('content')
    if isinstance(content, str):
        return [{'type': 'text', 'text': content}]
    return [b for b in content or [] if isinstance(b, dict)]


def scan(path, seen):
    """Skill calls of one transcript: dicts {id, day, skill, dir, cwd, tokens, errors}. `seen` — tool_use ids
    already counted in other files; it is updated."""
    calls, last = [], None
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            msg = o.get('message') or {}
            blocks = _blocks(msg)
            if o.get('type') == 'assistant':
                out = int(((msg.get('usage') or {}).get('output_tokens')) or 0)
                for b in blocks:
                    if b.get('type') != 'tool_use' or b.get('name') != 'Skill' or b.get('id') in seen:
                        continue
                    seen.add(b.get('id'))
                    skill = str((b.get('input') or {}).get('skill') or '?')
                    last = {'id': b.get('id'), 'day': local_day(o.get('timestamp')), 'skill': skill, 'dir': None,
                            'cwd': o.get('cwd') or '', 'tokens': out, 'errors': 0}
                    calls.append(last)
                continue
            if o.get('type') != 'user' or last is None:
                continue
            results = [b for b in blocks if b.get('type') == 'tool_result']
            if results:
                last['errors'] += sum(1 for b in results if b.get('is_error') is True)
                continue
            texts = [b.get('text') or '' for b in blocks if b.get('type') == 'text']
            if o.get('isMeta') and texts and texts[0].startswith(BASE_DIR) and last['dir'] is None:
                last['dir'] = texts[0][len(BASE_DIR):].split('\n', 1)[0].strip()
                last['tokens'] += est_tokens('\n'.join(texts))
            elif not o.get('isMeta') and texts:
                last = None  # a new prompt: the turn of the skill is over
    return calls


def mentions_skill(path):
    """A cheap pass before parsing: most transcripts have no `Skill` call. Streams, does not load the file."""
    with open(path, 'rb') as f:
        return any(NEEDLE in line for line in f)


def where(call, roots):
    """(product, entity name) of a call. The loaded skill dir decides; a call that loaded no text (the launch
    failed) goes to the product of its cwd under the name it asked for, unless it is a plugin skill (`plugin:name`)."""
    if call['dir']:
        return product_of(call['dir'], roots), os.path.basename(call['dir'].rstrip('/'))
    if ':' in call['skill'] or not call['cwd']:
        return None, call['skill']
    return product_of(call['cwd'], roots), call['skill']


def collect(days=7, projects=PROJECTS, root=ROOT, now=None):
    """{'counts': {(product, name, day): {activations, tokens, errors}}, 'outside': {name: activations}}."""
    now = now or datetime.now()
    first = (now - timedelta(days=days - 1)).strftime('%Y-%m-%d')
    start = datetime.strptime(first, '%Y-%m-%d').timestamp()
    roots, seen = products(root), set()
    counts, outside = {}, {}
    for path in transcripts(projects, start):
        if not mentions_skill(path):
            continue
        for call in scan(path, seen):
            if not call['day'] or call['day'] < first:
                continue
            product, name = where(call, roots)
            if product is None:
                outside[call['skill']] = outside.get(call['skill'], 0) + 1
                continue
            row = counts.setdefault((product, name, call['day']), {'activations': 0, 'tokens': 0, 'errors': 0})
            row['activations'] += 1
            row['tokens'] += call['tokens']
            row['errors'] += call['errors']
    return {'counts': counts, 'outside': outside, 'first': first}


def host_id():
    """A stable host label without the machine name: the first 12 hex of sha256(hostname)."""
    return hashlib.sha256(socket.gethostname().encode('utf-8')).hexdigest()[:12]


def payloads(counts, host):
    """product → POST body: {host, days: [{day, items: [{kind, name, activations, tokens, errors}]}]}."""
    out = {}
    for (product, name, day), row in sorted(counts.items()):
        body = out.setdefault(product, {'host': host, 'days': []})
        if not body['days'] or body['days'][-1]['day'] != day:
            body['days'].append({'day': day, 'items': []})
        body['days'][-1]['items'].append({'kind': 'skill', 'name': name, **row})
    for body in out.values():
        body['days'].sort(key=lambda d: d['day'])
    return out


def sync_homes(pattern=HOMES):
    """real repoRoot → {workspace, base_url, home} of each Mac sync home; the key stays in the home. base_url is None
    when the home has no baseUrl: the server address is the home's setting, never a value in this code."""
    out = {}
    for home in sorted(glob.glob(pattern)):
        try:
            with open(os.path.join(home, 'config.json'), encoding='utf-8') as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            continue
        if cfg.get('repoRoot') and cfg.get('workspaceId'):
            out[os.path.realpath(cfg['repoRoot'])] = {
                'workspace': cfg['workspaceId'], 'home': home,
                'base_url': (cfg.get('baseUrl') or '').rstrip('/') or None}
    return out


def own_product(roots, path=HERE):
    """The product of this checkout: the one whose repo_root holds this file."""
    return product_of(path, roots)


def post(bodies, roots, homes, opener=urllib.request.urlopen):
    """Send each product's body to its workspace; one product's failure does not stop the others. → (lines, failed)."""
    lines, failed = [], 0
    for product, body in sorted(bodies.items()):
        target = homes.get(roots.get(product, ''))
        if not target:
            lines.append('%s: no sync home with repoRoot %s — not sent' % (product, roots.get(product)))
            failed += 1
            continue
        if not target['base_url']:
            lines.append('%s: no baseUrl in %s/config.json — not sent' % (product, target['home']))
            failed += 1
            continue
        url = '%s/api/ssr/%s/usage' % (target['base_url'], target['workspace'])
        try:
            with open(os.path.join(target['home'], 'api_key'), encoding='utf-8') as f:
                key = f.read().strip()
            req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'), method='POST',
                                         headers={'content-type': 'application/json', 'x-api-key': key})
            with opener(req, timeout=POST_TIMEOUT) as res:
                answer = res.read().decode('utf-8', 'replace')
            lines.append('%s → %s: %s' % (product, target['workspace'], answer[:300]))
        except (urllib.error.URLError, OSError) as exc:
            lines.append('%s → %s: %s' % (product, target['workspace'], exc))
            failed += 1
    return lines, failed


def render(result):
    by_product = {}
    for (product, name, _day), row in result['counts'].items():
        agg = by_product.setdefault(product, {}).setdefault(name, {'activations': 0, 'tokens': 0, 'errors': 0})
        for k in agg:
            agg[k] += row[k]
    lines = ['Скиллы с %s (%s):' % (result['first'], ', '.join(sorted(by_product)) or 'нет вызовов')]
    for product, rows in sorted(by_product.items()):
        for name, row in sorted(rows.items(), key=lambda kv: -kv[1]['activations']):
            lines.append('  %s %s: %d вызовов, ~%d токенов, ошибок %d' % (
                product, name, row['activations'], row['tokens'], row['errors']))
    if result['outside']:
        lines.append('  вне продуктов (не отправляются): ' + ', '.join(
            '%s %d' % kv for kv in sorted(result['outside'].items(), key=lambda kv: -kv[1])))
    return '\n'.join(lines)


def selected(argv, roots):
    """The --product slugs; by default, the product of this checkout only."""
    chosen = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == '--product']
    if chosen:
        return set(chosen)
    own = own_product(roots)
    return {own} if own else set()


def pick(bodies, chosen):
    """(the bodies of the chosen products, the names of the products left out)."""
    return ({product: body for product, body in bodies.items() if product in chosen},
            sorted(set(bodies) - set(chosen)))


def main(argv):
    days = int(argv[argv.index('--days') + 1]) if '--days' in argv else 7
    roots = products()
    result = collect(days)
    bodies, left = pick(payloads(result['counts'], host_id()), selected(argv, roots))
    if '--json' in argv:
        print(json.dumps(bodies, ensure_ascii=False, indent=1))
    else:
        print(render(result))
    if left:
        print('не выбраны (--product), не отправляются: ' + ', '.join(left))
    if '--post' in argv:
        lines, failed = post(bodies, roots, sync_homes())
        print('\n'.join(lines))
        return 1 if failed else 0
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
