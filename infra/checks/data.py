"""Data completeness and integrity of what the product keeps in git:

- every tracked `.json` parses (JSON-with-comments configs — tsconfig, .vscode, *.jsonc — are skipped), every
  `.jsonl` line parses;
- board plans `eval/board/plan-*.json`: unique keys, a known status and priority, `parent`/`blocks`/`related` point
  to cards that exist (in any plan or the seed), no subtask cycles;
- the owner-decision ledger `eval/data/decisions.jsonl`: id, q, a, source, ISO date on every line;
- drizzle migrations `boards/apps/api/drizzle/`: the journal is sequential (`idx` 0…n), `when` strictly grows
  (drizzle skips a migration whose `when` is not newer — the 0077 collision of 31.10), every journal entry has its
  `.sql` and snapshot, and every `.sql` is in the journal;
- the owner-queue schema `oq` in the boards' Postgres (TB-28, `docs/specs/owner-queue-move.md` §5.2): the boards'
  code under `boards/apps/` and `boards/packages/` holds no SQL to `oq.*` — the ops console is its only writer, and the
  boards app connects as a superuser. Only the migrations create the schema.
"""
import glob
import json
import os
import re

from common import Finding, VENDORED

JSONC = ('tsconfig', '.vscode/', '.jsonc', 'jsconfig', 'biome.json', 'turbo.json', 'devcontainer.json',
         '.oxlintrc', 'components.json')
STATUSES = {'to-do', 'in-progress', 'in-review', 'done', 'archived', 'planned', 'backlog'}
PRIORITIES = {'no-priority', 'low', 'medium', 'high', 'urgent', 'critical'}
DRIZZLE = 'boards/apps/api/drizzle'
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
OQ_CODE = ('boards/apps/', 'boards/packages/')
OQ_EXT = ('.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql', '.sh')
# A table of the schema, the schema itself in DDL or search_path, a drizzle pgSchema("oq").
OQ_SQL = re.compile(r'''\boq"?\s*\.\s*"?(docs|events|files)\b|\bschema\s+"?oq\b|search_path[^;\n]*\boq\b|'''
                    r'''pgSchema\(\s*['"`]oq['"`]''', re.IGNORECASE)


def json_files(root, files):
    out = []
    for path in files:
        if path.startswith(VENDORED):
            continue
        full = os.path.join(root, path)
        if path.endswith('.json') and not any(m in path for m in JSONC):
            try:
                with open(full, encoding='utf-8') as f:
                    json.load(f)
            except (ValueError, UnicodeDecodeError) as e:
                out.append(Finding('data', 'error', path, getattr(e, 'lineno', 0), 'invalid JSON: %s' % str(e)[:120]))
        elif path.endswith('.jsonl'):
            with open(full, encoding='utf-8', errors='replace') as f:
                for n, line in enumerate(f, 1):
                    if line.strip():
                        try:
                            json.loads(line)
                        except ValueError as e:
                            out.append(Finding('data', 'error', path, n, 'invalid JSON line: %s' % str(e)[:100]))
    return out


def plans(root):
    out, cards, where = [], {}, {}
    paths = sorted(glob.glob(os.path.join(root, 'eval/board/plan-*.json')))
    for full in paths:
        rel = os.path.relpath(full, root)
        with open(full, encoding='utf-8') as f:
            data = json.load(f)
        for project in data.get('projects', []):
            for card in project.get('cards', []):
                key = card.get('key')
                if not key:
                    out.append(Finding('data', 'error', rel, 0, 'card without key: %s' % card.get('title', '')[:60]))
                    continue
                if key in where and where[key] == rel:
                    out.append(Finding('data', 'error', rel, 0, 'duplicate card key %s' % key))
                cards[key], where[key] = card, rel
                if card.get('status') not in STATUSES:
                    out.append(Finding('data', 'error', rel, 0, '%s: unknown status %r' % (key, card.get('status'))))
                if card.get('priority') not in PRIORITIES:
                    out.append(Finding('data', 'error', rel, 0, '%s: unknown priority %r' % (key, card.get('priority'))))
        for edit in data.get('edits', []):
            cards.setdefault(edit.get('key'), {})  # edits name seed cards that exist on the board
            where.setdefault(edit.get('key'), rel)
        for link in data.get('links', []):
            for k in (link.get('from'), link.get('to')):
                if k:
                    cards.setdefault(k, {})
                    where.setdefault(k, rel)
    seed = re.compile(r'^(TB|SE|OPS)-\d+$')  # seed cards on the board (plan format note) — not in the plan files
    for key, card in cards.items():
        refs = ([card['parent']] if card.get('parent') else []) + list(card.get('blocks', []) or []) \
            + list(card.get('related', []) or [])
        for ref in refs:
            if ref not in cards and not seed.match(str(ref)):
                out.append(Finding('data', 'error', where[key], 0, '%s points to unknown card %s' % (key, ref)))
    for key in cards:
        seen, cur = set(), key
        while cur in cards and cards[cur].get('parent'):
            if cur in seen:
                out.append(Finding('data', 'error', where[key], 0, 'subtask cycle through %s' % key))
                break
            seen.add(cur)
            cur = cards[cur]['parent']
    return out


def decisions(root):
    out, rel = [], 'eval/data/decisions.jsonl'
    full = os.path.join(root, rel)
    if not os.path.isfile(full):
        return out
    with open(full, encoding='utf-8') as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue  # reported by json_files
            missing = [k for k in ('id', 'q', 'a', 'source', 'date') if not str(e.get(k, '')).strip()]
            if missing:
                out.append(Finding('data', 'error', rel, n, 'missing %s' % ', '.join(missing)))
            elif not DATE.match(e['date']):
                out.append(Finding('data', 'error', rel, n, 'date is not ISO: %r' % e['date']))
    return out


def drizzle(root):
    out = []
    base = os.path.join(root, DRIZZLE)
    journal = os.path.join(base, 'meta', '_journal.json')
    if not os.path.isfile(journal):
        return out
    rel = os.path.relpath(journal, root)
    with open(journal, encoding='utf-8') as f:
        entries = json.load(f).get('entries', [])
    last_when, tags = None, set()
    for i, e in enumerate(entries):
        tag = e.get('tag', '')
        tags.add(tag)
        if e.get('idx') != i:
            out.append(Finding('data', 'error', rel, 0, 'entry %s: idx %s, expected %d' % (tag, e.get('idx'), i)))
        if last_when is not None and e.get('when', 0) <= last_when:
            out.append(Finding('data', 'error', rel, 0, '%s: when %s is not newer than the previous %s — drizzle '
                               'would skip it on existing databases' % (tag, e.get('when'), last_when)))
        last_when = e.get('when', 0)
        if not os.path.isfile(os.path.join(base, tag + '.sql')):
            out.append(Finding('data', 'error', rel, 0, '%s: no %s.sql' % (tag, tag)))
        if not os.path.isfile(os.path.join(base, 'meta', '%s_snapshot.json' % tag.split('_', 1)[0])):
            out.append(Finding('data', 'warning', rel, 0, '%s: no snapshot (next db:generate diffs against an older one)'
                               % tag))
    for sql in sorted(glob.glob(os.path.join(base, '*.sql'))):
        tag = os.path.basename(sql)[:-4]
        if tag not in tags:
            out.append(Finding('data', 'error', os.path.relpath(sql, root), 0, 'migration is not in the journal — '
                               'it never runs'))
    return out


def oq_schema(root, files, read_text):
    out = []
    for path in files:
        if not path.startswith(OQ_CODE) or path.startswith(DRIZZLE + '/') or not path.endswith(OQ_EXT):
            continue
        for n, line in enumerate((read_text(root, path) or '').splitlines(), 1):
            if OQ_SQL.search(line):
                out.append(Finding('data', 'error', path, n, 'SQL to the owner-queue schema oq.*: the ops console is '
                                   'its only writer, the boards read it through the console API (TB-28)'))
    return out


def run(root, files, read_text):
    return (json_files(root, files) + plans(root) + decisions(root) + drizzle(root)
            + oq_schema(root, files, read_text))
