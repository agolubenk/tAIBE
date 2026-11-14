#!/usr/bin/env python3
"""Ходы команды, начатые пиром и Нервом, и ответы владельца без прочтения (SE-59, приёмка; база — SE-53: 42 %).

usage: peer_turns.py [--hours 60] [--until "YYYY-MM-DD HH:MM"] [--projects DIR] [--nerve DIR] [--json]

Ход — вход сессии в простое: запись `user` с текстом, которую харнесс пометил `turnOrigin` (в старом журнале без
метки — не результат инструмента и не мета-текст навыка). Вход посреди хода (`queued_command` после результата
инструмента) хода не начинает — он в счёте «вставок». Причина хода: пир (`<cross-session-message>`), Нерв
(уведомление монитора с «НЕРВ»), истёкший срок монитора, прочий монитор и фон, человек, сжатие, прочее.
Ответ владельца — событие `owner.answer` журнала Нерва (ключ `oq:answer:<id>:<время ответа>`); прочитан — первый
вход любой сессии (текст, результат инструмента, вставка) с этим id после ответа.
Маршрут: дошёл ли ответ до адресата — сессии, чей тап (`nerve.py tap <роль> [--product <slug>]`) слушает роль и
продукт из события. Пауза лимита (`limit.hit` → `limit.resume`): тап придерживает `owner.answer` до конца паузы
(`nerve.py` cmd_tap, `tap.pass_in_pause`), поэтому отдельный счёт — опоздание, отсчитанное от конца паузы.

Только чтение: журналы сессий `<projects>/*/*.jsonl` (без папки наблюдателя claude-mem) и журналы Нерва
`<nerve>/journal.jsonl`, `<nerve>/products/*/journal.jsonl`. Вывод — только числа и доли: ни текста сообщений,
ни промптов, ни id пунктов.
"""
import argparse
import collections
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.expanduser("~/.claude/projects")
NERVE = os.path.join(HERE, "..", "nerve", "state")
SHARED = os.path.join(HERE, "..", "..", "instances", "_shared.json")  # default_product: его журнал — без папки
TAP = re.compile(r"nerve\.py tap ([a-z0-9][a-z0-9_-]*)(?:\s+--product\s+([a-z0-9-]+))?")
ENV_PRODUCT = re.compile(r"TAIBE_PRODUCT=([a-z0-9-]+)")
SKIP_DIRS = ("claude-mem-observer",)  # служебные сессии наблюдателя памяти — не ходы команды
KINDS = ("пир", "нерв", "монитор истёк", "монитор", "человек", "сжатие", "прочее")  # истёк — срок Monitor, перевзвод
LATE = timedelta(minutes=15)


def parse_ts(text):
    try:
        t = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.astimezone()


def origin(o):
    og = o.get("origin")
    return og.get("kind") if isinstance(og, dict) else og


def user_text(o):
    """Текст записи `user`; None — результат инструмента (вход посреди хода)."""
    c = (o.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c or []):
        return None
    return " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict) and x.get("type") == "text")


def input_kind(og, text):
    if og == "peer" or "<cross-session-message" in text or "<agent-message" in text:
        return "пир"
    if og == "task-notification" or text.lstrip().startswith("<task-notification"):
        return "нерв" if "НЕРВ" in text else "монитор истёк" if "[Monitor expired" in text else "монитор"
    return "человек" if og == "human" else "прочее"


def turn_kind(o):
    """Причина хода записи `o`; None — запись хода не начинает."""
    if o.get("type") != "user":
        return None
    text = user_text(o)
    if text is None or not text.strip():
        return None
    if o.get("isCompactSummary") or text.startswith("This session is being continued"):
        return "сжатие"
    turn = o.get("turnOrigin")  # харнесс сам метит начало хода (`turnPosition`) и его причину
    if turn:
        return {"peer": "пир", "human": "человек"}.get(turn) or (
            input_kind("task-notification", text) if turn == "task_notification" else "прочее")
    if o.get("isMeta"):  # старый журнал без метки: тело навыка, напоминание — продолжение того же хода
        return None
    return input_kind(origin(o), text)


def team_of(text):
    low = (text or "").lower()
    return "Т3" if "т3" in low else "Т2" if "ключ реестра" in low else "прочие"


def journals(nerve):
    """(продукт, путь) журналов Нерва; продукт по умолчанию — пустая строка."""
    products = glob.glob(os.path.join(nerve, "products", "*", "journal.jsonl"))
    return [("", os.path.join(nerve, "journal.jsonl"))] + [(os.path.basename(os.path.dirname(p)), p) for p in products]


def records(path, marker):
    try:
        lines = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return
    with lines:
        for line in lines:
            if marker in line:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


def owner_answers(nerve, since, until):
    """{id пункта: {at — время ответа, ts — запись в журнал, product, to}} для ответов владельца в окне."""
    out = {}
    for product, path in journals(nerve):
        for o in records(path, '"owner.answer"'):
            parts = str(o.get("key", "")).split(":", 3)
            at = parse_ts(parts[3]) if len(parts) == 4 and parts[0] == "oq" else None
            if at and since <= at <= until and (parts[2] not in out or at < out[parts[2]]["at"]):
                out[parts[2]] = {"at": at, "ts": parse_ts(o.get("ts", "")) or at, "product": product,
                                 "to": set(o.get("to") or [])}
    return out


def pauses(nerve, until):
    """[(начало, конец)] пауз лимита: `limit.hit` → `limit.resume`; незакрытая — до конца окна."""
    marks = sorted((parse_ts(o.get("ts", "")), o.get("kind")) for _, path in journals(nerve)
                   for o in records(path, '"limit.') if o.get("kind") in ("limit.hit", "limit.resume")
                   and parse_ts(o.get("ts", "")))
    out, start = [], None
    for t, kind in marks:
        if kind == "limit.hit" and start is None:
            start = t
        elif kind == "limit.resume" and start is not None:
            out.append((start, t))
            start = None
    return out + ([(start, until)] if start else [])


def tap_of(line, default):
    """(роль, продукт) тапа из команды в строке журнала сессии; продукт по умолчанию — пустая строка."""
    m = TAP.search(line)
    if not m:
        return None
    env = ENV_PRODUCT.search(line)
    product = m.group(2) or (env.group(1) if env else "")
    return m.group(1), "" if product == default else product


def first(seen, key, t):
    if key not in seen or t < seen[key]:
        seen[key] = t


def scan(path, since, until, rx, answers, seen, stats, routed, default=""):
    """Один проход по журналу сессии: ходы и вставки по причинам, первое прочтение ответов владельца — любой сессией
    (`seen`) и адресатом (`routed`: тап сессии слушает роль и продукт события)."""
    team, turns, inserts = None, collections.Counter(), collections.Counter()
    taps, reads = collections.Counter(), {}
    with open(path, encoding="utf-8", errors="replace") as lines:
        for line in lines:
            is_user, is_insert = '"user"' in line, '"queued_command"' in line  # без пробелов в JSON не полагаться
            if "nerve.py tap" in line and '"tool_use"' in line:
                taps.update([tap_of(line, default)] if tap_of(line, default) else [])
            if not (is_user or is_insert):
                continue
            hits = set(rx.findall(line)) if rx else set()
            if not hits and '"tool_result"' in line:  # ход не начинает, команду не называет
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            t = parse_ts(o.get("timestamp", ""))
            for h in hits:
                if t and t >= answers[h]["at"]:
                    first(reads, h, t)
            if team is None and o.get("type") == "user" and "human" in (origin(o), o.get("turnOrigin")):
                team = team_of(user_text(o))
            if not t or not since <= t <= until:
                continue
            a, kind = o.get("attachment") or {}, turn_kind(o)
            if o.get("type") == "attachment" and a.get("type") == "queued_command":
                inserts[input_kind(None, str(a.get("prompt") or ""))] += 1
            elif kind:
                turns[kind] += 1
    tap = taps.most_common(1)[0][0] if taps else None  # роль сессии — тап, который она взводит чаще всего
    for h, t in reads.items():
        first(seen, h, t)
        if tap and tap[0] in answers[h]["to"] and tap[1] == answers[h]["product"]:
            first(routed, h, t)
    team = team or "прочие"
    stats.setdefault(team, {"turns": collections.Counter(), "inserts": collections.Counter()})
    stats[team]["turns"].update(turns)
    stats[team]["inserts"].update(inserts)


def share(part, whole):
    return round(part / whole, 3) if whole else 0.0


def in_pause(start, end, gaps):
    """Сколько из [start, end] пришлось на паузы лимита. Пересечение, а не «ответ внутри паузы»: `limit.hit` пишется
    на проход Нерва позже, чем аккаунт встал, и ответ за минуту до записи тоже придержан."""
    return sum((min(end, b) - max(start, a) for a, b in gaps if min(end, b) > max(start, a)), timedelta())


def routing(due, seen, routed, gaps, until):
    wait = {i: (seen.get(i, until) - a["at"], in_pause(a["at"], seen.get(i, until), gaps)) for i, a in due.items()}
    late = [i for i, a in due.items() if i not in seen or wait[i][0] > LATE]
    return {"прочитано_адресатом": sum(1 for i in due if i in routed),
            "первым_прочёл_адресат": sum(1 for i in due if i in routed and routed[i] == seen.get(i)),
            "опоздали_в_паузе_лимита": sum(1 for i in late if wait[i][1]),
            "дольше_15_мин_без_паузы": sum(1 for i in late if wait[i][0] - wait[i][1] > LATE)}


def summary(stats, answers, seen, until, routed=None, gaps=()):
    teams = {}
    for team, s in sorted(stats.items()):
        n = sum(s["turns"].values())
        teams[team] = {"ходов": n, **{k: s["turns"][k] for k in KINDS},
                       "доля_пир": share(s["turns"]["пир"], n),
                       "доля_пир_и_нерв": share(s["turns"]["пир"] + s["turns"]["нерв"], n),
                       "вставок_пир": s["inserts"]["пир"], "вставок_нерв": s["inserts"]["нерв"]}
    due = {i: a for i, a in answers.items() if a["at"] + LATE <= until}  # моложе 15 мин — опоздать ещё не мог
    lags = sorted((seen[i] - a["at"]).total_seconds() / 60 for i, a in due.items() if i in seen)
    late = sum(1 for i, a in due.items() if i not in seen or seen[i] - a["at"] > LATE)
    return {"команды": teams, "ответы_владельца": {
        "в_окне": len(answers), "к_сроку": len(due), "без_прочтения_дольше_15_мин": late,
        "не_прочитано": sum(1 for i in due if i not in seen),
        "медиана_мин": round(lags[len(lags) // 2], 1) if lags else None,
        "p90_мин": round(lags[int(len(lags) * 0.9)], 1) if lags else None,
        **routing(due, seen, routed or {}, gaps, until)}}


def default_product(shared=SHARED):
    try:
        with open(shared, encoding="utf-8") as f:
            return str(json.load(f).get("default_product") or "")
    except (OSError, ValueError, AttributeError):
        return ""


def run(projects, nerve, since, until, default=""):
    answers = owner_answers(nerve, since, until)
    rx = re.compile(r"(?<![\w-])(" + "|".join(re.escape(i) for i in sorted(answers, key=len, reverse=True)) +
                    r")(?![\w-])") if answers else None
    seen, stats, routed = {}, {}, {}
    for path in glob.glob(os.path.join(projects, "*", "*.jsonl")):
        if any(s in os.path.basename(os.path.dirname(path)) for s in SKIP_DIRS):
            continue
        if datetime.fromtimestamp(os.path.getmtime(path), timezone.utc) < since:
            continue
        scan(path, since, until, rx, answers, seen, stats, routed, default)
    return summary(stats, answers, seen, until, routed, pauses(nerve, until))


def render(res, since, until):
    out = [f"SE-59: окно {since.astimezone():%d.%m %H:%M} → {until.astimezone():%d.%m %H:%M}; база SE-53 — пир 42 %, "
           "цель ≤ 20 % (≤ 15 % с документом релиза)"]
    for team, s in res["команды"].items():
        kinds = ", ".join(f"{k} {s[k]}" for k in KINDS if s[k])
        out.append(f"{team}: ходов {s['ходов']} ({kinds}); пир {s['доля_пир']:.0%}, пир и Нерв "
                   f"{s['доля_пир_и_нерв']:.0%}; вставок посреди хода: пир {s['вставок_пир']}, "
                   f"Нерв {s['вставок_нерв']}")
    a = res["ответы_владельца"]
    out.append(f"Ответы владельца: в окне {a['в_окне']}, к сроку {a['к_сроку']}; без прочтения дольше 15 мин "
               f"{a['без_прочтения_дольше_15_мин']} (не прочитано {a['не_прочитано']}); до прочтения медиана "
               f"{a['медиана_мин']} мин, p90 {a['p90_мин']} мин (цель — 0 дольше 15 мин)")
    out.append(f"Маршрут: прочитано адресатом {a['прочитано_адресатом']} из {a['к_сроку']} (первым прочёл адресат "
               f"{a['первым_прочёл_адресат']}); из опоздавших в паузе лимита {a['опоздали_в_паузе_лимита']}; "
               f"дольше 15 мин без учёта паузы {a['дольше_15_мин_без_паузы']}")
    return "\n".join(out)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--hours", type=float, default=60)
    p.add_argument("--until", help="YYYY-MM-DD HH:MM, местное время; по умолчанию — сейчас")
    p.add_argument("--projects", default=PROJECTS)
    p.add_argument("--nerve", default=NERVE)
    p.add_argument("--shared", default=SHARED, help="instances/_shared.json — продукт по умолчанию")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    until = datetime.strptime(a.until, "%Y-%m-%d %H:%M").astimezone() if a.until else datetime.now(timezone.utc)
    since = until - timedelta(hours=a.hours)
    res = run(a.projects, a.nerve, since, until, default_product(a.shared))
    print(json.dumps(res, ensure_ascii=False, indent=1) if a.json else render(res, since, until))
    return 0


if __name__ == "__main__":
    sys.exit(main())
