"""Передача Контроля сторожем retire (IS-233): если предшественник — Контроль, его sessionId в
`.claude/merge-guard.local.json` каждой папки --guard заменяется на sessionId проверенного наследника.

Передать Контроль может только сам Контроль и только свой: сторож запускает предшественник (spawn_session.sh
--handoff), и меняется только запись с его sessionId. Сессия не в списке ничего не передаёт. Личность обеих сессий —
из реестра `~/.claude/sessions/<pid>.json` того же старта процесса: этот реестр, как и список Контроля, хук
merge-guard закрывает от записи агентами. Наследник ещё и сверяется с окном, которое открыл spawn_session.sh: его tty
(аргумент сторожа --succ-tty, не запись линии — папку линий правят агенты) и родитель — пусковой скрипт или shell этого
окна (вложенный claude, переподвешенный к launchd, не пройдёт). Папка списка — корень репозитория по .git (worktree —
через commondir), и только если хук, режущий путь по «/worktrees/», прочтёт ту же.

Все папки или ни одной, и при любом сомнении — ни одной (fail-closed): предшественник не снимается, Контроль не
теряется, владельцу остаётся прежний путь — s-пункт. Сомнение — список испорчен, это ссылка или файл с жёсткими
ссылками, папку не свести к корню репозитория, sessionId предшественника не известен, tty окна не передан, блокировка
не взята за LOCK_WAIT, остался журнал прерванной передачи, наследник не подтвердился после записи. Сбой записи в любой
папке — уже записанные возвращаются к прежнему тексту. Сторож убит между записями — журнал `guard-handover.intent.json`
остаётся, и следующая передача отказывает, пока человек не сверит списки и не удалит его. Блокировка и журнал — в
`~/.claude/sessions/lineage-guard/` (state_dir): реестр сессий хук закрывает от агентов, подложить журнал и заблокировать
передачу агент не может. Журнал только сигнал: содержимого для записи в нём нет.
Прежний текст каждой папки — в `merge-guard.local.json.before-handover` (одна копия, перезаписывается).
"""
import errno
import fcntl
import json
import os
import re
import stat
import tempfile
import time
from pathlib import Path

from lineage import LAUNCHER_RE, SHELLS, ancestor_claude, argv0, norm, read_json, sessions_dir

GUARD = Path(".claude") / "merge-guard.local.json"
BACKUP = GUARD.name + ".before-handover"
INTENT = "guard-handover.intent.json"
LOCK_WAIT = 60.0  # с на чужую передачу под guard.lock; дольше — отказ, а не вечное ожидание
FATAL_ERRNO = {errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM, errno.EROFS}  # повтор open их не исправит
MAX_LIST = 1 << 20  # список Контроля — килобайты; больше 1 МБ — испорчен (лог, дамп), не читаем
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


def state_dir():
    """guard.lock и журнал передачи: папка в реестре сессий, который хук merge-guard закрывает от записи агентами."""
    return sessions_dir() / "lineage-guard"


def head(path, n=4096):
    """Начало файла (≤ n байт) текстом; None — не прочесть."""
    try:
        with open(path, "rb") as fh:
            return fh.read(n).decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def common_root(top, gitfile):
    """Основная папка worktree по файлу .git: «gitdir: X» → X/commondir → общая .git → её родитель; None — не так."""
    text = head(gitfile)
    first = text.splitlines()[0] if text else ""
    if not first.startswith("gitdir:"):
        return None
    gd = Path(first[len("gitdir:"):].strip())
    gd = gd if gd.is_absolute() else top / gd
    rel = (head(gd / "commondir") or "").strip()
    if not rel:
        return None
    common = Path(rel) if Path(rel).is_absolute() else gd / rel
    common = common.resolve()
    return common.parent if common.name == ".git" and common.is_dir() else None


def main_root(path):
    """Основная папка репозитория, из которой хук читает список Контроля (worktree → основной checkout); None —
    сомнение. Корень — по .git, не по подстроке пути. Хук режет путь проекта по «/worktrees/»
    (pre-tool-use-merge-guard.py, main_roots): прочтёт другую папку (например, «/worktrees/» выше корня) — None."""
    p = Path(path).resolve()
    for top in (p, *p.parents):
        g = top / ".git"
        if g.is_dir():
            root = top
            break
        if g.is_file():
            root = common_root(top, g)
            break
    else:
        return None
    if root is None or str(top).split("/worktrees/", 1)[0] != str(root):
        return None
    return root


def guard_dirs(dirs):
    """Основные папки --guard без повторов; None — хоть одну не свести к корню репозитория (сомнение)."""
    out = []
    for d in dirs:
        if not str(d or "").strip():  # spawn_session.sh: пустой --guard, если cd не вышел, — не текущая папка
            continue
        r = main_root(d)
        if r is None:
            return None
        if r not in out:
            out.append(r)
    return out


MISSING = object()  # списка нет (нет файла или папки .claude) — папку пропускаем


def open_dir(path):
    """fd папки path, пройденной от «/» без перехода по ссылкам на каждом звене (GLM #120 7fb2287d2, находка 2):
    папку, подменённую ссылкой (.claude → /tmp/fake), не открыть — ELOOP или ENOTDIR, а не чужой список. path — уже
    без ссылок (корень из main_root — после resolve)."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
    except BaseException:
        os.close(fd)
        raise
    return fd


def read_control(f):
    """(текст, документ, список control, права) — одним чтением; путь пройден без перехода по ссылкам, и сам файл —
    не ссылка. MISSING — файла нет; None — сомнение: испорчен, ссылка на любом звене пути или несколько жёстких ссылок
    (rename заменил бы не тот файл, что читает хук). Предел MAX_LIST — самим чтением: файл мог вырасти после fstat."""
    try:
        dfd = open_dir(Path(f).parent)
    except FileNotFoundError:
        return MISSING
    except OSError:
        return None
    try:
        fd = os.open(Path(f).name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
    except FileNotFoundError:
        return MISSING
    except OSError:
        return None
    finally:
        os.close(dfd)
    try:
        with os.fdopen(fd, "rb") as fh:
            st = os.fstat(fh.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                return None
            data = fh.read(MAX_LIST + 1)
        if len(data) > MAX_LIST:
            return None
        text = data.decode("utf-8")
        doc = json.loads(text)
    except (OSError, ValueError):
        return None
    ctl = doc.get("control") if isinstance(doc, dict) else None
    if not isinstance(ctl, list) or not all(isinstance(x, str) for x in ctl):
        return None
    return text, doc, ctl, st.st_mode & 0o777


def fsync_dir(d):
    try:
        fd = os.open(str(d), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_atomic(f, text, mode):
    """Временный файл со случайным именем (mkstemp: O_EXCL, подложенная заранее ссылка не сработает) → fsync →
    rename поверх f (rename не идёт по ссылке) → fsync папки. Сбой — временный файл удаляется, fd закрыт (GLM #120
    89dcafeb9, minor resources: fchmod до with оставлял fd открытым на всю жизнь сторожа)."""
    f = Path(f)
    fd, tmp = tempfile.mkstemp(prefix=f.name + ".", suffix=".tmp-handover", dir=str(f.parent))
    try:
        try:
            fh = os.fdopen(fd, "w", encoding="utf-8")
        except BaseException:
            os.close(fd)
            raise
        with fh:
            os.fchmod(fh.fileno(), mode)
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, f)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(f.parent)


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


def plan(dirs, pred_sid, log):
    """[(файл, старый текст, документ, права)] для папок, где предшественник в списке; None — где-то файл испорчен."""
    todo = []
    for d in dirs:
        f = d / GUARD
        got = read_control(f)
        if got is MISSING:
            log(f"Контроль: в {d} списка нет — эту папку пропускаю")
            continue
        if got is None:
            return None
        text, doc, ctl, mode = got
        if any(entry_is(e, pred_sid) for e in ctl):
            todo.append((f, text, doc, mode))
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
    """Замена один в один; схлопывается только повтор наследника (он мог уже быть в списке)."""
    out = []
    for e in ctl:
        x = succ_sid if entry_is(e, pred_sid) else e
        if x == succ_sid and succ_sid in out:
            continue
        out.append(x)
    return out


def hand_control(dirs, pred_sid, succ, suffix, log, lock_wait=LOCK_WAIT):
    """succ — (sessionId наследника, причина отказа) или функция без аргументов, которая его возвращает: она
    вызывается под guard.lock прямо перед первой записью — наследник, упавший за ожидание блокировки, Контроль не
    получит. True — передано или передавать нечего; False — сбой, сомнение или наследник не подтверждён: все файлы как
    были, предшественника не снимать (Контроль не теряется)."""
    asked = bool(dirs)
    dirs = guard_dirs(dirs)
    if dirs is None:
        log("Контроль: папку --guard не свести к корню репозитория по .git (или хук прочтёт другую) — guard не трогаю, "
            "предшественника не снимаю")
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
    sd = state_dir()
    try:
        sd.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as e:
        log(f"Контроль: папка блокировки {sd} не создана ({e}) — guard не трогаю, предшественника не снимаю")
        return False
    if sd.is_symlink() or not sd.is_dir():
        log(f"Контроль: {sd} — ссылка или не папка — guard не трогаю, предшественника не снимаю")
        return False
    # Два сторожа одного предшественника (дубль наследника): передаёт первый, второй уже не найдёт его в списке.
    fd = lock(lock_wait)
    if fd is None:
        log(f"Контроль: guard.lock занят дольше {lock_wait:.0f} с — guard не трогаю, предшественника не снимаю")
        return False
    try:
        return locked_handover(dirs, pred_sid, succ, suffix, log)
    finally:
        os.close(fd)


def locked_handover(dirs, pred_sid, succ, suffix, log):
    intent = state_dir() / INTENT
    if os.path.lexists(intent):
        if not settled(intent):
            log(f"Контроль: остался журнал прерванной передачи {intent}, списки расходятся — сверить списки руками и "
                "удалить его; guard не трогаю, предшественника не снимаю")
            return False
        log(f"Контроль: журнал прерванной передачи {intent} — списки согласованы, снимаю его")
        drop_intent(intent, log)
        if os.path.lexists(intent):
            return False
    todo = plan(dirs, pred_sid, log)
    if todo is None:
        log("Контроль: список в одной из папок испорчен или это ссылка — guard не трогаю, предшественника не снимаю")
        return False
    if not todo:
        log(f"Контроль: предшественника ({pred_sid[:8]}) нет в списке — передавать нечего")
        return True
    succ_sid, why = succ() if callable(succ) else succ
    if not succ_sid:
        log(f"Контроль: {why} — guard не трогаю, предшественника не снимаю")
        return False
    try:
        write_atomic(intent, json.dumps({"from": pred_sid[:8], "to": succ_sid[:8], "line": suffix,
                                         "files": [str(f) for f, *_ in todo]}) + "\n", 0o600)
    except OSError as e:
        log(f"Контроль: журнал передачи не записан ({e}) — guard не трогаю, предшественника не снимаю")
        return False
    done = []
    try:
        # Сначала все сверки и копии, потом списки подряд, сверка после (GLM #120 7fb2287d2, находка 3): окно, в
        # котором убитый сторож оставит списки разными, — одна запись, а не цикл с копиями и сверками.
        for f, old, doc, mode in todo:
            now = read_control(f)  # список правили после plan() (владелец без guard.lock) — не затираем его правку
            if not isinstance(now, tuple) or now[0] != old:
                raise OSError(f"{f} изменился после чтения")
            write_atomic(f.with_name(BACKUP), old, 0o600)
        for f, old, doc, mode in todo:
            doc["control"] = new_control(doc["control"], pred_sid, succ_sid)
            new = json.dumps(doc, ensure_ascii=False) + "\n"
            write_atomic(f, new, mode)
            done.append((f, old, mode, new))
        for f, *_ in done:
            back = read_control(f)
            if not isinstance(back, tuple) or succ_sid not in back[2] or any(entry_is(e, pred_sid) for e in back[2]):
                raise OSError(f"сверка {f} не прошла")
        if callable(succ):  # наследник мог упасть за время записи — Контроль не должен остаться за мёртвой сессией
            again, why = succ()
            if again != succ_sid:
                raise OSError(f"наследник после записи не подтверждён ({why or 'другой sessionId'})")
    except OSError as e:
        lost = []
        for f, old, mode, new in done:
            cur = read_control(f)  # после нашей записи список правили — не затираем правку откатом (находка 6)
            if not isinstance(cur, tuple) or cur[0] != new:
                lost.append(f)
                log(f"Контроль: {f} изменён после записи — не откатываю, прежний текст в {BACKUP}")
                continue
            try:
                write_atomic(f, old, mode)
            except OSError as e2:
                lost.append(f)
                log(f"Контроль: откат {f} не удался ({e2}) — прежний текст в {BACKUP}")
        if lost:
            log(f"Контроль: сбой записи ({e}), откат не полон: {', '.join(str(f) for f in lost)} — сверить по "
                f"{BACKUP} и журналу {intent}; предшественника не снимаю")
            return False
        drop_intent(intent, log)
        log(f"Контроль: сбой записи ({e}) — файлы возвращены, предшественника не снимаю")
        return False
    drop_intent(intent, log)
    log(f"Контроль: {pred_sid[:8]} → {succ_sid[:8]} в {len(done)} папк. (линия {suffix}, копия {BACKUP})")
    return True


def settled(intent):
    """Журнал прерванной передачи можно снять (GLM #120 7fb2287d2, находки 7 и 14): во всех его списках
    предшественника нет (передача дошла или владелец уже сверил), или во всех он есть, а наследника нет (откат дошёл).
    Иначе — расхождение, его сверяет человек. Журнал в state_dir: агенты его не пишут."""
    try:
        with open(intent, encoding="utf-8") as fh:
            j = json.loads(fh.read(MAX_LIST))
        frm, to, files = str(j["from"]), str(j["to"]), j["files"]
    except (OSError, ValueError, KeyError, TypeError):
        return False
    if len(frm) < 8 or len(to) < 8 or not isinstance(files, list) or not files:
        return False
    marks = []
    for f in files:
        got = read_control(Path(str(f)))
        if not isinstance(got, tuple):
            return False
        marks.append((any(e[:8] == frm for e in got[2]), any(e[:8] == to for e in got[2])))
    return all(not a for a, _ in marks) or all(a and not b for a, b in marks)


def drop_intent(intent, log):
    """Журнал удаляется после согласованной записи. Не удалился — передача уже сделана (или откачена), исход не
    меняется; следующая передача откажет на журнале, пока человек не удалит его, — об этом строка журнала сторожа."""
    try:
        os.unlink(intent)
    except FileNotFoundError:
        pass
    except OSError as e:
        log(f"Контроль: журнал {intent} не удалён ({e}) — списки согласованы; удалить его руками, иначе следующая "
            "передача откажет")
        return
    fsync_dir(intent.parent)
