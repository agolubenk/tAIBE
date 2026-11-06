"""Окно Terminal линии после выхода claude — свой модуль lineage.py (лимит 500 строк).

  lineage.py exited --rc N [--keep]
      пусковой скрипт spawn_session.sh сразу после выхода claude: код выхода и время — в запись своей линии
      (<каталог линий>/<TAIBE_LINEAGE>.json); --keep — владелец нажал Enter в отсчёте, окно не закрывать никому.
  lineage.py autoclose --tty /dev/ttysNNN --pid PID
      тот же скрипт после отсчёта (10 с, Enter — оставить): сторож без терминала ждёт выхода скрипта PID и закрывает
      окно своей линии — только при записанном коде 0 без --keep, одна вкладка, тот же tty, в ней только shell.
      Не зависит от настройки Terminal «When the shell exits»: окно закрывается явно, shell-остатки получают HUP.
"""
import os
import re
import sys

import lineage as L
import lineage_retire as LR

SHELL_NAMES = '{"login", "zsh", "bash", "sh", "fish", "tcsh", "csh"}'

# Все окна Terminal одним вызовом: id, число вкладок, tty, busy и процессы первой вкладки (через TAB).
# `tab` внутри tell Terminal — класс вкладки, поэтому разделитель — character id 9. Terminal не запущен — пусто.
# Процессы — по индексу: `repeat with p in (processes of t)` даёт ссылки, и `p as text` падает с -1700 (замер 06.11:
# try молча проглатывал ошибку, список окон был пуст, а закрытие никогда бы не сработало).
LIST_SCRIPT = """if application "Terminal" is not running then return ""
tell application "Terminal"
  set out to ""
  set sep to character id 9
  repeat with i from 1 to (count of windows)
    try
      set w to window i
      set t to tab 1 of w
      set pl to processes of t
      set ps to ""
      repeat with k from 1 to (count of pl)
        set ps to ps & (item k of pl) & ","
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
            set pl to processes of t
            repeat with q from 1 to (count of pl)
              set nm to (item q of pl) as text
              if nm starts with "-" then set nm to text 2 thru -1 of nm
              if not (""" + SHELL_NAMES + """ contains nm) then return "skip " & k & ": " & nm
            end repeat
            if busy of t then return "skip " & k & ": busy"
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


def own_record():
    """(линия, запись) своей линии, если её открыл spawn_session.sh в Terminal; иначе (линия, None)."""
    line = os.environ.get("TAIBE_LINEAGE", "")
    if not L.valid_line(line):
        return line, None
    rec = L.read_json(L.ldir() / f"{line}.json")
    return line, rec if isinstance(rec, dict) and rec.get("terminal") == "terminal" else None


def closable_exit(rec):
    """Почему окно этой записи нельзя закрывать ('' — можно): нет кода выхода, код ≠ 0, владелец оставил."""
    rc = (rec or {}).get("exit")
    if not isinstance(rc, int) or isinstance(rc, bool):
        return "нет кода выхода claude"
    if rc != 0:
        return f"claude вышел с кодом {rc} — окно оставлено ради причины"
    if rec.get("keep"):
        return "владелец оставил окно (Enter)"
    return ""


def add_exited_args(p):
    p.add_argument("--rc", type=int, required=True)
    p.add_argument("--keep", action="store_true")


def cmd_exited(sx, a):
    line, rec = own_record()
    if rec is None:
        return 0  # не окно spawn_session.sh в Terminal — записывать некуда
    rec = {**rec, "exit": a.rc, "exited_at": L.stamp(), **({"keep": True} if a.keep else {})}
    L.write_json(L.ldir() / f"{line}.json", rec)
    return 0


def add_autoclose_args(p):
    p.add_argument("--tty", required=True, help="tty вкладки пускового скрипта (`tty`)")
    p.add_argument("--pid", type=int, default=0, help="pid пускового скрипта: закрывать, когда он вышел")
    p.add_argument("--wait", type=float, default=20.0, help="с: сколько ждать выхода скрипта и прочих процессов")
    p.add_argument("--poll", type=float, default=0.5)
    p.add_argument("--foreground", action="store_true", help="без отцепления (тесты)")


def close_own(sx, a, line, log):
    """Окно своей вкладки, когда в ней остались только shell: пока жив хоть один наш shell, tty не отдан другой
    вкладке, поэтому без id окна достаточно tty. Запись перечитывается: Enter мог прийти в последний миг."""
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
    rec = L.read_json(L.ldir() / f"{line}.json") or {}
    why = closable_exit(rec)
    if why:
        log(f"окно {a.tty}: {why} — не закрываю")
        return 3
    wid = str(rec.get("window_id") or "")
    res = sx.osa(CLOSE_IDLE_SCRIPT, a.tty, wid if wid.isdigit() else "")
    log(f"окно {a.tty}: {res}")
    if not res.startswith("closed"):
        return 3
    LR.hup_tty(sx, short, log)
    return 0


def cmd_autoclose(sx, a):
    line, rec = own_record()
    if not L.valid_line(line) or not re.fullmatch(r"/dev/ttys?[0-9]+", a.tty or ""):
        return L.die("autoclose: нужны линия (TAIBE_LINEAGE) и --tty /dev/ttysNNN")
    if rec is None or (rec.get("tty") and rec["tty"] != a.tty):
        print("autoclose: окно не из записи spawn_session.sh (Terminal, тот же tty) — не закрываю")
        return 0
    if closable_exit(rec):
        print(f"autoclose: {closable_exit(rec)} — не закрываю")
        return 0
    if a.foreground:
        return close_own(sx, a, line, L.make_log(sys.stdout))
    if not LR.detach(L.ldir() / f"{line}.autoclose.log"):
        return 0
    rc = 3
    try:
        rc = close_own(sx, a, line, L.make_log(sys.stdout))
    except Exception as e:  # сторож без терминала: причина — только в журнале
        print(f"{L.stamp()} сбой autoclose: {e!r}", flush=True)
    os._exit(rc)
