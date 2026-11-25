"""
Переменные shell для merge-guard (merge_guard_shell): какие значения может иметь `$NAME` в команде.

Порядок выполнения разбор не повторяет (ветки `if`, функции, циклы), поэтому повторное присваивание не заменяет
значение, а добавляет: у переменной — все значения, которые она получала в команде. Если команда меняет переменную
так, как разбор не повторяет (`read`, `printf -v`, `+=`, `${G:=…}`, `typeset -l`, `eval`, `source`), к значениям
добавляется «неизвестно» — само слово `$NAME`. Тогда на месте имени команды оно уходит в догадку, а в цели push
даёт отказ.
"""
import itertools
import os
import re
import shlex

SUBST = "MGSUBST"  # на месте $(…): цель refspec с ним не видна — отказ
SHELL_WORDS = {"if", "then", "elif", "else", "do", "while", "until", "!", "{", "}", "fi", "done"}
DECLARE = {"export", "local", "declare", "readonly", "typeset"}
SETTERS = DECLARE | {"read", "unset", "mapfile", "readarray", "getopts", "select", "vared", "zparseopts", "printf"}
RUN_TEXT = {"eval", "source", "."}  # чужой текст в этом же shell: присвоить может что угодно
READERS = {"read", "mapfile", "readarray", "vared", "getopts", "select", "zparseopts"}  # значение — из ввода
BLIND = "\0blind"  # ключ env: имена, заданные невидимо (`read G`), "*" — любые (`source e.sh`): догадка строже
ASSIGN = re.compile(r"([^\W\d]\w*)(\[.*\])?(\+?)=(.*)", re.S)  # `A=…`, `A+=…`, `a[1]=…`; в zsh имя — и не ASCII
VAR = re.compile(r"\$\{?([^\W\d]\w*)")
MAX_VARIANTS = 16
LOST = "/.merge-guard-lost-dir"  # папка shell, которую разбор не видит (`cd "$X"`, `cd $(…)`), см. merge_guard_dirs
GLOB = re.compile(r"[*?[]")  # `cd g*`: какую папку выберет shell, разбор не знает
CODE = re.compile(r"[;&|\s]")  # разделитель или пробел в слове — оно в кавычках: код `bash -c`, `eval` (#480 B1)


def is_lost(path):
    """Путь от папки, которую разбор не видит (LOST): что там лежит, не прочесть."""
    return path == LOST or path.startswith(LOST + "/")


def exact(name):
    """`$NAME` и `${NAME}`, значение которых — само значение переменной. Не они: `${NAME…}` с оператором (`${G%x}`,
    `${G:-x}`, `${G/x/y}`), индекс zsh (`$G[2,3]`) и модификатор zsh после двоеточия (`$G:l`, `$B:r`). Модификатор —
    любая буква: в zsh 5.9 `$B:main` — не он, но слово без подстановки остаётся `$B` — догадка или отказ, не проход."""
    return re.compile(rf"\$\{{{name}\}}|\${name}(?![\w\[]|:[A-Za-z&])")


def words(text):
    if not re.search(r"[\"'\\]", text):  # без кавычек и `\` shlex делит только по пробелам — и без него в разы быстрее
        return [w for w in re.split(r"[ \t\r\n]+", text) if w]
    try:
        return shlex.split(text)
    except ValueError:
        return text.split()


def add(env, name, values):
    """Значения копятся (см. описание модуля); первые MAX_VARIANTS + 1 — сверх них expand_vars отмечает переполнение."""
    env[name] = list(dict.fromkeys(env.get(name, []) + values))[:MAX_VARIANTS + 1]


def unknown(env, names):
    """К значениям известных переменных — «неизвестно»; $PWD и $OLDPWD ведёт разбор папок (dir_vars)."""
    for n in [n for n in names if n in env and n not in ("PWD", "OLDPWD")]:
        add(env, n, ["${" + n + "}"])  # в скобках: `${G}y` — не имя `Gy` (Claude-линза #480 B2)


def mentioned(names, argv, rest):
    """Имена из names, которые команда может поменять: имя словом (`read G`, `printf -vG`, `unset G`, `let G+=1`) или
    `${G:=…}`. Имя, которого нет в тексте команды, не проверяется: регэкспы на каждое имя — главный расход разбора."""
    clean = [re.sub(r"[\"'\\]", "", t) for t in rest]
    blob = "\0".join(argv + clean)
    out = []
    for n in (n for n in names if n in blob):
        e = re.escape(n)
        if any(re.search(rf"\$\{{{e}(\[[^]]*\])?:{{0,2}}=", t) for t in argv) or any(
                re.fullmatch(rf"(-[A-Za-z]+)?{e}(\[.*\])?(\+?=.*)?", t, re.S) for t in clean):
            out.append(n)
    return out


def computed(rest):
    """Команда задаёт переменную с вычисленным именем: `read $n`, `unset $(…)`, `printf -v "$n"` (у printf и print
    zsh имя — только значение -v)."""
    if rest[:1] in (["printf"], ["print"]):
        names = [x[2:] or y for x, y in zip(rest, rest[1:] + [""]) if x.startswith("-v")]
    else:
        names = rest[1:] if rest[:1] and rest[0] in SETTERS else []
    return any(re.match(rf"(-[A-Za-z]*)?(\$|{SUBST})", x) for x in names)


def declared(a, env):
    """export/local/declare/readonly/typeset: `NAME=…` — значение; опции, которые его меняют (`-l`, `-i`, `-a`), `+=`
    и индекс — «неизвестно» этим именам; ссылка `-n` и вычисленное имя (`export $n=…`) — всем."""
    opts = "".join(t for t in a[1:] if t[:1] in "-+")
    names = [t for t in a[1:] if t[:1] not in "-+"]
    if "n" in opts or any(re.search(rf"\$|{SUBST}", t.split("=", 1)[0]) for t in names):
        env[BLIND] = ["*"]  # `export $(cat .env)`
        return unknown(env, list(env))
    plain = not re.search(r"[^-+xrg]", opts)
    for t in names:
        m = ASSIGN.fullmatch(t)
        if m and plain and not (m.group(2) or m.group(3)):
            add(env, m.group(1), substitute(m.group(4), env))
        elif m or not plain:
            unknown(env, [m.group(1) if m else t])


def note_vars(argv, env):
    """Значения после команды argv: `NAME=…` в начале команды, после export/local/… (declared), `for NAME in …`;
    «неизвестно» — переменным, которые команда может поменять иначе (mentioned), а всем — после `eval`, `source`,
    вычисленного имени (`read $n`, `${(P)n::=…}`)."""
    note_ifs(argv, env)
    a = [t for t in argv if t not in SHELL_WORDS] if argv[:1] and argv[0] in SHELL_WORDS else argv
    if any(re.search(r"\$\{[#!][^}]*=", t) for t in argv):  # `${(P)n::=…}` (tokenize: `${(` → `${#`), `${!n=…}`
        return unknown(env, list(env))
    if a[:1] and a[0] in DECLARE:
        unknown(env, mentioned(list(env), argv, []))  # `export X=${G:=gh}`
        return declared(a, env)
    k = 0
    for t in a:  # значение раскрывается при присваивании: `A=$PWD; cd x; cd $A` — прежняя папка
        m = ASSIGN.fullmatch(t)
        if not m:
            break
        k += 1
        if m.group(2) or m.group(3):
            unknown(env, [m.group(1)])
        else:
            add(env, m.group(1), substitute(m.group(4), env))
    if a[:1] == ["for"] and len(a) > 2 and a[2] == "in":
        return add(env, a[1], [v for x in a[3:] for v in substitute(x, env)] or [""])
    rest = list(itertools.dropwhile(lambda t: t in ("command", "builtin", "noglob", "exec"), a[k:]))
    if rest[:1] and rest[0] in RUN_TEXT or computed(rest):
        env[BLIND] = ["*"]
        return unknown(env, list(env))
    if rest[:1] and rest[0] in READERS:  # `read G S < f`: значения этих имён не видны
        env[BLIND] = env.get(BLIND, []) + [t for t in rest[1:] if re.fullmatch(r"[^\W\d]\w*", t)]
    unknown(env, mentioned(list(env), argv, rest))


def dir_vars(env, cwd, old=None):
    """$PWD, $OLDPWD и $HOME — их значения известны без выполнения (в кавычках shlex: expand_vars делит подставленное
    на слова). Прежняя папка неизвестна — $OLDPWD остаётся словом, и `cd $OLDPWD` уходит в LOST. Папка, которую bash
    подставит не так, как видит разбор (SE-173, SE-175), — см. _dir_var."""
    if "HOME" not in env:
        _dir_var(env, "HOME", os.path.expanduser("~"))
    for name, value in (("PWD", cwd), ("OLDPWD", old)):
        env.pop(name, None)
        if value is not None:
            _dir_var(env, name, value)
    return env


def _dir_var(env, name, value):
    """В кавычках — точное значение: скрипт `"$PWD/m.sh"`, цель `"$PWD/../x"`. Если bash подставит не то, что видит
    разбор, — ещё вариант «неизвестно» (`${ИМЯ}`: `${PWD}x` — не имя `PWDx`, #480 B2), и имя невидимо (BLIND):
    пробельный символ (без кавычек bash делит значение на слова, #458 B2), маска (`cd g*` — папку выберет shell) и LOST
    (SE-175)."""
    env[name] = [shlex.quote(value)]
    if re.search(r"\s", value) or GLOB.search(value) or is_lost(value):
        env[name].append("${" + name + "}")
        env[BLIND] = list(dict.fromkeys(env.get(BLIND, []) + [name]))


def substitute(t, env):
    """Тексты слова t после подстановки известных переменных — по варианту на каждое сочетание значений."""
    texts = [t]
    for name in (n for n in dict.fromkeys(VAR.findall(t)) if n in env):
        pat = exact(re.escape(name))
        texts = [pat.sub(lambda _, v=v: v, o) for o in texts for v in env[name]]
    return texts


ANY_SEP = r"[\W_]+"  # IFS неизвестен: делим по любому знаку не буквы и не цифры
# IFS неизвестен и может быть буквой (`IFS=$'x'`, `IFS=$SEP`): слова защищённой команды остаются целыми, только если
# в IFS нет ни одной их буквы. Значит, деление по всем знакам вне их алфавита даёт эти слова — надмножество (#525 B2)
GUARDED_WORDS = ("gh pr merge", "gh workflow run", "gh run rerun", "git push")
ALPHABET_SEPS = [rf"[^{re.escape(''.join(sorted(set(w) - {' '})))}]+" for w in GUARDED_WORDS]
UNKNOWN = "unknown"
IFS_TEXT = re.compile(r"\bIFS\b")
IFS_PLAIN = re.compile(r"IFS=.*", re.S)


def ifs_split(env):
    """AUTO-178: `IFS=,; C=gh,pr,merge; $C 1` — bash делит подставленное по символам IFS, а не по пробелам. Регэксп
    разделителя, UNKNOWN или None (IFS в команде не задан или пуст: `IFS= read`). Неизвестен IFS со значением с `$`
    или `\\`, изменённый невидимо (`IFS+=`, `read IFS`, `printf -v IFS`) или после `eval`/`source` (#525 B1)."""
    if {"IFS", "*"} & set(env.get(BLIND, [])):
        return UNKNOWN
    chars = set()
    for v in env.get("IFS", []):
        if "$" in v or "\\" in v:
            return UNKNOWN
        chars |= set(v) - set("'\"")
    return "[" + re.escape("".join(sorted(chars))) + r"\s]+" if chars else None


def ifs_words(text, sep):
    """Варианты слов text после деления по IFS (sep — из ifs_split); пустые части bash отбрасывает. UNKNOWN — по
    любому знаку не буквы и не цифры и по знакам вне алфавита каждой защищённой команды (GUARDED_WORDS)."""
    text = re.sub(r"[\"']", "", text)
    seps = [ANY_SEP] + ALPHABET_SEPS if sep == UNKNOWN else [sep]
    return [[w for w in re.split(s, text, flags=re.I) if w] for s in seps]


def note_ifs(argv, env):
    """IFS, который команда меняет не простым присваиванием (`IFS+=,`, `read IFS`, `printf -v IFS`, `unset IFS`), —
    неизвестен: `unknown` его не отмечает, если IFS не было в env (#525 B1). Чтение `$IFS` — тоже: лишний вариант."""
    if any(IFS_TEXT.search(t) for t in argv) and not any(IFS_PLAIN.fullmatch(t) for t in argv):
        add(env, "IFS", ["${IFS}"])


def expand_vars(argv, env):
    """Варианты argv после подстановки известных переменных (цикл даёт по варианту на значение) и признак, что
    вариантов больше 16 и часть отброшена. Подставленное делится на слова, как без кавычек: `C="gh pr merge"; $C 1`;
    если команда задала IFS — ещё вариант с делением по его символам (AUTO-178)."""
    out, overflow = [[]], False
    sep = ifs_split(env)
    for i, t in enumerate(argv):
        texts = substitute(t, env)
        opts = [words(o) for o in texts] if texts != [t] else [[t]]
        if sep and texts != [t]:
            for w in (w for o in texts for w in ifs_words(o, sep)):
                if w and w not in opts:
                    opts.append(w)
        if i and texts != [t] and CODE.search(t):  # `bash -c 'cd "a b"; $PWD/x'`: в кавычках `$PWD` раскроет вложенный
            opts = [[t]] + opts  # shell уже после своего cd — и слово как есть, первым: переполнение его не отбросит (SE-175)
        out = [x + o for x in out for o in opts]
        if len(out) > MAX_VARIANTS:
            out, overflow = out[:MAX_VARIANTS], True
    return out, overflow


GUESSED = {"git", "gh", "curl", "wget", "http", "xh"}  # имена догадки: `$D/GIT` на macOS — тот же git (регистр)


# Имена, которые оболочка пишет без присваивания в команде (read без имени, mapfile, getopts, $_, zsh $argv/$match):
# BLIND их не видит — значение невидимо (Claude-линза #458 B1')
SHELL_SET = {"_", "REPLY", "reply", "MAPFILE", "OPTARG", "argv", "BASH_REMATCH", "match", "MATCH"}


def visible_name(exe, hidden):
    """SE-78: `"$D/swiftc"` — путь из переменной, но последняя часть буквальная и не git/gh/curl: догадки «это git»
    нет. Догадка остаётся, если имя не видно (`$X`, `$D/$(…)`, `$D/g*`) или значение невидимо (hidden)."""
    base = exe.rpartition("/")[2] if "/" in exe else ""
    # `${=D}`, `${(z)D}`, `$@`, `$1`, `${a[@]}` делятся на слова, а VAR их имён не видит — значение невидимо
    if re.search(r"\$(?![A-Za-z_]|\{[A-Za-z_])|\[[@*]\]", exe) or set(VAR.findall(exe)) & SHELL_SET:
        return False
    return bool(not hidden and re.fullmatch(r"[\w.+-]+", base) and SUBST not in base and base.lower() not in GUESSED)
