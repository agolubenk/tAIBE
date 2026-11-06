#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nerve.py — «Нерв» команды сессий (supertick-eval П7, П8, П10). stdlib, python3 -I.

  python3 -I nerve.py run [--interval 60]     демон (launchd): опрос источников, журнал, авто-действия
  python3 -I nerve.py once [--seed]           один проход; --seed — без доставки (ключи запомнены, никому не слать)
  python3 -I nerve.py tap <роль> [--once]     для Monitor роли: строка — только когда роли нужно действовать
  python3 -I nerve.py emit <роль> <текст>     нервное событие вручную (назначение от Координатора)
  python3 -I nerve.py status                  режим, окно 5 ч, лимит, пульс, ошибки источников
  tap, emit, status: --product <slug> (иначе env TAIBE_PRODUCT, иначе продукт по умолчанию из instances/)

Продукты (OPS-25, docs/plans/roadmap/nerve-per-product.md): один процесс. Проход продукта по умолчанию — как раньше,
в state/; другие активные продукты (instances/<slug>.json, active: true) — GitHub своего репо, журнал и курсоры в
state/products/<slug>/. Режим, пульс, cycle.json, бюджет и замок — общие, в state/.

Журнал — state/journal.jsonl (append-only, ключ идемпотентности, запись до доставки). Режим — state/mode.json.
Откат: launchctl bootout gui/$(id -u)/space.hrhelper.nerve; сессии возвращаются к правилу 3 TEAM-0.
"""
import argparse
import fcntl
import json
import math
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import actions  # noqa: E402
import sources  # noqa: E402
from journal import ALL, DIGEST, NERVOUS, Journal, addressed, now_iso, read_from  # noqa: E402

STATE_DIR = os.environ.get("NERVE_STATE_DIR", os.path.join(HERE, "state"))
# Awake time since boot, one count for every process: CLOCK_UPTIME_RAW on macOS, CLOCK_MONOTONIC on Linux.
# Neither runs while the system sleeps — and neither does the daemon's time.sleep.
AWAKE_CLOCK = getattr(time, "CLOCK_UPTIME_RAW", time.CLOCK_MONOTONIC)


def awake_seconds():
    return time.clock_gettime(AWAKE_CLOCK)


def wakes_on():
    """The product's switch `nerveWakes` (tAI-Boards pipeline settings): off — events are still journaled, but
    nobody is woken. Errors and missing layer → on."""
    try:
        sys.path.insert(0, os.path.join(HERE, "..", "..", ".claude", "scripts"))
        import pipeline_settings
        return pipeline_settings.enabled("nerveWakes")
    except Exception:  # noqa: BLE001 — the watchdog never dies on settings
        return True


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = f"{path}.tmp{os.getpid()}"   # свой tmp у процесса: два tap одной роли не рвут файл друг другу
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def local_tz():
    return datetime.now().astimezone().tzinfo


class Ctx:
    def __init__(self, cfg, state_dir, deliver=True):
        self.cfg = cfg
        self.state_dir = state_dir
        self.deliver = deliver
        self.tz = local_tz()
        self.now = datetime.now(timezone.utc)
        self.projects_root = os.path.expanduser(cfg["team"]["projects_root"])
        self.state = load_json(os.path.join(state_dir, "state.json"), {})
        self.journal = Journal(os.path.join(state_dir, "journal.jsonl"))
        self._token = None
        self.emitted = 0

    def emit(self, key, kind, cls, to, text, src=""):
        ok = self.journal.emit(key, kind, cls, to if self.deliver else [], text, src)
        self.emitted += ok
        return ok

    def oq_token(self):
        if self._token is None:
            p = subprocess.run(["bash", self.cfg["queue"]["secret_cmd"], "OQ_TOKEN"], capture_output=True, text=True,
                               timeout=20, cwd=self.cfg["repo_root"])
            self._token = p.stdout.strip()
            if not self._token:
                raise RuntimeError("нет OQ_TOKEN (mcp-secret.sh)")
        return self._token

    def write_mode(self, mode):
        save_json(os.path.join(self.state_dir, "mode.json"), mode)

    def save(self):
        save_json(os.path.join(self.state_dir, "state.json"), self.state)


POLLS = [("github", sources.poll_github), ("queue", sources.poll_queue), ("system", sources.poll_system),
         ("budget", actions.poll_budget)]


def one_pass(ctx, polls=None, finish=True):
    """finish=False — пульс и запись state.json оставить run_products (одна запись ≈1 МБ за проход, а не две)."""
    errs = ctx.state.setdefault("errors", {})
    for name, fn in (POLLS if polls is None else polls):
        if not ctx.cfg["sources"].get(name, True):
            continue
        try:
            fn(ctx)
            if name in errs:
                ctx.emit(f"err:{name}:ok:{errs[name]['since']}", "nerve.error", DIGEST, ["release"],
                         f"источник {name} снова отвечает (сбой с {errs[name]['since'][11:16]})", "nerve")
                del errs[name]
        except Exception as e:  # источник не должен валить демон
            msg = f"{type(e).__name__}: {e}"[:200]
            if name not in errs:
                errs[name] = {"since": now_iso(), "msg": msg}
                ctx.emit(f"err:{name}:{errs[name]['since']}", "nerve.error", DIGEST, ["release"],
                         f"источник {name} не отвечает: {msg}", "nerve")
            errs[name]["msg"] = msg
    if polls is not None:          # проход другого продукта: пульс и режим пишет только проход по умолчанию
        ctx.save()
        return
    if not finish:
        return
    ctx.state["heartbeat"] = now_iso()
    ctx.save()
    with open(os.path.join(ctx.state_dir, "heartbeat"), "w") as f:
        f.write(ctx.state["heartbeat"])


# ---------- Продукты (OPS-25) ----------

PRODUCT_POLLS = [("github", sources.poll_github)]   # Ф2a: свой репо; очередь и события аккаунта — Ф2b


def load_products():
    """(default_slug, {slug: cfg}) из instances/; без instances/ — (None, {}) и один продукт из config.json."""
    if not os.path.isdir(os.path.join(HERE, "..", "..", "instances")):
        return None, {}
    import products as P
    shared, items = P.load()
    return shared["default_product"], {slug: P.config_for(slug, shared, items) for slug in items}


def product_state(slug, default):
    import products as P
    return P.product_dir(slug, STATE_DIR, default)


def other_product_passes(deliver):
    """Проход каждого активного продукта, кроме продукта по умолчанию. Сбой продукта — в его errors, остальным не
    мешает; сбой загрузки instances/ — исключение вызывающему (run_products пишет его в журнал по умолчанию)."""
    default, cfgs = load_products()
    for slug, pcfg in cfgs.items():
        if slug == default or pcfg.get("active") is not True:
            continue
        pdir = product_state(slug, default)
        os.makedirs(pdir, exist_ok=True)
        open(os.path.join(pdir, "journal.jsonl"), "a").close()
        ctx = Ctx(pcfg, pdir)
        # R-4: seed — пока нет отметки «seeded», а не пока нет файла журнала: emit до первого прохода или сбой gh в
        # первом проходе иначе отдали бы все открытые PR будилками. Отметка — только после прохода без сбоя GitHub.
        seeded = bool(ctx.state.get("seeded"))
        ctx.deliver = deliver and seeded
        one_pass(ctx, PRODUCT_POLLS)
        if not seeded and "github" not in ctx.state.get("errors", {}):
            ctx.state["seeded"] = now_iso()
            ctx.save()


def run_products(ctx, deliver):
    """Проходы других продуктов после прохода по умолчанию; сбой загрузки instances/ — событие release в журнале по
    умолчанию (один раз на текст ошибки) и stderr, демон продукта по умолчанию живёт дальше."""
    try:
        other_product_passes(deliver)
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e}"[:200]
        print(f"продукты: {msg}", file=sys.stderr, flush=True)
        ctx.emit(f"err:products:{msg}", "nerve.error", DIGEST, ["release"], f"instances/ не читается: {msg}", "nerve")
    # Пульс — после всех продуктов: долгий проход другого продукта не даёт ложное «НЕРВ МОЛЧИТ» ролям по умолчанию.
    hb = now_iso()
    ctx.state["heartbeat"] = hb
    ctx.save()
    with open(os.path.join(STATE_DIR, "heartbeat"), "w") as f:
        f.write(hb)


def resolve_product(cfg, a):
    """(cfg, папка журнала и курсоров, slug) для tap/emit/status: --product → TAIBE_PRODUCT → продукт по умолчанию.
    Фолбэк без флага и env — одна строка в stderr: ошибка видна, а живые Monitor ролей продукта по умолчанию не
    падают — даже если instances/ сломан."""
    want = getattr(a, "product", None) or os.environ.get("TAIBE_PRODUCT", "")
    try:
        default, cfgs = load_products()
    except Exception as e:  # noqa: BLE001 — сломанный instances/ (в том числе файл неактивного продукта)
        if want:
            raise SystemExit(f"--product {want}: instances/ не читается: {e}") from None
        print(f"instances/ не читается ({type(e).__name__}) — продукт по умолчанию из config.json", file=sys.stderr)
        return cfg, STATE_DIR, ""
    if default is None:
        if want:
            raise SystemExit(f"--product {want}: нет instances/ — продукт один")
        return cfg, STATE_DIR, ""
    if not want:
        # Строка — только когда есть другой включённый продукт: иначе она будила бы Monitor каждой роли (2>&1) зря.
        if any(c.get("active") is True for s, c in cfgs.items() if s != default):
            print(f"продукт не задан (--product, TAIBE_PRODUCT) — продукт по умолчанию {default}", file=sys.stderr)
        want = default
    if want not in cfgs:
        raise SystemExit(f"нет продукта {want}: {', '.join(sorted(cfgs))}")
    if want == default:
        return cfg, STATE_DIR, want
    return cfgs[want], product_state(want, default), want


def cmd_run(cfg, a):
    os.makedirs(STATE_DIR, exist_ok=True)
    lock = open(os.path.join(STATE_DIR, "nerve.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("нерв уже работает (замок state/nerve.lock)", file=sys.stderr)
        return 0
    seed = not os.path.exists(os.path.join(STATE_DIR, "journal.jsonl"))
    while True:
        deliver = wakes_on()
        ctx = Ctx(cfg, STATE_DIR, deliver=not seed and deliver)
        one_pass(ctx, finish=False)
        seed = False
        run_products(ctx, deliver)
        pause = cycle_seconds(cfg, load_json(os.path.join(STATE_DIR, "mode.json"), {}), a.interval)
        save_json(os.path.join(STATE_DIR, "cycle.json"), {"seconds": pause, "at": now_iso(), "awake": awake_seconds()})
        time.sleep(pause)


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


def resolve_roles(cfg, spec, strict=True):
    """Target of emit/tap → role keys. Takes a key («boards»), the role number of the team registry (1 = coord …
    6 = boards, the order of team.roles), «all» and comma lists («backend,release»). A record whose «to» no tap
    matches is lost without a trace: on 04.11 21 assignments went to «6», «4» and «backend,release» and reached
    nobody. strict (emit) refuses an unknown name; tap stays lenient only for named helper taps such as «selftest».
    A number outside 1…N is refused in both modes: emit can never write it, so a tap on it would listen to nobody."""
    roles = list(cfg.get("team", {}).get("roles", []))
    out = []
    for part in (p.strip() for p in spec.split(",")):
        if part.isdigit():
            if not 1 <= int(part) <= len(roles):
                raise ValueError(part)
            part = roles[int(part) - 1]
        if strict and part != ALL and part not in roles:
            raise ValueError(part or spec)
        if part and part not in out:
            out.append(part)
    if not out:
        raise ValueError(spec)
    return out


def cmd_once(cfg, a):
    os.makedirs(STATE_DIR, exist_ok=True)
    ctx = Ctx(cfg, STATE_DIR, deliver=not a.seed and wakes_on())
    one_pass(ctx, finish=False)
    run_products(ctx, not a.seed and wakes_on())
    print(f"проход: событий {ctx.emitted}, ошибки {list(ctx.state.get('errors', {}))}")
    return 0


def fmt(rec, tz):
    t = datetime.fromisoformat(rec["ts"]).astimezone(tz).strftime("%H:%M")
    return f"НЕРВ {t} {rec['kind']}: {rec['text']}"


def cmd_tap(cfg, a):
    cfg, pdir, _slug = resolve_product(cfg, a)
    try:
        roles = resolve_roles(cfg, a.role, strict=False)
    except ValueError:
        roles = []
    if len(roles) != 1:
        print(f"tap слушает одну роль, а не «{a.role}»: {', '.join(cfg['team']['roles'])} или номер 1–"
              f"{len(cfg['team']['roles'])}", file=sys.stderr)
        return 2
    role = roles[0]
    tc = cfg["tap"]
    os.makedirs(pdir, exist_ok=True)                 # tap нового продукта может стартовать раньше его первого прохода
    jpath = os.path.join(pdir, "journal.jsonl")      # журнал и курсор — продукта
    cpath = os.path.join(pdir, f"tap-{role}.json")
    cur = load_json(cpath, None)
    if cur is None:
        cur = {"offset": os.path.getsize(jpath) if os.path.exists(jpath) else 0, "pending": [], "held": [],
               "last_flush": now_iso(), "dead_warned": False}
    tz = local_tz()
    while True:
        recs, cur["offset"] = read_from(jpath, cur["offset"])
        mode = as_obj(load_json(os.path.join(STATE_DIR, "mode.json"), {}))
        now = datetime.now(timezone.utc)
        pause = bool(mode.get("pause"))
        for r in recs:
            if not addressed(r, role):
                continue
            if r["class"] == NERVOUS:
                if pause and r["kind"] not in tc["pass_in_pause"]:
                    cur["held"].append(fmt(r, tz))
                else:
                    print(fmt(r, tz), flush=True)
            else:
                cur["pending"].append(r["text"])
        if not pause and cur["held"]:
            for line in cur["held"]:
                print(line + " (придержано на время лимита)", flush=True)
            cur["held"] = []
        every = timedelta(minutes=tc["digest_minutes"] * (tc["batch_factor"] if mode.get("batch") else 1))
        due = now - datetime.fromisoformat(cur["last_flush"]) >= every
        if cur["pending"] and due and not pause and mode.get("phase", "day") == "day":
            n = len(cur["pending"])
            head = " · ".join(cur["pending"][: tc["digest_max"]])
            more = f" · ещё {n - tc['digest_max']}" if n > tc["digest_max"] else ""
            print(f"НЕРВ {datetime.now(tz):%H:%M} дайджест ({n}): {head}{more}", flush=True)
            cur["pending"] = []
            cur["last_flush"] = now_iso()
        elif not cur["pending"]:
            cur["last_flush"] = now_iso() if due else cur["last_flush"]
        if role in tc["heartbeat_watchers"]:
            hb = read_heartbeat()
            cycle = load_json(os.path.join(STATE_DIR, "cycle.json"), None)
            stale = heartbeat_silent(cfg, mode, cycle, hb, now, awake_seconds())
            if stale and not cur["dead_warned"]:
                print(f"НЕРВ МОЛЧИТ с {hb[11:16] if hb else '—'} UTC: демон не пишет пульс — "
                      f"launchctl kickstart -k gui/{os.getuid()}/space.hrhelper.nerve", flush=True)
            cur["dead_warned"] = stale
        save_json(cpath, cur)
        if a.once:
            return 0
        time.sleep(tc["poll_seconds"])


def read_heartbeat():
    """Пульс — из файла state/heartbeat (25 Б, пишется каждым проходом), а не из state.json (≈1 МБ каждые 15 с);
    нет файла (демон старее) — из state.json, как раньше."""
    try:
        with open(os.path.join(STATE_DIR, "heartbeat"), encoding="utf-8") as f:
            hb = f.read().strip()
        if hb:
            return hb
    except OSError:
        pass
    return as_obj(load_json(os.path.join(STATE_DIR, "state.json"), {})).get("heartbeat")


def cmd_emit(cfg, a):
    cfg, pdir, slug = resolve_product(cfg, a)
    if cfg.get("active") is False:   # журнал невключённого продукта никто не обходит и не читает
        print(f"продукт {slug} не включён (active: false) — ничего не записано", file=sys.stderr)
        return 2
    try:
        to = resolve_roles(cfg, a.role)
    except ValueError as e:
        print(f"неизвестная роль «{e}» — ничего не записано. Роли: {', '.join(cfg['team']['roles'])}, {ALL}, "
              f"номер 1–{len(cfg['team']['roles'])} или список через запятую", file=sys.stderr)
        return 2
    j = Journal(os.path.join(pdir, "journal.jsonl"))
    key = f"manual:{now_iso()}:{','.join(to)}:{abs(hash(a.text)) % 10**8}"
    j.emit(key, a.kind, NERVOUS, to, a.text, "manual")
    print(f"записано: {key} → {', '.join(to)}")
    return 0


def cmd_status(cfg, a):
    _cfg, pdir, slug = resolve_product(cfg, a)
    st = load_json(os.path.join(STATE_DIR, "state.json"), {})
    pst = st if pdir == STATE_DIR else load_json(os.path.join(pdir, "state.json"), {})
    mode = load_json(os.path.join(STATE_DIR, "mode.json"), {})
    b = st.get("budget", {})
    print(f"пульс: {st.get('heartbeat', '—')}")
    print(f"режим: {json.dumps(mode, ensure_ascii=False)}")
    print(f"лимит: {json.dumps(b.get('limit'), ensure_ascii=False)}")
    waves = b.get("waves", [])
    print(f"волн лимита окна: {len(waves)}; последние: " +
          ", ".join(f"{w['hit'][5:16]} ${w['usd']}" for w in waves[-6:]))
    print(f"ошибки источников{' ' + slug if slug else ''}: {json.dumps(pst.get('errors', {}), ensure_ascii=False)}")
    recs, _ = read_from(os.path.join(pdir, "journal.jsonl"), 0)
    live = [r for r in recs if r.get("to")]
    print(f"журнал: записей {len(recs)}, адресных {len(live)}")
    for r in live[-a.last:]:
        print(f"  {r['ts'][5:16]} {r['class'][:3]} {','.join(r['to'])} {r['kind']}: {r['text'][:100]}")
    return 0


def main():
    cfg = load_json(os.path.join(HERE, "config.json"), None)
    if cfg is None:
        print("нет config.json", file=sys.stderr)
        return 2
    p = argparse.ArgumentParser(prog="nerve")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--interval", type=int, default=cfg["interval_seconds"])
    o = sub.add_parser("once")
    o.add_argument("--seed", action="store_true")
    t = sub.add_parser("tap")
    t.add_argument("role")
    t.add_argument("--once", action="store_true")
    e = sub.add_parser("emit")
    e.add_argument("role")
    e.add_argument("text")
    e.add_argument("--kind", default="assign")
    s = sub.add_parser("status")
    s.add_argument("--last", type=int, default=10)
    for q in (t, e, s):
        q.add_argument("--product", help="slug продукта из instances/ (OPS-25)")
    a = p.parse_args()
    return {"run": cmd_run, "once": cmd_once, "tap": cmd_tap, "emit": cmd_emit, "status": cmd_status}[a.cmd](cfg, a)


if __name__ == "__main__":
    sys.exit(main())
