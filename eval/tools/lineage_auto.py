"""Автоуборка сессий (решение владельца 06.11) и само-закрытие окна — свой модуль lineage.py (лимит 500 строк).

  lineage.py reap --auto [--apply] [--ack-minutes 30] [--auto-idle-hours 8] [--keep-cwd DIR] [--root DIR]
      по умолчанию сухо: список и журнал, ничего не снимает. --apply — только не из сессии claude (launchd владельца
      или его терминал; агенту — нет, как и --kill). Снимает только:
        ack    — предшественника, чей наследник принял: квитанция проверена как у сторожа retire (наследник жив, это
                 claude той же линии, не в дереве предшественника) и ей не меньше --ack-minutes;
        window — окно Terminal линии (запись spawn_session.sh: id окна и tty), когда claude этой линии уже нет:
                 окно с одной вкладкой, тот же tty, в ней только shell; запись старше запуска Terminal не в счёт;
        idle   — сессию с простоем ≥ --auto-idle-hours: статус idle, не держатель роли (как team_status.py live),
                 без незакоммиченного в своей папке (git status --porcelain пуст).
      Никогда: своя сессия и её предки, busy/shell, чужой проект (вне --root), сессия не в Terminal (VS Code и
      прочие — руками), сессия ровно в общем корне проектов (--keep-cwd; по умолчанию папка над основным checkout
      слоя — там постоянный мост). Каждое решение «снять» и каждое действие — строкой JSON в
      <каталог линий>/reap-auto.jsonl (mode dry|apply).
  lineage.py autoclose --tty /dev/ttysNNN --pid PID
      пусковой скрипт spawn_session.sh (PID — он сам) после выхода claude с кодом 0: сторож без терминала ждёт,
      пока скрипт выйдет, и закрывает окно своей линии — одна вкладка, тот же tty, в ней только shell.
      Не зависит от настройки Terminal «When the shell exits»: окно закрывается явно, shell-остатки получают HUP.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

import lineage as L
import lineage_reap as R
import lineage_retire as LR

JOURNAL_MAX = 1 << 20  # байт: больше — журнал уходит в .1 и начинается заново
SHELL_NAMES = '{"login", "zsh", "bash", "sh", "fish", "tcsh", "csh"}'

# Все окна Terminal одним вызовом: id, число вкладок, tty, busy и процессы первой вкладки (через TAB).
# `tab` внутри tell Terminal — класс вкладки, поэтому разделитель — character id 9. Terminal не запущен — пусто.
LIST_SCRIPT = """if application "Terminal" is not running then return ""
tell application "Terminal"
  set out to ""
  set sep to character id 9
  repeat with i from 1 to (count of windows)
    try
      set w to window i
      set t to tab 1 of w
      set ps to ""
      repeat with p in (processes of t)
        set ps to ps & (p as text) & ","
      end repeat
      set out to out & ((id of w) as text) & sep & ((count of tabs of w) as text) & sep & (tty of t) & sep & ¬
        ((busy of t) as text) & sep & ps & linefeed
    end try
  end repeat
  return out
end tell
"""

# Закрыть окно только простаивающей вкладки: id окна (если дан — только оно), одна вкладка, тот же tty, не busy и в
# ней только shell. Иначе «skip …» и окно остаётся.
CLOSE_IDLE_SCRIPT = """on run argv
  set want to item 1 of argv
  set wid to item 2 of argv
  if application "Terminal" is not running then return "not found"
  tell application "Terminal"
    set cands to {}
    if wid is not "" then
      try
        set end of cands to (window id (wid as integer))
      end try
    else
      repeat with i from 1 to (count of windows)
        try
          set end of cands to (window i)
        end try
      end repeat
    end if
    repeat with w in cands
      try
        set n to count of tabs of w
        repeat with j from 1 to n
          set t to tab j of w
          if (tty of t) is want then
            set k to (id of w) as text
            if n > 1 then return "skip " & k & ": tabs " & (n as text)
            if busy of t then return "skip " & k & ": busy"
            repeat with p in (processes of t)
              set nm to p as text
              if nm starts with "-" then set nm to text 2 thru -1 of nm
              if not (""" + SHELL_NAMES + """ contains nm) then return "skip " & k & ": " & nm
            end repeat
            close w saving no
            return "closed " & k
          end if
        end repeat
      end try
    end repeat
  end tell
  return "not found"
end run
"""


def parse_stamp(s):
    try:
        return datetime.strptime(str(s), "%Y-%m-%dT%H:%M:%S%z").timestamp()
    except (TypeError, ValueError):
        return None


def parse_lstart(s):
    """lstart из ps (C_ENV: TZ=UTC, LC_ALL=C) → секунды эпохи."""
    try:
        return datetime.strptime(L.norm(s), "%a %b %d %H:%M:%S %Y").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def terminal_start(procs):
    starts = [parse_lstart(p.start) for p in procs.values() if "/Terminal.app/Contents/MacOS/Terminal" in p.command]
    starts = [s for s in starts if s is not None]
    return min(starts) if starts else None


def keep_dirs(extra):
    """Общий корень проектов (папка над основным checkout слоя: ~/Desktop/Development, там мост) и --keep-cwd."""
    main = R.git_root(os.path.dirname(os.path.realpath(__file__)))
    cands = ([os.path.dirname(main)] if main else []) + list(extra)
    return {os.path.realpath(os.path.expanduser(c)) for c in cands if c}


def verified_ack(sx, procs, r):
    """(линия наследника, минут с квитанции) — если квитанции можно верить, как сторожу retire; иначе None."""
    line = r["line"]
    if not L.valid_line(line or "") or not L.ldir().is_dir():
        return None
    one = re.compile("^" + re.escape(line) + r"\.[a-z0-9]+\.ack$")
    for f in sorted(L.ldir().glob(line + ".*.ack")):
        if not one.match(f.name):
            continue
        a = L.read_json(f) or {}
        s = procs.get(a.get("pid") if isinstance(a.get("pid"), int) else -1)
        child = f.name[:-len(".ack")]
        if LR.successor_problem(sx, procs, r["proc"], s, a, child):
            continue
        at = parse_stamp(a.get("at"))
        if at is None:
            try:
                at = f.stat().st_mtime
            except OSError:
                continue
        return child, max(0.0, sx.now() - at) / 60
    return None


def role_holders(rows):
    """pid держателей ролей — как team_status.py live, отдельно по каждому продукту (основной checkout папки)."""
    import team_status as T  # noqa: E402 — team_status сам импортирует lineage_reap
    by_root = {}
    for r in rows:
        if r["role"]:
            by_root.setdefault(R.git_root(r["cwd"]) or os.path.realpath(r["cwd"] or "/"), []).append(r)
    return {r["pid"] for group in by_root.values() for r in T.live_roles(group).values()}


def decide(sx, procs, r, ctx, a):
    """(действие ack|idle|None, почему). Защиты — до критериев: они сильнее любого критерия."""
    if r["pid"] in ctx["protect"]:
        return None, "своя сессия"
    if os.path.realpath(r["cwd"] or "/nonexistent") in ctx["keep"]:
        return None, "общий корень проектов (мост)"
    if not R.under(r["cwd"], ctx["roots"]):
        return None, "чужой проект"
    if r["status"] not in ("idle", "waiting"):
        return None, f"статус {r['status']}"
    where = L.host(procs, r["proc"])
    if where != "terminal":
        return None, f"не в Terminal ({where}) — только руками"
    ack = verified_ack(sx, procs, r)
    if ack:
        child, age = ack
        if age >= a.ack_minutes:
            return "ack", f"наследник {child} принял {age:.0f} мин назад"
        return None, f"квитанция {child} свежая ({age:.0f} < {a.ack_minutes:g} мин)"
    if r["status"] != "idle":
        return None, "ждёт ввода"
    if r["idle_h"] < a.auto_idle_hours:
        return None, f"простой {r['idle_h']:.1f} < {a.auto_idle_hours:g} ч"
    if r["pid"] in ctx["holders"]:
        return None, "держатель роли"
    if sx.dirty(r["cwd"]):
        return None, "незакоммиченное в папке"
    return "idle", f"простой {r['idle_h']:.0f} ч, не держатель роли, в папке всё закоммичено"


def parse_windows(out):
    wins = {}
    for ln in (out or "").splitlines():
        t = ln.split("\t")
        if len(t) >= 5 and t[0].isdigit():
            wins[t[0]] = {"tabs": int(t[1]) if t[1].isdigit() else 0, "tty": t[2], "busy": t[3] == "true",
                          "procs": [x.lstrip("-") for x in t[4].split(",") if x]}
    return wins


def window_plan(sx, procs, rows):
    """Окна линий, у которых claude уже нет. Записи без id окна или tty не рассматриваются: по одному tty можно
    закрыть чужую новую вкладку, получившую тот же tty."""
    recs = []
    for f in sorted(L.ldir().glob("r*.json")) if L.ldir().is_dir() else []:
        rec = L.read_json(f)
        if isinstance(rec, dict) and rec.get("terminal") == "terminal" and rec.get("line") == f.stem \
                and L.valid_line(f.stem) and str(rec.get("window_id") or "").isdigit() \
                and str(rec.get("tty") or "").startswith("/dev/tty"):
            recs.append(rec)
    tstart = terminal_start(procs)
    if not recs or tstart is None:
        return []  # нет записей или Terminal не запущен — окон нет
    live = {r["line"] for r in rows if r["line"]}
    claude_ttys = {"/dev/" + p.tty for p in procs.values() if L.argv0(p) == "claude"}
    wins = parse_windows(sx.osa(LIST_SCRIPT))
    plan = []
    for rec in recs:
        wid, tty = str(rec["window_id"]), rec["tty"]
        w = wins.get(wid)
        if w is None or rec["line"] in live:
            continue  # окна уже нет или claude линии жив (его решает строка сессии)
        at = parse_stamp(rec.get("at"))
        if tty in claude_ttys:
            why = "на tty живой claude"
        elif at is None or at < tstart:
            why = "запись старше запуска Terminal (id окна мог смениться)"
        elif w["tty"] != tty:
            why = f"в окне другой tty ({w['tty']})"
        elif w["tabs"] != 1:
            why = f"вкладок {w['tabs']}"
        elif w["busy"] or any(x not in L.SHELLS for x in w["procs"]):
            why = "в окне идёт процесс"
        else:
            plan.append({"kind": "window", "line": rec["line"], "wid": wid, "tty": tty,
                         "why": "claude линии нет, в окне только shell"})
            continue
        plan.append({"kind": None, "line": rec["line"], "wid": wid, "tty": tty, "why": why})
    return plan


def journal(entry):
    path = L.ldir() / "reap-auto.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        if path.stat().st_size > JOURNAL_MAX:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"at": L.stamp(), **entry}, ensure_ascii=False) + "\n")


def show(rows, wplan, a, roots, keep, out=None):
    out = out or sys.stdout
    mode = "ДЕЙСТВУЮ (--apply)" if a.apply else "сухо — ничего не снимаю"
    print(f"автоуборка, {mode}: квитанция ≥ {a.ack_minutes:g} мин · простой ≥ {a.auto_idle_hours:g} ч\n"
          f"  свои проекты: {', '.join(roots) or '—'}; не трогаю папки: {', '.join(sorted(keep)) or '—'}", file=out)
    for r in sorted(rows, key=lambda r: (r["auto"] is None, -r["idle_h"])):
        what = ("СНЯТЬ: " if r["auto"] else "оставить: ") + r["auto_why"]
        print(f"{r['pid']:>6}  {r['name'][:20]:<20} {r['status'][:8]:<8} {r['idle_h']:>5.1f}ч  "
              f"{(r['role'] or '—'):<8} {what} · {r['cwd']}", file=out)
    for w in wplan:
        what = ("ЗАКРЫТЬ: " if w["kind"] else "оставить: ") + w["why"]
        print(f"  окно {w['wid']} {w['tty']} линии {w['line']}: {what}", file=out)


def act(sx, rows, wplan, protect, log):
    for r in [r for r in rows if r["auto"]]:
        st = sx.status(r["pid"])
        if st not in (("idle",) if r["auto"] == "idle" else ("idle", "waiting")):
            result = f"пропуск: статус стал {st}"
        else:
            log(f"— {r['pid']} {r['name']} ({r['auto_why']})")
            result = "снята" if LR.take_down(sx, r["proc"], r["line"], protect, log) else "отказ"
        journal({"mode": "apply", "kind": r["auto"], "pid": r["pid"], "name": r["name"], "line": r["line"],
                 "cwd": r["cwd"], "why": r["auto_why"], "result": result})
    for w in [w for w in wplan if w["kind"]]:
        res = sx.osa(CLOSE_IDLE_SCRIPT, w["tty"], w["wid"])
        log(f"окно {w['wid']} {w['tty']}: {res}")
        if res.startswith("closed"):
            LR.hup_tty(sx, w["tty"][len("/dev/"):], log)
        journal({"mode": "apply", "kind": "window", "line": w["line"], "wid": w["wid"], "tty": w["tty"],
                 "why": w["why"], "result": res})


def cmd_auto(sx, a):
    roots, keep = R.own_roots(a.root), keep_dirs(a.keep_cwd)
    procs, rows = R.scan(sx, a.idle_hours, True, roots, a.superseded_idle_hours)
    if a.apply and L.ancestor_claude(procs, os.getpid()) is not None:
        return L.die("--apply — действие launchd владельца или его терминала, не сессии claude; без --apply — список")
    ctx = {"protect": R.ancestors(procs, os.getpid()), "roots": roots, "keep": keep, "holders": role_holders(rows)}
    for r in rows:
        r["auto"], r["auto_why"] = decide(sx, procs, r, ctx, a)
    wplan = window_plan(sx, procs, rows)
    show(rows, wplan, a, roots, keep)
    todo = [r for r in rows if r["auto"]]
    wtodo = [w for w in wplan if w["kind"]]
    summary = {"sessions": len(rows), "ack": sum(r["auto"] == "ack" for r in todo),
               "idle": sum(r["auto"] == "idle" for r in todo), "windows": len(wtodo)}
    if not a.apply:
        for r in todo:
            journal({"mode": "dry", "kind": r["auto"], "pid": r["pid"], "name": r["name"], "line": r["line"],
                     "cwd": r["cwd"], "why": r["auto_why"]})
        for w in wtodo:
            journal({"mode": "dry", "kind": "window", "line": w["line"], "wid": w["wid"], "tty": w["tty"],
                     "why": w["why"]})
        journal({"mode": "dry", "summary": summary})
        print(f"\nсессий {summary['sessions']}; снял бы: {len(todo)} (квитанция {summary['ack']}, простой "
              f"{summary['idle']}), окон закрыл бы: {len(wtodo)}. Действует только launchd владельца "
              f"(reaper_launchd.sh install --apply) или он сам: reap_sessions.sh --auto --apply")
        return 0
    before = sx.metrics()
    act(sx, rows, wplan, ctx["protect"], L.make_log(sys.stdout))
    after = sx.metrics()
    journal({"mode": "apply", "summary": summary, "claude": [before["claude"], after["claude"]],
             "terminal_windows": [before["terminal_windows"], after["terminal_windows"]]})
    pruned = R.prune_lineage_dir(a.prune_days)
    print(f"claude: {before['claude']} → {after['claude']}; окон Terminal: {before['terminal_windows']} → "
          f"{after['terminal_windows']}; записей линий удалено: {pruned}\nswap до:    {before['swap']}\n"
          f"swap после: {after['swap']}")
    return 0


def add_autoclose_args(p):
    p.add_argument("--tty", required=True, help="tty вкладки пускового скрипта (`tty`)")
    p.add_argument("--pid", type=int, default=0, help="pid пускового скрипта: закрывать, когда он вышел")
    p.add_argument("--wait", type=float, default=20.0, help="с: сколько ждать выхода скрипта и прочих процессов")
    p.add_argument("--poll", type=float, default=0.5)
    p.add_argument("--foreground", action="store_true", help="без отцепления (тесты)")


def close_own(sx, a, rec, log):
    """Окно своей вкладки, когда в ней остались только shell: пока жив хоть один наш shell, tty не отдан другой
    вкладке, поэтому без id окна достаточно tty."""
    short = a.tty[len("/dev/"):]
    deadline = sx.now() + a.wait
    while a.pid and sx.pid_alive(a.pid):  # дешёвая проверка без ps -A, пока пусковой скрипт не вышел
        if sx.now() >= deadline:
            log(f"пусковой скрипт {a.pid} не вышел за {a.wait:g} с — окно не закрываю")
            return 3
        sx.sleep(a.poll)
    while True:
        busy = [f"{q.pid} {L.argv0(q)}" for q in sx.procs().values()
                if q.tty == short and L.argv0(q).lstrip("-") not in L.SHELLS]
        if not busy:
            break
        if sx.now() >= deadline:
            log(f"на {a.tty} идут процессы ({', '.join(busy)}) — окно не закрываю")
            return 3
        sx.sleep(max(a.poll, 1.0))
    wid = str(rec.get("window_id") or "")
    res = sx.osa(CLOSE_IDLE_SCRIPT, a.tty, wid if wid.isdigit() else "")
    log(f"окно {a.tty}: {res}")
    if not res.startswith("closed"):
        return 3
    LR.hup_tty(sx, short, log)
    return 0


def cmd_autoclose(sx, a):
    line = os.environ.get("TAIBE_LINEAGE", "")
    if not L.valid_line(line) or not re.fullmatch(r"/dev/ttys?[0-9]+", a.tty or ""):
        return L.die("autoclose: нужны линия (TAIBE_LINEAGE) и --tty /dev/ttysNNN")
    rec = L.read_json(L.ldir() / f"{line}.json")
    if not isinstance(rec, dict) or rec.get("terminal") != "terminal" or (rec.get("tty") and rec["tty"] != a.tty):
        print("autoclose: окно не из записи spawn_session.sh (Terminal, тот же tty) — не закрываю")
        return 0
    if a.foreground:
        return close_own(sx, a, rec, L.make_log(sys.stdout))
    if not LR.detach(L.ldir() / f"{line}.autoclose.log"):
        return 0
    rc = 3
    try:
        rc = close_own(sx, a, rec, L.make_log(sys.stdout))
    except Exception as e:  # сторож без терминала: причина — только в журнале
        print(f"{L.stamp()} сбой autoclose: {e!r}", flush=True)
    os._exit(rc)
