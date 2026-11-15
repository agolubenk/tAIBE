# -*- coding: utf-8 -*-
"""Циркадный бюджет (П10): расход против недельной квоты и режим доставки.

Расход — по прайсу API из usage в транскриптах Claude Code (как context_audit.py): на подписке это мерило лимита,
а не деньги. Квота в $ — калибровка по неделе, когда лимит кончился (nerve.py calibrate).
"""
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

# Один прайс на весь eval (GL-1): eval/tools/prices.py. В конец пути, а не в начало: модули Нерва не перекрываются.
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from prices import PRICES, call_usd, price  # noqa: E402,F401


def parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def week_start(now_local, weekday, hh, mm):
    """Последний сброс недельной квоты не позже now_local (weekday: пн=0)."""
    d = now_local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    d -= timedelta(days=(now_local.weekday() - weekday) % 7)
    if d > now_local:
        d -= timedelta(days=7)
    return d


def scan_usage(path, offset, t_from, t_to, last_rids):
    """Досчитывает расход файла с offset. Один ответ модели = несколько строк с общим requestId — считается один раз.
    Возвращает (usd, новый offset, хвост requestId)."""
    usd = 0.0
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return 0.0, offset, last_rids
    end = data.rfind(b"\n")
    if end < 0:
        return 0.0, offset, last_rids
    rids = list(last_rids)
    for raw in data[: end + 1].splitlines():
        if b'"usage"' not in raw or b'"assistant"' not in raw:
            continue
        try:
            o = json.loads(raw)
        except ValueError:
            continue
        m = o.get("message") or {}
        u = m.get("usage")
        if o.get("type") != "assistant" or not isinstance(u, dict):
            continue
        ts = parse_ts(o.get("timestamp") or "")
        if ts is None or ts < t_from or (t_to and ts > t_to):
            continue
        rid = o.get("requestId") or m.get("id")
        if rid and rid in rids:
            continue
        if rid:
            rids.append(rid)
            rids = rids[-64:]
        usd += call_usd(u, m.get("model"))
    return usd, offset + end + 1, rids


def limit_text(o):
    """Текст отказа по лимиту аккаунта из строки транскрипта или ''."""
    if not o.get("isApiErrorMessage"):
        return ""
    c = (o.get("message") or {}).get("content")
    text = str(c[0].get("text", "")) if isinstance(c, list) and c and isinstance(c[0], dict) else ""
    return text if LIMIT_RE.search(text) else ""


def scan_increments(path, offset, last_rids, limits=None):
    """Как scan_usage, но отдаёт приращения [(ts, usd)] — для поминутных корзин счётчика. Отказы по лимиту из тех же
    строк дописываются в limits [(ts, text)]: счётчик читает каждую новую строку, так что отказ не теряется."""
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return [], offset, last_rids
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset, last_rids
    rids = list(last_rids)
    out = []
    for raw in data[: end + 1].splitlines():
        lim = limits is not None and b"isApiErrorMessage" in raw and b"limit" in raw
        if not lim and (b'"usage"' not in raw or b'"assistant"' not in raw):
            continue
        try:
            o = json.loads(raw)
        except ValueError:
            continue
        m = o.get("message") or {}
        u = m.get("usage")
        ts = parse_ts(o.get("timestamp") or "")
        if lim and limits is not None and ts is not None and limit_text(o):
            limits.append((ts, limit_text(o)))
            continue
        if o.get("type") != "assistant" or not isinstance(u, dict) or ts is None:
            continue
        rid = o.get("requestId") or m.get("id")
        if rid and rid in rids:
            continue
        if rid:
            rids.append(rid)
            rids = rids[-64:]
        out.append((ts, call_usd(u, m.get("model"))))
    return out, offset + end + 1, rids


class Meter:
    """Поминутные корзины расхода аккаунта ($ по прайсу) за последние keep_days. Состояние — в dict демона."""

    def __init__(self, state, keep_days=8):
        self.st = state
        self.st.setdefault("files", {})
        self.st.setdefault("buckets", {})
        self.keep = timedelta(days=keep_days)

    def update(self, projects_root, now):
        """Досчитывает новые строки всех транскриптов. Возвращает отказы по лимиту из них: [(ts, text)]."""
        floor = now - self.keep
        files = glob.glob(os.path.join(projects_root, "*", "*.jsonl")) + \
            glob.glob(os.path.join(projects_root, "*", "*", "subagents", "*.jsonl"))
        seen = set()
        limits = []
        for p in files:
            try:
                if os.path.getmtime(p) < floor.timestamp():
                    continue
            except OSError:
                continue
            seen.add(p)
            f = self.st["files"].get(p) or {"offset": 0, "rids": []}
            inc, f["offset"], f["rids"] = scan_increments(p, f["offset"], f["rids"], limits)
            self.st["files"][p] = f
            for ts, usd in inc:
                if ts < floor:
                    continue
                k = ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")
                self.st["buckets"][k] = self.st["buckets"].get(k, 0.0) + usd
        for p in [k for k in self.st["files"] if k not in seen]:
            del self.st["files"][p]
        lo = floor.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        for k in [k for k in self.st["buckets"] if k < lo]:
            del self.st["buckets"][k]
        return sorted(limits)

    def total(self, t_from, t_to=None):
        lo = t_from.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        hi = t_to.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M") if t_to else "9999"
        return sum(v for k, v in self.st["buckets"].items() if lo <= k <= hi)


def median(xs):
    s = sorted(xs)
    if not s:
        return None
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def window_start(now, last_reset, hours):
    """Начало текущего окна лимита: последний известный сброс, если он внутри окна, иначе now − hours."""
    w = now - timedelta(hours=hours)
    return max(w, last_reset) if last_reset and last_reset <= now else w


def spend(projects_root, t_from, t_to=None, state=None):
    """Расход всех транскриптов (сессии и субагенты) за [t_from, t_to]. state — кэш смещений по файлам между
    проходами; при смене недели вызывающий передаёт пустой. Возвращает (usd, state)."""
    state = state if state is not None else {}
    files = glob.glob(os.path.join(projects_root, "*", "*.jsonl")) + \
        glob.glob(os.path.join(projects_root, "*", "*", "subagents", "*.jsonl"))
    floor = t_from.timestamp()
    for p in files:
        try:
            if os.path.getmtime(p) < floor:
                continue
        except OSError:
            continue
        st = state.get(p) or {"offset": 0, "usd": 0.0, "rids": []}
        usd, off, rids = scan_usage(p, st["offset"], t_from, t_to, st["rids"])
        state[p] = {"offset": off, "usd": st["usd"] + usd, "rids": rids}
    return sum(v["usd"] for v in state.values()), state


LIMIT_RE = re.compile(r"hit your (weekly|session|daily|[\w-]+ ?\w*) limit[^\n]*?resets ([^\n\"·]+)", re.I)
RESET_RE = re.compile(r"(?:(\w{3}) (\d{1,2}) at )?(\d{1,2})(?::(\d\d))?\s*(am|pm)", re.I)
MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}


def parse_reset(text, seen_local):
    """«Oct 29 at 7pm (Europe/Minsk)» или «7pm (…)» → datetime в поясе seen_local. Пояс в скобках считается
    местным: Claude Code пишет время в поясе пользователя."""
    m = RESET_RE.search(text or "")
    if not m:
        return None
    mon, day, hh, mm, ap = m.groups()
    h = int(hh) % 12 + (12 if ap.lower() == "pm" else 0)
    d = seen_local.replace(hour=h, minute=int(mm or 0), second=0, microsecond=0)
    if mon and mon.lower()[:3] in MONTHS:
        d = d.replace(month=MONTHS[mon.lower()[:3]], day=int(day))
        if d < seen_local - timedelta(days=1):
            d = d.replace(year=d.year + 1)
    elif d <= seen_local:
        d += timedelta(days=1)
    return d


def find_limits(projects_root, t_from, tz):
    """Отказы по лимиту аккаунта в транскриптах с t_from: [(ts, вид, сброс)]. Один отказ попадает во многие
    сессии — схлопывается по (вид, сброс)."""
    out = {}
    floor = t_from.timestamp()
    for p in glob.glob(os.path.join(projects_root, "*", "*.jsonl")):
        try:
            if os.path.getmtime(p) < floor:
                continue
            with open(p, "rb") as f:
                for raw in f:
                    if b"limit" not in raw or b"isApiErrorMessage" not in raw:
                        continue
                    try:
                        o = json.loads(raw)
                    except ValueError:
                        continue
                    ts = parse_ts(o.get("timestamp") or "")
                    if not o.get("isApiErrorMessage") or ts is None or ts < t_from:
                        continue
                    c = (o.get("message") or {}).get("content")
                    text = str(c[0].get("text", "")) if isinstance(c, list) and c and isinstance(c[0], dict) else ""
                    m = LIMIT_RE.search(text)
                    if not m:
                        continue
                    kind = "weekly" if "weekly" in m.group(1).lower() else "session"
                    reset = parse_reset(m.group(2), ts.astimezone(tz))
                    k = (kind, reset.isoformat() if reset else m.group(2).strip())
                    if k not in out or ts < out[k][0]:
                        out[k] = (ts, kind, reset)
        except OSError:
            continue
    return sorted(out.values(), key=lambda x: x[0])


def circadian(now_local, day_from, evening_from, night_from):
    """day | evening | night по местному времени. Границы — "HH:MM"."""
    hm = now_local.strftime("%H:%M")
    if day_from <= hm < evening_from:
        return "day"
    if evening_from <= hm < night_from:
        return "evening"
    return "night"


def decide_mode(now_local, share5, limit_until, cfg):
    """Режим доставки тапов.
    phase — день / вечер / ночь; pause — лимит аккаунта действует (до limit_until): тапы молчат, кроме нервного
    класса; batch — окно 5 ч израсходовано на batch_at и больше: дайджест реже, линзы пачками."""
    b = cfg["budget"]
    c = cfg["circadian"]
    phase = circadian(now_local, c["day_from"], c["evening_from"], c["night_from"])
    pause = bool(limit_until) and now_local < limit_until
    batch = share5 is not None and share5 >= b["batch_at"]
    return {"phase": phase, "pause": pause, "batch": batch,
            "share5": None if share5 is None else round(share5, 3),
            "limit_until": limit_until.isoformat(timespec="minutes") if pause else ""}


def next_day_start(now_local, day_from):
    hh, mm = (int(x) for x in day_from.split(":"))
    d = now_local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    return d if d > now_local else d + timedelta(days=1)


def resume_at(reset_local, cfg):
    """Когда будить роли после сброса лимита: сразу, если сброс днём или вечером; ночью — в начале дня."""
    c = cfg["circadian"]
    if circadian(reset_local, c["day_from"], c["evening_from"], c["night_from"]) == "night":
        return next_day_start(reset_local, c["day_from"])
    return reset_local


def utc(dt_local):
    return dt_local.astimezone(timezone.utc)
