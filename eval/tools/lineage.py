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
  lineage.py reap [--idle-hours 24] [--include-waiting] [--prune-days 30] [--kill [--yes]]
      без флагов — список и чистка записей линий старше --prune-days; --kill — действие владельца, только по списку последнего показа (≤ 10 мин)
  lineage.py reap --auto [--apply] [--summary] [--ack-minutes 30] [--auto-idle-hours 8] [--window-minutes 10]
      безопасная автоуборка (решение владельца 06.11, lineage_auto.py): без --apply — список, в журнал — изменения
      плана; --apply — только launchd владельца; --summary — читаемая сводка журнала
  lineage.py exited --rc N [--keep] · lineage.py autoclose --tty /dev/ttysNNN --pid PID
      пусковой скрипт spawn_session.sh после выхода claude (lineage_close.py): код выхода в запись линии; при коде 0
      и без Enter в 10-секундном отсчёте окно Terminal своей линии закрывается само

Снимается сессия так: TERM группе claude и потомкам вне группы → 10 с → KILL выживших → окно Terminal (по id из
record, иначе по tty; окно с другими вкладками, iTerm и VS Code не трогаются) → HUP shell-остаткам на tty.
Группа — claude-лидер или пусковой bash spawn_session.sh, в группе которого claude (без exec, чтобы закрыть окно).
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
LAUNCHER_RE = re.compile(r"/claude-spawn\.[A-Za-z0-9]+/[a-z]+\.sh(\s|$)")  # пусковой скрипт spawn_session.sh
SHELLS = {"login", "zsh", "bash", "sh", "fish", "tcsh", "csh"}
TERM_WAIT = 10          # с между TERM и KILL
TAP_WAIT = 180          # с на взвод Monitor наследника (nerve.py tap <роль>)
IDLE_WAIT = 300         # с, чтобы предшественник закончил текущий ход
LIST_TTL = 600          # с: --kill берёт только свежий показанный список
C_ENV = {**os.environ, "TZ": "UTC", "LC_ALL": "C"}  # lstart как procStart в ~/.claude/sessions/<pid>.json

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
    """Атомарно и только для владельца (0600): записи линий и журнал называют окна, tty и папки."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(json.dumps(data, ensure_ascii=False, indent=1))
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

    def alive(self, p):
        """Жив ли p (старт тот же — тот же процесс) без полного ps -A: ≈3 мс CPU вместо ≈355 мс (замер роли 6)."""
        r = subprocess.run(["ps", "-o", "stat=,lstart=", "-p", str(p.pid)], capture_output=True, text=True, env=C_ENV)
        t = r.stdout.split(None, 1)
        return len(t) == 2 and not t[0].startswith("Z") and norm(t[1]) == norm(p.start)

    def pid_alive(self, pid):
        """Есть ли процесс pid (сигнал 0): ожидание выхода своего родителя без ps."""
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

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

    def unsaved(self, path):
        """Что в checkout папки path пропадёт со снятием сессии ('' — ничего): незакоммиченное (вкл.
        неотслеживаемое), коммиты, которых нет ни на одном remote, stash этой ветки (stash общий для worktree).
        Не git или сбой — причина: не знаем — не трогаем."""
        def git(*args):
            r = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, timeout=30)
            if r.returncode != 0:
                raise OSError(r.stderr.strip()[:80])
            return r.stdout
        try:
            if git("status", "--porcelain", "--untracked-files=normal").strip():
                return "незакоммиченное"
            if int(git("rev-list", "--count", "HEAD", "--not", "--remotes").strip() or 0):
                return "коммиты не на remote"
            branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
            tag = "(no branch)" if branch == "HEAD" else branch
            if any(re.match(r"(?:WIP on|On) " + re.escape(tag) + ":", ln)
                   for ln in git("stash", "list", "--format=%gs").splitlines()):
                return "stash этой ветки"
        except (OSError, subprocess.SubprocessError, ValueError):
            return "git не ответил"
        return ""

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


def group_of(procs, p):
    """Группа сессии p, которую можно снимать целиком: p — её лидер (exec в пусковом скрипте), или лидер — родитель
    p, пусковой bash spawn_session.sh (claude без exec, чтобы потом закрыть окно). Иначе None — только дерево p."""
    if p.pgid == p.pid:
        return p.pgid
    parent = procs.get(p.ppid)
    if parent and parent.pid == p.pgid and argv0(parent) == "bash" and LAUNCHER_RE.search(parent.command):
        return p.pgid
    return None


def doomed(procs, p):
    """Что снимается вместе с сессией: она, её группа (group_of — MCP-серверы, пусковой bash) и потомки вне группы
    (Bash-инструмент живёт в своей группе). Отцепленные демоны (ppid 1) сюда не попадают."""
    s = descendants(procs, p.pid) | {p.pid}
    g = group_of(procs, p)
    if g is not None:
        s |= {q.pid for q in procs.values() if q.pgid == g}
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
    t.add_argument("--guard", action="append", default=[], metavar="DIR",
                   help="папка со списком Контроля: если предшественник — Контроль, он переходит наследнику (IS-233)")
    t.add_argument("--succ-tty", default="", metavar="TTY",
                   help="tty окна наследника от spawn_session.sh (/dev/ttysNNN); пусто — Контроль не передаётся")
    from lineage_reap import add_reap_args, cmd_reap  # noqa: E402 — уборка и сторож в своих модулях (лимит 500 строк)
    from lineage_retire import cmd_retire  # noqa: E402
    from lineage_close import add_autoclose_args, add_exited_args, cmd_autoclose, cmd_exited  # noqa: E402
    add_reap_args(sub.add_parser("reap"))
    add_autoclose_args(sub.add_parser("autoclose"))
    add_exited_args(sub.add_parser("exited"))
    a = ap.parse_args(argv)
    sx = sx or Sys()
    return {"record": cmd_record, "ack": cmd_ack, "line": cmd_line, "retire": cmd_retire,
            "reap": cmd_reap, "autoclose": cmd_autoclose, "exited": cmd_exited}[a.cmd](sx, a)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    sys.exit(main())
