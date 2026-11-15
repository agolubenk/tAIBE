#!/usr/bin/env python3
"""Расход команды ИИ-сессий по прайсу API: сессия × день, роль, продукт, полосы окна (GL-1, PR 1 плана замера
14.11, v1.1). Только чтение транскриптов, без LLM; сессиям и доскам не пишет.

usage: python3 -I eval/tools/spend.py --hours 24 [--json out.json]
       python3 -I eval/tools/spend.py "<с YYYY-MM-DD HH:MM>" "<по YYYY-MM-DD HH:MM>" [--json out.json]
       [--instances <папка>]   # другие instances/*.json — для тестов и другой установки

Определения (план v1.1 на карточке GL-1; здесь — чтобы наследник их не искал):
- Вызов — один ответ модели (один requestId). Запрос из возобновлённой или скопированной сессии считается один раз,
  там, где его сделали: transcript.files идёт по времени создания файла.
- $ — по прайсу API (prices.py): вход, запись кэша 5 мин / 1 ч, чтение кэша, выход. На подписке $ — мерило лимита.
- Контекст вызова — вход + запись кэша + чтение кэша. Медиана и p90 — по вызовам.
- Полосы окна — по контексту вызова: ≤ 250K, 250–500K, 500K–1M, > 1M. Доля вызовов и доля $.
- Холодный вызов — запись кэша больше половины контекста при контексте от 30K (как в context_audit.py).
- Сжатие — сообщение «This session is being continued» в основном файле сессии.
- Первый вызов — контекст первого вызова основного файла сессии, если он в окне.
- Сессия — основной файл `<sid>.jsonl`. Вызовы субагентов `<sid>/subagents/*.jsonl` идут в сессию-родителя.
- Роль, линия, ключ реестра — из первого сообщения сессии («роль N», «Линия: r.xxxx», «ключ реестра K»). Роли нет —
  «прочее»: доля «прочего» покажет, нужна ли метка.
- Продукт — у каждого вызова, той же функцией, что доля окна Нерва (budget.Products, SE-66): cwd записи под repo_root
  продукта из instances/*.json, иначе папка проекта сессии, иначе unattributed. Сессия, сменившая cwd на чужой репо,
  делится между продуктами так же, как в budget.py: одна сессия — одна разбивка в обоих.
- День — местная дата вызова; окно [с, по] — по местному времени.
Привязка к задачам и PR — PR 2, ночной прогон и строка в сводке — PR 3.
"""
import collections
import json
import math
import os
import re
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# Продукт вызова — одна функция с долей окна Нерва. В конец пути: модули eval/tools не перекрываются.
sys.path.append(os.path.join(HERE, '..', 'nerve'))
import prices  # noqa: E402
import transcript as tr  # noqa: E402
from budget import UNATTRIBUTED, Products, project_dir_name  # noqa: E402

INSTANCES = os.path.join(HERE, '..', '..', 'instances')
BANDS = ((250_000, '≤ 250K'), (500_000, '250–500K'), (1_000_000, '500K–1M'), (math.inf, '> 1M'))
OTHER = 'прочее'
ROLE_RE = re.compile(r'\bроль\s+(\d+)', re.IGNORECASE)
LINE_RE = re.compile(r'Линия:?\s*(r\.[\w.]+)')
KEY_RE = re.compile(r'ключ реестра\s+([\w-]+)')


def roots(instances=INSTANCES):
    """{slug: repo_root} из instances/*.json (кроме _shared.json) — вход budget.Products."""
    out = {}
    for name in sorted(os.listdir(instances)) if os.path.isdir(instances) else []:
        if not name.endswith('.json') or name.startswith('_'):
            continue
        try:
            with open(os.path.join(instances, name), encoding='utf-8') as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and d.get('repo_root') and d.get('slug'):
            out[d['slug']] = d['repo_root']
    return out


def session_of(path, is_sub):
    """(папка проекта, sid, путь основного файла сессии)."""
    if is_sub:
        d = os.path.dirname(os.path.dirname(path))   # <проект>/<sid>/subagents/x.jsonl
        return os.path.basename(os.path.dirname(d)), os.path.basename(d), d + '.jsonl'
    return os.path.basename(os.path.dirname(path)), os.path.basename(path)[:-len('.jsonl')], path


def records(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if isinstance(o, dict):
                    yield o
    except OSError:
        return


def is_text_message(o):
    c = (o.get('message') or {}).get('content') if isinstance(o.get('message'), dict) else None
    return o.get('type') == 'user' and not (isinstance(c, list) and any(
        isinstance(x, dict) and x.get('type') == 'tool_result' for x in c))


def session_meta(main, project):
    """Роль, линия, ключ реестра — из первого текстового сообщения сессии."""
    meta = {'project': project, 'role': OTHER, 'lineage': None, 'key': None}
    for o in records(main):
        if not is_text_message(o):
            continue
        text = tr.text_of(o['message'].get('content')).strip()
        if not text or text.startswith('<'):
            continue
        for field, rx in (('role', ROLE_RE), ('lineage', LINE_RE), ('key', KEY_RE)):
            m = rx.search(text[:2000])
            meta[field] = m.group(1) if m else meta[field]
        break
    return meta


def band(ctx):
    return next(name for top, name in BANDS if ctx <= top)


def new_roll(key, meta):
    sid, day, product = key
    return dict(meta, sid=sid, day=day, product=product, calls=0, usd=0.0, parts=dict.fromkeys(prices.PARTS, 0.0),
                ctx=[], bands={name: {'calls': 0, 'usd': 0.0} for _, name in BANDS}, cold=0, compactions=0,
                first_ctx=None, subagent_calls=0, subagent_usd=0.0)


def add_call(r, u, model, is_sub, first):
    cc = prices.call_cost(u, model)
    usd, ctx = sum(cc.values()), prices.context_tokens(u)
    write = (u.get('cache_creation_input_tokens', 0) or 0)
    r['calls'] += 1
    r['usd'] += usd
    for k, v in cc.items():
        r['parts'][k] += v
    r['ctx'].append(ctx)
    b = r['bands'][band(ctx)]
    b['calls'] += 1
    b['usd'] += usd
    r['cold'] += ctx > 30_000 and write > 0.5 * ctx
    if is_sub:
        r['subagent_calls'] += 1
        r['subagent_usd'] += usd
    elif first:
        r['first_ctx'] = ctx


def scan(since, until, home=None, instances=INSTANCES):
    """{(sid, день, продукт): свёртка} за окно [since, until] и число файлов субагентов с вызовами в окне."""
    prods = Products(roots(instances))
    prefixes = [project_dir_name(root) for _, root in prods.roots] or tr.project_prefixes()
    seen, meta, roll, subs = set(), {}, {}, 0
    for path, is_sub in tr.files(prefixes, home):
        try:
            if datetime.fromtimestamp(os.path.getmtime(path)) < since:
                continue
        except OSError:
            continue
        project, sid, main = session_of(path, is_sub)
        if sid not in meta:
            meta[sid] = session_meta(main, project)
        file_calls, used = 0, False
        for o in records(path):
            ts = o.get('timestamp')
            if not isinstance(ts, str):
                continue
            t = tr.local_time(ts)
            in_window = since <= t <= until
            key = (sid, t.date().isoformat(), prods.of(o.get('cwd'), project))
            m = o.get('message') if isinstance(o.get('message'), dict) else {}
            if not is_sub and in_window and is_text_message(o) and tr.COMPACTED in tr.text_of(m.get('content')):
                roll.setdefault(key, new_roll(key, meta[sid]))['compactions'] += 1
            if o.get('type') != 'assistant' or not isinstance(m.get('usage'), dict) or m.get('model') == '<synthetic>':
                continue
            rid = o.get('requestId') or m.get('id')
            if rid is not None and rid in seen:
                continue
            seen.add(rid)
            file_calls += 1
            if not in_window:
                continue
            add_call(roll.setdefault(key, new_roll(key, meta[sid])), m['usage'], m.get('model') or '', is_sub,
                     file_calls == 1)
            used = True
        subs += is_sub and used
    return roll, subs


def p90(values):
    s = sorted(values)
    return s[max(0, math.ceil(0.9 * len(s)) - 1)] if s else 0


def median(values):
    s = sorted(values)
    n = len(s)
    return 0 if not n else s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def rounded(bands):
    return {k: {'calls': v['calls'], 'usd': round(v['usd'], 4)} for k, v in bands.items()}


def group(rolls, fields):
    """Итоги по (день, *поля): сессии, вызовы, $, медиана и p90 контекста, полосы, холодные вызовы, сжатия."""
    out = {}
    for r in rolls:
        g = out.setdefault((r['day'],) + tuple(str(r[f]) for f in fields), {
            'sessions': set(), 'calls': 0, 'usd': 0.0, 'ctx': [], 'cold': 0, 'compactions': 0,
            'bands': {name: {'calls': 0, 'usd': 0.0} for _, name in BANDS}})
        g['sessions'].add(r['sid'])
        for k in ('calls', 'usd', 'cold', 'compactions'):
            g[k] += r[k]
        g['ctx'] += r['ctx']
        for name, b in r['bands'].items():
            g['bands'][name]['calls'] += b['calls']
            g['bands'][name]['usd'] += b['usd']
    return [dict(zip(('day',) + tuple(fields), key), sessions=len(g['sessions']), calls=g['calls'],
                 usd=round(g['usd'], 4), ctx_median=median(g['ctx']), ctx_p90=p90(g['ctx']), cold=g['cold'],
                 compactions=g['compactions'], bands=rounded(g['bands']))
            for key, g in sorted(out.items())]


def report(roll, subagents, since, until):
    """Словарь для --json: итог, свёртки сессий (без списка контекстов), разрезы по ролям и продуктам."""
    rolls = list(roll.values())
    total = sum(r['usd'] for r in rolls)
    by_product = group(rolls, ('product',))
    day_usd = collections.Counter()
    for g in by_product:
        day_usd[g['day']] += g['usd']
    for g in by_product:
        g['share'] = round(g['usd'] / day_usd[g['day']], 4) if day_usd[g['day']] else 0.0
    sessions = [dict({k: v for k, v in r.items() if k != 'ctx'}, usd=round(r['usd'], 4),
                     subagent_usd=round(r['subagent_usd'], 4), ctx_median=median(r['ctx']), ctx_p90=p90(r['ctx']),
                     ctx_max=max(r['ctx'], default=0), parts={k: round(v, 4) for k, v in r['parts'].items()},
                     bands=rounded(r['bands']))
                for r in sorted(rolls, key=lambda x: (x['day'], -x['usd']))]
    return {'since': since.strftime('%Y-%m-%d %H:%M'), 'until': until.strftime('%Y-%m-%d %H:%M'),
            'sessions': len({r['sid'] for r in rolls}), 'subagents': subagents,
            'calls': sum(r['calls'] for r in rolls), 'usd': round(total, 4),
            'by_role': group(rolls, ('product', 'role', 'key')), 'by_product': by_product, 'rollups': sessions}


def share(part, whole):
    return f'{part / whole:.0%}' if whole else '—'


def text(rep):
    """Отчёт для человека: итог, роли по дням (полосы — доля $), продукты по дням."""
    lines = [f"Расход по прайсу API, {rep['since']} – {rep['until']} (местное время). Сессий {rep['sessions']}, "
             f"субагентов {rep['subagents']}, вызовов {rep['calls']}, ${rep['usd']:.2f}.", '', '1. Роли',
             '| день | продукт | роль | ключ | сессий | вызовов | $ | медиана контекста | p90 | холодных | сжатий | '
             + ' | '.join(n for _, n in BANDS) + ' |', '|---' * (11 + len(BANDS)) + '|']
    for g in rep['by_role']:
        bands = ' | '.join(share(g['bands'][n]['usd'], g['usd']) for _, n in BANDS)
        lines.append(f"| {g['day']} | {g['product']} | {g['role']} | {g['key']} | {g['sessions']} | {g['calls']} | "
                     f"{g['usd']:.2f} | {g['ctx_median'] / 1000:.0f}K | {g['ctx_p90'] / 1000:.0f}K | {g['cold']} | "
                     f"{g['compactions']} | {bands} |")
    lines += ['', '2. Продукты (доля $ дня)', '| день | продукт | $ | доля |', '|---|---|---|---|']
    lines += [f"| {g['day']} | {g['product']} | {g['usd']:.2f} | {g['share']:.0%} |" for g in rep['by_product']]
    lines += ['', 'Полосы окна — доля $ роли за день. На подписке $ — мерило расхода лимита.']
    return '\n'.join(lines)


def window(argv, now=None):
    """(с, по, --json, --instances) из аргументов."""
    def value(flag):
        return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else None
    out, inst, hours = value('--json'), value('--instances'), value('--hours')
    pos = [a for a in argv if not a.startswith('--') and a not in (out, inst, hours)]
    if hours:
        until = (now or datetime.now()).replace(second=0, microsecond=0)
        return until - timedelta(hours=float(hours)), until, out, inst
    return datetime.strptime(pos[0], '%Y-%m-%d %H:%M'), datetime.strptime(pos[1], '%Y-%m-%d %H:%M'), out, inst


def main(argv):
    try:
        since, until, out, inst = window(argv)
    except (IndexError, ValueError):
        print(__doc__.split('\n\n')[1], file=sys.stderr)
        return 2
    roll, subagents = scan(since, until, instances=inst or INSTANCES)
    rep = report(roll, subagents, since, until)
    print(text(rep))
    if out:
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
