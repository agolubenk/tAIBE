#!/usr/bin/env python3
"""AI Council — функция 2: приоритизация и расписание. Только stdlib.

Канон: docs/specs/ai-council.md §8.

    python3 infra/ai-council/planner_service.py --once            # показать план
    python3 infra/ai-council/planner_service.py --once --apply    # записать в файлы
    python3 infra/ai-council/planner_service.py --once --date 2026-08-14
    python3 infra/ai-council/planner_service.py --once --from 11:00 --to 15:00

Порядок работ определяет КОД, а не модель. Причина в C9: «приоритизация на своё усмотрение»
у модели — источник шума, потому что она не видит ни зависимостей, ни реальной длительности,
ни того, что владелец уже начал делать. Модель здесь получает готовый список и вправе
предложить не более `llm_adjacent_swaps` обменов СОСЕДНИХ элементов, каждый с обоснованием;
обмен, ломающий жёсткое правило или топосорт, отклоняется кодом.

Жёсткие правила (§8) — не веса, а фильтры: half-baked не планируется вовсе, ошибки идут
раньше задач, `в работе` закрепляется первой, зависимости соблюдаются топосортом.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import signal
import sys
import time
from dataclasses import dataclass, field
from datetime import date as date_cls, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod                              # noqa: E402
from store import Store, new_id                          # noqa: E402

SEVERITY_NORM = {"critical": 1.0, "high": 0.75, "medium": 0.5, "low": 0.25}
PRIORITY_NORM = {"P0": 1.0, "P1": 0.75, "P2": 0.5, "P3": 0.25}
BUG_TIER_SEVERITIES = frozenset({"critical", "high"})
# «в работе» — снимок Notion и колонки, перенесённые из него; slug колонок t-boards — in-progress, в-работе.
IN_PROGRESS = frozenset({"в работе", "in-progress", "в-работе"})
EST_ORDER = ("S", "M", "L", "XL")


def est_bucket(payload: dict) -> str:
    """Общая трудоёмкость карточки из бакетов пунктов: берём максимум, а не сумму.
    Сумма ломается на длинных списках мелких шагов — десять S не равны XL."""
    buckets = [str(s.get("est")) for s in (payload.get("decomposition") or [])
               if isinstance(s, dict) and str(s.get("est")) in EST_ORDER]
    if not buckets:
        return ""
    return max(buckets, key=lambda b: EST_ORDER.index(b))

PLAN_BEGIN = "<!-- ai-council:plan:begin"
PLAN_END = "<!-- ai-council:plan:end -->"


def log(msg: str) -> None:
    print(msg, flush=True)


@dataclass
class Item:
    card: dict
    payload: dict = field(default_factory=dict)
    readiness: float = 0.0
    est: str = "M"
    minutes: int = 90
    score: float = 0.0
    tier: int = 1                  # 0 = закреплённое/ошибки, 1 = остальное
    reasons: list = field(default_factory=list)
    start: str = ""
    end: str = ""

    @property
    def card_id(self) -> str:
        return self.card["card_id"]

    @property
    def modules(self) -> set:
        try:
            return set(json.loads(self.card.get("modules") or "[]"))
        except ValueError:
            return set()

    @property
    def touched_modules(self) -> set:
        return set((self.payload.get("touched") or {}).get("modules") or []) | self.modules

    @property
    def label(self) -> str:
        if self.card["db"] == "bugs":
            return f"Ошибка · {self.card.get('severity') or '?'}"
        return f"Задача · {self.card.get('priority') or '—'}"


# ── окно времени ────────────────────────────────────────────────────────────
def parse_hm(value: str) -> timedelta:
    hours, minutes = (value or "0:0").split(":")
    return timedelta(hours=int(hours), minutes=int(minutes))


def resolve_date(cfg, override: str = "") -> date_cls:
    raw = (override or str(cfg.get("planner.window.date", "today+1"))).strip()
    if raw.startswith("today"):
        shift = 0
        match = re.match(r"today([+-]\d+)$", raw)
        if match:
            shift = int(match.group(1))
        return date_cls.today() + timedelta(days=shift)
    return datetime.strptime(raw, "%Y-%m-%d").date()


def apply_window_override(cfg, time_from: str = "", time_to: str = "") -> list[str]:
    """Разовое окно из CLI/UI поверх `planner.window.from/to`.

    Окно правится чаще всего остального («сегодня работаю с 11 до 15») — и требовать
    ради этого правки config.toml значит либо не пользоваться планировщиком, либо
    оставить в конфиге чужое вчерашнее окно. Переопределение живёт ровно один прогон:
    в файл ничего не пишется, а факт подмены попадает в заголовок плана.

    Возвращает список изменённых ключей (для отчёта). Невалидное время — ConfigError:
    молча планировать сутки напролёт из-за опечатки хуже, чем не построить план.
    """
    changed: list[str] = []
    window = cfg.data.setdefault("planner", {}).setdefault("window", {})
    for key, value in (("from", time_from), ("to", time_to)):
        raw = (value or "").strip()
        if not raw:
            continue
        if not re.fullmatch(r"([01]?\d|2[0-3]):[0-5]\d", raw):
            raise config_mod.ConfigError(
                f"--{key} должен быть временем ЧЧ:ММ в пределах суток, получено `{raw}`")
        window[key] = raw
        changed.append(key)
    if changed and parse_hm(window.get("to")) <= parse_hm(window.get("from")):
        raise config_mod.ConfigError(
            f"окно пустое: --from {window.get('from')} не раньше --to {window.get('to')}")
    return changed


def free_intervals(cfg, day: date_cls) -> list[tuple[datetime, datetime]]:
    """Окно минус перерывы. Перерыв внутри окна разрезает его на два интервала —
    задача не может «перешагнуть» обед, иначе расписание врёт о времени старта."""
    start = datetime.combine(day, datetime.min.time()) + parse_hm(cfg.get("planner.window.from"))
    end = datetime.combine(day, datetime.min.time()) + parse_hm(cfg.get("planner.window.to"))
    breaks = []
    for item in cfg.get("planner.window.breaks", []) or []:
        b_from = datetime.combine(day, datetime.min.time()) + parse_hm(item.get("from"))
        b_to = datetime.combine(day, datetime.min.time()) + parse_hm(item.get("to"))
        breaks.append((b_from, b_to))
    breaks.sort()

    intervals: list[tuple[datetime, datetime]] = []
    cursor = start
    for b_from, b_to in breaks:
        if b_from > cursor:
            intervals.append((cursor, min(b_from, end)))
        cursor = max(cursor, b_to)
    if cursor < end:
        intervals.append((cursor, end))
    return [(a, b) for a, b in intervals if b > a]


# ── сбор кандидатов ─────────────────────────────────────────────────────────
def latest_done_payload(store: Store, card_id: str) -> dict:
    row = store.q1(
        "SELECT payload, readiness FROM runs WHERE card_id = ? AND status = 'done' "
        "AND payload IS NOT NULL ORDER BY finished_at DESC LIMIT 1", (card_id,))
    if not row or not row["payload"]:
        return {}
    try:
        return json.loads(row["payload"])
    except ValueError:
        return {}


def abstained_questions(store: Store, card_id: str) -> list[str]:
    """Почему карточка требует человека: последний прогон воздержался."""
    row = store.q1(
        "SELECT outcome, payload FROM runs WHERE card_id = ? AND status = 'abstained' "
        "ORDER BY finished_at DESC LIMIT 1", (card_id,))
    if not row:
        return []
    questions: list[str] = []
    if row["payload"]:
        try:
            questions = list((json.loads(row["payload"]) or {}).get("open_questions") or [])
        except ValueError:
            questions = []
    return questions or ([row["outcome"]] if row["outcome"] else [])


def collect(cfg, store: Store) -> tuple[list[Item], list[dict]]:
    """Возвращает (кандидаты в окно, needs_human). Half-baked в окно не попадает никогда."""
    effort = cfg.get("planner.effort_minutes", {}) or {}
    hard = set(cfg.get("planner.hard_rules", []) or [])
    candidates: list[Item] = []
    needs_human: list[dict] = []

    for card in store.open_cards():
        if card.get("db") == "draft":
            # Черновик главной формы (Ф1/P2) — ещё не отправлен владельцем, в плановое
            # окно не участвует и в needs_human не всплывает (это не «зависший» пункт).
            continue
        payload = latest_done_payload(store, card["card_id"])
        if card["half_baked"] and "no_half_baked_in_window" in hard:
            needs_human.append({
                "card_id": card["card_id"], "title": card["title"], "url": card.get("url", ""),
                "why": "Half-baked idea — в рабочее окно не планируется, флаг снимает владелец",
                "questions": (payload.get("open_questions") or [])[:5],
            })
            continue
        if not payload:
            questions = abstained_questions(store, card["card_id"])
            needs_human.append({
                "card_id": card["card_id"], "title": card["title"], "url": card.get("url", ""),
                "why": "нет проработки консилиума" if not questions else
                       "консилиум воздержался",
                "questions": questions[:5],
            })
            continue

        bucket = est_bucket(payload) or "M"
        item = Item(card=card, payload=payload,
                    readiness=float(payload.get("readiness") or 0.0),
                    est=bucket, minutes=int(effort.get(bucket, 90)))
        candidates.append(item)
    return candidates, needs_human


# ── зависимости ─────────────────────────────────────────────────────────────
def dependency_map(items: list[Item]) -> dict[str, set]:
    """`card_id → множество card_id, которые должны идти РАНЬШЕ него.

    Источник — только `parent_card_id`/`subtask_ids` из снапшота: подзадача идёт раньше
    родителя. Поля `blocked_by`/`blocks` из §7 здесь не используются, потому что арбитр их
    не производит — `MERGED_SCHEMA` в council.py не содержит `relations`. Это пробел
    контракта арбитра; топосорт написан так, что подключение этого источника — одна строка.
    """
    known = {i.card_id for i in items}
    deps: dict[str, set] = {i.card_id: set() for i in items}
    for item in items:
        for sub in json.loads(item.card.get("subtask_ids") or "[]"):
            if sub in known:
                deps[item.card_id].add(sub)
        parent = item.card.get("parent_card_id")
        if parent in known:
            deps[parent].add(item.card_id)
    return deps


def toposort(items: list[Item], deps: dict[str, set]) -> tuple[list[Item], list[Item]]:
    """Кана-сортировка по зависимостям. Цикл не «разрываем на глазок» — обе карточки
    уходят человеку: автоматически выбранная точка разрыва цикла это скрытое продуктовое
    решение."""
    by_id = {i.card_id: i for i in items}
    incoming = {cid: set(d & set(by_id)) for cid, d in deps.items() if cid in by_id}
    ordered: list[Item] = []
    ready = [cid for cid, d in incoming.items() if not d]
    while ready:
        # Стабильность: среди готовых берём по убыванию score, иначе порядок случаен.
        ready.sort(key=lambda cid: by_id[cid].score, reverse=True)
        cid = ready.pop(0)
        ordered.append(by_id[cid])
        for other, d in incoming.items():
            if cid in d:
                d.discard(cid)
                if not d and other not in [o.card_id for o in ordered] and other not in ready:
                    ready.append(other)
    cyclic = [by_id[cid] for cid in incoming if cid not in {o.card_id for o in ordered}]
    return ordered, cyclic


# ── скоринг ─────────────────────────────────────────────────────────────────
def score_items(cfg, items: list[Item], deps: dict[str, set]) -> None:
    weights = cfg.get("planner.weights", {}) or {}
    hard = set(cfg.get("planner.hard_rules", []) or [])
    bug_weight = float(cfg.get("sources.tboards.bug_weight", 2.0))

    downstream: dict[str, int] = {i.card_id: 0 for i in items}
    for cid, required in deps.items():
        for dep in required:
            if dep in downstream:
                downstream[dep] += 1

    now_ts = time.time()
    ages = []
    for item in items:
        edited = item.card.get("notion_edited_at") or ""
        try:
            ts = datetime.strptime(edited[:19], "%Y-%m-%dT%H:%M:%S").timestamp()
        except (ValueError, TypeError):
            ts = now_ts
        item.reasons = []
        ages.append(max(now_ts - ts, 0))
    # Пустой список кандидатов — нормальное состояние (борд ещё не проработан), а не сбой.
    max_age = max(ages, default=1.0) or 1.0

    for item, age in zip(items, ages):
        severity = SEVERITY_NORM.get((item.card.get("severity") or "").lower(), 0.0)
        priority = PRIORITY_NORM.get((item.card.get("priority") or "").upper(), 0.0)
        score = (
            float(weights.get("severity", 3.0)) * severity
            + float(weights.get("priority", 2.5)) * priority
            + float(weights.get("readiness", 2.0)) * item.readiness
            + float(weights.get("unblocks", 1.5)) * math.log1p(downstream[item.card_id])
            + float(weights.get("staleness", 0.5)) * (age / max_age)
        )
        if item.card["db"] == "bugs":
            score *= bug_weight

        item.score = round(score, 3)
        if severity:
            item.reasons.append(f"severity {item.card['severity']}")
        if priority:
            item.reasons.append(f"приоритет {item.card['priority']}")
        if downstream[item.card_id]:
            item.reasons.append(f"разблокирует {downstream[item.card_id]}")
        item.reasons.append(f"готовность {item.readiness:.2f}")

        # Тир — это жёсткое правило, а не вес: он не даёт задаче обогнать ошибку,
        # какой бы высокой ни была её оценка.
        pinned = (item.card.get("status") or "") in IN_PROGRESS
        if pinned and "pin_in_progress" in hard:
            item.tier = 0
            item.reasons.insert(0, "уже в работе")
        elif (item.card["db"] == "bugs"
              and (item.card.get("severity") or "").lower() in BUG_TIER_SEVERITIES
              and "bugs_before_tasks" in hard):
            item.tier = 0
        else:
            item.tier = 1


def affinity(item: Item, previous: Item | None) -> float:
    """Совпадение по модулям с предыдущим пунктом — это и есть «логичность по пути
    разработки»: подряд идёт то, что живёт в одном куске кода."""
    if previous is None:
        return 0.0
    a, b = item.touched_modules, previous.touched_modules
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


# ── упаковка в окно ─────────────────────────────────────────────────────────
def pack(cfg, ordered: list[Item], intervals: list[tuple[datetime, datetime]]
         ) -> tuple[list[Item], list[Item]]:
    """Жадная упаковка с учётом сцепления по модулям и топосорта.

    `focus_ratio` — доля продуктивного времени: задача на 30 продуктивных минут занимает
    30/0.7 ≈ 43 минуты стены. Без этого план обещает вдвое больше, чем влезает в день.
    """
    focus = float(cfg.get("planner.window.focus_ratio", 0.7)) or 0.7
    coupling_w = float((cfg.get("planner.weights", {}) or {}).get("coupling", 1.0))
    remaining = list(ordered)
    placed: list[Item] = []
    overflow: list[Item] = []
    done_ids: set = set()

    slots = list(intervals)
    slot_index = 0
    cursor = slots[0][0] if slots else None
    if not remaining:
        return [], []

    while remaining and cursor is not None:
        # Доступны только те, чьи зависимости уже размещены — топосорт задал порядок,
        # но сцепление может захотеть взять элемент раньше, и это нельзя разрешать слепо.
        available = [i for i in remaining
                     if all(dep in done_ids for dep in getattr(i, "_deps", set()))]
        if not available:
            available = remaining
        previous = placed[-1] if placed else None
        best = max(available, key=lambda i: (-i.tier,
                                             i.score + coupling_w * affinity(i, previous)))
        wall = timedelta(minutes=math.ceil(best.minutes / focus))

        slot_start, slot_end = slots[slot_index]
        if cursor + wall > slot_end:
            # В текущем интервале не влезает — пробуем следующий (после перерыва).
            if slot_index + 1 < len(slots):
                slot_index += 1
                cursor = slots[slot_index][0]
                continue
            overflow.extend(remaining)
            break

        best.start = cursor.strftime("%H:%M")
        best.end = (cursor + wall).strftime("%H:%M")
        aff = affinity(best, previous)
        if aff > 0:
            best.reasons.append(f"тот же модуль, что предыдущий пункт ({aff:.2f})")
        cursor += wall
        placed.append(best)
        done_ids.add(best.card_id)
        remaining.remove(best)

    if remaining and not overflow:
        overflow.extend(remaining)
    return placed, overflow


# ── вывод ───────────────────────────────────────────────────────────────────
def render_plan(cfg, day: date_cls, intervals: list, placed: list[Item],
                overflow: list[Item], needs_human: list[dict], cyclic: list[Item]) -> list[str]:
    total = sum((b - a for a, b in intervals), timedelta())
    focus = float(cfg.get("planner.window.focus_ratio", 0.7)) or 0.7
    productive = timedelta(minutes=int(total.total_seconds() / 60 * focus))

    def hm(delta: timedelta) -> str:
        minutes = int(delta.total_seconds() // 60)
        return f"{minutes // 60}ч {minutes % 60:02d}м"

    window_from = cfg.get("planner.window.from")
    window_to = cfg.get("planner.window.to")
    lines = [
        f"{PLAN_BEGIN}  run={day.isoformat()}T{window_from}  "
        f"config={cfg.config_hash()}  generated={time.strftime('%Y-%m-%d %H:%M')} -->",
        "",
        f"## План на {day.isoformat()}, {window_from}–{window_to} "
        f"(окно {hm(total)}, продуктивных {hm(productive)})",
        "",
        "| # | Время | Карточка | Тип | Готовность | Оценка | Почему здесь |",
        "|---|-------|----------|-----|-----------|--------|--------------|",
    ]
    for n, item in enumerate(placed, 1):
        title = (item.card.get("backlog_id") or item.card["title"])[:60].replace("|", "/")
        url = item.card.get("url") or ""
        link = f"[{title}]({url})" if url else title
        why = "; ".join(item.reasons[:3])
        lines.append(f"| {n} | {item.start}–{item.end} | {link} | {item.label} | "
                     f"{item.readiness:.2f} | {item.est} · {item.minutes}м | {why} |")

    if not placed:
        lines.append("| — | — | _нечего планировать: нет проработанных карточек_ | | | | |")

    if overflow:
        lines += ["", "### Не поместилось в окно"]
        for item in overflow[:20]:
            title = (item.card.get("backlog_id") or item.card["title"])[:70]
            lines.append(f"- {title} — {item.est} · {item.minutes}м, "
                         f"score {item.score}, готовность {item.readiness:.2f}")

    if cyclic:
        lines += ["", "### Цикл зависимостей (требует решения человека)"]
        for item in cyclic:
            lines.append(f"- {item.card['title'][:70]} — участвует в цикле "
                         "подзадача↔родитель, порядок выбрать вручную")

    if needs_human:
        lines += ["", "### Требует человека (needs_human)"]
        for entry in needs_human[:25]:
            questions = "; ".join(str(q)[:90] for q in entry.get("questions") or [])
            title = entry["title"][:70]
            link = f"[{title}]({entry['url']})" if entry.get("url") else title
            lines.append(f"- {link} — {entry['why']}"
                         + (f": {questions}" if questions else ""))

    lines += ["", PLAN_END]
    return lines


def write_block(path: Path, lines: list[str]) -> str:
    """Вставка/замена делимитированного блока. Файл может быть заморожен как живой
    документ — поэтому трогаем ровно область между маркерами и ничего вокруг."""
    block = "\n".join(lines)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(block + "\n", encoding="utf-8")
        return "создан"

    begin = text.find(PLAN_BEGIN)
    end = text.find(PLAN_END)
    if begin >= 0 and end > begin:
        new = text[:begin] + block + text[end + len(PLAN_END):]
        path.write_text(new, encoding="utf-8")
        return "блок заменён"
    path.write_text(text.rstrip() + "\n\n" + block + "\n", encoding="utf-8")
    return "блок добавлен"


def build_plan(cfg, date_override: str = "", apply: bool = False) -> int:
    day = resolve_date(cfg, date_override)
    intervals = free_intervals(cfg, day)
    if not intervals:
        log("окно пустое — проверь planner.window.from/to и перерывы")
        return 1

    with Store() as store:
        items, needs_human = collect(cfg, store)
        deps = dependency_map(items)
        score_items(cfg, items, deps)
        for item in items:
            item._deps = deps.get(item.card_id, set())      # noqa: SLF001 — для pack()
        ordered, cyclic = toposort(items, deps)
        for item in cyclic:
            needs_human.append({
                "card_id": item.card_id, "title": item.card["title"],
                "url": item.card.get("url", ""), "why": "цикл зависимостей", "questions": [],
            })
        placed, overflow = pack(cfg, ordered, intervals)
        lines = render_plan(cfg, day, intervals, placed, overflow, needs_human, cyclic)

        plan_id = new_id("plan")
        store.x(
            "INSERT INTO plans (id, window_from, window_to, items, overflow, needs_human, "
            "config_hash, emitted_to, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (plan_id, f"{day.isoformat()}T{cfg.get('planner.window.from')}",
             f"{day.isoformat()}T{cfg.get('planner.window.to')}",
             json.dumps([{"card_id": i.card_id, "title": i.card["title"], "start": i.start,
                          "end": i.end, "est": i.est, "minutes": i.minutes, "score": i.score,
                          "readiness": i.readiness, "reasons": i.reasons} for i in placed],
                        ensure_ascii=False),
             json.dumps([{"card_id": i.card_id, "title": i.card["title"],
                          "score": i.score} for i in overflow], ensure_ascii=False),
             json.dumps(needs_human, ensure_ascii=False),
             cfg.config_hash(), "" if not apply else str(cfg.get("outputs.plan_file")),
             int(time.time())),
        )

        log("\n".join(lines))
        log(f"\nитого: в окно {len(placed)}, за окном {len(overflow)}, "
            f"человеку {len(needs_human)}; план {plan_id}")

        if not apply:
            log("\nэто предпросмотр — для записи в файлы добавь --apply")
            return 0

        plan_file = cfg.path_of("outputs.plan_file")
        action = write_block(plan_file, lines)
        log(f"✓ {plan_file.name}: {action}")

        plan_json = cfg.path_of("outputs.plan_json")
        plan_json.parent.mkdir(parents=True, exist_ok=True)
        plan_json.write_text(json.dumps({
            "plan_id": plan_id, "date": day.isoformat(),
            "window": {"from": cfg.get("planner.window.from"),
                       "to": cfg.get("planner.window.to"),
                       "focus_ratio": cfg.get("planner.window.focus_ratio")},
            "items": [{"card_id": i.card_id, "title": i.card["title"], "url": i.card.get("url"),
                       "start": i.start, "end": i.end, "est": i.est, "minutes": i.minutes,
                       "score": i.score, "readiness": i.readiness, "reasons": i.reasons}
                      for i in placed],
            "overflow": [{"card_id": i.card_id, "title": i.card["title"], "score": i.score}
                         for i in overflow],
            "needs_human": needs_human,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"✓ {plan_json}")
        store.event("plan.emitted", plan_id, f"{len(placed)} пунктов")
        return 0


def watch(cfg, date_override: str = "", apply: bool = False) -> int:
    """Режим сервиса: пересобирать план по расписанию и не завершаться.

    До этого супервизор запускал планировщик как демон, а он строил план и выходил —
    поэтому в `status` он вечно значился «остановлен», хотя отработал штатно. Демон и
    разовая команда — разные режимы, и различать их должен явный флаг, а не догадка.

    План уезжает в таблицу `plans` (её читает UI) каждые `planner.rebuild_minutes`.
    В файлы репозитория демон по умолчанию НЕ пишет: `docs/plans/BACKLOG.md` — рабочий
    документ владельца, и правка его фоном без просьбы — не то поведение, которое можно
    включить умолчанием. Явная запись — `planner.watch_apply = true` или операция
    «Собрать план и записать».
    """
    every = max(1, int(cfg.get("planner.rebuild_minutes", 30) or 30))
    stopping = {"now": False}

    def on_signal(_sig, _frame):
        stopping["now"] = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, on_signal)

    log(f"планировщик: режим сервиса, пересборка каждые {every} мин"
        + (", с записью в файлы" if apply else ", только в БД (planner.watch_apply=false)"))
    while not stopping["now"]:
        started = time.time()
        try:
            build_plan(cfg, date_override, apply)
        except Exception as exc:                            # noqa: BLE001
            # Один упавший цикл не должен ронять сервис: следующий пройдёт по свежему
            # снапшоту, а причина остаётся в логе.
            log(f"❌ цикл планировщика не удался: {type(exc).__name__}: {exc}")
        deadline = started + every * 60
        while not stopping["now"] and time.time() < deadline:
            time.sleep(min(5.0, max(0.0, deadline - time.time())))
    log("планировщик остановлен по сигналу")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — планировщик (§8)")
    parser.add_argument("--once", action="store_true", help="построить план и выйти")
    parser.add_argument("--watch", action="store_true",
                        help="режим сервиса: пересобирать план каждые "
                             "planner.rebuild_minutes и не выходить")
    parser.add_argument("--date", default="", help="YYYY-MM-DD, иначе planner.window.date")
    parser.add_argument("--from", dest="time_from", default="",
                        help="начало окна ЧЧ:ММ на этот прогон, иначе planner.window.from")
    parser.add_argument("--to", dest="time_to", default="",
                        help="конец окна ЧЧ:ММ на этот прогон, иначе planner.window.to")
    parser.add_argument("--apply", action="store_true",
                        help="записать план в outputs.plan_file и plan_json")
    args = parser.parse_args()

    cfg = config_mod.load(strict=False)
    try:
        overridden = apply_window_override(cfg, args.time_from, args.time_to)
    except config_mod.ConfigError as exc:
        log(f"❌ {exc}")
        return 1
    if overridden:
        log(f"окно на этот прогон: {cfg.get('planner.window.from')}–"
            f"{cfg.get('planner.window.to')} (из аргументов, config.toml не изменён)")

    if args.watch:
        return watch(cfg, args.date, args.apply or bool(cfg.get("planner.watch_apply", False)))
    return build_plan(cfg, args.date, args.apply)


if __name__ == "__main__":
    sys.exit(main())
