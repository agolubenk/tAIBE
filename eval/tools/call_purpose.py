#!/usr/bin/env python3
"""Зачем команда вызывала модель: работа, координация или пустой ход.

Только чтение журналов. Печатает счётчики и суммы — ни текстов, ни команд.
Вызов: python3 -I call_purpose.py "<YYYY-MM-DD HH:MM>" "<YYYY-MM-DD HH:MM>"

Класс вызова определяется по набору tool_use в одном ответе модели (один requestId):
  координация — только SendMessage/ListAgents/Monitor/TaskStop/Cron*/ToolSearch/work_state/oq_* и опрос
                статуса через Bash (gh pr view|checks|list|status, gh run, sleep, work_state);
  работа      — есть хотя бы один инструмент вне этого списка;
  без инструментов — текстовый ответ (конец хода).
"""
import collections
import glob
import json
import os
import re
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prices import call_usd as cost  # noqa: E402 — один прайс на eval (GL-1)

ROOT = os.path.expanduser('~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2')
COORD_TOOLS = {'SendMessage', 'ListAgents', 'Monitor', 'TaskStop', 'CronCreate', 'CronDelete', 'CronList',
               'ToolSearch', 'TaskOutput', 'TaskList', 'TaskGet'}
COORD_MCP = re.compile(r'work_state_|__oq_')
COORD_BASH = re.compile(r'^\s*(cd [^;&]+(&&|;)\s*)?(gh (pr (view|checks|list|status)|run (view|list|watch))|sleep |'
                        r'.*work_state|.*oq_call)')

since = datetime.strptime(sys.argv[1], '%Y-%m-%d %H:%M')
until = datetime.strptime(sys.argv[2], '%Y-%m-%d %H:%M')


def text_of(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ' '.join(x.get('text', '') for x in c if isinstance(x, dict))
    return ''


def team_session(path):
    for line in open(path, encoding='utf-8', errors='replace'):
        if '"type":"user"' not in line and '"type": "user"' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = text_of((o.get('message') or {}).get('content'))
        if t.strip():
            return 'ключ реестра' in t[:400]
    return False


def is_coord(b):
    name = b.get('name') or ''
    if name in COORD_TOOLS or COORD_MCP.search(name):
        return True
    if name == 'Bash':
        return bool(COORD_BASH.match((b.get('input') or {}).get('command') or ''))
    return False


cls_n, cls_usd, cls_ctx = collections.Counter(), collections.Counter(), collections.Counter()
tools_per_call = []
for path in glob.glob(os.path.join(ROOT, '*.jsonl')):
    if datetime.fromtimestamp(os.path.getmtime(path)) < since or not team_session(path):
        continue
    req = {}
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        m = o.get('message') if isinstance(o.get('message'), dict) else {}
        if o.get('type') != 'assistant' or not m.get('usage') or not o.get('timestamp'):
            continue
        t = datetime.fromisoformat(o['timestamp'].replace('Z', '+00:00')).astimezone().replace(tzinfo=None)
        rid = o.get('requestId') or m.get('id')
        r = req.setdefault(rid, {'t': t, 'u': m['usage'], 'model': m.get('model'), 'tools': []})
        r['tools'] += [b for b in m.get('content') or [] if isinstance(b, dict) and b.get('type') == 'tool_use']
    for r in req.values():
        if not since <= r['t'] <= until or r['model'] == '<synthetic>':
            continue
        tl = r['tools']
        k = 'без инструментов' if not tl else 'координация' if all(is_coord(b) for b in tl) else 'работа'
        u = r['u']
        cls_n[k] += 1
        cls_usd[k] += cost(u, r['model'])
        cls_ctx[k] += sum(u.get(x, 0) or 0 for x in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
        if tl:
            tools_per_call.append(len(tl))

total_n, total_usd = sum(cls_n.values()), sum(cls_usd.values())
print(f'Окно {since:%d.%m %H:%M} – {until:%d.%m %H:%M}: вызовов {total_n}, ${total_usd:,.1f}')
for k in ('работа', 'координация', 'без инструментов'):
    n = cls_n[k]
    print(f'  {k:17} {n:5} ({100 * n / max(1, total_n):4.1f}%) · ${cls_usd[k]:8,.1f} ({100 * cls_usd[k] / max(1e-9, total_usd):4.1f}%)'
          f' · средний контекст {cls_ctx[k] // max(1, n):,}')
if tools_per_call:
    one = sum(1 for x in tools_per_call if x == 1)
    print(f'  инструментов на вызов с инструментами: {sum(tools_per_call) / len(tools_per_call):.2f}; '
          f'вызовов ровно с одним инструментом {100 * one / len(tools_per_call):.0f}%')
