"""Сторож retire для lineage.py (свой модуль — лимит 500 строк): ждёт квитанцию наследника, проверяет его и снимает
предшественника — процессы, окно Terminal, shell-остатки на tty."""
import os
import re
import signal
import sys

from lineage import (IDLE_WAIT, SHELLS, TAP_WAIT, TERM_WAIT, ancestor_claude, argv0, descendants, die, doomed,
                     group_of, host, lfile, make_log, norm, read_json, same, session_line, stamp,
                     valid_line)
from lineage_guard import hand_control, session_id, successor_sid, take_pins


# Окно Terminal: сначала по id из record (если в нём вкладка с этим tty), иначе перебором по tty. Окно с несколькими
# вкладками не закрывается (там чужие сессии). try на каждом окне: окно без вкладок даёт −1728 на `tabs of w`.
CLOSE_SCRIPT = """on run argv
  set want to item 1 of argv
  set wid to item 2 of argv
  tell application "Terminal"
    set cands to {}
    if wid is not "" then
      try
        set end of cands to (window id (wid as integer))
      end try
    end if
    repeat with i from 1 to (count of windows)
      try
        set end of cands to (window i)
      end try
    end repeat
    repeat with w in cands
      try
        set n to count of tabs of w
        repeat with j from 1 to n
          if (tty of tab j of w) is want then
            set k to (id of w) as text
            if n > 1 then return "skip " & k & ": tabs " & (n as text)
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


def terminate(sx, p, protect, log):
    """TERM группе и потомкам → TERM_WAIT с → KILL выживших (сверка старта: pid мог уйти другому процессу)."""
    procs = sx.procs()
    if not same(procs, p):
        log(f"pid {p.pid} уже завершён")
        return True
    pids = doomed(procs, p)
    if pids & protect:
        log(f"отказ: в снимаемом дереве {p.pid} есть защищённые pid {sorted(pids & protect)}")
        return False
    snap = {pid: procs[pid].start for pid in pids}
    group = group_of(procs, p)
    leader = group is not None
    if leader:
        sx.killpg(group, signal.SIGTERM)
    for pid in sorted(pids):
        if not (leader and procs[pid].pgid == group):
            sx.kill(pid, signal.SIGTERM)
    deadline = sx.now() + TERM_WAIT
    while True:
        cur = sx.procs()
        alive = [pid for pid, st in snap.items() if pid in cur and cur[pid].start == st]
        if not alive or sx.now() >= deadline:
            break
        sx.sleep(1)
    for pid in alive:
        sx.kill(pid, signal.SIGKILL)
    log(f"TERM {len(snap)} процессам (группа {'да' if leader else 'нет'}), KILL {len(alive)}")
    return True


def close_window(sx, procs, p, rec, log):
    """Окно Terminal сессии p. procs — снимок до снятия (после него цепочку предков уже не пройти)."""
    kind = (rec or {}).get("terminal") or ""
    where = host(procs, p)
    if where != "terminal" or kind in ("iterm", "print"):
        log(f"окно не трогаю: хост {where}{', запись ' + kind if kind else ''}")
        return False
    if p.tty in ("", "??", "-"):
        log("окно не трогаю: у сессии нет tty")
        return False
    tty = "/dev/" + p.tty
    wid = str((rec or {}).get("window_id") or "")
    if rec and rec.get("tty") and rec["tty"] != tty:
        wid = ""  # запись о другом окне — ищем только по tty
    out = sx.osa(CLOSE_SCRIPT, tty, wid)
    log(f"окно {tty}: {out}")
    return out.startswith("closed")


def hup_tty(sx, tty, log):
    """`close w saving no` закрывает окно, но login и -zsh на его tty живут дальше — HUP только им."""
    left = [q for q in sx.procs().values() if q.tty == tty]
    shells = [q for q in left if argv0(q).lstrip("-") in SHELLS]
    for q in shells:
        sx.kill(q.pid, signal.SIGHUP)
    other = [f"{q.pid} {argv0(q)}" for q in left if q not in shells]
    log(f"HUP {len(shells)} shell на {tty}" + (f"; не тронуты: {', '.join(other)}" if other else ""))


def take_down(sx, p, line, protect, log):
    """Снять сессию p целиком: процессы, затем окно, затем остатки на tty."""
    procs = sx.procs()
    if not same(procs, p):
        log(f"pid {p.pid} уже завершён")
        return True
    if not terminate(sx, p, protect, log):
        return False
    rec = read_json(lfile(line, ".json")) if valid_line(line or "") else None
    if close_window(sx, procs, p, rec, log):
        hup_tty(sx, p.tty, log)
    return True


# Флаги — в любом месте (`tap --product taibe boards`, `tap --product=taibe --once boards`, `tap boards --product
# taibe`, OPS-25).
TAP = "nerve\\.py\\s+tap\\s+(?:--once\\s+|--product(?:=|\\s+)\\S+\\s+)*{}(\\s|$)"
# Продукт сессии по её геному: genome/<роль>.json — продукт по умолчанию (''), genome/<slug>/<роль>.json — slug.
GENOME_PRODUCT = re.compile(r"/genome/(?:([a-z][a-z0-9-]*[a-z0-9])/)?[a-z]+\.json")


def genome_product(proc):
    m = GENOME_PRODUCT.search(proc.command) if proc is not None else None
    return (m.group(1) or "") if m else None
TAP_PRODUCT = re.compile(r"--product[ =](\S+)")


def tap_products(procs, s, tap):
    """Продукты, которые слушают tap роли под s: '' — без флага (продукт из env генома или по умолчанию)."""
    out = set()
    for q in descendants(procs, s.pid):
        if q in procs and tap.search(procs[q].command):
            m = TAP_PRODUCT.search(procs[q].command)
            out.add(m.group(1) if m else "")
    return out


def tapped(procs, s, tap, want=None):
    """Есть tap роли; с want — того же продукта. '' (без флага) совместим с любым: флаг виден в argv, env — нет."""
    got = tap_products(procs, s, tap)
    if not got:
        return False
    if not want or "" in want or "" in got:
        return True
    return bool(got & want)


def successor_problem(sx, procs, p, s, a, child):
    """Почему квитанции нельзя верить (None — можно): наследник жив, это claude с той же линией, не сам p и не его
    потомок (иначе снятие p убило бы и наследника)."""
    if s is None:
        return f"наследник {a.get('pid')} не жив"
    if norm(s.start) != norm(a.get("start")):
        return f"pid {s.pid} — другой процесс (старт {s.start} ≠ {a.get('start')})"
    if argv0(s) != "claude":
        return f"pid {s.pid} — не claude ({argv0(s)})"
    if s.pid == p.pid:
        return "квитанцию записал сам предшественник"
    line = sx.env_line(s.pid)
    if line != child:
        return f"у pid {s.pid} другая линия ({line or 'нет'})"
    if same(procs, p) and s.pid in doomed(procs, p):
        return f"наследник {s.pid} — в дереве предшественника"
    return None


def watch(sx, p, parent, child, role, timeout, log, poll=5.0, ctl=None):
    """Сторож предшественника p. Код возврата: 0 — снят или уже ушёл сам, 3 — проверка не прошла, p не тронут.
    ctl — {"dirs": папки списка Контроля, "sid": sessionId p}: если p — Контроль, он переходит проверенному наследнику
    до снятия p; не перешёл — p не снимается (lineage_guard)."""
    def handover(s):
        if not ctl:
            return True

        def succ():
            # Свежая сверка наследника под guard.lock, прямо перед записью списка: за ожидание квитанции и блокировки
            # он мог упасть (и в ветках «ушёл сам»).
            procs = sx.procs()
            why = successor_problem(sx, procs, p, procs.get(s.pid), a, child)
            return (None, why) if why else successor_sid(procs, procs.get(s.pid), ctl.get("tty"))

        return hand_control(ctl["dirs"], ctl.get("sid"), succ, child.rsplit(".", 1)[-1], log, pins=ctl.get("pins"))

    ack = lfile(child, ".ack")
    deadline = sx.now() + timeout
    # Паритет: tap требуем от наследника, только если он был у предшественника (ночью мониторов нет — TEAM-0 §10.6).
    tap = re.compile(TAP.format(re.escape(role))) if role else None
    want = tap_products(sx.procs(), p, tap) if tap else set()
    if tap and not want:
        log(f"у предшественника {p.pid} нет nerve.py tap {role} — от наследника tap не требую")
        tap = None
    log(f"жду квитанцию {ack} до {timeout:.0f} с; предшественник {p.pid}, линия {parent or '—'}")
    while not ack.exists():
        if sx.now() >= deadline:
            log("квитанции нет — предшественника не трогаю")
            return 3
        if not sx.alive(p):
            log("предшественник уже завершился сам")
            return 0
        sx.sleep(poll)
    a = read_json(ack) or {}
    procs = sx.procs()
    s = procs.get(a.get("pid") if isinstance(a.get("pid"), int) else -1)
    why = successor_problem(sx, procs, p, s, a, child)
    gp, gs = genome_product(p), genome_product(s)
    if not why and gp is not None and gs is not None and gp != gs:
        why = f"наследник с геномом другого продукта ({gs or 'по умолчанию'} против {gp or 'по умолчанию'})"
    if why:
        log("проверка не прошла: " + why + " — предшественника не трогаю")
        return 3
    def gone():
        log("предшественник уже завершился сам")
        if handover(s):
            return 0
        log("Контроль наследнику не передан, а предшественник ушёл — его sessionId остался в списке; нужен s-пункт "
            "владельцу (s-set-control)")  # GLM #120 7fb2287d2, находка 8: rc 3 здесь — не «сессию оставили»
        return 3

    if not same(procs, p):
        return gone()
    if tap:
        until = sx.now() + TAP_WAIT
        while not tapped(procs, s, tap, want):
            if sx.now() >= until or not same(procs, s):
                log(f"у наследника {s.pid} нет nerve.py tap {role} за {TAP_WAIT} с — предшественника не трогаю")
                return 3
            sx.sleep(poll)
            procs = sx.procs()
        log(f"наследник {s.pid} принял и слушает нерв ({role})")
    until = sx.now() + IDLE_WAIT
    while sx.status(p.pid) == "busy" and sx.now() < until:
        sx.sleep(poll)
    procs = sx.procs()
    if not same(procs, p):
        return gone()
    # За IDLE_WAIT мир мог смениться: ход не кончился — не рвём его; наследник упал или снял tap — роль без сессии.
    why = (sx.status(p.pid) == "busy" and f"предшественник {p.pid} занят дольше {IDLE_WAIT} с") or \
        successor_problem(sx, procs, p, procs.get(s.pid), a, child) or \
        (tap and not tapped(procs, s, tap, want) and f"у наследника {s.pid} пропал nerve.py tap {role}")
    if why:
        log("перед снятием: " + why + " — предшественника не трогаю")
        return 3
    if not handover(s):
        return 3
    protect = {s.pid} | descendants(procs, s.pid)
    return 0 if take_down(sx, p, parent, protect, log) else 3


def detach(logpath):
    """Двойной fork + setsid: сторож переживает снятие группы предшественника и не держит пайпы Bash-инструмента
    (иначе вызов spawn_session.sh в сессии висел бы до конца ожидания). True — в сторожe, False — в вызвавшем."""
    pid = os.fork()
    if pid > 0:
        os.waitpid(pid, 0)
        return False
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    logpath.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    null = os.open(os.devnull, os.O_RDWR)
    out = os.open(str(logpath), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(null, 0)
    os.dup2(out, 1)
    os.dup2(out, 2)
    os.closerange(3, 1024)
    return True


def cmd_retire(sx, a):
    p = ancestor_claude(sx.procs(), os.getpid())
    parent = os.environ.get("TAIBE_LINEAGE", "") or (session_line(sx, p) if p else None) or ""
    if not valid_line(a.child) or (parent and not a.child.startswith(parent + ".")):
        return die(f"линия наследника {a.child!r} не продолжает свою ({parent or '—'})")
    if p is None:
        print("retire: запуск не из сессии claude — снимать некого")
        return 0
    logpath = lfile(a.child, ".retire.log")
    # sessionId — сейчас, пока предшественник жив: после его ухода запись реестра исчезает. tty окна наследника —
    # из аргумента spawn_session.sh, не из записи линии: папку линий правят агенты (GLM #120, находка 1).
    # Пины папок списка — тоже сейчас, до ожидания квитанции: подмену .claude или списка за ожидание сторож заметит
    # (GLM #120 104b29f96, S1).
    ctl = ({"dirs": a.guard, "sid": session_id(p), "tty": getattr(a, "succ_tty", "") or "", "pins": take_pins(a.guard)}
           if getattr(a, "guard", None) else None)
    if a.foreground:
        return watch(sx, p, parent, a.child, a.role, a.timeout, make_log(sys.stdout), a.poll, ctl)
    if not detach(logpath):
        print(f"retire: сессия {p.pid} уйдёт сама после квитанции {a.child} (до {a.timeout:.0f} с); журнал {logpath}")
        return 0
    rc = 3
    try:
        rc = watch(sx, p, parent, a.child, a.role, a.timeout, make_log(sys.stdout), a.poll, ctl)
    except Exception as e:  # сторож без терминала: причина — только в журнале
        print(f"{stamp()} сбой сторожа: {e!r}", flush=True)
    os._exit(rc)
