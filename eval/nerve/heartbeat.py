"""Нерв: пульс и длина цикла — когда tap считает демон молчащим. Вынесено из nerve.py (лимит 500 строк, OPS-25 Ф2b);
nerve.py реэкспортирует имена, вызовы `nerve.heartbeat_silent` и `nerve.awake_seconds` (team_status.py) не меняются."""
import math
import time
from datetime import datetime, timedelta

# Awake time since boot, one count for every process: CLOCK_UPTIME_RAW on macOS, CLOCK_MONOTONIC on Linux.
# Neither runs while the system sleeps — and neither does the daemon's time.sleep.
AWAKE_CLOCK = getattr(time, "CLOCK_UPTIME_RAW", time.CLOCK_MONOTONIC)


def awake_seconds():
    return time.clock_gettime(AWAKE_CLOCK)


def cycle_seconds(cfg, mode, interval=None):
    """Pause of the daemon after a pass: night_interval_factor times longer at night. The phase comes from mode.json,
    which only the daemon's own pass writes (budget.py), so a tap reading it sees the phase the daemon slept on."""
    base = cfg["interval_seconds"] if interval is None else interval
    return base * (cfg.get("night_interval_factor", 5) if mode.get("phase") == "night" else 1)


MAX_CYCLE_SECONDS = 24 * 3600


def as_obj(x):
    """A state file that is valid JSON but not an object ([1], "x", 5) reads as empty — the tap must not die on it."""
    return x if isinstance(x, dict) else {}


def finite_number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def slept_cycle(cfg, mode, cycle):
    """The pause the daemon really went to sleep on: state/cycle.json, which cmd_run writes right before time.sleep.
    It carries a manual «run --interval N» the config does not know. A missing, malformed or implausible file (a
    daemon from before it; Infinity; over a day — 1e12 would silence the watchdog for good) falls back to the config."""
    s = as_obj(cycle).get("seconds")
    if finite_number(s) and 0 < s <= MAX_CYCLE_SECONDS:
        return s
    return cycle_seconds(cfg, mode)


def heartbeat_stale_after(cfg, mode, cycle=None):
    """The heartbeat is stale once the daemon missed a cycle: at least two cycles, never under heartbeat_stale_min.
    Night cycle 60 s × 5 = 300 s equalled the 5-minute threshold, so any pass a second late raised a false
    «НЕРВ МОЛЧИТ» (04.11 22:22 and 22:37, heartbeat 5 s old). Day stays 5 minutes, night becomes 10."""
    return max(timedelta(minutes=cfg["tap"]["heartbeat_stale_min"]),
               timedelta(seconds=2 * slept_cycle(cfg, mode, cycle)))


def awake_since_sleep(cycle, hb, awake_now):
    """Awake seconds since the daemon went to sleep after the heartbeat `hb`, or None when that is unknown: no
    «awake» in cycle.json (a daemon from before it), a cycle of an older pass than the heartbeat, or a count that
    went back (a reboot)."""
    c = as_obj(cycle)
    a, at = c.get("awake"), c.get("at")
    if not finite_number(a) or not isinstance(at, str):
        return None
    try:
        if datetime.fromisoformat(at) < datetime.fromisoformat(hb):
            return None
    except (TypeError, ValueError):  # not a date, or a date without a time zone against an aware heartbeat
        return None
    return awake_now - a if awake_now >= a else None


def heartbeat_silent(cfg, mode, cycle, hb, now, awake_now):
    """The daemon missed its cycle — only when both clocks say so. time.sleep counts awake time only, so on a
    sleeping Mac a night pause stretches over the whole system sleep. Night 05.11: heartbeat 02:48:29, four
    «НЕРВ МОЛЧИТ» at 03:40, 03:56, 04:00 and 04:17 (DarkWake), and by 04:17 the Mac had been awake 272 s of
    88 min — less than the 300 s pause. Without a trusted awake count — the wall clock, as before."""
    limit = heartbeat_stale_after(cfg, mode, cycle)
    try:
        if now - datetime.fromisoformat(hb) <= limit:
            return False
    except (TypeError, ValueError):  # no pulse, or a broken one
        return True
    slept = awake_since_sleep(cycle, hb, awake_now)
    return slept is None or slept > limit.total_seconds()


# SE-70: проход внутри (state/pulse новее пульса) — это ещё не тишина. 13.11 17:32–17:38 проход шёл 6 мин, порог
# пульса днём 5 мин — «НЕРВ МОЛЧИТ» с перезапуском живого демона. Застрявшим проход считается после трёх порогов.
SLOW_PASS_FACTOR = 3


def running_pass(pulse, hb):
    """(начало прохода, источник), если state/pulse пишет проход, начатый после пульса `hb` — демон внутри прохода;
    иначе None (демон спит между проходами, демон старше SE-70 без файла, сломанный файл)."""
    p = as_obj(pulse)
    started, source = p.get("pass"), p.get("source")
    if not isinstance(started, str):
        return None
    try:
        start = datetime.fromisoformat(started)
        if isinstance(hb, str) and hb and start <= datetime.fromisoformat(hb):
            return None
    except (TypeError, ValueError):
        return None
    return started, source if isinstance(source, str) and source else "?"


def pass_stuck(cfg, mode, cycle, hb, run, now, awake_now):
    """Минуты прохода `run`, если он идёт дольше SLOW_PASS_FACTOR порогов пульса и по стенным часам, и по бодрствованию
    (Mac уснул посреди прохода — не застрял, тот же приём, что в heartbeat_silent); иначе 0."""
    limit = SLOW_PASS_FACTOR * heartbeat_stale_after(cfg, mode, cycle).total_seconds()
    try:
        age = (now - datetime.fromisoformat(run[0])).total_seconds()
    except (TypeError, ValueError):
        return 0
    if age <= limit:
        return 0
    slept = awake_since_sleep(cycle, hb, awake_now)
    if slept is not None and slept <= limit:
        return 0
    return int(age // 60)
