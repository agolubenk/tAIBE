"""
Файлы для merge-guard (pre-tool-use-merge-guard.py): как хук открывает файл, по которому решает (скрипт, тело gh api,
package.json, Makefile), и какие файлы команда пишет — защищённые пути и файлы, которые она может переписать раньше,
чем их прочтут: тогда прочитанное хуком — не то, что выполнится.
"""
import fnmatch
import functools
import itertools
import os
import re
import shlex
import stat

from merge_guard_vars import ASSIGN, DECLARE, SUBST, computed


WRITE_ALL = {"rm", "rmdir", "truncate", "touch", "chmod", "chown", "tee", "unlink", "shred", "mv", "sponge"}
WRITE_LAST = {"cp", "install", "rsync", "ln", "ditto", "scp"}
# IS-249. Второе имя пути: символьная и жёсткая ссылка; убирает или меняет путь целиком — и папку, где лежат законы.
LINKS = {"ln", "link"}
GONE = {"rm", "rmdir", "unlink", "shred", "truncate", "chmod", "chown", "chflags"}
FAMILY = GONE | LINKS | WRITE_LAST | {"mv", "tar", "bsdtar", "unzip"}  # команды link_findings (и `git mv`/`git rm`)
COPY_LINK = {"cp": "ls", "install": "l"}  # буква опции, с которой копия — ссылки (`cp -al`, `install -l s`)
GNU = WRITE_ALL | WRITE_LAST | LINKS | GONE | {"dd", "tar"}  # `gmv`, `gln`, `grm`, `gtee` — coreutils из Homebrew
GLOB = re.compile(r"[*?[]")
# формы маски zsh, которых _glob не повторяет (`[^x]`, `[!x]`, `[[:alpha:]]`, `**`; `^`, `#`, `~` — EXTENDED_GLOB):
# отказ, не подражание (coord 13:46, линза frontend #508); `(…)` в слове делит разбор — _group
ZSH_FORM = re.compile(r"\[[\^!]|\[:|\*\*")
# `^`, `#`, `~` в середине — маска только при EXTENDED_GLOB (в Bash-инструменте выключена): форма — в слове с `*?[` или
# когда команда её включает; `*~`, `a~`, `#x#`, `host:~/d` — буквы (проверено в zsh, линза Контроль #508 N2)
ZSH_EXT = re.compile(r"[\^#]|(?<=.)~(?=.)")
RSYNC_PATTERN = {"--exclude", "--include", "--filter", "-f"}  # значение через пробел — шаблон, не путь (`'**/x'`)
UNSEEN = re.compile(rf"{SUBST}|[$`]")  # слово из `$(…)`, `` `…` `` или неизвестной переменной: путь разбору не виден
SUBST_N = re.compile(rf"{SUBST}C(\d+)x")  # $(…) с номером текста в procs[SUBS] хука (merge_guard_shell.SUBST_AT)
ENV_WORD = re.compile(r"\$(?:\{(TMPDIR|USER|LOGNAME|RANDOM)\}|(TMPDIR|USER|LOGNAME|RANDOM)(?!\w)|\$)")  # HOME — dir_vars
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


def gnu(word):
    """`gmv`, `gln`, `grm`, `gtee`… (GNU coreutils на Mac) — то же, что mv, ln, rm, tee (IS-249)."""
    return word[1:] if word[:1] == "g" and word[1:] in GNU else word


def write_targets(a):
    """Пути, которые команда пишет или удаляет (по первому слову)."""
    cmd, args = gnu(a[0]), [x for x in a[1:] if not x.startswith("-")]
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
    from merge_guard_shell import command_name  # shell импортирует этот модуль; `ENV -i`, `/usr/bin/SUDO` (SE-90)
    w = argv
    rest = list(itertools.dropwhile(lambda x: ASSIGN.fullmatch(x) or x in ("command", "builtin", "noglob", "exec"), w))
    head = rest[0] if rest else ""
    own = itertools.takewhile(lambda x: x.startswith("-") or "=" in x, rest[1:])  # слова env до команды
    return any(CONFIG_NAMED.search(x) for x in w) or bool(RUNNERS & {command_name(x) for x in w}) or computed(rest) or (
        head in DECLARE and any(re.fullmatch(r"-\w*n\w*", x) for x in rest)) or (
        command_name(head) == "env" and any(x.startswith("-") for x in own))


def rewritten(paths, written):
    """Файл из paths переписывает та же команда: прочитанное хуком — не то, что выполнится."""
    paths, written = set(paths), {w.casefold() for w in written}  # APFS: `> X.sh; bash x.sh` — тот же файл (IS-245)
    return bool(paths) and (ANY in written or bool({n.casefold() for n in path_names(paths)} & written))


def opaque(paths, written):
    """Файл из paths та же команда переписывает тем, чего не видно: дерево другой ветки, загрузка, распаковка."""
    written = {w.casefold() for w in written}
    return ANY in written or any(ANY + n.casefold() in written for n in path_names(paths))


def command_writes(text, depth=0, alt=False, keep=False, raw=False):
    """Имена файлов, которые пишет команда целиком — с подстановками, heredoc и `bash -c`, без учёта порядка. Хук
    разбирает `$(…)` и heredoc раньше основной команды, а shell выполняет их после записи в той же строке
    (`printf … > m.sh; echo $(bash m.sh)`). Лишнее имя — лишь грубая проверка вместо разбора; что не разобрать — без имён.
    Кавычки не сошлись — имена из слов до ошибки: bash их выполнит (SE-76). Имена и из второго прочтения комментариев
    (comment_readings, SE-82; alt — оно само): запись, спрятанная `"` комментария, иначе не попала бы в имена, и хук
    прочёл бы с диска старый файл. Знак комментария мог смениться (keep — до текста, или текст называет настройку —
    comment_char_may_change, SE-77) — имена и из прочтения без снятия комментариев (raw), в том числе у `eval`/`-c`."""
    from merge_guard_shell import (SHELLS, command_name, comment_char_may_change, comment_readings, cut_heredocs,  # shell
                                   cut_substitutions, expand_vars, heredoc_text, join_lines, note_vars,  # импортирует
                                   split_commands, strip_prefix, substitute)  # этот модуль
    from merge_guard_partial import tokens_before_error  # этот модуль (через merge_guard_shell)
    if depth > 3:
        return set()
    source, keep = text, keep or comment_char_may_change(text)  # `histchars='!^%'; echo a # ; echo … > m.sh`
    try:
        text, bodies = (text, []) if alt else cut_heredocs(text)
        text, other = (join_lines(text), None) if raw else comment_readings(text, None, alt)  # с `'"`… остаётся
        text, inner = cut_substitutions(text)
    except Exception:
        return set()
    names, env, more = set(), {}, inner + [heredoc_text(b, e) for _, b, e in bodies]  # тело — как его прочтёт bash
    try:
        for argv, targets, *_ in split_commands(tokens_before_error(text)[0]):
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
    names |= command_writes(other, depth, True, keep) if other else set()
    names |= command_writes(source, depth, alt, keep, True) if keep and not raw else set()
    return names.union(*(command_writes(m, depth + 1, keep=keep) for m in more))


# ---------- IS-249: второе имя, перенос и удаление защищённого пути или папки над ним ----------
# protected_path хука защищает сами законы и настройки. Проходили (линза security на HR #684): `ln -s …/.claude/rules
# /tmp/r && echo x > /tmp/r/01-base.md` — нового имени realpath в момент проверки ещё не знает; `ln …/settings.json
# /tmp/h` — у жёсткой ссылки другой путь, а файл тот же; `mv .claude /tmp/c2` — законы уехали вместе с папкой. Так же
# `mv /tmp/x/settings.json .claude/` (имя в папке-цели) и `rm -rf .claude`. Папка над защищённым здесь — защищённая.

def guarded_dirs(roots, home):
    """Папки с защищённым: .claude каждого корня, ~/.claude (реестр сессий), ~ и $ZDOTDIR (файлы запуска shell)."""
    home = os.path.realpath(home)  # те же папки, что у home_protected
    out = [os.path.join(os.path.realpath(r), ".claude") for r in roots] + [home, os.path.dirname(home), "~"]
    return [os.path.realpath(os.path.expanduser(d)).casefold() for d in out + [os.environ.get("ZDOTDIR") or "~"]]


PATHS_MAX, SCAN_MAX = 20_000, 500_000  # на решение: путей масок для проверок, прочтённых имён (coord 14:02: < 3 с на Mac)
_scan = [None, 0, 0, {}]  # решение (merge_guard_git.decision), имён прочтено, путей отдано, пути масок этого решения


class Unread(Exception):
    """Маску не прочесть: шире предела (таймаут хука 10 с — пропуск; предел — счёт, не время, coord 13:27) или форма
    zsh, которой _glob не повторяет (coord 13:46). Тогда отказ: назовите пути словами."""


def _budget():
    import merge_guard_git as g  # git импортирует shell, shell — этот модуль
    if _scan[0] != g.decision():
        _scan[:] = [g.decision(), 0, 0, {}]
    return _scan


def _glob(p):
    """Пути маски p по частям пути (os.scandir), с именами с точкой (GLOB_DOTS). Папку читает потоком, в памяти — только
    совпадения; каждое прочтённое имя — в предел решения SCAN_MAX; ту же маску решение раскрывает один раз."""
    s = _budget()
    if p in s[3]:
        return s[3][p]
    cur, parts = [os.sep if os.path.isabs(p) else ""], [x for x in p.split(os.sep) if x]
    for k, part in enumerate(parts):
        if not GLOB.search(part):
            cur = [os.path.join(c, part) for c in cur]
            continue
        nxt, last, match = [], k == len(parts) - 1, re.compile(fnmatch.translate(part)).match  # как fnmatchcase
        for c in cur:
            try:
                with os.scandir(c or ".") as it:
                    for e in it:
                        s[1] += 1
                        if s[1] > SCAN_MAX or len(nxt) > PATHS_MAX:
                            raise Unread("маска раскрывается шире предела")
                        if match(e.name) and (last or e.is_dir()):
                            nxt.append(os.path.join(c, e.name))
            except OSError:
                continue
        cur = nxt
    s[3][p] = [c for c in cur if os.path.lexists(c)]
    return s[3][p]


def _paths(base, word, ext=False):
    """Пути слова от base; маску — и на имена с точкой (`mv .c* x`), не шире предела; ext — включён EXTENDED_GLOB."""
    if ZSH_FORM.search(word) or ZSH_EXT.search(word) and (ext or GLOB.search(word)):
        raise Unread("форма маски zsh, которую разбор не читает (`[^…]`, `[[:…:]]`, `**`, `^`, `#`, `~`)")
    p = os.path.join(base, os.path.expanduser(word))
    if not GLOB.search(word):
        return [p]
    got = _glob(p) or [p]
    _scan[2] += len(got)  # каждый путь проверка прочтёт (realpath): предел — на все проверки решения
    if _scan[2] > PATHS_MAX:
        raise Unread("маска раскрывается шире предела")
    return got


@functools.lru_cache(maxsize=8)
def _group(text):
    """В тексте у команды семьи link_findings `(` на месте слова: в zsh это маска (`.cl(a)ude`, `(a|b)/x`, `*(/)`), а
    разбор (merge_guard_shell.tokenize) делит её на команды и имени не видит. Не маска: `$(`, `=(`, `<(`, `f()`."""
    from merge_guard_shell import SEPARATORS, tokenize  # shell импортирует этот модуль
    try:
        tokens, argv = tokenize(text), []
    except ValueError:
        return False
    for t in tokens:
        if not (t and set(t) <= SEPARATORS):
            argv.append(t)
        elif t[0] == "(" and argv and not argv[-1].endswith(("$", "=")) and not (  # `;(`, `⏎(`, `<(` — не слово
                len(argv) == 1 and t.startswith("()")) and any(gnu(os.path.basename(w)) in FAMILY for w in argv):
            return True
        elif set(t) & set(";&|\n()"):
            argv = []
    return False


def _hit(word, bases, roots, protected, dirs, ext=False):
    """Путь слова от одной из bases — защищённый или папка над защищённым: что назвать в отказе, иначе None."""
    for base in bases:
        for q in _paths(base, word, ext):
            f = os.path.realpath(q).casefold()
            if p := protected(q, base, roots):
                return p
            if any(d == f or d.startswith(f.rstrip("/") + "/") for d in dirs):
                return os.path.realpath(q)
    return None


class Disk(str):
    """Путь скрипта с диска и текст, который хук прочёл (runs_code → whole[2]). reviewed — эти байты — блоб HEAD его
    репозитория (любого, в том числе worktree): невидимый путь у mv/rm в нём — не отказ (IS-249 B1, coord 13:10). Скрипт
    из scratchpad и правленый без коммита — отказ; обойти можно только коммитом, а его видно в git."""
    def __new__(cls, path, text):
        s = super().__new__(cls, path)
        s.text, s.ok = text, None
        return s

    def reviewed(self):
        if self.ok is None:  # git — только когда невидимый путь нашёлся; второго чтения файла нет
            import merge_guard_git as g  # git импортирует shell, shell — этот модуль; тест подменяет head_blob
            self.ok = g.head_blob(str(self), self.text.encode())
        return self.ok


def fresh(code, cwd):
    """Путь из `$(mktemp …)` без -u — нового файла, которого до команды не было (coord 12:57, #508 B1), или None:
    шаблон — от cwd, с -p/--tmpdir — в той папке, с -t и без шаблона — в папке временных файлов."""
    try:
        w = shlex.split(code)
    except ValueError:
        return None
    w, tmp = w[1:] if w[:1] == ["command"] else w, os.environ.get("TMPDIR") or "/tmp"
    if not w or w[0] not in ("mktemp", "gmktemp") or re.search(rf"[;&|<>`$\n]|{SUBST}", code) or any(
            x == "--dry-run" or re.fullmatch(r"-[a-zA-Z]*u[a-zA-Z]*", x) for x in w[1:]):
        return None
    ops, at, it = [], None, iter(w[1:])
    for x in it:
        if x.startswith("--tmpdir"):
            at = x.partition("=")[2] or tmp
        elif re.fullmatch(r"-[a-zA-Z]*[pt]", x) or x == "--suffix":  # значение — следующее слово (`-t` у macOS тоже)
            v = next(it, "")
            at = v if x[-1] == "p" else tmp if x[-1] == "t" else at
        elif re.fullmatch(r"-[a-zA-Z]*t[a-zA-Z]*", x):
            at = tmp
        elif not x.startswith("-"):
            ops.append(x)
    name = os.path.basename(ops[-1]) if ops else "tmp.is249"
    if at:
        return os.path.join(cwd, os.path.expanduser(at), name)
    return os.path.join(cwd, os.path.expanduser(ops[-1])) if ops else os.path.join(tmp, name)


def _env(m):
    """`$$` и `$RANDOM` — число; $TMPDIR — значение или /tmp; $USER и $LOGNAME — значение, без него — как было."""
    name = m.group(1) or m.group(2)
    if name in (None, "RANDOM"):
        return "1"
    return os.environ.get(name) or ("/tmp" if name == "TMPDIR" else m[0])


def seen_word(w, bodies, cwd, named=()):
    """Слово с $TMPDIR/$USER/$LOGNAME — с их значением; `$(mktemp …)` и переменная из него — с путём от fresh. named —
    имена, которые команда может поменять сама (`read USER`, `unset TMPDIR`, `printf -v USER`): остаются словом (Б2)."""
    w = ENV_WORD.sub(lambda m: m[0] if (m.group(1) or m.group(2)) in named else _env(m), w)
    path = lambda k: fresh(bodies[k], cwd) if k < len(bodies) else None  # noqa: E731
    return SUBST_N.sub(lambda m: path(int(m.group(1))) or m[0], w)


def link_findings(a, cwd, roots, protected, home, whole=("", "", False, None, ("", "")), bodies=(), hid=()):
    """[(«file», что)]: команда даёт защищённому пути или папке над ним второе имя (ln, link, cp -l/-s, install -l,
    rsync --link-dest), уносит его (mv, git mv), кладёт в папку законов файл с защищённым именем, удаляет или меняет
    папку (rm, chmod, git rm) или переписывает её копией папки и распаковкой. protected — protected_path хука; whole —
    как у classify_argv (whole[2] — Disk у скрипта с диска), bodies — тексты $(…), hid — BLIND. Невидимый путь: у
    ссылки, mv и GONE — в команде, которую набрал агент, и в скрипте без коммита (B1). Маска шире предела — отказ."""
    if gnu(a[0]) not in FAMILY | {"git"}:
        return []
    try:
        return _links(a, cwd, roots, protected, home, whole, bodies, hid)
    except Unread as e:  # `rm -rf <маска> <маска> .claude`, `rm -rf .cl(a)ude` (линза frontend #508)
        return [("file", f"{' '.join(a)[:80]} ({a[0]}: {e} — назовите пути словами, IS-249)")]


def _links(a, cwd, roots, protected, home, whole, bodies, hid):
    disk, text = whole[2], whole[4][1] if len(whole) > 4 else whole[1]
    named = {n for n in ("TMPDIR", "USER", "LOGNAME", "RANDOM") if n in hid or "*" in hid or (
        n in text and re.search(rf"(?<![$\w{{]){n}(?!\w)|\$\{{{n}(\[[^]]*\])?:{{0,2}}=", text))}  # read, unset, printf -v,
    # export, n=; `${n:=x}` и `${n::=x}` (zsh) — как mentioned в merge_guard_vars
    a = [a[0]] + [seen_word(w, bodies, cwd, named) for w in a[1:]]
    typed = lambda: not (isinstance(disk, Disk) and disk.reviewed())  # noqa: E731
    cmd, opts, ops = gnu(a[0]), [x for x in a[1:] if x.startswith("-")], [x for x in a[1:] if not x.startswith("-")]
    if cmd == "git":  # `git -C d mv .claude x`: пути — от d
        k, sub = git_sub(a)
        cwd = next((os.path.join(cwd, a[i + 1]) for i in range(k - 1) if a[i] == "-C"), cwd)
        cmd, ops = {"mv": "mv", "rm": "rm"}.get(sub, ""), [x for x in a[k + 1:] if not x.startswith("-")]
    if cmd not in FAMILY:  # остальным realpath папок не нужен
        return []
    if whole[0] and _group(whole[0]):  # текст своего уровня, без тел heredoc: тело для shell — свой уровень (N1, #508)
        raise Unread("форма маски zsh, которую разбор не читает (`(…)`, `(a|b)`, `*(/)`)")
    if cmd == "rsync":  # `--exclude '**/node_modules'`: значение опции — шаблон, не путь (Контроль N2, #508)
        val = {k + 1 for k, x in enumerate(a) if x in RSYNC_PATTERN or re.fullmatch(r"-[a-zA-Z]+f", x)}
        ops = [x for k, x in enumerate(a) if k and k not in val and not x.startswith("-")]
    short, dirs, norm = "".join(x[1:] for x in opts if x[:2] != "--"), guarded_dirs(roots, home), [gnu(a[0])] + a[1:]
    ext = "extendedglob" in text.casefold().replace("_", "")  # `setopt Extended_Glob`, `set -o …`, `zsh -o …` (zsh 5.9)
    hit = lambda w, bases: _hit(w, bases, roots, protected, dirs, ext)  # noqa: E731
    paths = lambda base, w: _paths(base, w, ext)  # noqa: E731
    say = lambda p, why: ("file", f"{p} ({a[0]} {why} — IS-249)")  # noqa: E731
    unseen = say(" ".join(a)[:80], "называет путь, который разбор не видит: " + (
        "закоммитьте скрипт или назовите путь словами" if isinstance(disk, Disk) else "назовите его словами"))
    if cmd in GONE | {"mv"} and any(UNSEEN.search(w) for w in a[1:]) and typed():  # `rm -rf "$X"`, `mv "$(…)" x`
        return [unseen]
    if cmd in GONE:
        return [say(p, "удаляет или меняет папку с законами и настройками") for w in ops if (p := hit(w, [cwd]))]
    if cmd in ("tar", "bsdtar", "unzip"):  # `tar -x` без -C и `unzip` без -d — в текущую папку
        listing = cmd == "unzip" and bool(set(short) & set("lvtZp"))  # `unzip -l`: только список
        into = unpack_dirs(norm) or ([cwd] if blind(norm) and not listing else [])
        why = "распаковывает в папку с законами и настройками (без -C/-d — в текущую: назовите другую папку)"
        return [say(p, why) for d in into if (p := hit(d, [cwd]))]
    link_dest = [x.split("=", 1)[1] for x in opts if x.startswith("--link-dest=")]
    linking = cmd in LINKS or bool(set(short) & set(COPY_LINK.get(cmd, ""))) or cmd == "cp" and bool(
        {"--link", "--symbolic-link"} & set(opts)) or cmd == "rsync" and any(x.startswith("--link-dest") for x in opts)
    if not (linking or cmd == "mv" or cmd in WRITE_LAST):
        return []
    into = _values(norm, "t", "--target-directory") if cmd in ("ln", "mv", "cp", "install") else []
    dest = into[0] if into else ops[-1] if len(ops) > 1 else None
    srcs = ([x for x in ops if x != dest] if into else ops[:-1] if dest else ops) + link_dest
    ats = paths(cwd, dest) if dest else [cwd]  # куда ляжет: папка-цель или новое имя; маску цели (`.cl*/`) — как shell
    found = []
    if linking and any(UNSEEN.search(w) for w in ops + link_dest) and typed():  # `ln -s "$(…)" /tmp/r && echo x > …`
        found.append(unseen)  # закоммиченный скрипт — прежнее правило (install.sh, agent-comms-link.sh; coord 13:27)
    if linking or cmd == "mv":  # символьная ссылка считается от своей папки, жёсткая и перенос — от cwd
        bases = [cwd] + [b for at in ats for b in (at, os.path.dirname(at))] if linking and dest else [cwd]
        found += [say(p, "даёт второе имя или уносит защищённое или папку над ним") for w in srcs if (p := hit(w, bases))]
    found += [say(p, "кладёт файл с защищённым именем") for at in ats for w in srcs for q in paths(cwd, w)
              if (p := protected(os.path.join(at, os.path.basename(q.rstrip("/"))), cwd, roots))]
    tree = cmd == "ditto" or cmd in ("cp", "rsync") and bool(
        re.search(r"[rRa]" if cmd == "cp" else r"[ra]", short) or {"--recursive", "--archive"} & set(opts))
    if tree and dest:  # содержимое (`x/.`, `x/`, ditto) и цель, которой нет, — в саму цель; иначе — в цель/имя источника
        def land(at, w, q):  # `cp -R /tmp/fixtures .` из корня — новая папка ./fixtures; имя `"$X"` — как в саму цель
            b = os.path.basename(q)
            return at if cmd == "ditto" or w.endswith(("/", "/.")) or not os.path.isdir(at) or UNSEEN.search(b) else (
                os.path.join(at, b))
        into = [land(at, w, q) for at in ats for w in srcs for q in paths(cwd, w) if not GLOB.search(os.path.basename(q))]
        found += [say(p, "копирует папку поверх папки с законами и настройками") for t in into if (p := hit(t, [cwd]))]
    return found
