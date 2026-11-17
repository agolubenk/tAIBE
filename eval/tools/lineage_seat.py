"""Контроль новому release после «ВКЛ» (SE-155): у продукта в списках Контроля нет живой записи, а мёртвая — ровно
одна — сторож команды заменяет её на sessionId только что открытого release.

Вписывает только team_plan.py up (решение координатора 17.11, SE-155 Q1 = A): сторож команды и вход под launchd
(space.hrhelper.team-keeper, space.hrhelper.dev-up) или «ВКЛ» в окне Terminal. Агентская сессия Контроль не создаёт.
Любое сомнение — ни одной записи (fail-closed), владельцу остаётся s-пункт, как до SE-155:
- Вызов: в цепочке предков seat нет claude, есть team_plan.py или agents_up.py, а верх цепочки (родитель — launchd) —
  процесс задачи launchd с такой меткой (pid из launchctl print) или приложение терминала над окном, на чьём tty вся
  цепочка ниже. Отцепленный потомок агентской сессии (nohup, `&`) тоже висит под launchd, но это не pid задачи.
- Наследник: единственный claude на tty окна, которое открыл spawn_session.sh (аргумент, не запись линии), той же
  линии, прошёл successor_sid (lineage_guard) и работает в корне продукта (не в worktree).
- Записи: продукт живой — по cwd в реестре сессий того же старта (реестр хук закрывает от агентов); мёртвой — по cwd
  в её транскрипте `~/.claude/projects/*/<sid>.jsonl`. Транскрипт агенты могут править, но он решает только, какую
  мёртвую запись заменить; Контроль получает лишь проверенный наследник. Нет транскрипта — запись чужая.
- Живая запись продукта есть — списки не меняются. Мёртвых записей продукта нет или их несколько — тоже: какую
  заменить, решает владелец. Записи других продуктов не трогаются.
Запись — hand_control (lineage_guard): guard.lock, журнал, пины, копия `.before-handover`, откат. Под блокировкой
перед записью и после неё наследник и отсутствие другой живой записи продукта проверяются заново.
"""
import glob
import json
import os
import re
import subprocess
import sys

from lineage import ancestor_claude, argv0, make_log, norm, projects_dir, read_json, session_line, sessions_dir
from lineage_guard import SID_RE, entry_is, hand_control, successor_sid
from lineage_guard_fs import GUARD, guard_dirs, read_control, take_pins

LABELS = ("space.hrhelper.team-keeper", "space.hrhelper.dev-up")  # = dev_power.LABEL_KEEPER, LABEL_UP
CALLER_RE = re.compile(r"(^|[\s/])(team_plan|agents_up)\.py(\s|$)")
TERMINAL_APPS = ("/Terminal.app/", "/iTerm.app/")  # tmux нет: окно в сервере tmux открывает и агент (tmux new-window)
ENTRY_RE = re.compile(r"[0-9a-f][0-9a-f-]{7,35}")
NO_TTY = ("", "??")


def job_pid(label):
    """pid работающей задачи launchd gui/<uid>/label; None — не работает или launchctl не ответил."""
    try:
        out = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], capture_output=True, text=True,
                             timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"^\tpid = (\d+)$", out, re.M)
    return int(m.group(1)) if m else None


def caller_problem(sx, procs, pid):
    """None — seat вызвал сторож команды (задача launchd) или «ВКЛ» (окно терминала); иначе причина отказа."""
    up = ancestor_claude(procs, pid)
    if up is not None:
        return f"seat запущен из сессии claude ({up.pid}) — агентская сессия Контроль не выдаёт"
    chain, cur = [], procs.get(pid)
    while cur is not None and cur not in chain:
        chain.append(cur)
        if cur.ppid <= 1:
            break
        cur = procs.get(cur.ppid)
    if not chain or chain[-1].ppid > 1:
        return "цепочка предков seat не дочитана до launchd"
    if not any(CALLER_RE.search(p.command) for p in chain):
        return "в цепочке нет team_plan.py или agents_up.py — release вписывает только сторож команды или «ВКЛ»"
    top, jobs = chain[-1], getattr(sx, "job_pid", job_pid)
    if top.pid in {jobs(label) for label in LABELS}:
        return None
    below = chain[:-1]
    if (top.tty in NO_TTY and any(a in top.command for a in TERMINAL_APPS) and below
            and below[0].tty not in NO_TTY and all(p.tty == below[0].tty for p in below)):
        return None
    return f"верх цепочки seat ({top.pid}) — не задача launchd сторожа и не окно терминала (отцепленный процесс?)"


def under(path, root):
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


def product_of(cwd, roots):
    """slug продукта, в чьём корне cwd (самый длинный корень); None — ни в чьём."""
    hits = [(len(os.path.realpath(r)), s) for s, r in roots.items() if cwd and under(cwd, r)]
    return max(hits)[1] if hits else None


def live_sessions(procs):
    """{sessionId: cwd} живых сессий claude: запись реестра того же старта."""
    out = {}
    for f in sorted(sessions_dir().glob("*.json")):
        d = read_json(f)
        if not isinstance(d, dict):
            continue
        p = procs.get(d.get("pid")) if isinstance(d.get("pid"), int) else None
        if p is not None and argv0(p) == "claude" and norm(p.start) == norm(d.get("procStart")) and d.get("sessionId"):
            out[str(d["sessionId"])] = str(d.get("cwd") or "")
    return out


def transcript(entry):
    """(sessionId, cwd) мёртвой записи по её транскрипту; None — нет транскрипта, их несколько или cwd в нём нет."""
    if not ENTRY_RE.fullmatch(entry):
        return None
    found = sorted(glob.glob(os.path.join(glob.escape(str(projects_dir())), "*", entry + "*.jsonl")))
    if len(found) != 1:
        return None
    try:
        with open(found[0], encoding="utf-8", errors="replace") as fh:
            for i, ln in enumerate(fh):
                if i >= 200:
                    break
                try:
                    cwd = json.loads(ln).get("cwd")
                except (ValueError, AttributeError):
                    continue
                if cwd:
                    sid = os.path.basename(found[0])[:-len(".jsonl")]
                    return (sid, str(cwd)) if SID_RE.fullmatch(sid) else None
    except OSError:
        return None
    return None


def entries(dirs):
    """Записи всех списков по порядку без повторов; None — список испорчен или это ссылка (сомнение)."""
    out = []
    for d in dirs:
        got = read_control(d / GUARD)
        if got is None:
            return None
        if isinstance(got, tuple):
            out += [e for e in got[2] if e not in out]
    return out


def classify(ctl, product, roots, live, succ_sid=None):
    """(живые записи продукта кроме наследника, sessionId мёртвых записей продукта)."""
    alive, dead = [], []
    for e in ctl:
        if succ_sid and entry_is(e, succ_sid):
            continue
        hit = [sid for sid in live if entry_is(e, sid)]
        if hit:
            if any(product_of(live[sid], roots) == product for sid in hit):
                alive.append(e)
            continue
        t = transcript(e)
        if t and entry_is(e, t[0]) and product_of(t[1], roots) == product and t[0] not in dead:
            dead.append(t[0])
    return alive, dead


def other_live(dirs, product, roots, procs, succ_sid=None):
    """(живые записи продукта кроме наследника, мёртвые записи продукта); None — список испорчен или это ссылка."""
    ctl = entries(dirs)
    return None if ctl is None else classify(ctl, product, roots, live_sessions(procs), succ_sid)


def dead_entry(dirs, product, roots, procs):
    """(sessionId мёртвой записи продукта, None) или (None, причина не трогать списки)."""
    got = other_live(dirs, product, roots, procs)
    if got is None:
        return None, "список Контроля испорчен или это ссылка — списки не меняю"
    alive, dead = got
    if alive:
        return None, f"у {product} есть живой Контроль ({', '.join(e[:8] for e in alive)}) — списки не меняю"
    if len(dead) != 1:
        what = "нет" if not dead else f"{len(dead)} ({', '.join(s[:8] for s in dead)})"
        return None, f"мёртвых записей {product}: {what} — какую заменить, решает владелец; списки не меняю"
    return dead[0], None


def successor(sx, procs, tty, line, root):
    """(sessionId release этой линии на tty окна в корне продукта, None) или (None, причина)."""
    cands = [p for p in procs.values() if argv0(p) == "claude" and tty and "/dev/" + str(p.tty) == tty]
    if len(cands) != 1:
        return None, f"на tty {tty or '(не передан)'} процессов claude: {len(cands)} — наследника не выбрать"
    s = cands[0]
    if session_line(sx, s) != line:
        return None, f"сессия {s.pid} на tty окна — не линии {line}"
    sid, why = successor_sid(procs, s, tty)
    if not sid:
        return None, why
    d = read_json(sessions_dir() / f"{s.pid}.json") or {}
    if not d.get("cwd") or os.path.realpath(str(d["cwd"])) != os.path.realpath(root):
        return None, f"release {s.pid} не в корне продукта ({d.get('cwd')})"
    return sid, None


def seat(sx, product, line, tty, guard, log, roots):
    """True — вписан или вписывать нечего по правилу; False — отказ. Списки меняет только hand_control."""
    procs = sx.procs()
    why = caller_problem(sx, procs, getattr(sx, "me", None) or os.getpid())
    if why:
        log(f"Контроль: {why}; списки не меняю")
        return False
    root = roots.get(product)
    if not root:
        log(f"Контроль: нет корня продукта {product} в instances/; списки не меняю")
        return False
    pins = take_pins(guard)
    dirs = guard_dirs(guard)
    if not dirs:
        log("Контроль: папки списка не сведены к корню репозитория; списки не меняю")
        return False
    pred, why = dead_entry(dirs, product, roots, procs)
    if not pred:
        log(f"Контроль: {why}")
        return True

    def succ():  # под guard.lock: перед первой записью и после последней
        now = sx.procs()
        sid, why = successor(sx, now, tty, line, root)
        if not sid:
            return None, why
        got = other_live(dirs, product, roots, now, succ_sid=sid)
        if got is None or got[0]:
            return None, f"у {product} появился другой живой Контроль или список не прочесть"
        return sid, None

    return hand_control(guard, pred, succ, line, log, pins=pins)


def add_seat_args(p):
    p.add_argument("--product", required=True, help="slug продукта открытого release (instances/)")
    p.add_argument("--line", required=True, help="линия release, которую открыл spawn_session.sh")
    p.add_argument("--succ-tty", required=True, metavar="TTY", help="tty окна release от spawn_session.sh")
    p.add_argument("--guard", action="append", default=[], metavar="DIR", help="папка со списком Контроля")


def cmd_seat(sx, a):
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    from team_status import product_roots  # noqa: E402 — instances/ читает products.py

    ok = seat(sx, a.product, a.line, a.succ_tty, a.guard, make_log(sys.stdout), dict(product_roots()))
    return 0 if ok else 1
