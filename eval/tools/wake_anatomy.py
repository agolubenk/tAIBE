"""Анатомия пробуждений команды: что будило сессии и чем кончался ход. Только чтение журналов, сессиям не пишет.

usage: wake_anatomy.py "<с YYYY-MM-DD HH:MM>" ["<по YYYY-MM-DD HH:MM>"] [--json out.json]

Ход (turn) — от входящего текста (сообщение, монитор, крон, человек) до следующего такого текста.
Ход «без действия» — в нём нет ни правки файлов, ни сообщения другой сессии, ни записи во внешний мир
(git commit/push/merge, gh pr comment/review/merge/create, очередь oq_put/oq_patch, Notion create/update, CronCreate).
Ход «только переписка» — единственное действие в нём SendMessage (work_state_write — учёт, не действие).
Такие ходы — верхняя граница того, что срезал бы супервизор-тик в духе supertick (будит только при P1+).
Суммы — $ по прайсу API (на подписке это мерило расхода лимита)."""
import collections
import glob
import json
import os
import re
import sys
from datetime import datetime

ROOT = os.path.expanduser('~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prices  # noqa: E402 — один прайс на eval (GL-1)

WRITE_TOOLS = {'Edit', 'Write', 'NotebookEdit', 'CronCreate', 'CronDelete'}
WRITE_MCP = re.compile(r'oq_put|oq_patch|notion-create|notion-update|create_pull_request|merge_pull_request|'
                       r'add_issue_comment|pull_request_review_write|push_files|create_or_update_file')
WRITE_BASH = re.compile(r'git\b[^|;&]*\b(commit|push|merge|rebase|cherry-pick)\b|'
                        r'gh\s+pr\s+(comment|review|merge|create|edit|close)|gh\s+api\b[^|;&]*-X\s*(POST|PATCH|PUT|DELETE)')

# --strict: Bash, который пишет файл (перенаправление в файл, tee, sed -i, mv/cp) или ходит в gh api / Notion
# raw API с телом, тоже считается действием — проверка чувствительности эвристики
STRICT = '--strict' in sys.argv
WRITE_BASH_STRICT = re.compile(r'(?<![0-9&])>>?\s*(?!/dev/null|&)[^\s|;&]+|\btee\b|\bsed\s+-i|\b(mv|cp)\s|'
                               r'gh\s+api\b[^|;&]*(-f|-F|--input|--field)\b|api\.notion\.com|notion\.py')

args = [a for a in sys.argv[1:] if not a.startswith('--')]
out_json = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
if out_json in args:
    args.remove(out_json)
since = datetime.strptime(args[0], '%Y-%m-%d %H:%M')
until = datetime.strptime(args[1], '%Y-%m-%d %H:%M') if len(args) > 1 else datetime.now()


def call_cost(m):
    """($ вызова, $ из них на запись кэша)."""
    c = prices.call_cost(m['usage'], m.get('model', ''))
    cost, write_cost = sum(c.values()), c['запись кэша 5 мин'] + c['запись кэша 1 ч']
    return cost, write_cost


def role_of(prompt):
    m = re.search(r'ключ реестра\s*([\w-]+)', prompt or '')
    if not m:
        return None
    team = 'Т3' if 'сборка Т3' in prompt else 'Т2'
    return f'{team}:{m.group(1)}'


def kind(text, cron_prompts):
    if 'cross-session-message' in text or '<agent-message' in text or text.startswith('Another Claude session sent'):
        return 'сообщение'
    if '<task-notification' in text:
        return 'монитор/фон'
    if 'This session is being continued' in text:
        return 'сжатие'
    head = text[:60]
    if any(head and p.startswith(head[:40]) for p in cron_prompts):
        return 'крон'
    return 'человек/прочее'


def first_prompt(path):
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get('type') != 'user':
            continue
        c = (o.get('message') or {}).get('content')
        t = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in (c or []) if isinstance(x, dict))
        if t.strip() and not t.lstrip().startswith('<'):
            return t
        if 'ключ реестра' in t:
            return t
    return ''


turns = []
for path in glob.glob(os.path.join(ROOT, '*.jsonl')):
    if datetime.fromtimestamp(os.path.getmtime(path)) < since:
        continue
    role = role_of(first_prompt(path)[:400])
    if not role:
        continue
    sid = os.path.basename(path)[:-len('.jsonl')]  # файл журнала: точная привязка хода для ручной сверки
    cron_prompts, seen, turn = [], set(), None

    def close(t):
        if t and t['calls']:
            turns.append(t)

    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        m = o.get('message') or {}
        if o.get('type') == 'assistant' and isinstance(m, dict):
            for b in m.get('content') or []:
                if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name') == 'CronCreate':
                    cron_prompts.append(((b.get('input') or {}).get('prompt') or '')[:60])
        ts = o.get('timestamp')
        if not ts:
            continue
        t = datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone().replace(tzinfo=None)
        if t < since or t > until:
            continue
        if o.get('type') == 'user' and isinstance(m, dict):
            c = m.get('content')
            if isinstance(c, list) and any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c):
                continue
            text = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in (c or []) if isinstance(x, dict) and x.get('type') == 'text')
            if text.strip():
                close(turn)
                turn = {'role': role, 'kind': kind(text.strip(), cron_prompts), 'at': t.strftime('%d.%m %H:%M'),
                        'sid': sid, 'ts': o.get('timestamp'),
                        'calls': 0, 'cost': 0.0, 'write_cost': 0.0, 'action': False, 'sent': False,
                        'tools': collections.Counter()}
        if o.get('type') == 'assistant' and isinstance(m, dict):
            if turn is None:
                turn = {'role': role, 'kind': 'человек/прочее', 'at': t.strftime('%d.%m %H:%M'), 'calls': 0,
                        'sid': sid, 'ts': o.get('timestamp'),
                        'cost': 0.0, 'write_cost': 0.0, 'action': False, 'sent': False,
                        'tools': collections.Counter()}
            for b in m.get('content') or []:
                if not (isinstance(b, dict) and b.get('type') == 'tool_use'):
                    continue
                name, inp = b.get('name', ''), b.get('input') or {}
                turn['tools'][name] += 1
                if name == 'SendMessage':
                    turn['sent'] = True
                if name in WRITE_TOOLS or WRITE_MCP.search(name) or (
                        name == 'Bash' and (WRITE_BASH.search(str(inp.get('command', ''))) or
                                            STRICT and WRITE_BASH_STRICT.search(str(inp.get('command', ''))))):
                    turn['action'] = True
            if m.get('usage') and m.get('id') not in seen:
                seen.add(m.get('id'))
                c, wc = call_cost(m)
                turn['calls'] += 1
                turn['cost'] += c
                turn['write_cost'] += wc
    close(turn)

if not turns:
    sys.exit('нет ходов в окне')
for team in sorted({t['role'].split(':')[0] for t in turns}):
    T = [t for t in turns if t['role'].startswith(team)]
    tot = sum(t['cost'] for t in T)
    print(f'\n{team}: окно {since:%d.%m %H:%M} → {until:%d.%m %H:%M}, ходов {len(T)}, ${tot:,.0f}')
    print(f'{"причина хода":16} {"ходов":>6} {"$":>8} {"доля":>5} | {"без действия":>12} {"$":>8} {"доля":>5} {"ср.$":>6} '
          f'{"запись кэша $":>13} | {"только переписка":>16} {"$":>7}')
    for k in ('сообщение', 'монитор/фон', 'крон', 'человек/прочее', 'сжатие'):
        K = [t for t in T if t['kind'] == k]
        if not K:
            continue
        N = [t for t in K if not t['action'] and not t['sent']]
        R = [t for t in K if not t['action'] and t['sent']]
        kc, nc = sum(t['cost'] for t in K), sum(t['cost'] for t in N)
        print(f'{k:16} {len(K):6} {kc:8.1f} {kc / tot:5.0%} | {len(N):12} {nc:8.1f} {nc / tot:5.0%} '
              f'{(nc / len(N) if N else 0):6.2f} {sum(t["write_cost"] for t in N):13.1f} | {len(R):16} {sum(t["cost"] for t in R):7.1f}')
    N = [t for t in T if not t['action'] and not t['sent'] and t['kind'] in ('сообщение', 'монитор/фон', 'крон')]
    R = [t for t in T if not t['action'] and t['sent'] and t['kind'] in ('сообщение', 'монитор/фон', 'крон')]
    nc = sum(t['cost'] for t in N)
    rc = sum(t['cost'] for t in R)
    short = [t for t in N if t['calls'] <= 6]
    print(f'Итого ходов без действия от сообщений/мониторов/кронов: {len(N)} · ${nc:,.1f} ({nc / tot:.0%}); '
          f'из них коротких (≤ 6 запросов) {len(short)} · ${sum(t["cost"] for t in short):,.1f}')
    print(f'Ходов «только переписка» от сообщений/мониторов/кронов: {len(R)} · ${rc:,.1f} ({rc / tot:.0%})')
    top = collections.Counter()
    for t in N:
        top[t['role'].split(':')[1]] += t['cost']
    print('Роли с наибольшим расходом на ходы без действия: ' +
          ', '.join(f'{r} ${c:.1f}' for r, c in top.most_common(5)))
    tools = collections.Counter()
    for t in N:
        tools.update(t['tools'])
    print('Чем заняты ходы без действия (инструменты): ' + ', '.join(f'{k} {v}' for k, v in tools.most_common(8)))

if out_json:
    json.dump([{**t, 'tools': dict(t['tools'])} for t in turns], open(out_json, 'w'), ensure_ascii=False, indent=0)
