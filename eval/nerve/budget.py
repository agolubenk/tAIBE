# -*- coding: utf-8 -*-
"""Циркадный бюджет (П10): расход против недельной квоты и режим доставки.

Расход — по прайсу API из usage в транскриптах Claude Code (как context_audit.py): на подписке это мерило лимита,
а не деньги. Квота в $ — калибровка по неделе, когда лимит кончился (nerve.py calibrate).
"""
import glob
import json
import os
import re
from datetime import datetime, timedelta, timezone

PRICES = {"fable": (10, 50, 0.25), "opus-5-5": (4, 20, 0.2), "opus-5": (5, 25, 0.5), "sonnet": (2, 10, 0.2),
          "haiku-5-5": (0.1, 0.5, 0.01)}


def price(model):
    for k in PRICES:
        if k in (model or ""):
            return PRICES[k]
    return PRICES["opus-5-5"]


def call_usd(u, model):
    pi, po, pr = price(model)
    cw = u.get("cache_creation_input_tokens", 0) or 0
    c1 = (u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens", 0) or 0
    return ((u.get("input_tokens", 0) or 0) * pi + (cw - c1) * 1.25 * pi + c1 * 2 * pi
            + (u.get("cache_read_input_tokens", 0) or 0) * pr + (u.get("output_tokens", 0) or 0) * po) / 1e6


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
    """Как scan_usage, но отдаёт приращения [(ts, usd, cwd)] — для поминутных корзин счётчика; cwd записи — для
    продукта (SE-66). Отказы по лимиту из тех же строк дописываются в limits [(ts, text)]: счётчик читает каждую новую
    строку, так что отказ не теряется."""
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
        out.append((ts, call_usd(u, m.get("model")), o.get("cwd")))
    return out, offset + end + 1, rids


OVERHEAD, UNATTRIBUTED = "overhead", "unattributed"
PRODUCT_STEP_MIN = 5                       # корзины продуктов — по 5 мин: окно 5 ч = 60 ключей на продукт
PRODUCT_KEEP = timedelta(hours=5, minutes=PRODUCT_STEP_MIN)


def project_dir_name(path):
    """Имя папки проекта Claude Code для пути: каждый знак, кроме буквы и цифры, — «-»."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


class Products:
    """Чей расход (SE-66): cwd записи под repo_root продукта (самый длинный корень, по границе пути); иначе папка, в
    которой сессия запущена (имя папки транскрипта); иначе unattributed. Так смена cwd внутри транскрипта
    (/private/tmp, чужой репо) не теряет продукт сессии, а запись в чужом репо уходит этому репо."""

    def __init__(self, roots):
        self.roots = sorted(((slug, os.path.normpath(os.path.expanduser(r))) for slug, r in roots.items() if r),
                            key=lambda sr: -len(sr[1]))

    def of_cwd(self, cwd):
        p = os.path.normpath(cwd) if isinstance(cwd, str) and cwd else ""
        return next((slug for slug, root in self.roots if p == root or p.startswith(root + os.sep)), None)

    def of_project(self, name):
        for slug, root in self.roots:
            enc = project_dir_name(root)
            if name == enc or name.startswith(enc + "-"):
                return slug
        return None

    def of(self, cwd, project):
        return self.of_cwd(cwd) or self.of_project(project) or UNATTRIBUTED


def _product_key(ts):
    t = ts.astimezone(timezone.utc)
    return t.replace(minute=t.minute - t.minute % PRODUCT_STEP_MIN).strftime("%Y-%m-%dT%H:%M")


class Meter:
    """Поминутные корзины расхода аккаунта ($ по прайсу) за последние keep_days. Состояние — в dict демона.
    С products — ещё корзины по продуктам за последние 5 ч (SE-66; state.json не раздувается: ≈ 60 ключей)."""

    def __init__(self, state, keep_days=8, products=None):
        self.st = state
        self.st.setdefault("files", {})
        self.st.setdefault("buckets", {})
        self.keep = timedelta(days=keep_days)
        self.products = products
        if products is not None:
            self.st.setdefault("products", {})

    def update(self, projects_root, now):
        """Досчитывает новые строки всех транскриптов. Возвращает отказы по лимиту из них: [(ts, text)]."""
        floor = now - self.keep
        files = glob.glob(os.path.join(projects_root, "*", "*.jsonl")) + \
            glob.glob(os.path.join(projects_root, "*", "*", "subagents", "*.jsonl"))
        seen = set()
        limits = []
        if self.products is not None and "products_from" not in self.st:
            # Смещения файлов уже в конце: корзины продуктов копятся с этого прохода, полное окно — через 5 ч.
            self.st["products_from"] = now.astimezone(timezone.utc).isoformat(timespec="minutes")
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
            project = os.path.relpath(p, projects_root).split(os.sep)[0]
            for ts, usd, cwd in inc:
                if ts < floor:
                    continue
                k = ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")
                self.st["buckets"][k] = self.st["buckets"].get(k, 0.0) + usd
                if self.products is not None and ts >= now - PRODUCT_KEEP:
                    cell = self.st["products"].setdefault(_product_key(ts), {})
                    slug = self.products.of(cwd, project)
                    cell[slug] = round(cell.get(slug, 0.0) + usd, 4)
        for p in [k for k in self.st["files"] if k not in seen]:
            del self.st["files"][p]
        lo = floor.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        for k in [k for k in self.st["buckets"] if k < lo]:
            del self.st["buckets"][k]
        if self.products is not None:
            lo5 = _product_key(now - PRODUCT_KEEP)
            for k in [k for k in self.st["products"] if k < lo5]:
                del self.st["products"][k]
        return sorted(limits)

    def by_product(self, t_from, t_to=None):
        """{продукт: $} за [t_from, t_to] с точностью до 5 мин (корзина, в которую попал t_from, — целиком)."""
        lo = _product_key(t_from)
        hi = t_to.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M") if t_to else "9999"
        out = {}
        for k, cell in self.st.get("products", {}).items():
            if lo <= k <= hi:
                for slug, usd in cell.items():
                    out[slug] = out.get(slug, 0.0) + usd
        return out

    def total(self, t_from, t_to=None):
        lo = t_from.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        hi = t_to.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M") if t_to else "9999"
        return sum(v for k, v in self.st["buckets"].items() if lo <= k <= hi)


def _load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def evolve_overhead(evolve_dir, t_from, t_to):
    """$ ночной эволюции (eval/evolve) в [t_from, t_to] — накладные (SE-66). Её вызовы Claude идут с
    --no-session-persistence, в транскриптах их нет. Судьи — budget.tokens отчёта runs/<дата>.json по цене входа
    sonnet (оценка: разбивки токенов в отчёте нет), сессия — usd из runs/session-latest.json; обе — в момент finished.
    Файл прогона назван днём старта: прогон, начатый накануне, мог закончиться в окне — день до t_from тоже читается.
    Файл сессии без finished (записан до SE-66) или битый — время по mtime файла (SE-81).
    → (usd, unknown): unknown — части, которые закончились в окне, но $ не дали (сессия без total_cost_usd)."""
    usd, unknown = 0.0, []

    def when(v):  # строка ISO с поясом → время; прочее (нет, не строка, без пояса) — None
        at = parse_ts(v) if isinstance(v, str) else None
        return at if at is not None and at.tzinfo is not None else None

    def inside(v):
        at = v if isinstance(v, datetime) else when(v)
        return at is not None and t_from <= at <= t_to

    for day in sorted({t_from.date() - timedelta(days=1), t_from.date(), t_to.date()}):
        r = _load(os.path.join(evolve_dir, "runs", f"{day.isoformat()}.json"))
        tokens = r.get("budget").get("tokens") if isinstance(r.get("budget"), dict) else 0
        if isinstance(tokens, (int, float)) and tokens > 0 and inside(r.get("finished")):
            usd += tokens * PRICES["sonnet"][0] / 1e6
    path = os.path.join(evolve_dir, "runs", "session-latest.json")
    s = _load(path)
    ended = when(s.get("finished"))
    if ended is None and os.path.isfile(path):
        ended = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc)
    if inside(ended):
        if isinstance(s.get("usd"), (int, float)) and not isinstance(s.get("usd"), bool):
            usd += s["usd"]
        else:
            unknown.append("сессия")
    return usd, unknown


def shares(share5, by, overhead_usd, quota):
    """Доли окна 5 ч по продуктам (SE-66): продукты из транскриптов делят share5 в пропорции своих $; накладные —
    overhead / квота окна, сверх share5 (share5 по-прежнему считает только транскрипты)."""
    total = sum(by.values())
    out = {slug: round(share5 * usd / total, 3) for slug, usd in sorted(by.items())} \
        if share5 is not None and total > 0 else {}
    if quota and overhead_usd:
        out[OVERHEAD] = round(overhead_usd / quota, 3)
    return out


SHARE_LABELS = {OVERHEAD: "накладные", UNATTRIBUTED: "не отнесено"}


def shares_text(mode):
    """Строка статуса и сводки: «share5 0.63: hr-helper 0.41 · taibe 0.17 · не отнесено 0.05 · накладные 0.02»."""
    by = mode.get("share5_by")
    if not by:
        err = mode.get("share5_by_error")
        return "share5 по продуктам: нет данных" + (f" (сбой: {err[:80]})" if err else "")
    order = sorted((k for k in by if k not in SHARE_LABELS), key=lambda k: -by[k]) + \
        [k for k in (UNATTRIBUTED, OVERHEAD) if k in by]
    parts = " · ".join(f"{SHARE_LABELS.get(k, k)} {by[k]:.2f}" for k in order)
    tail = f" (продукты — с {mode['products_from'][11:16]})" if mode.get("products_partial") else ""
    head = f"share5 {mode['share5']:.2f}" if mode.get("share5") is not None else "share5"
    gap = f", без $: {', '.join(mode['overhead_unknown'])}" if mode.get("overhead_unknown") else ""
    return f"{head}: {parts}{tail}; накладные — сверх share5{gap}"


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
