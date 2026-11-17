#!/usr/bin/env python3
"""Ask the owner once: before a question goes to the owner, look for its answer in what the team already has.

    python3 -I eval/tools/ask_once.py check "можно ли арендовать вырубленную карточку?" [--oq oq-export.json]
    python3 -I eval/tools/ask_once.py record --q "…" --a "<the owner's words>" --source "чат 01.11" [--id d-…]

Exit code of `check`:
- 0 — nothing close: ask the owner (in the owner queue), and `record` the answer when it comes;
- 3 — a candidate answer: READ the hit; if it really answers your question, cite it and do not ask, otherwise ask;
- 4 — the same question is already open (owner queue, spec `Q-1xx`): do not ask again, wait;
- 5 — no source could be read at all (wrong root, files missing): that is not «nobody decided», fix and retry.

A hit counts only when its score passes the threshold (0.3) AND it shares a distinctive word with the question
(one that occurs in ≤ 3 % of documents). On 8 answered and 8 unanswered questions (01.11) that finds 7 of 8 answers
with 1 false candidate — hence exit 3 means "read it", not "decided": "which language for commits?" does not borrow
the answer about the UI language, but a near miss can still surface and the reader rejects it. Only owner answers decide: the ledger `eval/data/decisions.jsonl` (one JSON per line; the last line of
an id wins, so a correction is a new line with the same id), the closed-items log `docs/plans/done/*.md` and spec
rows citing an owner answer `Q-0xx` or decision `D-0xx` (`boards/docs/t-boards-spec.md`). Open questions live where
the rules put them — the owner queue (`--oq`: an `oq_list` export) and the spec (`Q-1xx`); the roadmap summary
`open-items.md` is deleted (open work is on the boards). Matching is
TF-IDF over crudely stemmed words (Russian and English); ledger entries carry `kw` — keywords in the other language.
Nothing leaves the machine. Stdlib only.
"""
import argparse
import datetime
import json
import math
import os
import re
import secrets
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LEDGER = 'eval/data/decisions.jsonl'
DONE_DIR = 'docs/plans/done'
SPEC = 'boards/docs/t-boards-spec.md'
LEDGER_BOOST = 1.25  # a curated question→answer pair beats a line that only shares words
DECIDES = {'answered', 'done', 'spec'}
WORD = re.compile(r'[0-9a-zа-яё]+', re.I)
STOP = set('и в во не на с со что как по к ко о об от до за из у же ли бы то это а но или для при без над под '
           'ещё уже да нет его её их мы вы он она они я ты можно нужно ли какой какая какие какой-то ли '
           'the a an of to in on for and or is are be it this that with as by at from do does should can we i '
           'what which how when'.split())
ENDINGS = ('ings', 'ing', 'ies', 'ied', 'ed', 'es', 's')


def stem(word):
    w = word.lower().replace('ё', 'е')
    if re.match(r'[а-я]', w):
        return w[:5]  # Russian morphology lives in the endings; five letters keep the root
    for end in ENDINGS:
        if len(w) > len(end) + 3 and w.endswith(end):
            return w[:-len(end)][:7]
    return w[:7]


def terms(text):
    return [stem(w) for w in WORD.findall(text) if w.lower() not in STOP and len(w) > 1]


def _lines(root, rel):
    path = os.path.join(root, rel)
    if not os.path.isfile(path):
        return []
    with open(path, encoding='utf-8', errors='replace') as f:
        return list(enumerate(f.read().splitlines(), 1))


def ledger(root):
    """{id: (line number, entry)} — the last line of an id wins."""
    out = {}
    for n, line in _lines(root, LEDGER):
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('id'):
            out[e['id']] = (n, e)
    return out


def from_oq(path):
    """Open owner-queue items of an `oq_list` export (a list, or {items: [...]})."""
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    rows = data.get('items', data.get('docs', [])) if isinstance(data, dict) else data
    out = []
    for doc in rows:
        d = doc.get('data', doc)
        if d.get('done') or str(d.get('status', '')).lower() in ('done', 'closed'):
            continue
        text = ' '.join(str(d.get(k, '')) for k in ('title', 'question', 'body', 'text') if d.get(k))
        if text:
            out.append(('open', 'oq:%s' % doc.get('id', '?'), text))
    return out


def documents(root, oq=None):
    """[(status, source, text)]; status: answered | done | spec (decide) · open."""
    docs = []
    for ident, (n, e) in sorted(ledger(root).items(), key=lambda kv: kv[1][0]):
        if e.get('a'):
            text = '%s → %s [%s]' % (e.get('q', ''), e['a'], e.get('kw', ''))
            docs.append(('answered', '%s:%d (%s, %s)' % (LEDGER, n, ident, e.get('source', '?')), text))
    done = os.path.join(root, DONE_DIR)
    if os.path.isdir(done):
        for name in sorted(os.listdir(done)):
            rel = '%s/%s' % (DONE_DIR, name)
            for n, line in _lines(root, rel):
                if line.startswith(('- ', '* ', '|')) and len(terms(line)) >= 4:
                    docs.append(('done', '%s:%d' % (rel, n), line))
    for n, line in _lines(root, SPEC):
        if not line.startswith('|') or len(terms(line)) < 4:
            continue
        if re.search(r'\b[QD]-0\d\d\b', line):
            docs.append(('spec', '%s:%d' % (SPEC, n), line))
        elif re.search(r'\bQ-1\d\d\b', line):
            docs.append(('open', '%s:%d' % (SPEC, n), line))
    if oq:
        docs += from_oq(oq)
    return docs


def rank(question, docs, top=3):
    """[(score, status, source, text, distinctive shared words)] by cosine of TF-IDF vectors."""
    bags = [terms(text) for _, _, text in docs]
    df = {}
    for bag in bags:
        for t in set(bag):
            df[t] = df.get(t, 0) + 1
    n = len(docs) or 1
    idf = {t: math.log((n + 1) / (c + 0.5)) for t, c in df.items()}
    rare = max(2, int(n * 0.03))  # a word in ≤ 3 % of documents names the subject, not the grammar

    def vec(bag):
        v = {}
        for t in bag:
            v[t] = v.get(t, 0) + idf.get(t, math.log(n + 1))
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {t: x / norm for t, x in v.items()}

    q = vec(terms(question))
    scored = []
    for (status, source, text), bag in zip(docs, bags):
        d = vec(bag)
        score = sum(w * d.get(t, 0.0) for t, w in q.items())
        if source.startswith(LEDGER):
            score *= LEDGER_BOOST
        if score > 0:
            shared = sorted(t for t in q if t in d and df.get(t, 0) <= rare)
            scored.append((round(score, 3), status, source, text, shared))
    scored.sort(key=lambda s: -s[0])
    return scored[:top]


def verdict(hits, threshold, min_shared=1):
    strong = [h for h in hits if h[0] >= threshold and len(h[4]) >= min_shared]
    if not strong:
        return 0
    return 4 if strong[0][1] == 'open' else 3 if strong[0][1] in DECIDES else 0


def pipeline_on(name):
    """The product's switch (`.claude/scripts/pipeline_settings.py`); errors → on."""
    try:
        sys.path.insert(0, os.path.join(ROOT, '.claude', 'scripts'))
        import pipeline_settings
        return pipeline_settings.enabled(name)
    except Exception:  # noqa: BLE001
        return True


def record(root, q, a, source, ident, date):
    if not q.strip() or not source.strip() or not (a or '').strip():
        raise SystemExit('ask_once: --q, --a and --source are required (open questions go to the owner queue)')
    entry = {'id': ident or 'd-%s-%s' % (date.replace('-', ''), secrets.token_hex(3)), 'date': date,
             'q': q.strip(), 'a': a.strip(), 'source': source.strip()}
    path = os.path.join(root, LEDGER)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    return entry


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', default=ROOT)
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check')
    c.add_argument('question')
    c.add_argument('--oq', help='an oq_list export (JSON): its open items count as asked')
    c.add_argument('--threshold', type=float, default=0.3)
    c.add_argument('--top', type=int, default=3)
    c.add_argument('--json', action='store_true')
    r = sub.add_parser('record')
    r.add_argument('--q', required=True)
    r.add_argument('--a', required=True)
    r.add_argument('--source', required=True)
    r.add_argument('--id', default='', help='reuse an id to correct an earlier answer (the last line wins)')
    r.add_argument('--date', default=datetime.date.today().isoformat())
    args = ap.parse_args(argv)

    if args.cmd == 'record':
        print(json.dumps(record(args.root, args.q, args.a, args.source, args.id, args.date), ensure_ascii=False))
        return 0
    if not pipeline_on('askOnce'):
        print('ask_once: off in the product settings (tAI-Boards → «Pipeline & evolution», askOnce) — ask as usual')
        return 0
    docs = documents(args.root, args.oq)
    if not docs:
        # E9: no source could be read — that is not «nobody decided this», so the owner is not asked again blindly.
        print('ask_once: ни один источник не прочитан (%s, %s, %s) — это не «ответа нет»; проверь корень '
              '(--root) и файлы, потом повтори' % (LEDGER, DONE_DIR, SPEC))
        return 5
    hits = rank(args.question, docs, args.top)
    code = verdict(hits, args.threshold)
    if args.json:
        print(json.dumps({'verdict': {0: 'ask', 3: 'candidate', 4: 'open'}[code],
                          'hits': [dict(zip(('score', 'status', 'source', 'text', 'shared'), h)) for h in hits]},
                         ensure_ascii=False, indent=1))
    else:
        label = {0: 'близкого нет — спрашивай владельца (очередь), ответ — `record`',
                 3: 'есть кандидат-ответ — прочитай его: отвечает на твой вопрос — сошлись и не спрашивай, нет — спрашивай',
                 4: 'такой вопрос уже открыт — не спрашивай повторно, жди ответа в очереди'}[code]
        print('ask_once: %s' % label)
        for score, status, source, text, shared in hits:
            print('  %.2f %-8s %s [%s]\n       %s' % (score, status, source, ' '.join(shared), text.strip()[:200]))
    return code


if __name__ == '__main__':
    sys.exit(main())
