#!/usr/bin/env python3
"""Focus on a large queue: the few cards to work on next, in the board's order, in a few hundred tokens.

    python3 -I eval/tools/queue_focus.py eval/board/plan-*.json            # board plan files (projects[].cards[])
    python3 -I eval/tools/queue_focus.py export.json --top 5 --wip 2       # an MCP `list_tasks` export (a list)
    python3 -I eval/tools/queue_focus.py plan.json --json
    python3 -I eval/tools/queue_focus.py --plan --product taibe          # next cards from the owner-queue plan

`--plan` (SE-65, F1): the cards to take next come from the product's plan rows in the owner queue, not from the
newest signal. Rows: `work/w-<slug>-*` (the default product: every row without another product's prefix), without
`who: owner`, `blocked` and `done` rows. Row order: `work/focus-<slug>.rows` (TB-107), then `planStart`, `order`, id.
Inside a row: the board's law below. A card in two rows belongs to the first row by rank. Cards in progress are held
by a lane and are skipped, except a card with `mark` «без аренды» (TB-106: no lease, no update for 24 h; `c` is
the legacy card code): it comes first.
One GET of `/db/work`; token — `$OQ_TOKEN` or `instances/_shared.json` `queue.secret_cmd`.

Order is the board's law (`.claude/rules/17-notion-board.md`), not a guess:
1. bugs before tasks (kind `bug`, a severity, or the «Ошибки» project), by severity critical → high → medium → low;
2. finish before starting: cards already in progress or on review come first — when their number reaches `--wip`,
   new starts are not proposed at all;
3. then priority (urgent/critical → high → medium → low), then how many open cards the card unblocks, then key.
Out of the focus: final statuses (done, Брёвна, closed, выполненные, завершённые, закрыто), raw ideas (`halfBaked`
— not taken without the owner's go-ahead) and decided «what we do not build» reports. A card blocked by an open card
is listed under «blocked» with its blockers instead of being proposed. A card with open subtasks (a goal, a branch)
is not a work item — its leaves are. With `--session` (default `$TAIBE_LINEAGE`, set by `spawn_session.sh`) cards
held by other sessions leave the focus and the WIP count: a descendant is not frozen by its siblings' work.
Stdlib only.
"""
import argparse
import json
import os
import sys

FINAL = {'done', 'closed', 'archived', 'брёвна', 'бревна', 'выполненные', 'завершённые', 'завершенные', 'закрыто'}
ACTIVE = {'in-progress', 'in-review', 'в работе', 'на ревью', 'review'}
RANK = {'urgent': 0, 'critical': 0, 'p0': 0, 'high': 1, 'p1': 1, 'medium': 2, 'p2': 2, 'low': 3, 'p3': 3}
WAITING = {'grilling'}  # the card waits for the owner's answers (grill-task): not a lane's next card
BUG_PROJECTS = {'ошибки', 'bugs', 'errors'}


def _status(card):
    return str(card.get('status') or card.get('column') or '').strip().lower()


def load(paths):
    """Cards from plan files ({projects: [{key, name, cards}]}) or exports (a list of tasks, or {tasks: [...]})."""
    cards = []
    for path in paths:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict) and 'projects' in data:
            for project in data['projects']:
                for card in project.get('cards', []):
                    cards.append(dict(card, _project=str(project.get('name') or project.get('key') or '')))
        else:
            rows = data.get('tasks', data.get('items', [])) if isinstance(data, dict) else data
            for n, card in enumerate(rows):
                key = card.get('key') or card.get('ticketId') or card.get('backlogId') or card.get('id') \
                    or '%s#%d' % (path, n)  # never let keyless cards overwrite each other
                cards.append(dict(card, key=str(key), _project=str(card.get('project') or card.get('projectName') or '')))
    by_key = {}
    for card in cards:  # the same card in two plans: the later file wins (plans are patches)
        by_key[str(card['key'])] = card
    return by_key


def is_bug(card):
    return (card.get('kind') == 'bug' or bool(card.get('severity'))
            or card.get('_project', '').strip().lower() in BUG_PROJECTS)


def blockers_of(cards):
    """{key: [open blocker keys]} from `blocks` (this card blocks those) and `blockedBy`."""
    out = {}
    for key, card in cards.items():
        for target in card.get('blocks', []) or []:
            out.setdefault(str(target), set()).add(key)
        for source in card.get('blockedBy', []) or []:
            out.setdefault(key, set()).add(str(source))
    return {k: sorted(b for b in v if b in cards and _status(cards[b]) not in FINAL) for k, v in out.items()}


def unblocks(cards, key):
    """Open cards this one unblocks, transitively (explicit stack: long chains and cycles are fine)."""
    seen, stack = set(), [key]
    while stack:
        for target in cards.get(stack.pop(), {}).get('blocks', []) or []:
            target = str(target)
            if target in cards and target not in seen and target != key and _status(cards[target]) not in FINAL:
                seen.add(target)
                stack.append(target)
    return seen


def holder(card):
    """The session that holds the card: lease, work state or the card's own `session` label."""
    for field in ('session', 'leaseSession', 'leaseHolder', 'holder'):
        if card.get(field):
            return str(card[field])
    state = card.get('workState') if isinstance(card.get('workState'), dict) else {}
    return str(state.get('session') or '')


def workable(card):
    return _status(card) not in FINAL and not card.get('halfBaked') and not card.get('report')


def focus(cards, top=7, wip=3, session=None):
    blocked_by = blockers_of(cards)
    # A card with workable subtasks is a root or a branch of the forest: the work is in its leaves. Raw-idea and
    # report children do not count — a goal with only those is still a work item.
    containers = {str(c['parent']) for c in cards.values() if c.get('parent') and workable(c)}
    skipped = {'final': 0, 'halfBaked': 0, 'report': 0, 'container': 0, 'others': 0}
    candidates, blocked = [], []
    for key, card in cards.items():
        status = _status(card)
        if status in FINAL:
            skipped['final'] += 1
            continue
        if card.get('halfBaked'):
            skipped['halfBaked'] += 1
            continue
        if card.get('report'):
            skipped['report'] += 1
            continue
        if key in containers:
            skipped['container'] += 1
            continue
        held = holder(card)
        if session and held and held != session and not held.startswith(session + '.'):
            skipped['others'] += 1  # held by a sibling or the ancestor's other line — not this session's work
            continue
        item = {
            'key': key,
            'title': str(card.get('title', '')),
            'status': status or 'to-do',
            'priority': str(card.get('severity') or card.get('priority') or 'low').lower(),
            'bug': is_bug(card),
            'active': status in ACTIVE,
            'unblocks': len(unblocks(cards, key)),
        }
        if blocked_by.get(key) and not item['active']:
            item['blockedBy'] = blocked_by[key]
            blocked.append(item)
        else:
            candidates.append(item)
    order = lambda i: (not i['bug'], not i['active'], RANK.get(i['priority'], 4), -i['unblocks'], i['key'])  # noqa: E731
    candidates.sort(key=order)
    blocked.sort(key=order)
    active = [i for i in candidates if i['active']]
    if len(active) >= wip:  # WIP limit: finish what is open, start nothing new
        picked = active[:top]
        note = 'WIP %d ≥ %d: доведи начатое, новое не бери' % (len(active), wip)
    else:
        picked = candidates[:top]
        note = 'WIP %d из %d' % (len(active), wip)
    return {'focus': picked, 'blocked': blocked[:top], 'note': note, 'open': len(candidates) + len(blocked),
            'skipped': skipped}


def render(result):
    sk = result['skipped']
    lines = ['Фокус (%s; открыто %d; вне фокуса: финальные %d, сырые идеи %d, отчёты %d, ветки с открытыми '
             'подзадачами %d, у других сессий %d):' % (result['note'], result['open'], sk['final'], sk['halfBaked'],
                                                    sk['report'], sk['container'], sk['others'])]
    for i in result['focus']:
        tag = 'bug ' if i['bug'] else ''
        more = ' · открывает %d' % i['unblocks'] if i['unblocks'] else ''
        lines.append('  %s · %s%s · %s%s · %s' % (i['key'], tag, i['priority'], i['status'], more, i['title'][:80]))
    if result['blocked']:
        lines.append('Ждут блокеров:')
        for i in result['blocked']:
            lines.append('  %s ← %s · %s' % (i['key'], ', '.join(i['blockedBy']), i['title'][:70]))
    return '\n'.join(lines)


ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
ABANDONED = 'без аренды'
NOT_ROWS = ('done', 'blocked')


def products(root=ROOT):
    """(default product, every product slug) from `instances/`."""
    with open(os.path.join(root, 'instances', '_shared.json'), encoding='utf-8') as f:
        default = json.load(f).get('default_product') or 'hr-helper'
    slugs = [n[:-5] for n in sorted(os.listdir(os.path.join(root, 'instances')))
             if n.endswith('.json') and not n.startswith('_')]
    return default, slugs


def plan_rows(docs, product, default, slugs):
    """The product's open agent rows as (id, data). Prefix `w-<slug>-`; the default product owns unprefixed rows."""
    others = ['w-%s-' % s for s in slugs if s != default]
    rows = []
    for doc in docs:
        rid, d = str(doc.get('id') or ''), doc.get('data') or {}
        if not rid.startswith('w-') or d.get('kind') or d.get('archived'):
            continue
        own = rid.startswith('w-%s-' % product) if product != default else not any(rid.startswith(p) for p in others)
        if own and d.get('status') not in NOT_ROWS and d.get('who') != 'owner':
            rows.append((rid, d))
    return rows


def rank_rows(rows, order=()):
    """The focus doc's order first (TB-107), then `planStart`, `order`, id. A row without a date goes last."""
    pos = {rid: n for n, rid in enumerate(order)}
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else 1e9  # noqa: E731
    return sorted(rows, key=lambda r: (pos.get(r[0], len(pos)), r[1].get('planStart') or '9999-12-31',
                                       num(r[1].get('order')), r[0]))


def plan_next(rows, top=5):
    """The first `top` free cards: rows in rank order, inside a row the board's law; abandoned starts first."""
    seen, out = set(), []
    for rank, (rid, d) in enumerate(rows, 1):
        cards = {}
        for c in d.get('cards') or []:
            key = str(c.get('key') or '') if isinstance(c, dict) else ''
            if not key or key in seen:
                continue
            seen.add(key)
            bug = c.get('k') == 'bug'
            cards[key] = {'key': key, 'title': str(c.get('t') or ''), 'status': str(c.get('st') or 'to-do'),
                          'kind': 'bug' if bug else 'task', ('severity' if bug else 'priority'): str(c.get('s') or ''),
                          'abandoned': c.get('mark') == ABANDONED}
        cards = {k: v for k, v in cards.items() if v['status'].lower() not in WAITING}
        if not cards:
            continue
        picked = focus(cards, top=len(cards), wip=len(cards) + 1)['focus']
        gone = [i for i in picked if cards[i['key']]['abandoned']]
        free = gone + [i for i in picked if not i['active'] and i not in gone]
        for i in free:
            why = ('брошена (нет аренды 24 ч) — доведи' if cards[i['key']]['abandoned']
                   else ('ошибка ' if i['bug'] else '') + i['priority'])
            out.append(dict(i, row=rid, rank=rank, why=why))
            if len(out) >= top:
                return out
    return out


def fetch_work(root=ROOT):
    """All `work` docs of the owner queue: paged GET, the same token as the Nerve (stdlib, TLS verified)."""
    import ssl
    import subprocess
    import urllib.request
    with open(os.path.join(root, 'instances', '_shared.json'), encoding='utf-8') as f:
        queue = json.load(f)['queue']
    token = os.environ.get('OQ_TOKEN', '').strip() or subprocess.run(
        ['bash', os.path.join(root, queue['secret_cmd']), 'OQ_TOKEN'], capture_output=True, text=True, timeout=20,
        cwd=root).stdout.strip()
    if not token:
        raise SystemExit('нет OQ_TOKEN: env или %s' % queue['secret_cmd'])
    try:
        sys.path.insert(0, os.path.join(root, '.claude', 'scripts'))
        import pipeline_settings
        ctx = pipeline_settings._tls_context() or ssl.create_default_context()
    except Exception:  # noqa: BLE001 — the default store still verifies
        ctx = ssl.create_default_context()
    docs, offset = [], 0
    while True:
        req = urllib.request.Request('%s/api/oq/v1/db/work?limit=500&offset=%d' % (queue['url'].rstrip('/'), offset),
                                     headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            page = json.loads(resp.read() or b'{}')
        docs += page.get('docs') or []
        if page.get('next_offset') is None:
            return docs
        offset = page['next_offset']


def plan(product=None, top=5, root=ROOT, docs=None):
    default, slugs = products(root)
    product = product or os.environ.get('TAIBE_PRODUCT') or default
    docs = fetch_work(root) if docs is None else docs
    order = next(((d.get('data') or {}).get('rows') or [] for d in docs if d.get('id') == 'focus-%s' % product), [])
    rows = rank_rows(plan_rows(docs, product, default, slugs), order)
    return {'product': product, 'rows': len(rows), 'next': plan_next(rows, top)}


def render_plan(result):
    if not result['next']:
        return ('План %s: свободных карточек в строках нет (%d строк). Не бери работу вне плана — спроси координатора.'
                % (result['product'], result['rows']))
    lines = ['Следующее по плану %s (строк %d; возьми первое, аренда занята — следующее):' % (result['product'],
                                                                                             result['rows'])]
    for i in result['next']:
        lines.append('  %s · %s · %s · строка %s (#%d) · %s' % (i['key'], i['why'], i['status'], i['row'], i['rank'],
                                                              i['title'][:70]))
    return '\n'.join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('files', nargs='*')
    ap.add_argument('--plan', action='store_true', help='next cards from the owner-queue plan rows (SE-65)')
    ap.add_argument('--product', help='product slug for --plan (default $TAIBE_PRODUCT, else the default product)')
    ap.add_argument('--top', type=int, default=7)
    ap.add_argument('--wip', type=int, default=3, help='open in-progress/review cards before new starts stop')
    ap.add_argument('--session', default=os.environ.get('TAIBE_LINEAGE'),
                    help='own lineage id (default $TAIBE_LINEAGE): cards held by other sessions leave the focus and '
                         'the WIP count; descendants of this lineage count as own')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)
    if args.plan:
        result = plan(args.product, min(args.top, 5))
        print(json.dumps(result, ensure_ascii=False, indent=1) if args.json else render_plan(result))
        return 0
    if not args.files:
        ap.error('files or --plan')
    result = focus(load(args.files), args.top, args.wip, args.session)
    print(json.dumps(result, ensure_ascii=False, indent=1) if args.json else render(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
