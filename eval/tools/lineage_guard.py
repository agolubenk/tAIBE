"""Передача Контроля сторожем retire (IS-233): если предшественник — Контроль, его sessionId в
`.claude/merge-guard.local.json` каждой папки --guard заменяется на sessionId проверенного наследника.

Передать Контроль может только сам Контроль и только свой: сторож запускает предшественник (spawn_session.sh
--handoff), и меняется только запись с его sessionId. Сессия не в списке ничего не передаёт. Личность обеих сессий —
из реестра `~/.claude/sessions/<pid>.json` того же старта процесса: этот реестр, как и список Контроля, хук
merge-guard закрывает от записи агентами. Наследник ещё и сверяется с tty окна, которое открыл spawn_session.sh.

Все папки или ни одной: сбой записи или сверки в любой — уже записанные возвращаются из копии `.before-<суффикс>`,
и предшественник не снимается (Контроль не теряется). Владельцу остаётся прежний путь — s-пункт.
"""
import fcntl
import json
import os
import re
from pathlib import Path

from lineage import ancestor_claude, ldir, norm, read_json, sessions_dir

GUARD = Path(".claude") / "merge-guard.local.json"
SID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def session_id(p):
    """sessionId процесса claude p из реестра — только если запись того же старта (pid мог уйти другому процессу)."""
    d = read_json(sessions_dir() / f"{p.pid}.json") if p else None
    if not isinstance(d, dict) or norm(d.get("procStart")) != norm(p.start):
        return None
    sid = str(d.get("sessionId") or "")
    return sid if SID_RE.fullmatch(sid) else None


def entry_is(entry, sid):
    """Та же сверка, что у хука (merge_guard_identity.control_verdict): весь sessionId или префикс от 8 знаков."""
    return entry == sid or (len(entry) >= 8 and sid.startswith(entry))


def main_root(path):
    """Список Контроля хук читает из основной папки, не из worktree."""
    return Path(str(Path(path).resolve()).split("/worktrees/", 1)[0])


def guard_dirs(dirs):
    out = []
    for d in dirs:
        r = main_root(d)
        if r not in out:
            out.append(r)
    return out


def read_control(f):
    """(весь документ, список control) или None — файл испорчен или его нет."""
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    ctl = doc.get("control") if isinstance(doc, dict) else None
    if not isinstance(ctl, list) or not all(isinstance(x, str) for x in ctl):
        return None
    return doc, ctl


def write_atomic(f, text, mode):
    tmp = f.with_name(f.name + ".tmp-handover")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, f)


def plan(dirs, pred_sid):
    """[(файл, старый текст, новый документ)] для папок, где предшественник в списке; None — где-то файл испорчен."""
    todo = []
    for d in dirs:
        f = d / GUARD
        if not f.exists():
            continue
        got = read_control(f)
        if got is None:
            return None
        doc, ctl = got
        if any(entry_is(e, pred_sid) for e in ctl):
            todo.append((f, f.read_text(encoding="utf-8"), doc))
    return todo


def successor_sid(procs, s, child):
    """(sessionId наследника, None) или (None, причина): наследник — сессия верхнего уровня (не запущена из Bash
    другой сессии claude), на tty окна, которое открыл spawn_session.sh (запись линии), и в реестре сессий того же
    старта."""
    up = ancestor_claude(procs, s.ppid)
    if up is not None:
        return None, f"наследник {s.pid} запущен из другой сессии claude ({up.pid})"
    rec = read_json(ldir() / f"{child}.json") or {}
    tty = str(rec.get("tty") or "")
    if not tty or tty != "/dev/" + str(s.tty):
        return None, f"наследник {s.pid} не на tty окна spawn_session ({tty or 'в записи линии tty нет'})"
    sid = session_id(s)
    return (sid, None) if sid else (None, f"наследника {s.pid} нет в реестре сессий")


def hand_control(dirs, pred_sid, succ, suffix, log):
    """succ — (sessionId наследника, причина отказа). True — передано или передавать нечего; False — сбой или
    наследник не подтверждён: все файлы как были, предшественника не снимать (Контроль не теряется)."""
    if not pred_sid:
        log("Контроль: sessionId предшественника не известен — guard не трогаю")
        return True
    dirs = guard_dirs(dirs)
    if not dirs:
        return True
    ldir().mkdir(parents=True, exist_ok=True, mode=0o700)
    # Два сторожа одного предшественника (дубль наследника): передаёт первый, второй уже не найдёт его в списке.
    with open(ldir() / "guard.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        todo = plan(dirs, pred_sid)
        if todo is None:
            log("Контроль: список в одной из папок испорчен — guard не трогаю, предшественника не снимаю")
            return False
        if not todo:
            log(f"Контроль: предшественника ({pred_sid[:8]}) нет в списке — передавать нечего")
            return True
        succ_sid, why = succ
        if not succ_sid:
            log(f"Контроль: {why} — guard не трогаю, предшественника не снимаю")
            return False
        done = []
        try:
            for f, old, doc in todo:
                backup = f.with_name(f"{f.name}.before-{suffix}")
                if not backup.exists():
                    write_atomic(backup, old, 0o600)
                ctl = [succ_sid if entry_is(e, pred_sid) else e for e in doc["control"]]
                doc["control"] = list(dict.fromkeys(ctl))
                write_atomic(f, json.dumps(doc, ensure_ascii=False) + "\n", f.stat().st_mode & 0o777)
                done.append((f, old))
                back = read_control(f)
                if back is None or succ_sid not in back[1] or any(entry_is(e, pred_sid) for e in back[1]):
                    raise OSError(f"сверка {f} не прошла")
        except OSError as e:
            for f, old in done:
                try:
                    write_atomic(f, old, f.stat().st_mode & 0o777)
                except OSError as e2:
                    log(f"Контроль: откат {f} не удался ({e2}) — восстановить из .before-{suffix} руками")
            log(f"Контроль: сбой записи ({e}) — файлы возвращены, предшественника не снимаю")
            return False
    log(f"Контроль: {pred_sid[:8]} → {succ_sid[:8]} в {len(done)} папк. (копия .before-{suffix})")
    return True
