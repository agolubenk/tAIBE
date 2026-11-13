# -*- coding: utf-8 -*-
"""pass_watch.py — проход Нерва под наблюдением (SE-70): длительность источников, nerve.slow, тревога тапа о
застрявшем проходе, перезапуск после правки кода. Пульс прохода — state/pulse (state_io.write_pulse).

Инцидент 13.11 17:32–17:38: проход шёл 6 мин, пульс пишется только в конце прохода, тапы coord и release подняли
«НЕРВ МОЛЧИТ» с перезапуском живого демона. Длительности нигде не писались — медленный источник не назвать.
"""
import os
import sys
import time
from datetime import datetime

from heartbeat import awake_seconds, heartbeat_silent, pass_stuck, running_pass
from journal import DIGEST, now_iso
from state_io import load_json, read_heartbeat, read_pulse

SLOW_PASS_CYCLES = 2
SLOW_EVERY_SECONDS = 3600


def close_pass(ctx, peers=None):
    """Конец прохода по умолчанию: длительность прохода, nerve.slow, пульс и state.json — одна запись за проход.
    Длительности других продуктов (github@<slug>) — в общий список, только этого прохода: nerve.slow назовёт и
    медленный github другого репо, а не прошлый замер продукта, чей проход упал раньше источников."""
    d = ctx.state.setdefault("durations", {"at": ctx.pass_started, "sources": {}})
    for peer in (peers or {}).values():
        pd = peer.state.get("durations")
        if isinstance(pd, dict) and pd.get("at") == peer.pass_started:
            d["sources"].update(pd.get("sources") or {})
    d["pass"] = round(time.monotonic() - ctx.t0, 1)
    slow_pass(ctx, d)
    hb = now_iso()
    ctx.state["heartbeat"] = hb
    ctx.save()
    with open(os.path.join(ctx.state_dir, "heartbeat"), "w") as f:
        f.write(hb)


def slow_pass(ctx, d):
    """Проход дольше SLOW_PASS_CYCLES циклов — дайджест release с самым медленным источником, не чаще раза в час от
    прошлого дайджеста (`slow_at` в state.json: календарный час дал бы два дайджеста за 2 мин на его границе).
    Порог — от дневного цикла: ночью проход не медленнее, чем днём; --interval задаёт паузу, а не длину прохода."""
    limit = SLOW_PASS_CYCLES * ctx.cfg["interval_seconds"]
    if d["pass"] <= limit or not d["sources"]:
        return
    try:
        if (ctx.now - datetime.fromisoformat(ctx.state.get("slow_at") or "")).total_seconds() < SLOW_EVERY_SECONDS:
            return
    except (TypeError, ValueError):   # прошлого дайджеста нет или метка битая
        pass
    ctx.state["slow_at"] = ctx.pass_started
    name, sec = max(d["sources"].items(), key=lambda kv: kv[1])
    listing = ", ".join(f"{k} {v:g}" for k, v in d["sources"].items())
    ctx.emit(f"nerve:slow:{ctx.pass_started}", "nerve.slow", DIGEST, ["release"],
             f"проход Нерва шёл {d['pass']:g} с (порог {limit} с): дольше всех {name} — {sec:g} с; по источникам, с: "
             f"{listing}", "nerve")


def code_changed(started, here=None, now=None):
    """Файлы кода Нерва (*.py верхнего уровня, без test_*; подпакетов нет), изменённые после старта процесса. Модули загружены один раз: 13.11 git pull
    принёс поле queue.delta в instances/ и products.py, старый products.py давал ProductError на каждом проходе
    10:01–10:21, до ручного перезапуска. mtime в будущем (сбитые часы) не в счёт — иначе перезапуск по кругу."""
    here = here or os.path.dirname(os.path.abspath(__file__))
    now = time.time() if now is None else now
    out = []
    for n in sorted(os.listdir(here)):
        if not n.endswith(".py") or n.startswith("test_"):
            continue
        try:
            m = os.stat(os.path.join(here, n)).st_mtime
        except OSError:
            continue
        if started < m <= now:
            out.append(n)
    return out


def code_restart(ctx, started, here=None):
    """True — код обновился: строка в stderr и дайджест release (ключ — час: правка в checkout демона не будит release
    на каждом проходе); демон выходит с кодом ≠ 0, launchd поднимает новый."""
    changed = code_changed(started, here)
    if not changed:
        return False
    ctx.emit(f"nerve:restart:{ctx.now.astimezone(ctx.tz):%Y%m%d%H}", "nerve.restart", DIGEST, ["release"],
             f"код Нерва обновился ({', '.join(changed[:5])}) — демон выходит с кодом 3, launchd перезапустит его с "
             "новым кодом", "nerve")
    print(f"код обновился: {', '.join(changed)} — выход 3 для перезапуска", file=sys.stderr, flush=True)
    return True


def silence_alarm(cfg, mode, now, state_dir):
    """Строка тревоги о пульсе для тапов coord и release или "". Демон внутри прохода (state/pulse новее пульса) —
    тревога только о застрявшем проходе, с именем источника; между проходами — прежнее «НЕРВ МОЛЧИТ»."""
    hb = read_heartbeat(state_dir)
    cycle = load_json(os.path.join(state_dir, "cycle.json"), None)
    kick = f"launchctl kickstart -k gui/{os.getuid()}/space.hrhelper.nerve"
    run = running_pass(read_pulse(state_dir), hb, now)
    if run:
        minutes = pass_stuck(cfg, mode, cycle, hb, run, now, awake_seconds())
        if minutes:
            return f"НЕРВ ЗАСТРЯЛ: проход с {run[0][11:16]} UTC идёт {minutes} мин, источник {run[1]} — {kick}"
        return ""
    if heartbeat_silent(cfg, mode, cycle, hb, now, awake_seconds()):
        return f"НЕРВ МОЛЧИТ с {hb[11:16] if hb else '—'} UTC: демон не пишет пульс — {kick}"
    return ""


def pass_lines(st, state_dir):
    """Строки `nerve.py status`: последний проход с длительностями по источникам и проход, который идёт сейчас."""
    out = []
    d = st.get("durations") if isinstance(st.get("durations"), dict) else {}
    if isinstance(d.get("sources"), dict) and d["sources"]:
        at = str(d.get("at") or "")[11:16] or "—"
        out.append(f"проход {at} UTC: {d.get('pass', '—')} с; по источникам, с: " +
                   ", ".join(f"{k} {v}" for k, v in d["sources"].items()))
    run = running_pass(read_pulse(state_dir), st.get("heartbeat"))   # state.json уже прочитан — второй раз не читать
    if run:
        out.append(f"идёт проход с {run[0][11:16]} UTC, источник {run[1]}")
    return out
