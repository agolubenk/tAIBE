"""Передача Контроля сторожем retire (IS-233): если предшественник — Контроль, его sessionId в
`.claude/merge-guard.local.json` каждой папки --guard заменяется на sessionId проверенного наследника.

Передать Контроль может только сам Контроль и только свой: сторож запускает предшественник (spawn_session.sh
--handoff), и меняется только запись с его sessionId. Сессия не в списке ничего не передаёт. Личность обеих сессий —
из реестра `~/.claude/sessions/<pid>.json` того же старта процесса: этот реестр, как и список Контроля, хук
merge-guard закрывает от записи агентами. Наследник ещё и сверяется с окном, которое открыл spawn_session.sh: его tty
(аргумент сторожа --succ-tty, не запись линии — папку линий правят агенты) и родитель — пусковой скрипт или shell этого
окна (вложенный claude, переподвешенный к launchd, не пройдёт). Папка списка — корень репозитория по .git (worktree —
через commondir), и только если хук, режущий путь по «/worktrees/», прочтёт ту же.

Два прохода (GLM #120 104b29f96, F1/S2): сначала предшественник снимается со всех списков (`mid`), потом наследник
вписывается во все (`new`); откат — в обратном порядке. Сторож, убитый на любой записи, оставляет Контроль не больше
чем у одной из двух сессий: в худшем случае в одной папке Контроля нет ни у кого (хук отказывает громко), а не у обеих
молча. Каждая запись требует ровно ожидаемый прежний текст: правку владельца между проходами не затираем.

При любом сомнении — ни одной записи (fail-closed): предшественник не снимается, владельцу остаётся s-пункт. Сомнение —
список испорчен, ссылка или файл с жёсткими ссылками, папку не свести к корню репозитория, папка `.claude` или список
не те, что при старте сторожа (пины: dev, inode, время рождения — подмена `mv .claude …; mkdir .claude`, удаление или
появление списка), наследник уже в списке рядом с предшественником, sessionId предшественника не известен, tty окна не
передан, блокировка не взята за LOCK_WAIT, остался несогласованный журнал прерванной передачи, наследник не
подтвердился после записи. Папка `.claude` удерживается открытой от чтения до конца: временный файл, rename и fsync —
через её fd. Журнал `guard-handover.intent.json` пишется до первой записи списка и снимается после полной передачи или
полного отката; сторож убит — журнал остаётся, и следующая передача идёт, только если все списки в одном конце (все
`old` или все `new`). Блокировка и журнал — в `~/.claude/sessions/lineage-guard/` (state_dir): реестр сессий хук
закрывает от агентов. Прежний текст каждой папки — в `merge-guard.local.json.before-handover` (одна копия).
Файловая часть (корень по .git, пины, чтение и запись через fd папки) — lineage_guard_fs.py.
"""
import errno
import fcntl
import json
import os
import re
import time

from lineage import LAUNCHER_RE, SHELLS, ancestor_claude, argv0, norm, read_json, sessions_dir
from lineage_guard_fs import (ABSENT, GUARD, MAX_LIST, MISSING, fsync_dir, guard_dirs, open_dir, pin_of, read_control,
                              read_list, same_dir, sweep_tmp, write_atomic)
from lineage_guard_fs import main_root, take_pins  # noqa: F401 — API модуля: cmd_retire, тесты

BACKUP = GUARD.name + ".before-handover"
INTENT = "guard-handover.intent.json"
LOCK_WAIT = 60.0  # с на чужую передачу под guard.lock; дольше — отказ, а не вечное ожидание
FATAL_ERRNO = {errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM, errno.EROFS}  # повтор open их не исправит
SID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SKIP = object()  # в папке передавать нечего: списка не было и нет, или предшественника в нём нет
KEEP = "guard не трогаю, предшественника не снимаю"


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


def state_dir():
    """guard.lock и журнал передачи: папка в реестре сессий, который хук merge-guard закрывает от записи агентами."""
    return sessions_dir() / "lineage-guard"


def lock(wait):
    """fd взятой guard.lock или None за wait с. Файл блокировки удалили и создали заново, пока ждали, — наш flock
    на старом inode ничего не исключает: берём заново. Занято или другой inode — ждём и сверяемся со сроком: файл,
    который пересоздают на каждой попытке, не крутит цикл вечно. Ошибка, которую повтор не исправит (ссылка вместо
    файла, нет прав, не папка), — отказ сразу (fail-closed)."""
    path = state_dir() / "guard.lock"
    deadline = time.monotonic() + wait
    while True:
        try:
            fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        except OSError as e:
            if e.errno in FATAL_ERRNO:
                return None
            fd = None
        if fd is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if os.stat(path).st_ino == os.fstat(fd).st_ino:
                    return fd
            except OSError:  # BlockingIOError — занято; FileNotFoundError — файл удалили после open
                pass
            os.close(fd)
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.2)


class Target:
    """Папка, где предшественник в списке: удерживаемый fd `.claude`, пины, тексты old → mid → new и где список
    сейчас (state)."""
    __slots__ = ("f", "dfd", "dpin", "old", "doc", "ctl", "mode", "fpin", "mid", "new", "state")

    def __init__(self, f, dfd, dpin, got):
        self.f, self.dfd, self.dpin = f, dfd, dpin
        self.old, self.doc, self.ctl, self.mode, self.fpin = got
        self.mid = self.new = None
        self.state = "old"

    def texts(self, pred_sid, succ_sid):
        def dump(ctl):
            return json.dumps(dict(self.doc, control=ctl), ensure_ascii=False) + "\n"
        self.mid = dump([e for e in self.ctl if not entry_is(e, pred_sid)])
        self.new = dump(new_control(self.ctl, pred_sid, succ_sid))


def replaced(log, path):
    log(f"Контроль: {path} заменён, удалён или появился после старта сторожа (правка владельца?) — если Контроль уже "
        "выдан руками, делать ничего не нужно")
    return None


def plan_dir(d, pred_sid, log, pin):
    """Target папки d; SKIP — передавать здесь нечего; None — сомнение. Папка и список сверяются с пином старта
    сторожа: любое расхождение (другой inode или время рождения, был — пропал, не было — появился) — отказ (GLM #120
    104b29f96, M6)."""
    f = d / GUARD
    if pin is None:
        log(f"Контроль: {d} не снят при старте сторожа — не сверить, та ли это папка")
        return None
    dpin0, fpin0 = pin
    try:
        dfd = open_dir(f.parent)
    except FileNotFoundError:
        if dpin0 == ABSENT:
            log(f"Контроль: в {d} списка нет — эту папку пропускаю")
            return SKIP
        return replaced(log, f.parent)
    except OSError:
        return None
    keep = False
    try:
        dpin = pin_of(os.fstat(dfd))
        if dpin != dpin0:
            return replaced(log, f.parent)
        sweep_tmp(dfd)
        got = read_list(dfd)
        if got is MISSING:
            if fpin0 == ABSENT:
                log(f"Контроль: в {d} списка нет — эту папку пропускаю")
                return SKIP
            return replaced(log, f)
        if got is None:
            return None
        if got[4] != fpin0:
            return replaced(log, f)
        if not any(entry_is(e, pred_sid) for e in got[2]):
            return SKIP
        keep = True
        return Target(f, dfd, dpin, got)
    finally:
        if not keep:
            os.close(dfd)


def plan(dirs, pred_sid, log, pins):
    """[Target] папок, где предшественник в списке; None — сомнение хоть в одной (тогда все fd закрыты)."""
    todo = []
    for d in dirs:
        t = plan_dir(d, pred_sid, log, pins.get(str(d)))
        if t is None:
            for x in todo:
                os.close(x.dfd)
            return None
        if t is not SKIP:
            todo.append(t)
    return todo


def successor_sid(procs, s, tty):
    """(sessionId наследника, None) или (None, причина): наследник — сессия верхнего уровня (не запущена из Bash
    другой сессии claude), на tty окна, которое открыл spawn_session.sh (tty — аргумент сторожа, не запись линии:
    папку линий правят агенты), его родитель — пусковой скрипт или shell этого окна, и он в реестре сессий того же
    старта."""
    if s is None:
        return None, "наследник не жив"
    up = ancestor_claude(procs, s.ppid)
    if up is not None:
        return None, f"наследник {s.pid} запущен из другой сессии claude ({up.pid})"
    tty = str(tty or "")
    if not tty:
        return None, f"сторожу tty окна не передан — наследника {s.pid} не сверить с окном spawn_session"
    if tty != "/dev/" + str(s.tty):
        return None, f"наследник {s.pid} не на tty окна spawn_session ({tty})"
    par = procs.get(s.ppid)
    if par is None or s.ppid <= 1 or par.tty != s.tty or not (
            LAUNCHER_RE.search(par.command) or argv0(par).lstrip("-") in SHELLS):
        return None, f"родитель наследника {s.pid} ({s.ppid}) — не пусковой скрипт или shell окна"
    # Вся цепочка окна (лаунчер/shell → login) не переподвешена к launchd (GLM #120 7fb2287d2, находка 1): потомок Bash
    # наследника, умершего без квитанции, висит под осиротевшим shell (ppid 1). Выше окна — приложение терминала без tty.
    a, seen = par, set()
    while a is not None and a.tty == s.tty:
        if a.ppid <= 1 or a.pid in seen:
            return None, f"цепочка наследника {s.pid} оборвана у {a.pid} (переподвешен к launchd) — не окно spawn_session"
        seen.add(a.pid)
        a = procs.get(a.ppid)
    if a is None:
        return None, f"над окном наследника {s.pid} нет приложения терминала"
    sid = session_id(s)
    return (sid, None) if sid else (None, f"наследника {s.pid} нет в реестре сессий")


def new_control(ctl, pred_sid, succ_sid):
    """Замена один в один; схлопывается только повтор наследника."""
    out = []
    for e in ctl:
        x = succ_sid if entry_is(e, pred_sid) else e
        if x == succ_sid and succ_sid in out:
            continue
        out.append(x)
    return out


def hand_control(dirs, pred_sid, succ, suffix, log, lock_wait=LOCK_WAIT, *, pins):
    """succ — (sessionId наследника, причина отказа) или функция без аргументов, которая его возвращает: она
    вызывается под guard.lock прямо перед первой записью — наследник, упавший за ожидание блокировки, Контроль не
    получит. pins — снимок take_pins при старте сторожа (обязателен: без него подмену папки не заметить; None —
    снимок не удался). True — передано или передавать нечего; False — предшественника не снимать: сбой, сомнение или
    наследник не подтверждён. Списки тогда как были, кроме застрявшего отката — о нём строка «передача застряла»."""
    asked = bool(dirs)
    dirs = guard_dirs(dirs)
    if dirs is None:
        log(f"Контроль: папку --guard не свести к корню репозитория по .git (или хук прочтёт другую) — {KEEP}")
        return False
    if not dirs:
        if asked:
            log("Контроль: нет папок guard (все --guard пустые) — не проверить, Контроль ли предшественник; "
                "предшественника не снимаю")
            return False
        return True
    if not pred_sid:
        if any(read_control(d / GUARD) is not MISSING for d in dirs):
            log("Контроль: sessionId предшественника не известен — не проверить, Контроль ли он; предшественника не снимаю")
            return False
        return True
    if pins is None:
        log(f"Контроль: при старте сторожа папки guard не сняты (ссылка или нет прав) — {KEEP}")
        return False
    sd = state_dir()
    try:
        sd.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as e:
        log(f"Контроль: папка блокировки {sd} не создана ({e}) — {KEEP}")
        return False
    if sd.is_symlink() or not sd.is_dir():
        log(f"Контроль: {sd} — ссылка или не папка — {KEEP}")
        return False
    # Два сторожа одного предшественника (дубль наследника): передаёт первый, второй уже не найдёт его в списке.
    fd = lock(lock_wait)
    if fd is None:
        log(f"Контроль: guard.lock занят дольше {lock_wait:.0f} с — {KEEP}")
        return False
    try:
        return locked_handover(dirs, pred_sid, succ, suffix, log, pins)
    finally:
        os.close(fd)


def locked_handover(dirs, pred_sid, succ, suffix, log, pins):
    intent = state_dir() / INTENT
    if os.path.lexists(intent):
        if not settled(intent, pins):
            # Сторож, убитый на записи, строку «передача застряла» не оставил — её пишет следующий, по журналу.
            j = read_journal(intent)
            why = stuck({"from": j[0], "to": j[1], "files": j[2]}, j[4]) if j else "журнал не прочесть"
            log(f"Контроль: остался журнал прерванной передачи {intent}: списки не в одном конце или папки не те; "
                f"{why}; {KEEP}")
            return False
        log(f"Контроль: журнал прерванной передачи {intent} — списки согласованы, снимаю его")
        drop_intent(intent, log)  # не удалился — не беда: новый журнал ляжет поверх (GLM #120 104b29f96, minor 5)
    todo = plan(dirs, pred_sid, log, pins)
    if todo is None:
        log(f"Контроль: список в одной из папок испорчен, это ссылка или он не тот, что при старте сторожа — {KEEP}")
        return False
    try:
        return handover(todo, pred_sid, succ, suffix, log, intent)
    finally:
        for t in todo:
            os.close(t.dfd)


def handover(todo, pred_sid, succ, suffix, log, intent):
    if not todo:
        log(f"Контроль: предшественника ({pred_sid[:8]}) нет в списке — передавать нечего")
        return True
    succ_sid, why = succ() if callable(succ) else succ
    if not succ_sid:
        log(f"Контроль: {why} — {KEEP}")
        return False
    if any(entry_is(e, succ_sid) for t in todo for e in t.ctl):  # GLM #120 104b29f96, M1: тогда mid == new
        log(f"Контроль: наследник {succ_sid[:8]} уже в списке рядом с предшественником {pred_sid[:8]} — кому из них "
            f"Контроль, решает владелец; {KEEP}")
        return False
    for t in todo:
        t.texts(pred_sid, succ_sid)
    j = {"from": pred_sid[:8], "to": succ_sid[:8], "line": suffix, "files": [str(t.f) for t in todo],
         "dirpins": [list(t.dpin) for t in todo]}
    try:
        journal(intent, j, "revoke")  # до первой записи списка (M2)
    except OSError as e:
        log(f"Контроль: журнал передачи не записан ({e}) — {KEEP}")
        return False
    phase = "revoke"
    try:
        for t in todo:
            write_atomic(t.f.with_name(BACKUP), t.old, 0o600, dfd=t.dfd)
        for t in todo:
            step(t, t.old, t.mid, "mid")
        phase = "grant"
        journal(intent, j, phase)
        for t in todo:
            step(t, t.mid, t.new, "new")
        for t in todo:
            back = read_list(t.dfd)
            if not isinstance(back, tuple) or back[0] != t.new or back[4] != t.fpin:
                raise OSError(f"сверка {t.f} не прошла")
        if callable(succ):  # наследник мог упасть за время записи — Контроль не должен остаться за мёртвой сессией
            again, why = succ()
            if again != succ_sid:
                raise OSError(f"наследник после записи не подтверждён ({why or 'другой sessionId'})")
    except OSError as e:
        return roll_back(todo, j, phase, e, log, intent)
    drop_intent(intent, log)
    log(f"Контроль: {pred_sid[:8]} → {succ_sid[:8]} в {len(todo)} папк. (линия {suffix}, копия {BACKUP})")
    return True


def journal(intent, j, phase):
    write_atomic(intent, json.dumps(dict(j, phase=phase)) + "\n", 0o600)


def step(t, expect, text, state, check_dir=True):
    """Одна запись списка t через удерживаемый fd папки — только поверх ровно ожидаемого текста того же файла (M3):
    правку владельца не затираем. После записи папка по пути должна остаться той же (M4); откат пишет в удерживаемые
    папки без этой сверки — именно туда шли наши записи."""
    cur = read_list(t.dfd)
    if not isinstance(cur, tuple) or cur[0] != expect or cur[4] != t.fpin:
        raise OSError(f"{t.f} изменился после чтения")
    t.fpin = write_atomic(t.f, text, t.mode, dfd=t.dfd)
    t.state = state
    if check_dir and not same_dir(t.f.parent, t.dpin):
        raise OSError(f"папка {t.f.parent} подменена после записи")


def roll_back(todo, j, phase, err, log, intent):
    """Откат по проходам: все new → mid, потом все mid → old; на каждом шаге Контроль не больше чем у одной сессии.
    Расхождение или сбой — стоп: журнал остаётся, строка «передача застряла» называет допустимые концы (M7)."""
    try:
        for t in todo:
            if t.state == "new":
                step(t, t.new, t.mid, "mid", check_dir=False)
        for t in todo:
            if t.state == "mid":
                step(t, t.mid, t.old, "old", check_dir=False)
    except OSError as e2:
        log(f"Контроль: сбой записи ({err}), откат не полон ({e2}) — {stuck(j, phase)}; предшественника не снимаю")
        return False
    drop_intent(intent, log)
    log(f"Контроль: сбой записи ({err}) — файлы возвращены, предшественника не снимаю")
    return False


def stuck(j, phase):
    what = "снятие предшественника" if phase == "revoke" else "вписывание наследника"
    return (f"передача застряла на этапе «{what}» (предшественник {j['from']} → наследник {j['to']}). Списки: "
            f"{', '.join(j['files'])}. Допустимые концы: (a) вернуть предшественника {j['from']} в каждый список — "
            f"прежний текст в {BACKUP} рядом со списком; (b) наследник {j['to']} в каждом списке. Журнал "
            f"{INTENT} не удалять: следующая передача снимет его сама, когда все списки в одном конце; смешанные концы "
            "держат передачу закрытой")


def read_journal(intent):
    """(from, to, files, dirpins, phase) журнала передачи; None — не прочесть или не того вида."""
    try:
        with open(intent, encoding="utf-8") as fh:
            j = json.loads(fh.read(MAX_LIST))
        frm, to, files, dps = str(j["from"]), str(j["to"]), j["files"], j["dirpins"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if len(frm) < 8 or len(to) < 8 or not isinstance(files, list) or not files or not isinstance(dps, list) \
            or len(dps) != len(files):
        return None
    return frm, to, [str(f) for f in files], dps, str(j.get("phase") or "")


def settled(intent, pins):
    """Журнал прерванной передачи можно снять (GLM #120 104b29f96, M7): все его списки в одном конце — у всех
    предшественник без наследника (old) или у всех наследник без предшественника (new), — и папка каждого та же, что в
    журнале и при старте этого сторожа (журнал с чужими пинами не согласован). mid — не конец. Журнал в state_dir:
    агенты его не пишут."""
    j = read_journal(intent)
    if j is None:
        return False
    frm, to, files, dps, _ = j
    ends = set()
    for f, dp in zip(files, dps):
        pin = (pins or {}).get(os.path.dirname(os.path.dirname(f)))
        got = read_control(f)
        if not isinstance(got, tuple) or not isinstance(dp, list) or pin is None or tuple(dp) != got[5] \
                or got[5] != pin[0]:
            return False
        has_from, has_to = any(e[:8] == frm for e in got[2]), any(e[:8] == to for e in got[2])
        if has_from == has_to:  # mid (ни того, ни другого) или оба сразу
            return False
        ends.add(has_from)
    return len(ends) == 1


def drop_intent(intent, log):
    """Журнал удаляется после согласованной записи. Не удалился — передача уже сделана (или откачена), исход не
    меняется: следующая передача найдёт списки в одном конце и снимет его сама."""
    try:
        os.unlink(intent)
    except FileNotFoundError:
        pass
    except OSError as e:
        log(f"Контроль: журнал {intent} не удалён ({e}) — списки согласованы; следующая передача снимет его сама")
        return
    fsync_dir(intent.parent)
