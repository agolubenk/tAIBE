"""
Файлы для merge-guard (pre-tool-use-merge-guard.py): как хук открывает файл, по которому решает (скрипт, тело gh api,
package.json, Makefile), и какие файлы команда пишет — защищённые пути и файлы, которые она может переписать раньше,
чем их прочтут: тогда прочитанное хуком — не то, что выполнится.
"""
import itertools
import os
import re
import stat

from merge_guard_vars import ASSIGN, DECLARE, computed


WRITE_ALL = {"rm", "rmdir", "truncate", "touch", "chmod", "chown", "tee", "unlink", "shred", "mv", "sponge"}
WRITE_LAST = {"cp", "install", "rsync", "ln", "ditto", "scp"}
ANY = "/"  # имя-джокер (в имени файла `/` не бывает): команда переписывает файлы, которых по её словам не назвать
GH_MOVED = ANY + "\0gh"  # окружение gh сменено (config_moved): не файл, `\0` в имени тоже не бывает
GH_WRITTEN = ANY + "\0gh-config"  # запись по пути конфига gh: `~/.config/gh/config.yml`, `$GH_CONFIG_DIR/…`
# Сам конфиг или папка-предок: `ln -sfn d ~/.config/gh`, `mv d ~/.config`, `tar -xf a.tar -C ~/.config/gh`, `cp -R d gh`.
GH_CONFIG_PATH = re.compile(r"(^|/)gh/config\.yml$|GH_CONFIG_DIR|XDG_CONFIG_HOME|(^|/)(gh|\.config)/*$|^(~|\$\{?HOME\}?)/*$")
GIT_BLIND = {"checkout", "switch", "restore", "reset", "merge", "pull", "rebase", "cherry-pick", "revert", "am",
             "apply", "stash", "read-tree", "checkout-index", "submodule", "sparse-checkout", "bisect", "subtree", "clone"}
GH_BLIND = {("pr", "checkout"), ("repo", "clone"), ("repo", "fork"), ("repo", "sync"), ("run", "download"),
            ("release", "download"), ("gist", "clone"), ("codespace", "cp")}
BLIND = {"unzip", "7z", "7za", "cpio", "patch", "rsync", "ditto", "ed", "ex", "vi", "vim", "nvim"}
UNPACK = {"gunzip", "bunzip2", "unxz", "unzstd", "uncompress"}  # `gunzip x.gz` пишет x
FETCHED = {"curl", "wget"} | UNPACK  # содержимое названных целей — из сети или архива, не с диска и не из команды
GIT_VALUED = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
CONFIG_ENV = r"(GH_CONFIG_DIR|XDG_CONFIG_HOME|GH_DATA_DIR|XDG_DATA_HOME|HOME)"
# Имя переменной окружения gh не после `$`, в том числе значением опции (`printf -vHOME`, `read -aHOME`); присваивание
# в раскрытии (`${HOME:=…}`, zsh `${HOME::=…}`) и с вычисленным именем (`${!n=…}`, zsh `${(P)n::=…}` — см. tokenize).
CONFIG_NAMED = re.compile(rf"(?<![\w$])(?<!\$\{{){CONFIG_ENV}(?!\w)|^-[A-Za-z]+{CONFIG_ENV}(?!\w)"
                          rf"|\$\{{{CONFIG_ENV}[^}}]*=|\$\{{[#!][^}}]*=")
RUNNERS = {"eval", "sudo", "doas", "su"}
BLIND_RUN = ("код запускается после команды, которая меняет файлы вслепую (git switch/checkout/stash/pull…, загрузка, "
             "распаковка, cp -r) — на диске не то, что выполнится; запусти его отдельной командой")


def open_regular(path):
    """Обычный файл, открытый на чтение (байты), иначе None: FIFO, устройство, папка, ошибка. Открытие без блокировки
    и проверка того же дескриптора: FIFO без писателя не повесит хук (тайм-аут хука — пропуск), а подмена файла между
    проверкой и чтением не пройдёт."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except OSError:
        return None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        return None
    return os.fdopen(fd, "rb")


def write_targets(a):
    """Пути, которые команда пишет или удаляет (по первому слову)."""
    cmd, args = a[0], [x for x in a[1:] if not x.startswith("-")]
    if cmd in WRITE_ALL:
        return args
    if cmd in WRITE_LAST:
        return args[-1:]
    if cmd == "dd":
        return [x[3:] for x in a[1:] if x.startswith("of=")]
    if cmd in ("sed", "gsed", "perl", "ruby") and any(x == "-i" or re.fullmatch(r"-[a-zA-Z]*i\S*", x) for x in a[1:]):
        return args
    if cmd in ("awk", "gawk") and "inplace" in a:
        return args
    if cmd == "curl":
        return _values(a, "o", "--output")
    if cmd == "wget":
        return _values(a, "O", "--output-document")
    if cmd in UNPACK:
        return [re.sub(r"\.(gz|bz2|xz|zst|Z)$", "", x) for x in args]
    k, sub = git_sub(a) if cmd == "git" else (0, None)
    if sub in ("checkout", "restore", "rm", "mv", "apply"):
        return [x for x in a[k + 1:] if not x.startswith("-")]
    return []


def _values(a, letter, long):
    """Значения опции: `-o v`, `-ov`, связка `-sSLo v`, `--output v`, `--output=v`."""
    out = []
    for i, x in enumerate(a[1:], 1):
        nxt, m = a[i + 1] if i + 1 < len(a) else "", re.fullmatch(rf"-[a-zA-Z]*?{letter}(.*)", x)
        if x.startswith("--"):
            out += [x.split("=", 1)[1]] if x.startswith(long + "=") else [nxt] if x == long else []
        elif m:
            out.append(m.group(1) or nxt)
    return out


def base_names(paths):
    return {os.path.basename(p.rstrip("/")) for p in paths if p}


def gh_config(paths):
    return {GH_WRITTEN} if any(GH_CONFIG_PATH.search(p) for p in paths) else set()


def unpack_dirs(a):
    """Папка, куда распаковывает архив: `tar -xf a.tar -C d`, `unzip -o a.zip -d d`."""
    if a[0] in ("tar", "bsdtar") and blind(a):
        return _values(a, "C", "--directory")
    return _values(a, "d", "--d") if a[0] == "unzip" else []


def path_names(paths):
    """Все имена пути, не только последнее: `git restore --source=x scripts` переписывает и scripts/ok.sh."""
    return {n for p in paths if p for n in p.split("/") if n not in ("", ".", "..")}


def git_sub(a):
    """(индекс, подкоманда) git после глобальных опций: `git -C d -c k=v switch x` → (5, switch)."""
    i = 1
    while i < len(a) and a[i].startswith("-"):
        i += 2 if a[i] in GIT_VALUED else 1
    return (i, a[i]) if i < len(a) else (i, None)


def blind(a):
    """Команда пишет файлы, которых по её словам не назвать: дерево git из другой ветки, stash или патча, загрузка,
    распаковка, рекурсивная копия, редактор, `gh pr checkout`; псевдоним git или gh — тоже (не разбираем)."""
    cmd, opts = a[0], [x for x in a[1:] if x.startswith("-")]
    if cmd == "gh":  # `gh pr checkout`, загрузки; псевдоним и расширение (`gh co 1`) — как вслепую
        from merge_guard_gh import GH_BUILTIN, gh_words  # gh импортирует этот модуль
        words = [w for _, w in gh_words(a[1:])]
        return bool(words) and (words[0] not in GH_BUILTIN or tuple(words[:2]) in GH_BLIND)
    if cmd == "git":
        from merge_guard_git import GIT_BUILTINS  # git импортирует shell, shell — этот модуль
        k, sub = git_sub(a)
        rest = a[k + 1:]
        if sub == "restore" or sub == "checkout" and "--" in rest:  # пути названы (write_targets), если не `.`, маска,
            spec = rest[rest.index("--") + 1:] if "--" in rest else [x for x in rest if not x.startswith("-")]  # `:(…)`
            return any(x.startswith("--pathspec-from-file") for x in rest) or any(
                p in (".", "..") or p.startswith(":") or re.search(r"[*?[]", p) for p in spec)
        if sub == "worktree":
            return rest[:1] == ["add"]
        if sub in ("checkout", "switch") and {"-b", "-B", "-c", "-C", "--orphan"} & set(rest):
            return len([x for x in rest if not x.startswith("-")]) > 1  # `-b new` без точки старта дерево не меняет
        if sub == "stash" and rest[:1] in (["list"], ["show"]) or sub == "reset" and not {
                "--hard", "--merge", "--keep"} & set(rest):
            return False
        return sub in GIT_BLIND or sub is not None and sub not in GIT_BUILTINS  # псевдоним (`git co feat`), lfs…
    if cmd == "curl":  # `-O` — имя из URL; `-o F` — имя известно (write_targets)
        return any(x.startswith("--remote-name") or re.fullmatch(r"-[a-zA-Z]*O[a-zA-Z]*", x) for x in opts)
    if cmd == "wget":
        return not write_targets(a)
    if cmd in ("tar", "bsdtar"):  # `tar xzf a.tgz`: первая связка — и без дефиса
        return any(x in ("--extract", "--get") or re.fullmatch(r"-?[a-zA-Z]*x[a-zA-Z]*", x) for x in opts + a[1:2])
    if cmd in ("cp", "scp"):
        return any(x in ("--recursive", "--archive") or re.fullmatch(r"-[a-zA-Z]*[rRa][a-zA-Z]*", x) for x in opts)
    return cmd in BLIND


def written_names(a):
    """Имена файлов, которые команда может переписать: цели write_targets, у копирования — и источники (`cp m.sh d/`
    кладёт d/m.sh), у `npm pkg set` — package.json, у blind — ANY. По имени, не по пути: путь пишут по-разному. Имя,
    содержимое которого не видно (загрузка, распаковка, файл из ветки git), — ещё и как ANY + имя."""
    args = [x for x in a[1:] if not x.startswith("-")]
    paths = write_targets(a) + (args if a[0] in WRITE_LAST else [])
    names = (base_names(paths + (["package.json"] if a[0] == "npm" and args[:2] == ["pkg", "set"] else [])) |
             gh_config(write_targets(a) + unpack_dirs(a)))  # источник копии (`cp -R ~/.config/gh bak`) конфиг не пишет
    hidden = a[0] in FETCHED or a[0] == "git" and git_sub(a)[1] in ("checkout", "restore")
    return names | {ANY + n for n in names if hidden} | ({ANY} if blind(a) else set())


def config_moved(argv):
    """Команда может сменить окружение, по которому gh ищет config.yml и расширения: конфиг, который прочтёт хук, —
    не тот. Имя переменной не после `$` — присваивание любой формы (`GH_CONFIG_DIR=… gh`, `HOME+=…`, `export H"OME"=…`,
    `printf -v HOME`, `for HOME in`, `${HOME:=…}`); вычисленное имя (`export $n=…`, `read $n`, `declare -n`); `eval`;
    опция env (`env -i`, но не `-f` команды после него); sudo. Чтение (`$HOME`, `${HOME}`) — не смена. Кавычки в argv
    уже сняты (tokenize): `H"OME"=…` — `HOME=…`, `$'HOME'=…` — `$HOME=…`, вычисленное имя. `source` и `.` — не здесь:
    вызов псевдонима — запись вслепую (blind), и код из файла в той же команде получает отказ BLIND_RUN."""
    w = argv
    rest = list(itertools.dropwhile(lambda x: ASSIGN.fullmatch(x) or x in ("command", "builtin", "noglob", "exec"), w))
    head = rest[0] if rest else ""
    own = itertools.takewhile(lambda x: x.startswith("-") or "=" in x, rest[1:])  # слова env до команды
    return any(CONFIG_NAMED.search(x) for x in w) or bool(RUNNERS & set(w)) or computed(rest) or (
        head in DECLARE and any(re.fullmatch(r"-\w*n\w*", x) for x in rest)) or (
        head == "env" and any(x.startswith("-") for x in own))


def rewritten(paths, written):
    """Файл из paths переписывает та же команда: прочитанное хуком — не то, что выполнится."""
    paths, written = set(paths), {w.casefold() for w in written}  # APFS: `> X.sh; bash x.sh` — тот же файл (IS-245)
    return bool(paths) and (ANY in written or bool({n.casefold() for n in path_names(paths)} & written))


def opaque(paths, written):
    """Файл из paths та же команда переписывает тем, чего не видно: дерево другой ветки, загрузка, распаковка."""
    written = {w.casefold() for w in written}
    return ANY in written or any(ANY + n.casefold() in written for n in path_names(paths))


def command_writes(text, depth=0):
    """Имена файлов, которые пишет команда целиком — с подстановками, heredoc и `bash -c`, без учёта порядка. Хук
    разбирает `$(…)` и heredoc раньше основной команды, а shell выполняет их после записи в той же строке
    (`printf … > m.sh; echo $(bash m.sh)`). Лишнее имя — лишь грубая проверка вместо разбора; что не разобрать — без имён."""
    from merge_guard_shell import (SHELLS, command_name, cut_heredocs, cut_substitutions, expand_vars,  # shell
                                   note_vars, split_commands, strip_comments, strip_prefix, substitute,  # импортирует
                                   tokenize)  # этот модуль
    if depth > 3:
        return set()
    try:
        text, bodies = cut_heredocs(text)
        text, inner = cut_substitutions(strip_comments(text).replace("\\\n", " "))
    except Exception:
        return set()
    names, env, more = set(), {}, inner + [b for _, b, _ in bodies]
    try:
        for argv, targets, *_ in split_commands(tokenize(text)):
            out = [o.strip("'\"") for t in targets for o in substitute(t, env)]
            names |= base_names(out) | gh_config(out)
            names |= {GH_MOVED} if config_moved(argv) else set()  # gh прочтёт другой конфиг — как переписанный
            note_vars(argv, env)
            for r in filter(None, (strip_prefix(v) for v in expand_vars(argv, env)[0])):
                v = [command_name(r[0])] + r[1:]
                names |= written_names(v)
                more += v[1:] if v[0] == "eval" else v[v.index("-c") + 1:][:1] if v[0] in SHELLS and "-c" in v else []
    except Exception:
        pass
    return names.union(*(command_writes(m, depth + 1) for m in more))
