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
        add(env, n, ["$" + n])


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
    на слова). Прежняя папка неизвестна — $OLDPWD остаётся словом, и `cd $OLDPWD` уходит в LOST."""
    env.setdefault("HOME", [shlex.quote(os.path.expanduser("~"))])
    env["PWD"] = [shlex.quote(cwd)]
    if old is None:
        env.pop("OLDPWD", None)
    else:
        env["OLDPWD"] = [shlex.quote(old)]
    return env


def substitute(t, env):
    """Тексты слова t после подстановки известных переменных — по варианту на каждое сочетание значений."""
    texts = [t]
    for name in (n for n in dict.fromkeys(VAR.findall(t)) if n in env):
        pat = exact(re.escape(name))
        texts = [pat.sub(lambda _, v=v: v, o) for o in texts for v in env[name]]
    return texts


def expand_vars(argv, env):
    """Варианты argv после подстановки известных переменных (цикл даёт по варианту на значение) и признак, что
    вариантов больше 16 и часть отброшена. Подставленное делится на слова, как без кавычек: `C="gh pr merge"; $C 1`."""
    out, overflow = [[]], False
    for t in argv:
        texts = substitute(t, env)
        opts = [words(o) for o in texts] if texts != [t] else [[t]]
        out = [x + o for x in out for o in opts]
        if len(out) > MAX_VARIANTS:
            out, overflow = out[:MAX_VARIANTS], True
    return out, overflow
