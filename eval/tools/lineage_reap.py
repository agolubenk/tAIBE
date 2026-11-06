"""lineage.py reap — уборка закончившихся сессий Claude Code по списку (карточка 2 relaunch-terminal).

Список строится из ~/.claude/sessions/<pid>.json: только живой pid с тем же стартом (procStart) и argv0 claude.
Кандидат — наследник принял (квитанция <линия>.<4 симв>.ack, наследник жив) ИЛИ сменён: жива сессия той же роли с
линией «<линия>.…», простой ≥ --superseded-idle-hours и статус idle (сессии без квитанции — после --resume и до паритета
tap) ИЛИ простой дольше --idle-hours и это не текущая сессия своей роли (самая длинная линия на ключ роли). Чужой проект (cwd вне корней), «waiting»
и своя сессия показываются, но не снимаются. --kill — действие владельца: только кандидаты из списка последнего
показа (не старше 10 мин, pid и старт совпали) и только после «y» в терминале (или --yes).
Показ списка заодно удаляет из каталога линий записи (*.json, *.ack, *.log) старше --prune-days дней.
"""
import os
import re
import subprocess
import sys
import time

import lineage as L
import lineage_retire as LR

# genome/<роль>.json — продукт по умолчанию, genome/<slug>/<роль>.json — другие продукты (OPS-25).
ROLE_RE = re.compile(r"/genome/(?:([a-z][a-z0-9-]*[a-z0-9])/)?([a-z]+)\.json")


def add_reap_args(p):
    p.add_argument("--idle-hours", type=float, default=24.0)
    p.add_argument("--superseded-idle-hours", type=float, default=1.0,
                   help="сменённая наследником сессия — кандидат после такого простоя")
    p.add_argument("--include-waiting", action="store_true", help="снимать и сессии в состоянии waiting")
    p.add_argument("--root", action="append", default=[], help="ещё один корень своих проектов (можно несколько)")
    p.add_argument("--kill", action="store_true", help="снять кандидатов последнего показа (действие владельца)")
    p.add_argument("--yes", action="store_true", help="без вопроса в терминале — только сам владелец")
    p.add_argument("--prune-days", type=float, default=30.0,
                   help="при показе удалить записи каталога линий старше стольких дней (0 — не удалять)")
    p.add_argument("--auto", action="store_true",
                   help="безопасная автоуборка по правилам lineage_auto.py (решение владельца 06.11); без --apply — сухо")
    p.add_argument("--apply", action="store_true",
                   help="с --auto: действовать — только из launchd владельца (XPC_SERVICE_NAME=space.hrhelper.reaper)")
    p.add_argument("--summary", action="store_true", help="с --auto: читаемая сводка журнала за --since-hours")
    p.add_argument("--since-hours", type=float, default=24.0)
    p.add_argument("--window-minutes", type=float, default=10.0,
                   help="--auto: окно линии закрывается не раньше стольких минут после выхода claude с кодом 0")
    p.add_argument("--ack-minutes", type=float, default=30.0,
                   help="--auto: предшественник снимается, если проверенной квитанции наследника не меньше стольких минут")
    p.add_argument("--auto-idle-hours", type=float, default=8.0,
                   help="--auto: простой, после которого сессия — кандидат (не держатель роли, без незакоммиченного)")
    p.add_argument("--keep-cwd", action="append", default=[],
                   help="--auto: сессии ровно в этой папке не трогать (по умолчанию — папка над основным checkout слоя)")


def prune_lineage_dir(days, now=None):
    """Старые <линия>.json/.ack/.log — по mtime файла (реальные часы ФС, не часы sx). reap-list.json не трогаем."""
    if days <= 0:
        return 0
    cutoff = (now if now is not None else time.time()) - days * 86400
    n = 0
    for f in L.ldir().glob("*"):
        if f.name == "reap-list.json" or f.suffix not in {".json", ".ack", ".log"} or not f.is_file():
            continue
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
                n += 1
        except OSError:
            continue  # файл убрал другой процесс
    return n


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


def successor_gen(rows, r):
    """Поколение самого дальнего живого наследника той же роли (линия начинается с «<линия>.»); 0 — его нет.
    Префикс с точкой: сиблинг r.a1.b2 для r.a1.c3 и r.a10.x для r.a1 наследниками не считаются."""
    if not r["role"] or not r["line"]:
        return 0
    pre = r["line"] + "."
    return max((s["line"].count(".") for s in rows
                if s is not r and s["role"] == r["role"] and (s["line"] or "").startswith(pre)), default=0)


def scan(sx, idle_hours, include_waiting, roots, superseded_idle_hours=1.0):
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
        line = L.session_line(sx, p)
        m = ROLE_RE.search(p.command)
        last = max(d.get("updatedAt") or 0, d.get("statusUpdatedAt") or 0) / 1000.0
        status = d.get("status") or "?"
        rows.append({"pid": p.pid, "start": p.start, "proc": p, "name": d.get("name") or "", "status": status,
                     "cwd": d.get("cwd") or "", "line": line, "role": m.group(2) if m else None, "product": (m.group(1) or "") if m else "",
                     "age_h": max(0.0, now - (d.get("startedAt") or 0) / 1000.0) / 3600,
                     "idle_h": 0.0 if status == "busy" else max(0.0, now - last) / 3600})
    current = {}   # (продукт, роль) → текущая сессия: роль одного продукта не делает чужую «вытесненной»
    for r in rows:
        if r["role"]:
            key = (r["line"].count(".") if r["line"] else -1, -r["age_h"])  # длиннее линия, при равенстве — моложе
            pr = (r["product"], r["role"])
            if pr not in current or key > current[pr][0]:
                current[pr] = (key, r["pid"])
    for r in rows:
        r["ack"] = ack_state(procs, r["line"])
        is_current = r["role"] is not None and current[(r["product"], r["role"])][1] == r["pid"]
        gen = successor_gen(rows, r)
        r["cand"] = False
        if me is not None and r["pid"] == me.pid:
            r["verdict"] = "своя"
        elif not under(r["cwd"], roots):
            r["verdict"] = "чужой проект"
        elif r["status"] == "waiting" and not include_waiting:
            r["verdict"] = "ждёт ввода"
        elif r["ack"] == "ack":
            r["cand"], r["verdict"] = True, "кандидат: наследник принял"
        elif gen and r["status"] == "idle" and r["idle_h"] >= superseded_idle_hours:  # shell/busy — работает
            r["cand"], r["verdict"] = True, f"кандидат: сменён наследником (поколение {gen})"
        elif r["idle_h"] >= idle_hours and not is_current:
            r["cand"], r["verdict"] = True, f"кандидат: простой {r['idle_h']:.0f} ч"
        else:
            r["verdict"] = "текущая роль" if is_current else "живая"
    return procs, rows


def show(rows, out=None):
    out = out or sys.stdout  # не по умолчанию в сигнатуре: sys.stdout подменяют после импорта
    print(f"{'pid':>6}  {'имя':<20} {'статус':<8} {'возраст':>7} {'простой':>7}  {'роль':<8} {'пок.':>4}  "
          f"{'ack':<4}  вердикт · cwd", file=out)
    for r in sorted(rows, key=lambda r: (not r["cand"], -r["idle_h"])):
        gen = str(r["line"].count(".")) if r["line"] else "—"
        print(f"{r['pid']:>6}  {r['name'][:20]:<20} {r['status'][:8]:<8} {r['age_h']:>6.1f}ч {r['idle_h']:>6.1f}ч  "
              f"{(r['role'] or '—'):<8} {gen:>4}  {(r['ack'] or '—'):<4}  {r['verdict']} · {r['cwd']}", file=out)


def cmd_reap(sx, a):
    if a.auto or a.apply or a.summary:
        if a.kill or not a.auto:
            return L.die("--apply и --summary — только вместе с --auto; --kill с --auto не сочетается")
        from lineage_auto import cmd_auto  # noqa: E402 — свой модуль (лимит 500 строк)
        return cmd_auto(sx, a)
    roots = own_roots(a.root)
    procs, rows = scan(sx, a.idle_hours, a.include_waiting, roots, a.superseded_idle_hours)
    show(rows)
    cands = [r for r in rows if r["cand"]]
    listfile = L.ldir() / "reap-list.json"
    if not a.kill:
        L.write_json(listfile, {"at": sx.now(), "roots": roots,
                                "candidates": [{"pid": r["pid"], "start": r["start"], "name": r["name"]} for r in cands]})
        print(f"\nсессий {len(rows)}, кандидатов {len(cands)}; свои проекты: {', '.join(roots) or '—'}")
        pruned = prune_lineage_dir(a.prune_days)
        if pruned:
            print(f"записей линий старше {a.prune_days:g} дн. удалено: {pruned}")
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
        LR.take_down(sx, r["proc"], r["line"], protect, log)
    after = sx.metrics()
    print(f"claude: {before['claude']} → {after['claude']}; окон Terminal: {before['terminal_windows']} → "
          f"{after['terminal_windows']}\nswap до:    {before['swap']}\nswap после: {after['swap']}")
    L.write_json(listfile, {"at": 0, "candidates": []})  # список израсходован: повторный --kill — только после показа
    return 0
