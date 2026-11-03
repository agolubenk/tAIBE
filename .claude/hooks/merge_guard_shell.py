"""
Разбор Bash для merge-guard (pre-tool-use-merge-guard.py): слова команд, а не подстроки.

Решений не принимает. Отдаёт argv по командам, цели перенаправлений, источники stdin, тела heredoc с их читателями
и команды из подстановок `$(…)`/`` `…` ``/`<(…)`/`=(…)` (zsh). Ключевые слова shell (`if … then`, `do`, `!`, `{`)
и обёртки (`env`, `sudo`, `xargs`) снимаются с начала команды, переменные из `NAME=…` и `for NAME in …` — в argv.
"""
import glob
import os
import re
import shlex

from merge_guard_files import open_regular
from merge_guard_vars import (ASSIGN, SHELL_WORDS, SUBST, dir_vars, expand_vars, note_vars, substitute,  # noqa: F401
                              words)  # dir_vars, expand_vars, note_vars, substitute — отсюда для хука
from merge_guard_expand import NAMES_MAX, brace_words  # раскрытия до запуска

PROC = SUBST + "P"  # на месте <(…) и =(…): PROC + номер в списке подстановок — файл с выводом этой команды
SUBST_AT = re.compile(rf"{SUBST}C(\d+)x")  # на месте $(…) и `…`: SUBST, C, номер в списке подстановок, x (subst_code)
CURRENT = "MGHEAD"  # на месте $(git branch --show-current): текущая ветка папки, где выполняется shell
LOST = "/.merge-guard-lost-dir"  # папка shell, которую разбор не видит (`cd "$X"`, `cd $(…)`), см. merge_guard_dirs
SEPARATORS = set(";&|()<>\n")
WRAPPERS = {"sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "caffeinate", "xargs", "builtin",
            "noglob", "nocorrect", "-", "parallel", "watch", "stdbuf", "unbuffer", "chronic", "arch"}  # `-`, nocorrect — zsh
WRAPPER_VALUE_FLAGS = {"-I", "-n", "-P", "-L", "-d", "-E", "-s", "-u", "-g", "-C", "-k"}
SHELLS = {"bash", "sh", "zsh", "dash"}
HEREDOC = re.compile(r"<<-?\s*\\?(['\"]?)(\w+)\1([^\n]*)\n(.*?)\n[ \t]*\2[ \t]*(?=\n|$)", re.S)  # `<<\EOF` = `<<'EOF'`
# `$(…)`, которая печатает текущую ветку: на её место — CURRENT, остальные подстановки в цели push — «не видно куда».
CURRENT_BRANCH = re.compile(r"\s*git\s+(branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD"
                            r"|symbolic-ref\s+(-q\s+)?--short(\s+-q)?\s+HEAD)\s*")
PWD_CMD = re.compile(r"\s*pwd(\s+-[LP])?\s*")  # `$(pwd)`, `` `pwd` `` — папка shell: на их место — ${PWD}


def is_lost(path):
    """Путь от папки, которую разбор не видит (LOST): что там лежит, не прочесть."""
    return path == LOST or path.startswith(LOST + "/")


def cut_heredocs(cmd):
    """Тела heredoc — отдельно: [(читатели, тело, раскрывает ли shell `$(…)` в теле)].
    Читатели — argv команды с `<<` и команд после `|` в той же строке (`cat <<EOF | bash`)."""
    bodies = []

    def repl(m):
        line = cmd[cmd.rfind("\n", 0, m.start()) + 1:m.start()]
        heads = [re.split(r"[;&|(]", line)[-1]] + m.group(3).split("|")[1:]
        readers = [a for a in (normalize(words(h)) for h in heads) if a]
        bodies.append((readers, m.group(4), not m.group(1)))
        return f"<< {m.group(2)}{m.group(3)}\n"

    return HEREDOC.sub(repl, cmd), bodies


def _subst_end(cmd, i):
    """Индекс закрывающей `)` для `$(` в позиции i (с учётом вложенных скобок и одинарных кавычек)."""
    depth, j, quote = 0, i + 1, False
    while j < len(cmd):
        c = cmd[j]
        if quote:
            quote = c != "'"
        elif c == "'":
            quote = True
        elif c == "\\":
            j += 1
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return len(cmd)


def cut_substitutions(cmd, quotes=True):
    """`$(…)` и `` `…` `` вне одинарных кавычек, в том числе внутри двойных, и `<(…)`/`>(…)`/`=(…)` вне кавычек:
    команда — в список, на её место — SUBST (`$(git branch --show-current)` и подобные — HEAD), у `<(…)` и `=(…)`
    (zsh, в начале слова) — PROC с номером: shell подставит путь к файлу с выводом команды, его читают как скрипт
    или stdin. quotes=False — тело heredoc без кавычек у метки: там `'` не кавычка, а подстановки shell выполняет."""
    out, inner, i, quote = [], [], 0, None
    while i < len(cmd):
        c = cmd[i]
        if quote == "'":
            quote = None if c == "'" else quote
        elif c == "\\":
            out.append(cmd[i:i + 2])
            i += 2
            continue
        elif c == "'" and quote is None and quotes:
            quote = "'"
        elif c == '"' and quotes:
            quote = None if quote == '"' else '"'
        elif cmd.startswith("$(", i) or (quote is None and quotes and (cmd.startswith(("<(", ">("), i) or (
                cmd.startswith("=(", i) and (i == 0 or cmd[i - 1] in " \t\n;&|(<>")))):
            end = _subst_end(cmd, i)
            body = cmd[i + 2:end]
            if cmd[i] == "$" and CURRENT_BRANCH.fullmatch(body):
                out.append(CURRENT)
            elif cmd[i] == "$" and PWD_CMD.fullmatch(body):
                out.append("${PWD}")
            else:
                out.append(f"{PROC}{len(inner)}" if cmd[i] in "<=" else f"{SUBST}C{len(inner)}x")
                inner.append(body)
            i = end + 1
            continue
        elif c == "`":
            end = cmd.find("`", i + 1)
            end = len(cmd) if end < 0 else end
            if PWD_CMD.fullmatch(cmd[i + 1:end]):
                out.append("${PWD}")
            else:
                out.append(f"{SUBST}C{len(inner)}x")
                inner.append(cmd[i + 1:end])
            i = end + 1
            continue
        out.append(c)
        i += 1
    return "".join(out), inner


COMMENT_SAFE = re.compile(r"[^'\"`(){}\]]*")
# `(` — только после пробела: не `$(`, `<(`, `@(`
COMMENT_PARENS = re.compile(r"(?:[^'\"`(){}\]\\]|(?<=[ \t])\(|\))*")


def comment_safe(text):
    """Текст от `#` до конца строки можно снять как комментарий (см. strip_comments): в нём нет `'"`{}]` — символов,
    которыми bash закрыл бы строку, `${…}`, `$[…]` или обратные кавычки, а скобки, если есть, — парные, `(` после
    пробела и без `\\`: закрыть `$(…)`, `$((…))` или `((…))` нечем, открыть подстановку — тоже."""
    if COMMENT_SAFE.fullmatch(text):
        return True
    if not COMMENT_PARENS.fullmatch(text):
        return False
    depth = 0
    for c in text:
        depth += (c == "(") - (c == ")")
        if depth < 0:
            return False
    return depth == 0


def strip_comments(cmd, force=False):
    """Комментарии shell — от `#` в начале слова до конца строки — убрать, как это делает bash: `\\` в конце комментария
    строку не продолжает, `#` внутри слова (`a\\ #b`, `"…"#`, `$'…'`) — не комментарий. Снимается только то, что
    пропускает comment_safe: если разбор ошибся и для bash этот `#` внутри строки, `${…}`, `$((…))` или обратных
    кавычек, закрыть их bash может только символом, которого там нет, — и такой текст остаётся на разбор. Кавычки не
    сошлись — команда остаётся как есть (лишний отказ, не пропуск); force — всё равно снять: так безопасно для
    грубого признака, правило comment_safe от разбора кавычек не зависит."""
    out, i, quote, word = [], 0, None, False
    while i < len(cmd):
        c = cmd[i]
        if quote == "'":
            quote = None if c == "'" else quote
        elif quote == "$'" and c == "\\":  # в $'…' `\'` — экранированная кавычка
            out.append(cmd[i:i + 2])
            i += 2
            continue
        elif quote == "$'":
            quote = None if c == "'" else quote
        elif c == "\\":
            word = word or cmd[i + 1:i + 2] != "\n"  # `\`+перевод строки — склейка, слово не начинает
            out.append(cmd[i:i + 2])
            i += 2
            continue
        elif c == "$" and quote is None and cmd[i + 1:i + 2] == "'":
            quote, word = "$'", True
            out.append("$'")
            i += 2
            continue
        elif c == "'" and quote is None:
            quote = "'"
        elif c == '"':
            quote = None if quote == '"' else '"'
        elif c == "#" and quote is None and not word:
            end = cmd.find("\n", i)
            end = len(cmd) if end < 0 else end
            if comment_safe(cmd[i:end]):
                i = end
                continue
        word = quote is not None or c not in " \t\n;&|(<>"  # `)` слово не кончает: `$(true)#` — не комментарий
        out.append(c)
        i += 1
    return cmd if quote and not force else "".join(out)


FD = re.compile(r"(?<![^\s;&|(])\d+(?=[<>])")  # `0<f`, `2>&1`: номер дескриптора — не аргумент команды


def tokenize(cmd):
    """Слова и разделители; флаги zsh `${(L)G}` — `${#L#G}`: скобки внутри не делят слово, имя не подставляется."""
    cmd = re.sub(r"\$\{\(([^()]*)\)", r"${#\1#", FD.sub("", cmd))
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=";&|()<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    return list(lex)


def split_commands(tokens):
    """[(argv, цели записи-перенаправления, файлы на stdin через `<`, stdin из конвейера `|`, (дно, уровень))] по
    разделителям ; && || | ( ) и переводу строки. Слово после `<<<` — строка, не файл: в sources на её месте None, как
    и у `<&` (чужой дескриптор) — что придёт на stdin, не видно. `<>` открывает файл и на stdin, и на запись.
    Уровень — глубина подоболочек `( … )` у команды, дно — самая мелкая глубина после предыдущей команды: всё, что
    глубже дна, закрылось, и папка shell там — как до открытия."""
    argv, targets, sources, piped, skip = [], [], [], False, None
    depth = floor = 0
    mark = None
    for t in tokens:
        if t and set(t) <= SEPARATORS:
            depth = max(0, depth + t.count("(") - t.count(")"))
            floor = min(floor, depth)
            if t == "<>":
                skip = "both"
            elif ">" in t:
                skip = "target"
            elif "<" in t:
                skip = "source" if t == "<" else "string"
                if t in ("<<<", "<&"):
                    sources.append(None)
            else:  # перед `|` и `&` — подоболочка в bash и zsh: папка и переменные после неё — как до неё
                if argv or targets or sources:
                    yield argv, targets, sources, piped, mark if t.strip("\n") not in ("|", "|&", "&") else (
                        mark[0], mark[1] + 1)
                argv, targets, sources, skip, mark = [], [], [], None, None
                piped = t.replace("\n", "") in ("|", "|&")
            continue
        if mark is None:
            mark, floor = (floor, depth), depth
        if skip in ("target", "both"):
            targets.append(t)
        if skip in ("source", "both"):
            sources.append(t)
        elif skip is None:
            argv.append(t)
        skip = None
    if argv or targets or sources:
        yield argv, targets, sources, piped, mark


def normalize(argv):
    """Команда без префиксов (см. strip_prefix), первое слово — без пути: `/opt/homebrew/bin/gh` → `gh`."""
    rest = strip_prefix(argv)
    return [command_name(rest[0])] + rest[1:] if rest else []


def command_name(word):
    """Имя команды без пути: `/opt/homebrew/bin/gh` → `gh`; zsh `=gh` (EQUALS) — путь к gh, тоже `gh`."""
    w = word.lstrip("`")
    return os.path.basename(w[1:] if w.startswith("=") and len(w) > 1 else w)


def strip_prefix(argv):
    """Снять ключевые слова shell, присваивания (`A=…`, `A+=…`, `a[1]=…`) и обёртки; после `env` и `sudo` присваивание —
    любое слово с `=` (`env X.Y=1 gh …`); `env -S 'строка'` — разобрать строку как команду."""
    i, env_like = 0, False
    while i < len(argv):
        t = argv[i].lstrip("`")
        if t in SHELL_WORDS or ASSIGN.fullmatch(t) or env_like and "=" in t and not t.startswith("="):
            i += 1
            continue
        base = command_name(t)
        env_like = base in ("env", "sudo")
        if base == "repeat" and i + 1 < len(argv):  # zsh `repeat 2 gh pr merge 1` — цикл, команда после числа
            i += 2
            continue
        if base == "command" and any(re.fullmatch(r"-[pvV]*[vV][pvV]*", x) for x in argv[i + 1:i + 2]):
            return argv[i:]  # `command -v node` — поиск команды, не запуск
        if base in WRAPPERS or base == "timeout":
            i += 1
            while i < len(argv) and argv[i].startswith("-"):
                if base == "env" and argv[i] in ("-S", "--split-string"):
                    return strip_prefix(words(argv[i + 1] if i + 1 < len(argv) else "") + argv[i + 2:])
                if base == "env" and argv[i].startswith(("-S", "--split-string=")):
                    value = argv[i].split("=", 1)[1] if argv[i].startswith("--") else argv[i][2:]
                    return strip_prefix(words(value) + argv[i + 1:])
                i += 2 if argv[i] in WRAPPER_VALUE_FLAGS else 1
            if base == "timeout":
                i += 1
            continue
        break
    return argv[i:]


def expand_word(word, cwd):
    """Пути, которые shell подставит на место имени файла: `{a,b}` — оба, `~+` — папка shell, маска `*?[` — файлы от
    cwd (совпадений нет — слово как есть, как у bash). Не больше NAMES_MAX."""
    out = []
    for w in brace_words(word)[:NAMES_MAX] if "{" in word else [word]:
        w = cwd + w[2:] if w == "~+" or w.startswith("~+/") else w
        hits = sorted(glob.glob(os.path.join(glob.escape(cwd), os.path.expanduser(w)))) if re.search(r"[*?[]", w) else []
        out += hits or [w]
    return out[:NAMES_MAX]


# Как оболочка или интерпретатор разбирают свои опции (сверено с bash 5, python 3, perl 5, ruby, node):
# (буквы кода, длинные опции кода, буквы со значением — остаток связки или следующий аргумент,
#  буквы со значением только внутри связки — регэксп того, что они съедают, дальше связка продолжается).
# У оболочки буква со значением (`-o`, `-O`) всегда берёт следующий аргумент, а связка продолжается: `-oe pipefail`.
_REST = ".*"
LAUNCHERS = {
    "sh": ("c", (), "oO", {}),
    "python": ("c", (), "WXm", {}),
    "node": ("ep", ("--eval", "--print"), "rC", {}),
    "perl": ("eE", (), "I", {"l": "[0-7]*", "0": "(x[0-9a-fA-F]*|[0-7]*)", "C": "[IOESioDALa0-9]*", "d": "t?([:=].*)?",
                             **dict.fromkeys("MmxDiVF", _REST)}),
    "ruby": ("e", (), "rICE", {"0": "[0-7]*", **dict.fromkeys("xiFKTW", _REST)}),
    "osascript": ("e", (), "ls", {}),
}
INFO = {"node": {"-v", "-h"}, "python": {"-V", "-h"}, "perl": {"-v"}}  # и у всех `--version`, `--help`: только справка
STDIN_CODE = {"sh": "s", "python": "i"}  # `bash -s x` — код из stdin, x — аргумент; `python3 -i x.py` — stdin после x.py
LONG_VALUED = {"--rcfile", "--init-file", "--require", "--import", "--loader", "--experimental-loader", "--conditions",
               "--input-type", "--check-hash-based-pycs"}
SCRIPT_EXT = re.compile(r"\.(sh|bash|zsh|py|[mc]?js|[mc]?ts|pl|rb|scpt|applescript)$")
SCRIPT_MAX = 4 * 1024 * 1024
# Исполняемый файл ядра (ELF, Mach-O, universal) — не текст скрипта. NUL в тексте — не признак: bash отказывается от
# файла, только если NUL стоит до первого перевода строки, а дальше выполняет строки как обычно.
EXEC_MAGIC = (b"\x7fELF", b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe",
              b"\xca\xfe\xba\xbe")


def launcher(word):
    """Семейство оболочки или интерпретатора по имени команды (python3.12 → python); не они — None."""
    if word in SHELLS:
        return "sh"
    w = re.sub(r"[\d.]+$", "", word)
    return w if w in LAUNCHERS else None


def launch_args(a):
    """Как `bash`/`python3`/`node`/… поймут argv: (код в опциях, код из stdin, файл скрипта, модуль `python -m`, индекс
    конца опций). У оболочки с `-c` «файл» — сама строка кода; у интерпретатора с кодом (`-c`, `-e`) файла нет;
    `-` — stdin. Опции — a[1:конец]: искать файл по имени нельзя, оно бывает и значением опции (`+o noexec noexec`)."""
    fam = launcher(a[0])
    letters, longs, valued, attached = LAUNCHERS[fam]
    code, stdin, i = False, False, 1
    while i < len(a):
        x = a[i]
        if x == "--":
            i += 1
            break
        if x == "-" or len(x) < 2 or x[0] not in "-+" or (x[0] == "+" and fam != "sh"):
            break
        if x in ("--version", "--help") or x in INFO.get(fam, ()):  # `node -v` код не читает — как пустой код в опциях
            return True, False, None, None, i
        i += 1
        if x.startswith("--"):
            code = code or x.split("=", 1)[0] in longs
            i += x in LONG_VALUED
            continue
        k = 1
        while k < len(x):
            ch, k = x[k], k + 1
            stdin = stdin or ch in STDIN_CODE.get(fam, "")
            if ch in letters:
                code = True
                if fam != "sh":  # остаток связки или следующий аргумент — сам код, а не файл
                    i += k == len(x)
                    return code, stdin, None, None, i
            elif ch in valued and fam == "sh":
                i += 1
            elif ch in valued:
                value = x[k:] or (a[i] if i < len(a) else "")
                if fam == "python" and ch == "m":
                    return code, stdin, None, value, i
                i += k == len(x)
                break
            elif ch in attached:
                k += re.match(attached[ch], x[k:]).end()
    return code, stdin, (a[i] if i < len(a) else None), None, i


def device(path_str, cwd):
    """Путь в /dev или /proc (`/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/0`, ссылка на них): shell читает оттуда поток,
    а не файл — номера дескрипторов tokenize снимает, поэтому это stdin команды."""
    p = os.path.normpath(os.path.join(cwd, os.path.expanduser(path_str)))
    return any(x == "/dev" or x.startswith(("/dev/", "/proc/")) for x in (p, os.path.realpath(p)))


def cat_files(argvs, stdin_files, cwd="."):
    """Что предыдущая стадия конвейера отдаёт на stdin: у `cat` — файлы-аргументы, а без них или с `-` — свой stdin, и
    из `<`, и из конвейера (`cat f.sh | cat | bash`); `tee` отдаёт свой stdin. Остальное — None: не видно. Варианты
    подстановки — все. `cat /dev/stdin` — тоже свой stdin."""
    out = []
    for a in argvs:
        files = [x for x in a[1:] if not x.startswith("-")] if a[:1] == ["cat"] else []
        stdin = "-" in a[1:] or any(device(x, cwd) for x in files)
        files = [x for x in files if not device(x, cwd)]
        if a[:1] == ["tee"] or (a[:1] == ["cat"] and (not files or stdin)):
            out += list(stdin_files) or [None]
        elif a[:1] != ["cat"]:
            out.append(None)
        out += files
    return out or [None]


def proc_files(body, cwd):
    """Что `<(…)` и `$(…)` выводят: у `cat` — его файлы и stdin (cat_files), у `< f` без команды — f (`$(< f)` bash,
    `<(< f)` zsh), у прочих — None."""
    try:
        commands = split_commands(tokenize(cut_substitutions(strip_comments(body, force=True))[0]))
    except ValueError:
        return [None]
    out, prev = [], ([], [])
    for argv, _, sources, piped, _ in commands:
        a = normalize(argv)
        stdin = sources or (cat_files(*prev, cwd) if piped else [])
        prev = ([a], stdin)
        out += cat_files([a], stdin, cwd) if a else list(sources)
    return out or [None]


def uncommented(text):
    """Shell-текст для грубого признака: без комментариев (strip_comments, force), тела heredoc — как есть: для
    `python3 <<EOF` в них `#` — не комментарий shell."""
    try:
        cmd, bodies = cut_heredocs(text)
        return "\n".join([strip_comments(cmd, force=True)] + [b for _, b, _ in bodies])
    except Exception:
        return text


def read_script(path_str, cwd):
    """(состояние, путь, текст) файла, который команда запустит как код. Состояние: ok, missing (нет или не прочесть),
    binary (исполняемый файл ядра, см. EXEC_MAGIC), big (больше 4 МБ — не проверить), lost (от папки, которую разбор
    не видит, — см. LOST)."""
    p = os.path.join(cwd, os.path.expanduser(path_str))
    if is_lost(p):
        return "lost", p, None
    p = os.path.realpath(p)
    f = open_regular(p)  # FIFO и устройство — как нет файла: не повиснуть на чтении
    if f is None:
        return "missing", p, None
    try:
        with f:
            head = f.read(4096)
            if head.startswith(EXEC_MAGIC):
                return "binary", p, None
            if os.fstat(f.fileno()).st_size > SCRIPT_MAX:
                return "big", p, None
            return "ok", p, (head + f.read()).replace(b"\0", b"").decode("utf-8", errors="replace")  # bash NUL отбрасывает
    except OSError:
        return "missing", p, None


def subst_code(code, bodies, cwd, stale):
    """Код eval и `sh -c` с подстановкой (`eval "$(cat e.sh)"`, `bash -c "$(< v.sh); \\$G \\$S"`): вывод `$(cat f)` и
    `$(< f)` (proc_files) — текст f без переводов строк в конце, он и подставляется. Остальные — SUBST без номера: вывод
    не виден, а номер во вложенном разборе указал бы на чужой список bodies. (код, файлы): файлы, которых не прочесть
    или которые переписывает та же команда (stale), — их разбирает вызывающий, как `source f`."""
    unseen = []

    def put(m):
        k = int(m.group(1))
        files = proc_files(bodies[k], cwd) if k < len(bodies) else [None]
        if None in files:
            return SUBST
        texts = [None if stale(f) else read_script(f, cwd)[2] for f in files]
        unseen.extend(f for f, t in zip(files, texts) if t is None)
        return SUBST if None in texts else "".join(texts).rstrip("\n")
    return SUBST_AT.sub(put, code), unseen
