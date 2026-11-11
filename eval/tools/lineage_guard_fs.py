"""Файлы передачи Контроля (IS-233): корень репозитория по .git, пины папки `.claude` и списка, чтение и атомарная
запись списка через fd папки. Логика передачи — lineage_guard.py; здесь только файловая система.

Пин — (dev, inode, время рождения): снимается при старте сторожа (take_pins) и сверяется перед каждой записью. Подмена
`mv .claude …; mkdir .claude`, удаление или появление списка меняют пин; запись других файлов в папку — нет (GLM #120
104b29f96, S1). Временный файл, rename и fsync — через удерживаемый fd папки, а не через путь: путь мог смениться.
"""
import json
import os
import re
import secrets
import stat
from pathlib import Path

GUARD = Path(".claude") / "merge-guard.local.json"
MAX_LIST = 1 << 20  # список Контроля — килобайты; больше 1 МБ — испорчен (лог, дамп), не читаем
MISSING = object()  # списка нет (нет файла или папки .claude)
ABSENT = "absent"  # пин: при старте сторожа этого не было
TMP = ".tmp-handover"
TMP_RE = re.compile(re.escape(GUARD.name) + r"\.[0-9a-f]{12}" + re.escape(TMP))


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


def pin_of(st):
    """Пин файла или папки: (dev, inode, время рождения). Время рождения ловит inode, выданный заново после удаления,
    и не меняется от записи других файлов папки (ctime менялся бы). Нет st_birthtime (не macOS) — ctime в нс."""
    born = getattr(st, "st_birthtime", None)
    return (st.st_dev, st.st_ino, born if born is not None else st.st_ctime_ns)


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


def pins_now(root):
    """(пин .claude, пин списка) папки root сейчас; ABSENT — нет; None — сомнение (ссылка, нет прав)."""
    try:
        dfd = open_dir(Path(root) / ".claude")
    except FileNotFoundError:
        return ABSENT, ABSENT
    except OSError:
        return None
    try:
        try:
            st = os.stat(GUARD.name, dir_fd=dfd, follow_symlinks=False)
        except FileNotFoundError:
            return pin_of(os.fstat(dfd)), ABSENT
        except OSError:
            return None
        return pin_of(os.fstat(dfd)), pin_of(st)
    finally:
        os.close(dfd)


def take_pins(dirs):
    """Снимок папок списка в доверенный момент — при старте сторожа (cmd_retire), до ожидания квитанции (GLM #120
    104b29f96, S1): {корень: (пин .claude, пин списка)}; None — папку не свести к корню или она уже сомнительна."""
    roots = guard_dirs(dirs)
    if roots is None:
        return None
    out = {}
    for r in roots:
        p = pins_now(r)
        if p is None:
            return None
        out[str(r)] = p
    return out


def same_dir(path, dpin):
    """Папка по пути path — та же, что пин dpin (её не подменили после чтения или нашей записи)."""
    try:
        fd = open_dir(path)
    except OSError:
        return False
    try:
        return pin_of(os.fstat(fd)) == dpin
    finally:
        os.close(fd)


def read_list(dfd, name=GUARD.name):
    """(текст, документ, список control, права, пин файла) — одним чтением в открытой папке dfd; сам файл — не
    ссылка. MISSING — файла нет; None — сомнение: испорчен, ссылка или несколько жёстких ссылок (rename заменил бы не
    тот файл, что читает хук). Предел MAX_LIST — самим чтением: файл мог вырасти после fstat."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
    except FileNotFoundError:
        return MISSING
    except OSError:
        return None
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
    return text, doc, ctl, st.st_mode & 0o777, pin_of(st)


def read_control(f):
    """read_list по пути: путь пройден без перехода по ссылкам; к ответу добавлен пин папки. MISSING — нет файла или
    папки; None — сомнение."""
    try:
        dfd = open_dir(Path(f).parent)
    except FileNotFoundError:
        return MISSING
    except OSError:
        return None
    try:
        got = read_list(dfd, Path(f).name)
        return got + (pin_of(os.fstat(dfd)),) if isinstance(got, tuple) else got
    finally:
        os.close(dfd)


def sweep_tmp(dfd):
    """Свои временные файлы, оставленные убитым сторожем (`<список>.<12 hex>.tmp-handover`), — удалить. Только по
    точному имени: чужие файлы папки не трогаем; unlink ссылку не проходит."""
    try:
        names = os.listdir(dfd)
    except OSError:
        return
    for n in names:
        if TMP_RE.fullmatch(n):
            try:
                os.unlink(n, dir_fd=dfd)
            except OSError:
                pass


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


def write_at(dfd, name, text, mode):
    """Атомарная запись name в папке dfd: временный файл со случайным именем (O_EXCL|O_NOFOLLOW — подложенная заранее
    ссылка не сработает) → fsync → rename поверх name через тот же fd (rename не идёт по ссылке) → fsync папки.
    Возвращает пин нового файла. Сбой — временный файл удаляется, fd закрыт (GLM #120 89dcafeb9, minor resources)."""
    tmp = f"{name}.{secrets.token_hex(6)}{TMP}"
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
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
            st = os.fstat(fh.fileno())
        os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
    except BaseException:
        try:
            os.unlink(tmp, dir_fd=dfd)
        except OSError:
            pass
        raise
    try:
        os.fsync(dfd)
    except OSError:
        pass
    return pin_of(st)


def write_atomic(f, text, mode, dfd=None):
    """write_at для файла f: в удерживаемой папке dfd (списки, копии) или в папке f.parent (журнал в state_dir)."""
    f = Path(f)
    if dfd is not None:
        return write_at(dfd, f.name, text, mode)
    d = os.open(str(f.parent), os.O_RDONLY | os.O_DIRECTORY)
    try:
        return write_at(d, f.name, text, mode)
    finally:
        os.close(d)
