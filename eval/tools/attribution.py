#!/usr/bin/env python3
"""К чему отнесён вызов модели: PR, карточка или «не отнесено» (GL-1, PR 2 плана замера 14.11, v1.1).
Только чтение транскриптов и списка PR; сессиям и доскам не пишет. Вход — spend.scan(sink=Ledger(...)).

Определения (план v1.1 на карточке GL-1):
- События — из блоков tool_use всех записей файла, до отсева повторов requestId:
  `*forest_set_work_state` — карточка (taskId) и ветка (branch): состояние заменяется целиком, опущенное поле —
  нет карточки или ветки; `*forest_acquire_lease` — арендованная карточка;
  текст команды (Bash `command`, ctx_execute `code`, ctx_batch_execute `commands[].command`) —
  `gh pr view|diff|checkout|comment|review N` в начале команды (после `;`, `&&`, `|`, `(`, `do`, `then`, перевода
  строки), репозиторий — из `-R`/`--repo`, иначе репозиторий продукта записи с командой.
- Время события — время первой записи его requestId; сравнение со временем вызова — включительно.
- Окно линзы PR N — от первого view/diff/checkout N до comment/review N. Окно без comment/review отбрасывается.
  Окна пересекаются — побеждает открытое позже.
- Субагент видит свои события и события родителя.
- Порядок: окно линзы → ветка work_state → PR с этой headRefName → карточка work_state → PR, в теле которого id
  карточки → только карточка → карточка аренды (если сессия арендовала ровно одну) → «не отнесено».
  Из нескольких PR с одной веткой или карточкой берётся PR, не влитый до вызова, с большим номером.
- Список PR: `gh pr list -R <github.repo из instances> --state all --limit 1000` (414 PR tAIBE — 42 КБ, 6 с;
  797 PR HR — 84 КБ, 14 с; 15.11), для тестов — `--prs <файл>`. Список равен пределу — предупреждение в stderr:
  старые PR за пределом не видны.
"""
import bisect
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript as tr  # noqa: E402

UNATTRIBUTED = 'unattributed'
OPEN, CLOSE = frozenset(('view', 'diff', 'checkout')), frozenset(('comment', 'review'))
# Команда gh pr, а не текст внутри аргумента другой команды (`nerve.py emit "… gh pr diff 163"`, backend #417).
GH_PR_RE = re.compile(r'(?:^|[;&|(`\n]|\b(?:do|then|else)\s)\s*(?:\w+=\S*\s+)*gh\s+pr\s+'
                      r'(view|diff|checkout|comment|review)\s+#?(\d+)\b([^\n;&|]*)')
REPO_RE = re.compile(r'(?:^|\s)(?:-R|--repo)(?:\s+|=)([\w.-]+/[\w.-]+)')
CARD_RE = r'\b[a-z][a-z0-9]{23}\b'
PR_LIMIT = 1000
PR_JQ = '[.[] | {number, headRefName, mergedAt, cards: [.body | scan("%s")] | unique}]' % CARD_RE.replace('\\', '\\\\')


def repos(instances):
    """{slug: github.repo} и {repo: slug} из instances/*.json."""
    by_slug = {}
    for name in sorted(os.listdir(instances)) if os.path.isdir(instances) else []:
        if not name.endswith('.json') or name.startswith('_'):
            continue
        try:
            with open(os.path.join(instances, name), encoding='utf-8') as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        repo = (d.get('github') or {}).get('repo') if isinstance(d, dict) else None
        if repo and d.get('slug'):
            by_slug[d['slug']] = repo
    return by_slug


def load_prs(by_slug, path=None):
    """{repo: [{number, headRefName, mergedAt, cards}]}: из файла (тесты) или из gh pr list по каждому репозиторию."""
    if path:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    out = {}
    for repo in sorted(set(by_slug.values())):
        r = subprocess.run(['gh', 'pr', 'list', '-R', repo, '--state', 'all', '--limit', str(PR_LIMIT), '--json',
                            'number,headRefName,mergedAt,body', '--jq', PR_JQ], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f'gh pr list -R {repo}: {r.stderr.strip()}')
        out[repo] = json.loads(r.stdout or '[]')
        if len(out[repo]) >= PR_LIMIT:
            print(f'attribution: {repo} — {len(out[repo])} PR, это предел --limit {PR_LIMIT}: старые PR не видны',
                  file=sys.stderr)
    return out


def commands(block):
    """Тексты команд блока tool_use."""
    name, inp = block.get('name') or '', block.get('input')
    if not isinstance(inp, dict):
        return []
    if name == 'Bash':
        return [inp.get('command')] if isinstance(inp.get('command'), str) else []
    if name.endswith('ctx_execute'):
        return [inp.get('code')] if isinstance(inp.get('code'), str) else []
    if name.endswith('ctx_batch_execute'):
        return [c['command'] for c in inp.get('commands') or [] if isinstance(c, dict)
                and isinstance(c.get('command'), str)]
    return []


def block_events(block):
    """[(вид, значение)] одного блока tool_use: open/close (репозиторий или None, N), state (карточка или None,
    ветка или None), lease."""
    name, inp = block.get('name') or '', block.get('input') if isinstance(block.get('input'), dict) else {}
    out = []
    if name.endswith('forest_set_work_state'):
        out.append(('state', tuple(inp[f] if isinstance(inp.get(f), str) and inp[f] else None
                                   for f in ('taskId', 'branch'))))
    elif name.endswith('forest_acquire_lease') and isinstance(inp.get('taskId'), str):
        out.append(('lease', inp['taskId']))
    for text in commands(block):
        for m in GH_PR_RE.finditer(text):
            repo = REPO_RE.search(' ' + m.group(3))
            out.append(('open' if m.group(1) in OPEN else 'close', (repo.group(1) if repo else None, int(m.group(2)))))
    return out


class Timeline:
    """События одной сессии (основной файл и субагенты) и ответ «к чему отнесён вызов в момент t»."""

    def __init__(self):
        self.events = []        # (t, порядок, вид, значение)

    def add(self, t, kind, value):
        self.events.append((t, len(self.events), kind, value))

    def build(self, own=None):
        """Окна линз, состояние work_state и аренды по времени. own — события субагента поверх событий родителя."""
        # По (время, порядок): значения разных видов не сравнимы; при равенстве родитель раньше субагента.
        evs = sorted(self.events + (own.events if own else []), key=lambda e: e[:2])
        opened, windows, states, leases, last = {}, [], [], set(), {}
        for t, _, kind, value in evs:
            if kind == 'open':  # окно — от первого просмотра: проверка головы перед вердиктом его не режет
                opened.setdefault(value, t)
            elif kind == 'close' and value in opened:
                last[value] = len(windows)
                windows.append((opened.pop(value), t, value))
            elif kind == 'close' and value in last:  # второй comment/review того же PR продлевает окно (N1)
                start, _, pr = windows[last[value]]
                windows[last[value]] = (start, t, pr)
            elif kind == 'state':
                states.append((t,) + value)
                if any(value):  # work_state с веткой или карточкой — смена работы: старые просмотры окно не тянут (B1)
                    opened.clear()
                    last.clear()
            elif kind == 'lease':
                leases.add(value)
        self.windows = sorted(windows, key=lambda w: w[:2])  # repo бывает None: значения не сравниваем (N3)
        self.state_times = [s[0] for s in states]
        self.states = states
        self.lease = next(iter(leases)) if len(leases) == 1 else None
        return self

    def lens(self, t):
        """PR окна линзы, открытого позже других среди окон, в которые попадает t."""
        best = None
        for start, end, pr in self.windows:
            if start > t:
                break
            if t <= end:
                best = pr
        return best

    def state(self, t):
        """(карточка, ветка) последнего work_state не позже t."""
        i = bisect.bisect_right(self.state_times, t)
        return self.states[i - 1][1:] if i else (None, None)


def pick(prs, t):
    """PR, не влитый до t, с большим номером; иначе больший номер."""
    if not prs:
        return None
    live = [p for p in prs if not p.get('mergedAt') or tr.local_time(p['mergedAt']) >= t]
    return max(live or prs, key=lambda p: p['number'])['number']


class Ledger:
    """Сток spend.scan: события всех записей и вызовы в окне; resolve() — свёртка по цели."""

    def __init__(self, by_slug, prs):
        self.by_slug, self.prs = by_slug, prs
        self.by_branch, self.by_card = {}, {}
        for repo, items in prs.items():
            for p in items:
                self.by_branch.setdefault((repo, p.get('headRefName')), []).append(p)
                for card in p.get('cards') or ():
                    self.by_card.setdefault((repo, card), []).append(p)
        self.lines = {}         # (sid, путь субагента или None) → Timeline
        self.first = {}         # requestId → время первой записи
        self.calls = []         # (sid, путь субагента или None, t, продукт, $)

    def record(self, sid, path, is_sub, o, t, product=None):
        """Каждая запись файла с временем, до отсева повторов: время requestId и события tool_use. Окно линзы без
        `-R` — в репозитории продукта записи (product), чтобы `gh pr view 7 -R <он>` закрывал `gh pr comment 7`."""
        m = o.get('message') if isinstance(o.get('message'), dict) else {}
        rid = o.get('requestId') or m.get('id')
        when = self.first.setdefault(rid, t) if rid is not None else t
        content = m.get('content')
        if o.get('type') != 'assistant' or not isinstance(content, list):
            return
        line = self.lines.setdefault((sid, path if is_sub else None), Timeline())
        home = self.by_slug.get(product)
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'tool_use':
                for kind, value in block_events(block):
                    if kind in ('open', 'close') and value[0] is None:
                        value = (home, value[1])
                    line.add(when, kind, value)

    def call(self, sid, path, is_sub, t, product, usd):
        self.calls.append((sid, path if is_sub else None, t, product, usd))

    def target(self, line, t, repo):
        """Цель вызова: ('pr', repo, N), ('task', id) или UNATTRIBUTED."""
        pr = line.lens(t)
        if pr:
            return 'pr', pr[0] or repo, pr[1]
        task, branch = line.state(t)
        if branch and repo:
            n = pick(self.by_branch.get((repo, branch)), t)
            if n:
                return 'pr', repo, n
        if task and repo:
            n = pick(self.by_card.get((repo, task)), t)
            if n:
                return 'pr', repo, n
        if task:
            return 'task', task
        if line.lease:
            return 'task', line.lease
        return UNATTRIBUTED

    def resolve(self):
        """{цель: {'calls', 'usd'}} по всем вызовам в окне."""
        built, out = {}, {}
        for sid, sub, t, product, usd in self.calls:
            key = (sid, sub)
            if key not in built:
                parent = self.lines.get((sid, None), Timeline())
                built[key] = (Timeline().build(parent) if sub is None else
                              _merged(parent, self.lines.get(key)))
            goal = self.target(built[key], t, self.by_slug.get(product))
            agg = out.setdefault(goal, {'calls': 0, 'usd': 0.0})
            agg['calls'] += 1
            agg['usd'] += usd
        return out


def _merged(parent, own):
    line = Timeline()
    line.events = list(parent.events)
    return line.build(own)


def label(goal):
    """Строка цели для отчёта: agolubenk/tAIBE#410, card <id>, unattributed."""
    if goal == UNATTRIBUTED:
        return UNATTRIBUTED
    if goal[0] == 'pr':
        return f'{goal[1]}#{goal[2]}'
    return f'card {goal[1]}'


def rows(resolved):
    """Строки для --json по убыванию $: цель, вид, вызовов, $."""
    out = [{'target': label(g), 'kind': g if g == UNATTRIBUTED else g[0], 'calls': v['calls'],
            'usd': round(v['usd'], 4)} for g, v in resolved.items()]
    return sorted(out, key=lambda r: (-r['usd'], r['target']))


def text(rows_, total, top=15):
    """Раздел отчёта: доли PR, карточек и «не отнесено», затем первые top целей."""
    kinds = {}
    for r in rows_:
        kinds[r['kind']] = kinds.get(r['kind'], 0.0) + r['usd']
    def share(x):
        return f'{x / total:.0%}' if total else '—'
    lines = ['3. К чему отнесено (PR 2 GL-1): ' + ', '.join(
        f'{name} {share(kinds.get(kind, 0.0))}' for kind, name in (('pr', 'PR'), ('task', 'карточки'),
                                                                    (UNATTRIBUTED, UNATTRIBUTED))),
             '| цель | вызовов | $ | доля |', '|---|---|---|---|']
    lines += [f"| {r['target']} | {r['calls']} | {r['usd']:.2f} | {share(r['usd'])} |" for r in rows_[:top]]
    if len(rows_) > top:
        lines.append(f'| ещё {len(rows_) - top} | | | |')
    return '\n'.join(lines)
