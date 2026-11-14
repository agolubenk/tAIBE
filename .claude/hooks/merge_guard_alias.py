"""
Инструмент под другим именем для merge-guard (SE-90): ссылка, жёсткая ссылка или копия git, gh, curl, wget, http, xh.
`bin/swiftc push origin HEAD:main` при `bin/swiftc -> …/git` запускает git: имя команды хуку ничего не говорит.

1. Идентичность — (dev, inode) настоящих программ: git из CommandLineTools, Xcode, $DEVELOPER_DIR и PATH (кроме
   диспетчера xcrun /usr/bin/git на macOS: он решает по argv[0]), gh/curl/wget/http/xh из PATH (realpath).
2. Копия — размер как у программы из набора, затем sha256.
3. ln/cp/install/ditto/rsync/mv с источником-инструментом или невидимым источником — имя цели получает догадку
   (метка в written, см. command_writes); имя не видно — догадку получает любой путь и голое имя после смены PATH.
   Программы по пути при решении хука нет или её переписывает тот же текст (`cat G > n`, `dd of=n`, python) —
   содержимое не видно: догадка, как у невидимой цели.
4. Голое имя ищется по папкам PATH, только если тот же текст меняет PATH (`PATH=… cmd`, `env PATH=… cmd`, `env -P`,
   export, `PATH+=`, zsh path); невидимая папка — догадка. Остаток: ссылку в папке PATH сделал прошлый вызов, теперь
   голое имя (карточка SE-90).
"""
import hashlib
import os
import shutil
import stat
import sys

from merge_guard_files import open_regular, rewritten
from merge_guard_shell import command_name as _name, strip_prefix  # shell импортирует files, files этот модуль — лениво
from merge_guard_vars import ASSIGN, DECLARE, SUBST, substitute, words

TOOLS = ("git", "gh", "curl", "wget", "http", "xh")
MARK = "\0tool/"  # в written: имя, под которым та же команда кладёт инструмент (`\0` в имени файла не бывает)
ANY_TOOL = MARK + "*"  # то же, но имя не видно (`cp "$G" bin/`)
PATH_KEY = "\0path"  # ключ env: папки PATH, заданные текстом
HIDDEN = "\0hidden"  # папка PATH, которую разбор не видит
COPIERS = {"ln", "cp", "install", "ditto", "rsync", "mv", "gln", "gcp", "ginstall"}
ENV_VALUED = {"-u", "-P", "-C", "-S"}  # опции env со значением в следующем слове (BSD и GNU)
VALUED = {"-m", "-o", "-g", "-B", "-S", "-M", "-e", "-f", "--arch", "--mode", "--owner", "--group", "--rsh", "--chmod",
          "--suffix", "--exclude", "--include", "--filter"}  # значение — следующий аргумент, не источник
GIT_HOMES = ("/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git")
_cache = {}


def _stat(path):
    try:
        st = os.stat(path)
    except (OSError, ValueError):
        return None
    return st if stat.S_ISREG(st.st_mode) else None


def members():
    """[(инструмент, путь, (dev, inode), размер)] — набор идентичности (п. 1); один раз за вызов хука."""
    if "members" not in _cache:
        dev = os.environ.get("DEVELOPER_DIR")
        shim = _stat("/usr/bin/git") if sys.platform == "darwin" else None
        found = {t: [shutil.which(t)] for t in TOOLS}
        found["git"] += list(GIT_HOMES) + ([os.path.join(dev, "usr/bin/git")] if dev else [])
        out = []
        for tool, paths in found.items():
            for p in dict.fromkeys(os.path.realpath(p) for p in paths if p):
                st = _stat(p)
                if st and not (shim and (st.st_dev, st.st_ino) == (shim.st_dev, shim.st_ino)):
                    out.append((tool, p, (st.st_dev, st.st_ino), st.st_size))
        _cache["members"] = out
    return _cache["members"]


def _sha(path):
    if path not in _cache:
        f = open_regular(path)
        if f is None:
            _cache[path] = None
        else:
            with f:
                h = hashlib.sha256()
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
                _cache[path] = h.hexdigest()
    return _cache[path]


def identify(path):
    """Инструмент, которым окажется файл path (ссылка, жёсткая ссылка, копия), иначе None."""
    st = _stat(path)
    if st is None:
        return None
    same = [(t, p) for t, p, ident, size in members() if size == st.st_size]
    hit = next((t for t, p, ident, _ in members() if ident == (st.st_dev, st.st_ino)), None)
    if hit or not same:
        return hit
    digest = _sha(path)
    return next((t for t, p in same if digest and _sha(p) == digest), None)


def _hidden(word):
    return any(m in word for m in ("$", "`", SUBST, "*", "?", "["))


def _path(word, cwd):
    w = os.path.expanduser(word)
    return w if os.path.isabs(w) else os.path.join(cwd, w) if cwd else None


def _operands(v):
    """(источники, цель, цель — папка?) команды копирования: значения опций (VALUED) — не источники; `-t D`, `--target-
    directory=D` (GNU) — цель-папка D, все операнды — источники; один операнд у ln — ссылка в текущей папке."""
    args, target, skip = [], None, False
    for k, x in enumerate(v[1:], 1):
        if skip:
            skip = False
        elif x in ("-t", "--target-directory") or x.startswith("--target-directory="):
            target = x.split("=", 1)[1] if "=" in x else (v[k + 1] if k + 1 < len(v) else "")
            skip = "=" not in x
        elif x in VALUED:
            skip = True
        elif not x.startswith("-"):
            args.append(x)
    if target is not None:
        return args, target, True
    if len(args) == 1:
        return args, ".", True
    return args[:-1], args[-1] if args else "", len(args) > 2


def copy_marks(v, cwd=None, marks=()):
    """Метки written у копирования (п. 3): источник — инструмент по имени, по идентичности, невидимый или уже
    помеченный (`ln -s …/git a; mv a b`) — имя цели получает догадку; имя не видно — ANY_TOOL."""
    if v[0] not in COPIERS:
        return set()
    sources, target, into = _operands(v)
    tooly = [s for s in sources if _hidden(s) or _name(s) in TOOLS or MARK + _name(s) in marks or (
        _path(s, cwd) and identify(_path(s, cwd)))]
    if not tooly:
        return set()
    into = into or target in (".", "..") or target.endswith("/") or bool(
        _path(target, cwd) and os.path.isdir(_path(target, cwd)))
    return {MARK} | {ANY_TOOL if _hidden(n) else MARK + _name(n) for n in (tooly if into else [target])}  # MARK — метки есть


def note_path(argv, env):
    """Папки PATH, которые задаёт команда argv (п. 4): `PATH=…` в префиксе команды (и после env, sudo, nice…), после
    export/typeset/…, `PATH+=…`, `env -P папки`; `$PATH` — папки хука, не ищутся; zsh `path=(…)` разбор делит на
    подоболочку, `env -S 'строка'` и `env -C папка` — тоже: папка невидима."""
    if not any(t[:4] in ("PATH", "path") or t[:2] == "-P" for t in argv):
        return
    found, in_env, moved, prev = [], False, False, ""
    if argv[:1] and argv[0] in DECLARE:
        pre = [t for t in argv[1:] if not t.startswith("-")]
    else:
        rest = strip_prefix(argv)
        pre = argv[:len(argv) - len(rest)]
        if argv[len(pre):] != rest:  # `env -S 'PATH=bin swiftc …'` — строка разобрана как команда заново
            pre, found = [], [HIDDEN] if any("PATH" in t or "path" in t for t in argv) else []
    for t in pre:
        in_env = _name(t) == "env" or in_env and (t.startswith("-") or "=" in t or prev in ENV_VALUED)
        if in_env and (prev == "-P" or t.startswith("-P") and len(t) > 2):  # BSD `env -P папки cmd` — вместо PATH
            found += (t if prev == "-P" else t[2:]).split(":")
        moved = moved or in_env and t.startswith(("-C", "--chdir"))  # GNU `env -C папка`: от неё и папки PATH
        prev = t
        m = ASSIGN.fullmatch(t)
        if m and (m.group(1) == "path" or m.group(1) == "PATH" and m.group(2)):
            found.append(HIDDEN)
        elif m and m.group(1) == "PATH":
            found += [d for text in substitute(m.group(4), env) for d in " ".join(words(text)).split(":")]
    dirs = [HIDDEN if _hidden(d) or moved and not os.path.isabs(os.path.expanduser(d)) else d for d in found
            if d not in ("$PATH", "${PATH}")]
    if dirs:
        env[PATH_KEY] = env.get(PATH_KEY, []) + dirs


def _unseen(path, word, written):
    """Файла path при решении хука нет или тот же текст переписывает word (путь, как написан): запустится то, чего хук не
    видел."""
    return not os.path.exists(path) or rewritten([word], written)


def alias_kind(exe, cwd, written, dirs):
    """(инструмент по идентичности или None, догадка ли) для команды с первым словом exe: путь — по файлу (п. 1, 2) и
    меткам копирования (п. 3); голое имя — по папкам dirs, если текст менял PATH (п. 4), до первого файла, который хук
    видит. Файла нет или его переписывает тот же текст — догадка: копию делает и `cat >`, и `dd`, и python."""
    if MARK not in written and not dirs and "/" not in exe:
        return None, False  # без меток копирования и смены PATH голое имя решает только имя
    base = exe.rpartition("/")[2]
    guess = not _hidden(base) and MARK + _name(base) in written
    if _hidden(exe):
        return None, guess  # `$G …` — догадка хука по `$` в имени; `"$D/x"` — папка не видна
    if "/" in exe:  # `cat G > n; ./n …`, `dd of=n`, python: файла нет или его переписывают — содержимое не видно
        p = _path(exe, cwd)
        tool = identify(p) if p else None
        return tool, guess or ANY_TOOL in written or not tool and (not p or _unseen(p, exe, written))
    tool, guess = None, guess or ANY_TOOL in written
    for d in dirs:
        home = None if d == HIDDEN else _path(d or ".", cwd)
        p = os.path.join(home, exe) if home else None
        tool = identify(p) if p else None
        unseen = not p or _unseen(p, os.path.join(d, exe), written)
        guess = guess or not tool and unseen
        if tool or not unseen:  # первый файл, который хук видит, — его shell и запустит
            break
    return tool, guess
