"""lineage.py reap — уборка закончившихся сессий Claude Code по списку (карточка 2 relaunch-terminal).

Список строится из ~/.claude/sessions/<pid>.json: только живой pid с тем же стартом (procStart) и argv0 claude.
Кандидат — наследник принял (квитанция <линия>.<4 симв>.ack, наследник жив) ИЛИ простой дольше --idle-hours и
это не текущая сессия своей роли (самая длинная линия на ключ роли). Чужой проект (cwd вне корней), «waiting»
и своя сессия показываются, но не снимаются. --kill — действие владельца: только кандидаты из списка последнего
показа (не старше 10 мин, pid и старт совпали) и только после «y» в терминале (или --yes).
"""
import os
import re
import subprocess
import sys

import lineage as L

ROLE_RE = re.compile(r"/genome/([a-z]+)\.json")
LINE_ARG_RE = re.compile(r"Линия: (r(?:\.[a-z0-9]+)+)")


def add_reap_args(p):
    p.add_argument("--idle-hours", type=float, default=24.0)
    p.add_argument("--include-waiting", action="store_true", help="снимать и сессии в состоянии waiting")
    p.add_argument("--root", action="append", default=[], help="ещё один корень своих проектов (можно несколько)")
    p.add_argument("--kill", action="store_true", help="снять кандидатов последнего показа (действие владельца)")
    p.add_argument("--yes", action="store_true", help="без вопроса в терминале — только сам владелец")


def git_root(path):
    try:
        r = subprocess.run(["git", "-C", str(path), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return os.path.realpath(os.path.dirname(r.stdout.strip())) if r.returncode == 0 and r.stdout.strip() else None


def own_roots(extra):
    """Свои проекты: основной checkout репо скрипта, репо текущей папки, TAIBE_HOST_ROOT и --root."""
    cands = [git_root(os.path.dirname(os.path.realpath(__file__))), git_root(os.getcwd()),
             os.environ.get("TAIBE_HOST_ROOT"), *extra]
    return sorted({os.path.realpath(c) for c in cands if c})


def under(path, roots):
    rp = os.path.realpath(path or "/nonexistent")
    return any(rp == r or rp.startswith(r.rstrip(os.sep) + os.sep) for r in roots)


def ancestors(procs, pid):
    out, seen = set(), set()
    while pid in procs and pid not in seen and pid > 1:
        seen.add(pid)
        out.add(pid)
        pid = procs[pid].ppid
    return out


def ack_state(procs, line):
    """«ack» — наследник этой линии принял и жив; «ack†» — квитанция есть, наследника уже нет; "" — нет."""
    if not L.valid_line(line or ""):
        return ""
    one = re.compile("^" + re.escape(line) + r"\.[a-z0-9]+\.ack$")
    state = ""
    for f in sorted(L.ldir().glob(line + ".*.ack")) if L.ldir().is_dir() else []:
        if not one.match(f.name):
            continue
        a = L.read_json(f) or {}
        s = procs.get(a.get("pid") if isinstance(a.get("pid"), int) else -1)
        if s is not None and L.argv0(s) == "claude" and L.norm(s.start) == L.norm(a.get("start")):
            return "ack"
        state = "ack†"
    return state


def scan(sx, idle_hours, include_waiting, roots):
    procs = sx.procs()
    me = L.ancestor_claude(procs, os.getpid())
    now = sx.now()
    rows = []
    for f in sorted(L.sessions_dir().glob("*.json")):
        d = L.read_json(f)
        if not isinstance(d, dict) or not isinstance(d.get("pid"), int):
            continue  # рядом лежат *.key и битые файлы
        p = procs.get(d["pid"])
        if p is None or L.argv0(p) != "claude" or L.norm(p.start) != L.norm(d.get("procStart")):
            continue  # файл от завершённой сессии или pid уже у другого процесса
        line = sx.env_line(p.pid)
        if not L.valid_line(line or ""):
            m = LINE_ARG_RE.search(p.command)
            line = m.group(1) if m else None
        m = ROLE_RE.search(p.command)
        last = max(d.get("updatedAt") or 0, d.get("statusUpdatedAt") or 0) / 1000.0
        status = d.get("status") or "?"
        rows.append({"pid": p.pid, "start": p.start, "proc": p, "name": d.get("name") or "", "status": status,
                     "cwd": d.get("cwd") or "", "line": line, "role": m.group(1) if m else None,
                     "age_h": max(0.0, now - (d.get("startedAt") or 0) / 1000.0) / 3600,
                     "idle_h": 0.0 if status == "busy" else max(0.0, now - last) / 3600})
    current = {}
    for r in rows:
        if r["role"]:
            key = (r["line"].count(".") if r["line"] else -1, -r["age_h"])  # длиннее линия, при равенстве — моложе
            if r["role"] not in current or key > current[r["role"]][0]:
                current[r["role"]] = (key, r["pid"])
    for r in rows:
        r["ack"] = ack_state(procs, r["line"])
        is_current = r["role"] is not None and current[r["role"]][1] == r["pid"]
        r["cand"] = False
        if me is not None and r["pid"] == me.pid:
            r["verdict"] = "своя"
        elif not under(r["cwd"], roots):
            r["verdict"] = "чужой проект"
        elif r["status"] == "waiting" and not include_waiting:
            r["verdict"] = "ждёт ввода"
        elif r["ack"] == "ack":
            r["cand"], r["verdict"] = True, "кандидат: наследник принял"
        elif r["idle_h"] >= idle_hours and not is_current:
            r["cand"], r["verdict"] = True, f"кандидат: простой {r['idle_h']:.0f} ч"
        else:
            r["verdict"] = "текущая роль" if is_current else "живая"
    return procs, rows


def show(rows, out=sys.stdout):
    print(f"{'pid':>6}  {'имя':<20} {'статус':<8} {'возраст':>7} {'простой':>7}  {'роль':<8} {'пок.':>4}  "
          f"{'ack':<4}  вердикт · cwd", file=out)
    for r in sorted(rows, key=lambda r: (not r["cand"], -r["idle_h"])):
        gen = str(r["line"].count(".")) if r["line"] else "—"
        print(f"{r['pid']:>6}  {r['name'][:20]:<20} {r['status'][:8]:<8} {r['age_h']:>6.1f}ч {r['idle_h']:>6.1f}ч  "
              f"{(r['role'] or '—'):<8} {gen:>4}  {(r['ack'] or '—'):<4}  {r['verdict']} · {r['cwd']}", file=out)


def cmd_reap(sx, a):
    roots = own_roots(a.root)
    procs, rows = scan(sx, a.idle_hours, a.include_waiting, roots)
    show(rows)
    cands = [r for r in rows if r["cand"]]
    listfile = L.ldir() / "reap-list.json"
    if not a.kill:
        L.write_json(listfile, {"at": sx.now(), "roots": roots,
                                "candidates": [{"pid": r["pid"], "start": r["start"], "name": r["name"]} for r in cands]})
        print(f"\nсессий {len(rows)}, кандидатов {len(cands)}; свои проекты: {', '.join(roots) or '—'}")
        if cands:
            print("снять (владелец, в течение 10 мин): bash eval/tools/reap_sessions.sh --kill")
        return 0
    shown = L.read_json(listfile)
    if not isinstance(shown, dict) or sx.now() - float(shown.get("at") or 0) > L.LIST_TTL:
        return L.die("сначала список без --kill, затем --kill не позже чем через 10 мин")
    keys = {(c.get("pid"), L.norm(c.get("start"))) for c in shown.get("candidates") or []}
    chosen = [r for r in cands if (r["pid"], L.norm(r["start"])) in keys]
    print(f"\nиз показанного списка ({len(keys)}) всё ещё кандидаты: {len(chosen)}")
    if not chosen:
        return 0
    if not a.yes:
        if not sys.stdin.isatty():
            return L.die("нужно подтверждение владельца: запусти в своём терминале (или --yes)")
        ans = input(f"Снять {len(chosen)} сессий — процессы и окна? [y/N] ")
        if ans.strip().lower() not in {"y", "yes", "д", "да"}:
            print("отменено")
            return 1
    before = sx.metrics()
    protect = ancestors(procs, os.getpid())
    log = L.make_log(sys.stdout)
    for r in chosen:
        log(f"— {r['pid']} {r['name']} ({r['verdict']})")
        L.take_down(sx, r["proc"], r["line"], protect, log)
    after = sx.metrics()
    print(f"claude: {before['claude']} → {after['claude']}; окон Terminal: {before['terminal_windows']} → "
          f"{after['terminal_windows']}\nswap до:    {before['swap']}\nswap после: {after['swap']}")
    L.write_json(listfile, {"at": 0, "candidates": []})  # список израсходован: повторный --kill — только после показа
    return 0
