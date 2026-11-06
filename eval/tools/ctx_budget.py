#!/usr/bin/env python3
"""Бюджет окна — живой потолок контекста каждой сессии Claude Code (решение владельца 06.11; порог 80 % снят).

100 % — точка автосжатия W_eff, а не номинальное окно: по истории сжатий этого окна, иначе доля W_eff/окно
изученного окна (250K: 216,9K), иначе 213/250. s = U / W_eff, U — usage последнего ответа основной цепочки.
Окно: SUCCESSOR_WINDOW_TOKENS → autoCompactWindow, пока U в него влезает (U > окна — окно определено неверно, а не
сигнал передачи) → пометка 1M у модели (message.model, model в настройках, ANTHROPIC_MODEL) → U > окна × 1,02 →
1M → 200K. Раз увиденное окно 1M держится до конца сессии.
H — цена передачи (savepoint, work_state, handoff, spawn): p80 по истории, иначе 4 %. T — оценка задачи:
заявлена (`next --size`, × калибровка) → медиана цены задачи роли по истории → 10 %.

  s < 0.85                    тишина: передачи до 85 % нет
  s ≥ 0.985 − H               передать сейчас при любых оценках (страховка)
  s + остаток + H ≤ 0.985     можно закончить текущую (на границе — взять следующую)
  иначе                       передать сейчас (savepoint посреди задачи)

Остаток = max(T − потрачено с начала задачи, 2 %); на границе — T следующей. Границы: `next` / `done`; у
незаявленной задачи ещё git commit, gh pr create, смена статуса карточки (их видит хук context-threshold.py).

  ctx_budget.py next "<задача>" --size S|M|L|<n%>   начать задачу (S 3 %, M 7 %, L 15 %), вердикт
  ctx_budget.py done                                 закрыть задачу — граница, вердикт
  ctx_budget.py status                               s, W_eff, H, T, потолок и решение
  ctx_budget.py learn [--days 30] [--dry-run]        параметры по транскриптам (ctx_budget_params.py)
  сессия — CLAUDE_CODE_SESSION_ID (выставляет Claude Code) или --session. Коды: 0 — ок, 1 — нет данных или
  ошибка чтения/записи, 2 — аргументы.

Каталог — CTX_BUDGET_DIR (по умолчанию ~/.claude/ctx-budget): params.json (learn), journal.jsonl (старт/конец
задач: числа, роль, sid), sessions/<sid>.json + .lock (flock). Общий для всех checkout: транскрипты и окна —
машинные, а сессия из worktree зовёт CLI своей копии, и состояние у хука и CLI должно быть одно.
Имя задачи из `next` не сохраняется. Только stdlib, запуск python3 -I.
"""
import argparse
import contextlib
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover — не POSIX: без блокировки
    fcntl = None

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from ctx_budget_params import (  # noqa: E402 — пути, окно сессии и выученные параметры
    ONE_M, T_RANGE, budget_dir, calibration, clamp, handoff_cost, lineage_dir, load_params, pct, projects_dir,
    session_window, task_estimate, w_eff)

FLOOR, CEIL = 0.85, 0.985          # решение владельца 06.11
REM_MIN = 0.02                      # остаток текущей задачи не меньше 2 %
RESET_DROP = 0.15                   # падение U на 15 % W_eff между проверками — сжатие или /clear
SIZES = {"S": 0.03, "M": 0.07, "L": 0.15}
BOUNDARY_PHASE = 0.01               # потрачено меньше 1 % с границы — ещё граница
TAIL_BYTES = 400_000
STATE_MAX_AGE_S = 3 * 86400
JOURNAL_MAX = 2_000_000


def parse_size(text):
    """S|M|L или n% (6, 6%, 6.5%, 6,5 %) → доля окна. ValueError — непонятно."""
    raw = str(text or "").strip().upper().replace(",", ".").replace(" ", "")
    if raw in SIZES:
        return SIZES[raw]
    value = float(raw.rstrip("%"))
    if not 0 < value <= 100:
        raise ValueError(text)
    return value / 100


# ---------------------------------------------------------------- решение

def decide(s, rem, h, floor=FLOOR, ceil=CEIL):
    """quiet | ok | handoff | safety. rem — остаток текущей задачи (на границе — оценка следующей)."""
    if s < floor:
        return "quiet"
    if s >= ceil - h:
        return "safety"
    return "ok" if s + rem + h <= ceil + 1e-9 else "handoff"  # 1e-9: 0,90 + 0,045 + 0,04 — это ровно 0,985


def remaining(task, u, weff):
    """(остаток, потрачено, граница?) задачи в долях W_eff."""
    u0 = task.get("u0")
    spent = max(0.0, (u - u0) / weff) if isinstance(u0, (int, float)) else 0.0
    boundary = not task.get("explicit") and spent < BOUNDARY_PHASE
    return (task["t"] if boundary else max(task["t"] - spent, REM_MIN)), spent, boundary


def verdict(st, u, window, params):
    weff, wsrc = w_eff(window, params)
    h, hsrc = handoff_cost(params)
    task = st["task"]
    rem, spent, boundary = remaining(task, u, weff)
    s = u / weff
    kind = decide(s, rem, h)
    epoch, xseq = st.get("epoch", 0), st.get("xseq", 0)
    handoff_key = "handoff:%d:%d" % (epoch, xseq)
    key = {"quiet": None, "ok": "ok:%d:%d" % (epoch, task["seq"]), "handoff": handoff_key,
           "safety": "safety:%d" % epoch}[kind]
    return {"kind": kind, "key": key, "s": s, "u": u, "weff": weff, "wsrc": wsrc, "window": window, "h": h,
            "hsrc": hsrc, "t": task["t"], "tsrc": task.get("src", ""), "rem": rem, "spent": spent,
            "boundary": boundary, "handoff_said": handoff_key in st.get("printed", [])}


def line(v):
    """Вердикт одной строкой — для CLI и как начало текста хука."""
    head = "контекст %s %%, потолок 98,5 %%" % pct(v["s"])
    if v["kind"] == "quiet":
        return "%s; передачи до 85 %% нет — работай (100 %% ≈ %dK)" % (head, v["weff"] // 1000)
    if v["kind"] == "safety":
        return "передай сейчас (страховка): контекст %s %% ≥ 98,5 %% − передача ~%s %%; сжатие ≈ %dK" % (
            pct(v["s"]), pct(v["h"]), v["weff"] // 1000)
    if v["kind"] == "handoff":
        return "передай сейчас: контекст %s %% + %s ~%s %% + передача ~%s %% = %s %% > потолка 98,5 %%" % (
            pct(v["s"]), "следующая" if v["boundary"] else "задача", pct(v["rem"]), pct(v["h"]),
            pct(v["s"] + v["rem"] + v["h"]))
    if v["boundary"]:
        return "%s, следующая ~%s %% (%s), передача ~%s %% → можно взять следующую" % (
            head, pct(v["rem"]), v["tsrc"], pct(v["h"]))
    return "%s, задача ~%s %% (осталось), передача ~%s %% → можно закончить текущую" % (head, pct(v["rem"]), pct(v["h"]))


# ---------------------------------------------------------------- транскрипт и состояние

def last_context_tokens(transcript):
    """usage последнего ответа модели основной цепочки (не субагента) из хвоста транскрипта; None — нет."""
    return last_answer(transcript)[0]


def last_answer(transcript):
    """(usage, message.model) последнего ответа основной цепочки; (None, None) — нет."""
    try:
        size = transcript.stat().st_size
        with transcript.open("rb") as fh:
            fh.seek(max(0, size - TAIL_BYTES))
            tail = fh.read().decode("utf-8", "ignore")
    except OSError:
        return None, None
    for ln in reversed(tail.splitlines()):
        if '"usage"' not in ln:
            continue
        try:
            entry = json.loads(ln)
            if entry.get("type") != "assistant" or entry.get("isSidechain"):
                continue
            msg = entry.get("message") or {}
            usage = msg.get("usage") or {}
            total = sum(int(usage.get(k) or 0) for k in (
                "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
        except (ValueError, TypeError, AttributeError):
            continue  # первая строка хвоста обрезана или запись не того вида
        if total > 0:
            return total, (str(msg.get("model"))[:80] if msg.get("model") else None)
    return None, None


def safe_sid(session_id):
    return "".join(ch for ch in str(session_id or "") if ch.isalnum() or ch in "-_")[:80]


def sessions_dir():
    return budget_dir() / "sessions"


def load_state(sid):
    try:
        data = json.loads((sessions_dir() / (sid + ".json")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(sid, st):
    sessions_dir().mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=sessions_dir(), prefix=sid + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(st, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, sessions_dir() / (sid + ".json"))


@contextlib.contextmanager
def session_lock(sid, timeout=2.0):
    """flock на <sid>.lock: параллельные вызовы хука и CLI не теряют записи друг друга."""
    sessions_dir().mkdir(parents=True, exist_ok=True)
    fd = os.open(sessions_dir() / (sid + ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if fcntl is not None:
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() > deadline:
                        raise TimeoutError("ctx_budget: блокировка сессии занята")
                    time.sleep(0.02)
        yield
    finally:
        os.close(fd)  # закрытие снимает flock


def prune(now=None):
    now = now or time.time()
    try:
        for path in sessions_dir().iterdir():
            if now - path.stat().st_mtime > STATE_MAX_AGE_S:
                path.unlink()
    except OSError:
        pass


def journal(event):
    """Строка журнала задач: только числа, роль, sid и тип события."""
    try:
        path = budget_dir() / "journal.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > JOURNAL_MAX:
            os.replace(path, path.with_name("journal.1.jsonl"))
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    except OSError:
        pass


def session_role():
    """T3_ROLE_KEY → роль линии (TAIBE_LINEAGE → ~/.claude/lineage/<линия>.json) → «-»."""
    role = os.environ.get("T3_ROLE_KEY", "").strip()
    lineage = os.environ.get("TAIBE_LINEAGE", "").strip()
    if not role and re.fullmatch(r"[A-Za-z0-9._-]{1,200}", lineage):
        try:
            role = str(json.loads((lineage_dir() / (lineage + ".json")).read_text(encoding="utf-8")).get("role") or "")
        except (OSError, ValueError, AttributeError):
            role = ""
    return re.sub(r"[^A-Za-z0-9_-]", "", role)[:40] or "-"


def find_transcript(sid, st=None):
    path = Path((st or {}).get("transcript") or "")
    if path.is_file():
        return path
    found = sorted(projects_dir().glob("*/%s.jsonl" % sid))
    return found[0] if found else None


def start_task(st, sid, u, weff, t, src, explicit, now, log=True):
    """Закрыть текущую задачу (в журнал — факт) и начать новую с U = u."""
    old = st.get("task")
    if log and old and isinstance(old.get("u0"), (int, float)) and u is not None:
        journal({"ts": int(now), "sid": sid, "role": st.get("role", "-"), "ev": "end", "seq": old["seq"],
                 "u": u, "weff": weff})
    seq = (old or {}).get("seq", -1) + 1
    st["task"] = {"seq": seq, "explicit": bool(explicit), "t": round(t, 4), "src": src, "u0": u}
    if explicit:
        st["xseq"] = st.get("xseq", 0) + 1
    if log:
        journal({"ts": int(now), "sid": sid, "role": st.get("role", "-"), "ev": "start", "seq": seq, "u": u,
                 "weff": weff, "t": round(t, 4), "src": src, "explicit": bool(explicit)})


def refresh(st, sid, u, window, params, now, log=True):
    """Сброс после сжатия или /clear (резкое падение U); задача по умолчанию; u0 у заявленной без замера."""
    weff = w_eff(window, params)[0]
    st.setdefault("role", session_role())
    st.setdefault("printed", [])
    prev = st.get("u")
    if isinstance(prev, (int, float)) and u < prev - RESET_DROP * weff:
        st["epoch"] = st.get("epoch", 0) + 1
        st["printed"] = []
        st.pop("task", None)
        if log:
            journal({"ts": int(now), "sid": sid, "role": st["role"], "ev": "reset", "u": u, "weff": weff})
    if not st.get("task"):
        t, src = task_estimate(st["role"], params)
        start_task(st, sid, u, weff, t, src, False, now, log)
    elif st["task"].get("u0") is None:
        st["task"]["u0"] = u
    return weff


def window_for(st, u, model):
    """(окно, источник) сессии; окно 1M, раз увиденное (модель или U больше окна), держится до конца сессии."""
    window, src = session_window(u, model)
    if window == ONE_M:
        st["one_m"] = True
    elif st.get("one_m"):
        window, src = ONE_M, "1M раньше в сессии"
    return window, src


def remember(st, v, now):
    st.update(u=v["u"], s=round(v["s"], 4), weff=v["weff"], window=v["window"], ts=int(now))


# ---------------------------------------------------------------- CLI сессии

def _sid(args):
    sid = safe_sid(args.session or os.environ.get("CLAUDE_CODE_SESSION_ID"))
    if not sid:
        print("ctx_budget: нет id сессии — CLAUDE_CODE_SESSION_ID или --session", file=sys.stderr)
        raise SystemExit(2)
    return sid


def _measure(sid, st):
    """(U, окно, источник окна) по транскрипту сессии; U None — нет usage."""
    transcript = find_transcript(sid, st)
    u, model = last_answer(transcript) if transcript else (None, None)
    if transcript:
        st["transcript"] = str(transcript)
    return (u,) + window_for(st, u, model)


def cmd_next(args):
    try:
        size = parse_size(args.size)
    except ValueError:
        print("ctx_budget: --size — S|M|L или n%% (0 < n ≤ 100), не %r" % args.size, file=sys.stderr)
        return 2
    sid, now = _sid(args), time.time()
    with session_lock(sid):
        st = load_state(sid)
        (u, window, _), params = _measure(sid, st), load_params()
        cal = calibration(params)
        if u is not None:
            weff = refresh(st, sid, u, window, params, now)
        else:
            weff = w_eff(window, params)[0]
            st.setdefault("role", session_role())
            st.setdefault("printed", [])
        src = "заявлена" + (" × калибровка %s" % ("%.2f" % cal).replace(".", ",") if cal > 1 else "")
        start_task(st, sid, u, weff, clamp(size * cal, T_RANGE), src, True, now)
        if u is None:
            save_state(sid, st)
            print("задача ~%s %% записана; usage в транскрипте нет — вердикт даст хук" % pct(st["task"]["t"]))
            return 0
        v = verdict(st, u, window, params)
        if v["kind"] == "ok":
            st["printed"].append(v["key"])  # хук не повторит; передачу хук скажет сам — с шагами
        remember(st, v, now)
        save_state(sid, st)
    print("задача «%s» ~%s %% (%s): %s" % (args.task[:80], pct(v["t"]), v["tsrc"], line(v)))
    return 0


def cmd_done(args):
    sid, now = _sid(args), time.time()
    with session_lock(sid):
        st = load_state(sid)
        (u, window, _), params = _measure(sid, st), load_params()
        if u is None:
            print("ctx_budget: в транскрипте нет usage — границу не поставить", file=sys.stderr)
            return 1
        weff = refresh(st, sid, u, window, params, now)
        old = st["task"]
        spent = max(0.0, (u - old["u0"]) / weff)
        t, src = task_estimate(st["role"], params)
        start_task(st, sid, u, weff, t, src, False, now)
        st["xseq"] = st.get("xseq", 0) + 1  # границу поставила сессия: передачу можно сказать заново
        v = verdict(st, u, window, params)
        if v["kind"] == "ok":
            st["printed"].append(v["key"])
        remember(st, v, now)
        save_state(sid, st)
    print("задача закрыта (факт ~%s %%, оценка ~%s %%). Граница: %s" % (pct(spent), pct(old["t"]), line(v)))
    return 0


def cmd_status(args):
    sid, now = _sid(args), time.time()
    st = load_state(sid)  # status ничего не записывает
    (u, window, win_src), params = _measure(sid, st), load_params()
    if u is None:
        print("ctx_budget: в транскрипте сессии %s нет usage" % sid, file=sys.stderr)
        return 1
    refresh(st, sid, u, window, params, now, log=False)
    v = verdict(st, u, window, params)
    print("контекст %s %% (U %dK / W_eff %dK — %s; окно %dK — %s) · передача ~%s %% (%s) · задача ~%s %% (%s%s) · "
          "потолок 98,5 %%, передача не раньше 85 %%" % (
              pct(v["s"]), u // 1000, v["weff"] // 1000, v["wsrc"], window // 1000, win_src, pct(v["h"]), v["hsrc"],
              pct(v["t"]), v["tsrc"], ", граница" if v["boundary"] else ", осталось ~%s %%" % pct(v["rem"])))
    print("решение: " + line(v))
    return 0


def cmd_learn(args):
    import ctx_budget_params
    return ctx_budget_params.run(args)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ctx_budget.py", description="Бюджет окна сессии (решение владельца 06.11)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("next", help="начать задачу и получить вердикт")
    p.add_argument("task")
    p.add_argument("--size", required=True, help="S|M|L|<n%%>")
    p.add_argument("--session")
    p.set_defaults(fn=cmd_next)
    for name, fn, hint in (("done", cmd_done, "закрыть задачу — граница"), ("status", cmd_status, "бюджет сейчас")):
        p = sub.add_parser(name, help=hint)
        p.add_argument("--session")
        p.set_defaults(fn=fn)
    p = sub.add_parser("learn", help="пересчитать параметры по транскриптам ~/.claude/projects/*")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--projects", help="каталог транскриптов (по умолчанию CTX_BUDGET_PROJECTS или ~/.claude/projects)")
    p.add_argument("--out", help="файл параметров (по умолчанию CTX_BUDGET_DIR/params.json)")
    p.add_argument("--dry-run", action="store_true", help="посчитать и напечатать, не записывая")
    p.set_defaults(fn=cmd_learn)
    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except (TimeoutError, OSError) as exc:
        print("ctx_budget: %s" % (exc if isinstance(exc, TimeoutError) else type(exc).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
