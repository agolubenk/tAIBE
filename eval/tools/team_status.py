#!/usr/bin/env python3
"""team_status.py — кто из ролей Т3 продукта жив и жив ли Нерв (OPS-24). Через него spawn_session.sh --launch
не дублирует живые роли и поднимает нерв.

  python3 -I eval/tools/team_status.py live --role KEY [--cwd DIR]     живая роль → «pid имя статус …», rc 0; нет — rc 3
                                                                       (другой rc — проверка сломалась, роль не открывать)
  python3 -I eval/tools/team_status.py wait --role KEY --line LINE [--timeout 90]   сессия этой линии поднялась → rc 0
  python3 -I eval/tools/team_status.py status [--cwd DIR]              роли по порядку 1→5→4→3→2→6 и пульс нерва
  python3 -I eval/tools/team_status.py stop [--cwd DIR]                команды kill живых ролей для владельца; сам не снимает
  python3 -I eval/tools/team_status.py nerve [--fix]                   пульс; --fix: не загружен → bootstrap, молчит → kickstart

Продукт — основной checkout папки --cwd вместе с его worktree. Живая роль — самая молодая живая сессия Claude Code
с геномом роли (`/genome/<ключ>.json` в аргументах), папкой внутри продукта и без наследника (ни квитанции, ни живой
сессии той же роли с линией «<линия>.…»). Самая длинная линия не подходит: новая корневая линия после перезапуска
команды короче старых.
"""
import argparse
import os
import plistlib
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import lineage as L  # noqa: E402
import lineage_reap as R  # noqa: E402

ORDER = ("coord", "release", "backend", "frontend", "plan", "boards")
NUM = {"coord": 1, "plan": 2, "frontend": 3, "backend": 4, "release": 5, "boards": 6}
LABEL = "space.hrhelper.nerve"  # до OPS-25 — один Нерв на Mac для всех продуктов
# «Роли нет» — свой код: 1 Python отдаёт и на трейсбек (сбой импорта, исключение), и по нему открылась бы вторая
# сессия живой роли.
RC_MISSING = 3
WAIT_POLL = 2.0


class Sys(L.Sys):
    def launchctl(self, *args):
        try:
            r = subprocess.run(["launchctl", *args], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as exc:
            return 127, f"launchctl недоступен: {exc}"
        return r.returncode, (r.stdout + r.stderr).strip()


def product_root(cwd):
    return R.git_root(cwd) or os.path.realpath(cwd)


def role_rows(sx, root):
    """Сессии ролей внутри продукта (scan из lineage_reap: живой pid того же старта, argv0 claude). Корень — realpath:
    under() сравнивает с realpath папки сессии (/var и /private/var на macOS)."""
    root = os.path.realpath(root)
    _, rows = R.scan(sx, idle_hours=24.0, include_waiting=True, roots=[root])
    return [r for r in rows if r["role"] in NUM and R.under(r["cwd"], [root])]


def live_roles(rows):
    """Роль → её живая сессия; сменённые наследником (квитанция или живой потомок той же роли) не в счёт."""
    best = {}
    for r in rows:
        if r["ack"] or R.successor_gen(rows, r):
            continue
        if r["role"] not in best or r["age_h"] < best[r["role"]]["age_h"]:
            best[r["role"]] = r
    return best


def describe(r):
    gen = str(r["line"].count(".")) if r["line"] else "—"
    return (f"pid {r['pid']} {r['name'] or '—'} {r['status']} · поколение {gen} · простой {r['idle_h']:.1f} ч"
            f" · линия …{'.'.join((r['line'] or '').split('.')[-2:]) or '—'}")


def find_line(sx, role, line, since):
    """Сессия роли с линией line, чей файл sessions/<pid>.json появился после since (с). Полный ps — только
    когда такой файл есть: ожидание не жжёт CPU на каждом опросе."""
    fresh = []
    for f in L.sessions_dir().glob("*.json") if L.sessions_dir().is_dir() else []:
        d = L.read_json(f)
        if isinstance(d, dict) and isinstance(d.get("pid"), int) and (d.get("startedAt") or 0) / 1000.0 >= since:
            fresh.append(d)
    if not fresh:
        return None
    procs = sx.procs()
    for d in fresh:
        p = procs.get(d["pid"])
        if p is None or L.argv0(p) != "claude" or L.norm(p.start) != L.norm(d.get("procStart")):
            continue
        m = R.ROLE_RE.search(p.command)
        if m and m.group(1) == role and L.session_line(sx, p) == line:
            return {"pid": p.pid, "name": d.get("name") or "", "status": d.get("status") or "?"}
    return None


# ── Нерв ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def plist_path():
    return Path(os.environ.get("NERVE_PLIST") or Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist")


def nerve_home(plist):
    """Папка нерва — из установленного plist (то, что запускает launchd), иначе основной checkout слоя."""
    try:
        with open(plist, "rb") as f:
            args = plistlib.load(f).get("ProgramArguments") or []
        for a in args:
            if isinstance(a, str) and a.endswith("nerve.py"):
                return Path(a).parent
    except (OSError, ValueError, plistlib.InvalidFileException, AttributeError):
        pass
    main = R.git_root(os.path.dirname(os.path.realpath(__file__)))
    return Path(main or Path(__file__).resolve().parents[2]) / "eval" / "nerve"


def _silent(home, hb, now_dt):
    """Молчит ли демон — правилом самого tap (оба часа, сон Mac); без кода нерва — max(2 цикла, heartbeat_stale_min)."""
    cfg = L.read_json(home / "config.json") or {}
    mode = L.read_json(home / "state" / "mode.json") or {}
    cycle = L.read_json(home / "state" / "cycle.json")
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "nerve"))
        import nerve as N
        return bool(N.heartbeat_silent(cfg, mode, cycle, hb, now_dt, N.awake_seconds()))
    except Exception:  # noqa: BLE001 — статус не падает из-за кода нерва
        pass
    try:
        stale_min = (cfg.get("tap") or {}).get("heartbeat_stale_min", 5)
        sec = (cycle or {}).get("seconds") or 300
        return now_dt - datetime.fromisoformat(hb) > max(timedelta(minutes=stale_min), timedelta(seconds=2 * sec))
    except (TypeError, ValueError, AttributeError):
        return True


def nerve_state(sx):
    plist = plist_path()
    home = nerve_home(plist)
    rc, out = sx.launchctl("print", f"gui/{os.getuid()}/{LABEL}")
    st = {"plist": plist, "installed": plist.is_file(), "home": home, "loaded": rc == 0, "pid": None,
          "running": False, "hb": None, "silent": True, "err": "" if rc in (0, 113) else out[-300:]}
    for ln in out.splitlines() if rc == 0 else []:
        if not ln.startswith("\t") or ln.startswith("\t\t"):
            continue  # только верхний уровень службы: во вложенных блоках свои «state = active»
        k, _, v = ln.strip().partition(" = ")
        if k == "state":
            st["running"] = v == "running"
        elif k == "pid" and v.isdigit():
            st["pid"] = int(v)
    st["hb"] = (L.read_json(home / "state" / "state.json") or {}).get("heartbeat")
    st["silent"] = _silent(home, st["hb"], datetime.fromtimestamp(sx.now(), timezone.utc))
    return st


def nerve_line(st):
    if not st["installed"]:
        return f"нерв: не установлен (нет {st['plist']}) — установка: eval/nerve/README.md"
    if not st["loaded"]:
        return "нерв: не загружен в launchd" + (f" ({st['err']})" if st["err"] else "")
    run = f"работает, pid {st['pid']}" if st["running"] else "загружен, процесса нет"
    hb = "—"
    if st["hb"]:
        try:
            hb = datetime.fromisoformat(st["hb"]).astimezone().strftime("%H:%M")
        except (TypeError, ValueError):
            hb = str(st["hb"])[:16]
    return f"нерв: {run} · пульс {hb} · {'МОЛЧИТ' if st['silent'] else 'ок'} · {st['home']}"


def nerve_fix(sx, st, log):
    """Не загружен → bootstrap; загружен, но молчит → kickstart -k. Не установлен — только подсказка: шаблон plist
    в репо может указывать на старый дом, ставит его владелец по README нерва."""
    dom = f"gui/{os.getuid()}"
    if not st["installed"]:
        return 1
    if not st["loaded"]:
        rc, out = sx.launchctl("bootstrap", dom, str(st["plist"]))
        log(f"нерв: bootstrap → {'загружен' if rc == 0 else 'ошибка: ' + out[-300:]}")
        return 0 if rc == 0 else 1
    if st["silent"]:
        rc, out = sx.launchctl("kickstart", "-k", f"{dom}/{LABEL}")
        log(f"нерв: пульс молчал — kickstart -k → {'перезапущен' if rc == 0 else 'ошибка: ' + out[-300:]}")
        return 0 if rc == 0 else 1
    return 0


# ── команды ──────────────────────────────────────────────────────────────────────────────────────────────────────
def cmd_live(sx, a):
    r = live_roles(role_rows(sx, product_root(a.cwd))).get(a.role)
    if r is None:
        return RC_MISSING
    print(describe(r))
    return 0


def cmd_wait(sx, a):
    since = sx.now() - 5  # часы sessions/*.json и запуска: небольшой запас
    deadline = sx.now() + a.timeout
    while True:
        hit = find_line(sx, a.role, a.line, since)
        if hit:
            print(f"pid {hit['pid']} {hit['name'] or '—'} {hit['status']}")
            return 0
        if sx.now() >= deadline:
            print(f"не поднялась за {a.timeout:.0f} с")
            return 1
        sx.sleep(WAIT_POLL)


def cmd_status(sx, a):
    root = product_root(a.cwd)
    rows = role_rows(sx, root)
    live = live_roles(rows)
    print(f"продукт: {root}")
    for role in ORDER:
        r = live.get(role)
        old = sum(1 for x in rows if x["role"] == role and x is not r)
        tail = f" · ещё {old} старых (reap_sessions.sh)" if old else ""
        print(f"{NUM[role]} {role:<9} {describe(r) if r else 'нет'}{tail}")
    print(nerve_line(nerve_state(sx)))
    return 0


def cmd_stop(sx, a):
    live = live_roles(role_rows(sx, product_root(a.cwd)))
    if not live:
        print("живых ролей нет")
        return 0
    print("# Остановка — действие владельца в его терминале; скрипт сам ничего не снимает.")
    for role in ORDER:
        if role in live:
            r = live[role]
            print(f"kill {r['pid']}   # {NUM[role]} {role} {r['name'] or '—'}")
    print(f"# нерв (общий на Mac до OPS-25): launchctl bootout gui/{os.getuid()}/{LABEL}")
    return 0


def cmd_nerve(sx, a):
    st = nerve_state(sx)
    print(nerve_line(st))
    if not a.fix:
        return 0 if st["loaded"] and not st["silent"] else 1
    rc = nerve_fix(sx, st, print)
    return rc if rc else (0 if st["installed"] else 1)


def main(argv=None, sx=None):
    ap = argparse.ArgumentParser(prog="team_status.py", description=__doc__.split("\n", 1)[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("live", "status", "stop"):
        p = sub.add_parser(name)
        p.add_argument("--cwd", default=os.getcwd())
        if name == "live":
            p.add_argument("--role", required=True, choices=ORDER)
    w = sub.add_parser("wait")
    w.add_argument("--role", required=True, choices=ORDER)
    w.add_argument("--line", required=True)
    w.add_argument("--timeout", type=float, default=90.0)
    n = sub.add_parser("nerve")
    n.add_argument("--fix", action="store_true")
    a = ap.parse_args(argv)
    sx = sx or Sys()
    try:
        return {"live": cmd_live, "wait": cmd_wait, "status": cmd_status, "stop": cmd_stop,
                "nerve": cmd_nerve}[a.cmd](sx, a)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"team_status: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
