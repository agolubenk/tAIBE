#!/usr/bin/env python3
"""Линия сессий: предшественник уходит сам после проверенного приёма, закончившиеся сессии убираются по списку.

  lineage.py record --line L --terminal terminal|iterm|print [--window-id N] [--tty /dev/ttysNNN] [--role K]
      spawn_session.sh при открытии окна: id окна и tty вкладки → <каталог>/<L>.json
  lineage.py line
      своя линия: TAIBE_LINEAGE → «Линия:» в аргументах claude → первый промпт транскрипта (сессия после --resume)
  lineage.py ack
      наследник после приёма, перевзвода Monitor и кронов: квитанция <TAIBE_LINEAGE>.ack (pid и старт его claude)
  lineage.py retire --child L [--role K] [--timeout 5400] [--foreground]
      spawn_session.sh --handoff: отцепленный сторож ждёт квитанцию L, проверяет наследника и снимает предшественника
  lineage.py reap [--idle-hours 24] [--include-waiting] [--kill [--yes]]
      без флагов — только список; --kill — действие владельца, только по списку последнего показа (≤ 10 мин)

Снимается сессия так: TERM группе claude и потомкам вне группы → 10 с → KILL выживших → окно Terminal (по id из
record, иначе по tty; окно с другими вкладками, iTerm и VS Code не трогаются) → HUP shell-остаткам на tty.
Каталог — TAIBE_LINEAGE_DIR (по умолчанию ~/.claude/lineage). Только stdlib, запуск python3 -I.
"""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from collections import namedtuple
from pathlib import Path

Proc = namedtuple("Proc", "pid ppid pgid tty start command")
LINE_RE = re.compile(r"^r(\.[a-z0-9]+)*$")
LINE_ARG_RE = re.compile(r"Линия: (r(?:\.[a-z0-9]+)+)")  # в первом сообщении, которое пишет spawn_session.sh
SHELLS = {"login", "zsh", "bash", "sh", "fish", "tcsh", "csh"}
TERM_WAIT = 10          # с между TERM и KILL
TAP_WAIT = 180          # с на взвод Monitor наследника (nerve.py tap <роль>)
IDLE_WAIT = 300         # с, чтобы предшественник закончил текущий ход
LIST_TTL = 600          # с: --kill берёт только свежий показанный список
C_ENV = {**os.environ, "TZ": "UTC", "LC_ALL": "C"}  # lstart как procStart в ~/.claude/sessions/<pid>.json

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


def ldir():
    return Path(os.environ.get("TAIBE_LINEAGE_DIR") or Path.home() / ".claude" / "lineage")


def sessions_dir():
    return Path(os.environ.get("CLAUDE_SESSIONS_DIR") or Path.home() / ".claude" / "sessions")


def projects_dir():
    return Path(os.environ.get("CLAUDE_PROJECTS_DIR") or Path.home() / ".claude" / "projects")


def norm(s):
    return " ".join(str(s or "").split())


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def argv0(p):
    return os.path.basename(p.command.split(" ", 1)[0]) if p and p.command else ""


def valid_line(line):
    return bool(line) and LINE_RE.match(line) is not None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class Sys:
    """Всё, что трогает процессы и окна, — здесь: тесты подменяют этот класс."""

    def procs(self):
        out = subprocess.run(["ps", "-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,tty=,lstart=,command="],
                             capture_output=True, text=True, env=C_ENV, check=True).stdout
        res = {}
        for ln in out.splitlines():
            t = ln.split(None, 10)
            if len(t) < 10 or t[3].startswith("Z"):
                continue  # зомби — уже не процесс: его ждёт только родитель
            try:
                pid, ppid, pgid = int(t[0]), int(t[1]), int(t[2])
            except ValueError:
                continue
            res[pid] = Proc(pid, ppid, pgid, t[4], " ".join(t[5:10]), t[10] if len(t) > 10 else "")
        return res

    def env_line(self, pid):
        """TAIBE_LINEAGE из окружения процесса (ps -E: только свои процессы). Последнее вхождение — окружение
        печатается после аргументов, а в аргументах (первое сообщение) могло встретиться то же слово."""
        r = subprocess.run(["ps", "-E", "-ww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True,
                           env=C_ENV)
        vals = [tok.split("=", 1)[1] for tok in r.stdout.split() if tok.startswith("TAIBE_LINEAGE=")]
        return vals[-1] if vals else None

    def status(self, pid):
        d = read_json(sessions_dir() / f"{pid}.json")
        return d.get("status") if isinstance(d, dict) else None

    def kill(self, pid, sig):
        try:
            os.kill(pid, sig)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    def killpg(self, pgid, sig):
        try:
            os.killpg(pgid, sig)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    def osa(self, script, *args):
        r = subprocess.run([os.environ.get("LINEAGE_OSASCRIPT", "osascript"), "-", *args], input=script,
                           capture_output=True, text=True, timeout=30)
        return (r.stdout or r.stderr).strip()

    def metrics(self):
        claude = sum(1 for p in self.procs().values() if argv0(p) == "claude")
        win = self.osa('if application "Terminal" is running then tell application "Terminal" to return count windows\n'
                       'return 0')
        swap = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout.strip()
        return {"claude": claude, "terminal_windows": win, "swap": swap}

    def now(self):
        return time.time()

    def sleep(self, s):
        time.sleep(s)


def transcript_line(session_id):
    """Линия из первого промпта транскрипта: у сессии, поднятой через --resume, нет ни TAIBE_LINEAGE, ни первого
    сообщения в аргументах (так 05.11 воскресили роли после лимита)."""
    if not re.fullmatch(r"[0-9a-f-]{36}", str(session_id or "")):
        return None
    for f in sorted(projects_dir().glob(f"*/{session_id}.jsonl")):
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for i, ln in enumerate(fh):
                    if i >= 400:
                        break
                    if '"user"' not in ln:
                        continue
                    try:
                        r = json.loads(ln)
                    except ValueError:
                        continue
                    if r.get("type") != "user" or r.get("isMeta"):
                        continue
                    c = (r.get("message") or {}).get("content")
                    text = c if isinstance(c, str) else " ".join(
                        str(x.get("text", "")) for x in c or [] if isinstance(x, dict))
                    m = LINE_ARG_RE.search(text)
                    return m.group(1) if m else None  # только первый промпт: дальше линии чужих сессий в цитатах
        except OSError:
            continue
    return None


def session_line(sx, p):
    """Линия сессии p: окружение → «Линия:» в аргументах → первый промпт транскрипта (sessions/<pid>.json того же
    старта, иначе pid уже у другого процесса)."""
    line = sx.env_line(p.pid)
    if valid_line(line or ""):
        return line
    m = LINE_ARG_RE.search(p.command)
    if m:
        return m.group(1)
    d = read_json(sessions_dir() / f"{p.pid}.json")
    if isinstance(d, dict) and norm(d.get("procStart")) == norm(p.start):
        return transcript_line(d.get("sessionId"))
    return None


def ancestor_claude(procs, pid):
    """Ближайший предок-claude (включая сам pid) — сессия, в чьём Bash-инструменте мы запущены."""
    seen = set()
    while pid in procs and pid not in seen and pid > 1:
        seen.add(pid)
        if argv0(procs[pid]) == "claude":
            return procs[pid]
        pid = procs[pid].ppid
    return None


def descendants(procs, root):
    kids = {}
    for p in procs.values():
        kids.setdefault(p.ppid, []).append(p.pid)
    out, todo = set(), [root]
    while todo:
        for c in kids.get(todo.pop(), []):
            if c not in out and c != root:
                out.add(c)
                todo.append(c)
    return out


def doomed(procs, p):
    """Что снимается вместе с сессией: она, её группа (если она лидер — MCP-серверы) и потомки вне группы
    (Bash-инструмент живёт в своей группе). Отцепленные демоны (ppid 1) сюда не попадают."""
    s = descendants(procs, p.pid) | {p.pid}
    if p.pgid == p.pid:
        s |= {q.pid for q in procs.values() if q.pgid == p.pid}
    return s - {os.getpid()}


def host(procs, p):
    """Чьё окно у сессии — по цепочке предков (entrypoint в sessions/*.json ненадёжен: claude-vscode и в Terminal)."""
    pid, seen = p.ppid, set()
    while pid in procs and pid not in seen and pid > 1:
        seen.add(pid)
        c = procs[pid].command
        if "/Terminal.app/" in c:
            return "terminal"
        if "iTerm" in c:
            return "iterm"
        if "/Code.app/" in c or "Code Helper" in c or "Visual Studio Code" in c:
            return "vscode"
        pid = procs[pid].ppid
    return "other"


def same(procs, p):
    q = procs.get(p.pid)
    return q is not None and norm(q.start) == norm(p.start)


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
    leader = p.pgid == p.pid
    if leader:
        sx.killpg(p.pid, signal.SIGTERM)
    for pid in sorted(pids):
        if not (leader and procs[pid].pgid == p.pid):
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
    rec = read_json(ldir() / f"{line}.json") if valid_line(line or "") else None
    if close_window(sx, procs, p, rec, log):
        hup_tty(sx, p.tty, log)
    return True


TAP = "nerve\\.py\\s+tap\\s+{}(\\s|$)"


def tapped(procs, s, tap):
    return any(tap.search(procs[q].command) for q in descendants(procs, s.pid) if q in procs)


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


def watch(sx, p, parent, child, role, timeout, log, poll=5.0):
    """Сторож предшественника p. Код возврата: 0 — снят или уже ушёл сам, 3 — проверка не прошла, p не тронут."""
    ack = ldir() / f"{child}.ack"
    deadline = sx.now() + timeout
    log(f"жду квитанцию {ack} до {timeout:.0f} с; предшественник {p.pid}, линия {parent or '—'}")
    while not ack.exists():
        if sx.now() >= deadline:
            log("квитанции нет — предшественника не трогаю")
            return 3
        if not same(sx.procs(), p):
            log("предшественник уже завершился сам")
            return 0
        sx.sleep(poll)
    a = read_json(ack) or {}
    procs = sx.procs()
    s = procs.get(a.get("pid") if isinstance(a.get("pid"), int) else -1)
    why = successor_problem(sx, procs, p, s, a, child)
    if why:
        log("проверка не прошла: " + why + " — предшественника не трогаю")
        return 3
    if not same(procs, p):
        log("предшественник уже завершился сам")
        return 0
    tap = re.compile(TAP.format(re.escape(role))) if role else None
    if tap:
        until = sx.now() + TAP_WAIT
        while not tapped(procs, s, tap):
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
        log("предшественник уже завершился сам")
        return 0
    # За IDLE_WAIT мир мог смениться: ход не кончился — не рвём его; наследник упал или снял tap — роль без сессии.
    why = (sx.status(p.pid) == "busy" and f"предшественник {p.pid} занят дольше {IDLE_WAIT} с") or \
        successor_problem(sx, procs, p, procs.get(s.pid), a, child) or \
        (tap and not tapped(procs, s, tap) and f"у наследника {s.pid} пропал nerve.py tap {role}")
    if why:
        log("перед снятием: " + why + " — предшественника не трогаю")
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


def make_log(stream):
    def log(msg):
        print(f"{stamp()} {msg}", file=stream, flush=True)
    return log


def cmd_record(sx, a):
    if not valid_line(a.line):
        return die(f"плохая линия: {a.line!r}")
    write_json(ldir() / f"{a.line}.json", {"line": a.line, "terminal": a.terminal, "window_id": a.window_id or None,
                                            "tty": a.tty or None, "role": a.role or None, "at": stamp()})
    return 0


def cmd_line(sx, a):
    """Своя линия — для spawn_session.sh, когда TAIBE_LINEAGE в окружении нет (сессия поднята через --resume)."""
    me = ancestor_claude(sx.procs(), os.getpid())
    line = os.environ.get("TAIBE_LINEAGE", "") or (session_line(sx, me) if me else None) or ""
    if not valid_line(line):
        return 1
    print(line)
    return 0


def cmd_ack(sx, a):
    me = ancestor_claude(sx.procs(), os.getpid())
    if me is None:
        return die("не под claude: квитанцию пишет сама сессия-наследник из своего Bash")
    line = os.environ.get("TAIBE_LINEAGE", "") or session_line(sx, me) or ""
    if not valid_line(line):
        return die("нет линии (TAIBE_LINEAGE, первый промпт) — сессию открыл не spawn_session.sh, квитанция не нужна")
    write_json(ldir() / f"{line}.ack", {"line": line, "pid": me.pid, "start": me.start, "at": stamp()})
    print(f"ack: линия {line}, claude {me.pid} — предшественника снимет его сторож")
    return 0


def cmd_retire(sx, a):
    p = ancestor_claude(sx.procs(), os.getpid())
    parent = os.environ.get("TAIBE_LINEAGE", "") or (session_line(sx, p) if p else None) or ""
    if not valid_line(a.child) or (parent and not a.child.startswith(parent + ".")):
        return die(f"линия наследника {a.child!r} не продолжает свою ({parent or '—'})")
    if p is None:
        print("retire: запуск не из сессии claude — снимать некого")
        return 0
    logpath = ldir() / f"{a.child}.retire.log"
    if a.foreground:
        return watch(sx, p, parent, a.child, a.role, a.timeout, make_log(sys.stdout), a.poll)
    if not detach(logpath):
        print(f"retire: сессия {p.pid} уйдёт сама после квитанции {a.child} (до {a.timeout:.0f} с); журнал {logpath}")
        return 0
    rc = 3
    try:
        rc = watch(sx, p, parent, a.child, a.role, a.timeout, make_log(sys.stdout), a.poll)
    except Exception as e:  # сторож без терминала: причина — только в журнале
        print(f"{stamp()} сбой сторожа: {e!r}", flush=True)
    os._exit(rc)


def die(msg):
    print("lineage: " + msg, file=sys.stderr)
    return 2


def main(argv=None, sx=None):
    ap = argparse.ArgumentParser(prog="lineage.py", description=__doc__.split("\n", 1)[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("--line", required=True)
    r.add_argument("--terminal", choices=["terminal", "iterm", "print"], required=True)
    r.add_argument("--window-id", default="")
    r.add_argument("--tty", default="")
    r.add_argument("--role", default="")
    sub.add_parser("ack")
    sub.add_parser("line")
    t = sub.add_parser("retire")
    t.add_argument("--child", required=True)
    t.add_argument("--role", default="")
    t.add_argument("--timeout", type=float, default=float(os.environ.get("SPAWN_RETIRE_TIMEOUT") or 5400))
    t.add_argument("--poll", type=float, default=5.0)
    t.add_argument("--foreground", action="store_true", help="без отцепления (тесты, отладка)")
    from lineage_reap import add_reap_args, cmd_reap  # noqa: E402 — уборка в своём модуле (лимит 500 строк)
    add_reap_args(sub.add_parser("reap"))
    a = ap.parse_args(argv)
    sx = sx or Sys()
    return {"record": cmd_record, "ack": cmd_ack, "line": cmd_line, "retire": cmd_retire,
            "reap": cmd_reap}[a.cmd](sx, a)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    sys.exit(main())
