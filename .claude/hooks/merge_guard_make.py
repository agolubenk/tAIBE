"""
make для pre-tool-use-merge-guard.py поверх разбора merge_guard_launch (make_files, опции make): make_option — причина,
по которой разбор не видит, что прочтёт или запустит make (хук отказывает с ней вместо LOST_DIR); make_hint — прямые
команды целей Makefile для сообщения об отказе (SE-105); trusted_make — команды рецептов `make check`/`check-layer`
вместо грубого признака (SE-127). Решений не принимает: отдаёт причину, строку и находки, решает хук.
"""
import os
import re

from merge_guard_files import command_writes
from merge_guard_launch import (IMPLIED_VAR, INCLUDE_ESCAPE, MAKE_BASE, MAKE_CONT, MAKE_ENV, MAKE_TEXT, MAKEFLAGS_ARG,
                                MAKES, NOT_ASCII, _make_opts, _make_where, make_files)
from merge_guard_shell import CURRENT, SUBST

WT_TRACKS = ("feature", "fix", "refactor", "spike", "review")
EVAL_SUITES = ("nerve", "pipeline", "pipeline/reflex", "pipeline/genome", "swarm", "evolve")
MAKE_VALUE = re.compile(r"[A-Za-z0-9._-]+\Z")
# Строка --eval, которая запускает или читает то, чего разбор не видит (SE-135): подстановка `$`, рецепт (`;`,
# табуляция, `.RECIPEPREFIX`), `!=`, `define`, `export`, shell рецептов и файлы make, пути поиска (`vpath`, VPATH,
# GPATH: make пересоберёт Makefile из другой папки, coord 12:35) — и в целевой переменной.
EVAL_RUNS = re.compile(r"[$;\t]|!=|\.RECIPEPREFIX|\.EXPORT_ALL_VARIABLES|\b(?:define|export|vpath)\b"
                       r"|(?<![\w.])(?:MAKEFILES|SHELL|\.SHELLFLAGS|[VG]PATH|(?:GNU)?MAKEFLAGS)\s*[:+?!]*=")
MAKE_VAR = re.compile(r"(?:MAKEFILES|SHELL|\.SHELLFLAGS|[VG]PATH)\s*[:+?!]*=")  # в строке make; MAKEFLAGS= — make_flags

# Причины отказа хука (launched) вместо LOST_DIR: папка видна, не разобрана опция.
MAKE_OPTION = ("длинная опция make, которую разбор не раскрывает однозначно (`--d`, `--frob`): какой Makefile make "
               "прочтёт, не видно — напишите опцию полностью (`--directory=…`)")
MAKEFLAGS_WHY = ("MAKEFILES, MAKEFLAGS или GNUMAKEFLAGS (и VPATH, GPATH, .SHELLFLAGS, .RECIPEPREFIX, .EXTRA_PREREQS) "
                 "из окружения: файлы MAKEFILES, папки поиска "
                 "VPATH и GPATH (make пересоберёт Makefile из другой папки), опция или переменная "
                 "в MAKEFLAGS, от которой зависит, что make прочтёт и запустит (`-I`, `-C`, `-f`, `--eval`, "
                 "`MAKEFILES=`, `SHELL=`, `.SHELLFLAGS=`, `VPATH=`, неизвестная длинная опция `--frob`, `--jobserver-auth`, "
                 "`-O` make 4.x), или кавычка, `\\`, `$`, `$(…)`, знак вне печатного ASCII, кроме таба, в "
                 "MAKEFLAGS (слова и подстановки make делит иначе, чем shell): папку make (`-C`, `cd`) разбор "
                 "с ними не сводит — передайте опции в командной строке make, файлы — через `-f`")
MAKE_STDIN = ("Makefile из потока, а не из файла (`-f -`, `-f /dev/stdin`, FIFO, ссылка на устройство, "
              "`include /dev/stdin` в Makefile или `--eval`, Makefile по умолчанию — ссылка на поток): его текст "
              "разбор не видит — запишите Makefile в файл и передайте `-f`")
MAKE_EVAL = ("строка `--eval`/`-E` с `$`, рецептом (`;`, табуляция, `.RECIPEPREFIX`), `!=`, `define`, `export`, "
             "`vpath` или `SHELL=`, `.SHELLFLAGS=`, `MAKEFILES=`, `VPATH=`, `GPATH=`: что она прочтёт и запустит, "
             "разбор не видит — передайте это "
             "Makefile-файлом (`-f`)")
MAKE_INCLUDE_WHY = ("строка include с `\\` или `#` (экранирование, комментарий): какой файл make прочтёт, разбор не "
                    "сводит — уберите их из строки include или запустите команды цели напрямую")
MAKE_SUBST = ("подстановка shell в слове make (`$(…)`, `` `…` ``, `<(…)`, `>(…)`, `=(…)`): что она даст make — путь, "
              "строку `--eval`, опцию, — разбор не видит; запишите значение в команду или в Makefile-файл (`-f`)")
MAKE_ASCII = ("знак вне печатного ASCII, кроме таба, в слове make (аргумент, `-f`, `--eval`): make делит слова по "
              "своей локали (в kk_KZ.PT154 байт 0xA0 — пробел), разбор так не делит — запишите слово в ASCII")
MAKE_TEXT_WHY = ("Makefile со словом include, с `$(eval`, `$(file`, `$(shell` (и `${…}`), с путём `/dev/`, Makefile, "
                 "который разбор не прочёл (права, больше 4 МБ), или make его пересоберёт (рядом `имя.sh`, `имя,v`, "
                 "RCS/, SCCS/; Makefile нет): что make прочтёт и запустит, разбор не сводит — запустите команды цели "
                 "напрямую")
MAKE_VAR_WHY = ("переменная make в командной строке, от которой зависит, чем make запустит рецепты и что прочтёт "
                "(`SHELL=`, `.SHELLFLAGS=`, `MAKEFILES=` — от папки после `-C`, `VPATH=`, `GPATH=`): разбор этого не "
                "видит — уберите её, файл make передайте через `-f`")
MAKE_BASE_WHY = ("Makefile отличается от основной ветки origin (у tAIBE — origin/board-agents; файл изменён, новый или в "
                 "другом репозитории): влейте основную ветку в свою или дайте CI запустить цель")


def make_option(a, cwd):
    """Причина, по которой разбор не видит, что прочтёт или запустит make, иначе "": метка make_flags (SE-133);
    длинная опция, которую getopt_long не раскроет однозначно (`--d`, `--o`, `--frob`, SE-128); Makefile из потока
    где угодно в дереве make_files (`-f -`, устройство, FIFO, Makefile по умолчанию — ссылка на поток, `include
    /dev/stdin` в Makefile или `--eval`); строка `--eval` с EVAL_RUNS; `SHELL=`, `.SHELLFLAGS=`, `MAKEFILES=` в строке
    make (SE-135). То, что разбор не сводит, — отказ (coord, #402): подстановка shell и знак вне печатного ASCII в
    любом слове make, строка include с `\\` или `#`, Makefile дерева с MAKE_TOKENS, нечитаемый или такой, что make
    его пересоберёт (coord 12:19). Разрешено только то, что прошло ревью (coord 12:35, 12:36): каждый Makefile дерева —
    блоб основной ветки origin (same_blob), MAKE_ENV нет в окружении хука и в строке. Рецепты Makefile на диске —
    грубый признак (хук), кроме `make check`/`check-layer` по разобранному Makefile: команды рецептов (trusted_make,
    SE-127)."""
    if a[0] not in MAKES:
        return ""
    if MAKEFLAGS_ARG in a or any(os.environ.get(k) for k in MAKE_ENV):
        return MAKEFLAGS_WHY
    if any(SUBST in w or CURRENT in w for w in a):  # правило coord 11:47 (#402): один раз на все слова make
        return MAKE_SUBST
    if any(NOT_ASCII.search(w) for w in a):  # правило coord 11:55 (#402): аргумент, `-f`, `--eval`
        return MAKE_ASCII
    values, rest = _make_opts(a)
    if "?" in values:
        return MAKE_OPTION
    _, named, evals, _ = _make_where(values, cwd)
    streams = []
    make_files(a, cwd, streams)
    if INCLUDE_ESCAPE in streams:
        return MAKE_INCLUDE_WHY
    if "-" in named or set(streams) - {MAKE_TEXT, MAKE_BASE}:
        return MAKE_STDIN
    if MAKE_TEXT in streams or MAKE_BASE in streams:
        return MAKE_TEXT_WHY if MAKE_TEXT in streams else MAKE_BASE_WHY
    if any(map(EVAL_RUNS.search, evals)):
        return MAKE_EVAL
    return MAKE_VAR_WHY if any(map(MAKE_VAR.match, rest)) else ""


def _direct(goal, var):
    """Команды рецепта цели worktree или проверок (Makefile команды) с TRACK/NAME/WT_BASE/WT_DEPS из var;
    [] — цели нет в списке."""
    track = goal[3:] if goal.startswith("wt-") and goal[3:] in WT_TRACKS else None
    t, n = track or var.get("TRACK", "<TRACK>"), var.get("NAME", "<NAME>")
    p, b = f'"worktrees/{t}/{n}"', f'"{t}/{n}"'
    if track or goal == "wt-add":
        return [f"mkdir -p worktrees/{t}", f"git worktree add {p} -b {b} {var['WT_BASE']}"
                f"  # ветка {b} уже есть — git worktree add {p} {b}"] + (
            [] if var.get("WT_DEPS") == "0" else [f"infra/scripts/dev/wt-deps.sh install {p}"])
    return {"wt-help": ["cat worktrees/README.md"], "wt-list": ["git worktree list"],
            "wt-deps": [f"infra/scripts/dev/wt-deps.sh install {p}"],
            "wt-check": [f'infra/scripts/dev/wt-deps.sh check "worktrees/{t}/{n}/boards"'],
            "wt-rm": [f"git worktree remove {p}"],
            "check-repo": ["python3 -I infra/checks/test_checks.py", "python3 -I infra/checks/run.py"],
            "check-eval": [f"python3 -I -m unittest discover -s eval/{s} -p 'test_*.py'" for s in EVAL_SUITES],
            }.get(goal, [])


def make_hint(a, text):
    """SE-105: make с признаком в Makefile — отказ, его решает хук, здесь он не меняется. Для целей worktree и
    проверок, которые есть в прочтённом Makefile (text), — строка с прямыми командами рецепта для сообщения об
    отказе: их хук разбирает как любые команды, Makefile при них не читается. "" — не make или целей из списка нет."""
    if a[0] not in MAKES or not text:
        return ""
    var = {k: v for k, _, v in (w.partition("=") for w in a[1:] if "=" in w and not w.startswith("-"))
           if MAKE_VALUE.match(v)}
    base = re.search(r"(?m)^WT_BASE[ \t]*\??=[ \t]*([A-Za-z0-9._/-]+)[ \t]*$", text)
    var.setdefault("WT_BASE", base.group(1) if base else "<WT_BASE>")
    goals = [w for w in dict.fromkeys(a[1:]) if not w.startswith("-") and "=" not in w and _direct(w, var)
             and re.search(rf"(?m)^{re.escape(w)}:", text)]
    lines = [c for g in goals for c in _direct(g, var)]
    return ("\nАгентской сессии вместо `make " + " ".join(goals) + "` — прямые команды рецепта: их хук разбирает "
            "как обычные, Makefile не читается (SE-105):\n" + "\n".join("  " + c for c in lines)) if lines else ""


# SE-127 (владелец, A): `make check`/`make check-layer` по прошедшему ревью Makefile — команды рецептов вместо грубого
# признака по всему тексту. Разбор строгий: всё, чего он не сводит к простым целям, — None, и решает грубый признак.
MAKE_TRUSTED_GOALS = {"check", "check-layer"}
MAKE_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*\Z")
MAKE_ASSIGN = re.compile(r"([A-Za-z0-9_][A-Za-z0-9_-]*)[ \t]*(\?|\+|:::|::|:)?=")
MAKE_DIRECTIVE = re.compile(r"[ \t]*(?:-?include|sinclude|ifn?eq|ifn?def|else|endif|define|endef|export|unexport"
                            r"|override|undefine|vpath|-?load)(?![A-Za-z0-9_-])")
MAKE_RESERVED = {"SHELL", "MAKESHELL", "MAKEFLAGS", "GNUMAKEFLAGS", "MFLAGS", "MAKEFILES", "VPATH", "GPATH", "MAKE",
                 "MAKEOVERRIDES", "MAKELEVEL", "MAKECMDGOALS", "CURDIR", "SUFFIXES"}


def _exported(assign):
    """Присваивание меняет окружение рецептов: имя пришло в make из окружения (GNU make отдаёт его shell рецепта со
    значением из Makefile, `PATH = /tmp/x`; `?=` значение из окружения не меняет) или меняет запуск программ
    (IMPLIED_VAR). Линза backend #419, заметка 4."""
    name = assign.group(1)
    return assign.group(2) != "?" and (name in os.environ or IMPLIED_VAR.fullmatch(name + "=") is not None)


def _make_rules(text):
    """{цель: (пререквизиты, строки рецепта)} и цели .PHONY; None — строка, которую разбор не сводит: директива,
    присваивание с `$`, `!=`, переменной make (MAKE_RESERVED, имя с точкой) или в окружение рецептов (_exported),
    правило с `$`, `%`, `::`, `;`, `|`,
    `=`, `#`, специальная цель кроме .PHONY, цель дважды, табуляция до первого правила. Строка рецепта с
    продолжением (обратная косая в конце) — None в списке: make отдаёт её shell с переводом строки как есть (в
    кавычках shell их не снимает), склейка разбора с этим не совпадает."""
    rules, phony, current = {}, set(), None
    for line in MAKE_CONT.sub(lambda m: m.group(1) + " \0", text).split("\n"):  # `\0` — место склейки
        if line.startswith("\t"):
            if current is None:
                return None
            current.append(None if "\0" in line else line[1:])
            continue
        line = line.replace("\0", "")  # вне рецепта make склеивает продолжение пробелом
        if not line.strip():  # и строка-комментарий: make_files снял его текст, рецепт она не прерывает
            continue
        current = None
        assign = MAKE_ASSIGN.match(line)
        if MAKE_DIRECTIVE.match(line) or assign and (assign.group(1) in MAKE_RESERVED or "$" in line
                                                     or _exported(assign)):
            return None
        if assign:
            continue
        targets, colon, prereqs = line.partition(":")
        names, deps = targets.split(), prereqs.split()
        if not colon or not names or not all(map(MAKE_NAME.match, deps)) or prereqs.startswith(":"):
            return None
        if names == [".PHONY"]:
            phony.update(deps)
            current = []
            continue
        if not all(map(MAKE_NAME.match, names)) or any(n in rules for n in names):
            return None
        current = []
        rules.update((n, (deps, current)) for n in names)
    return rules, phony


def make_recipe(a, files):
    """Команды, которые выполнит `make <цели>` (цели — только MAKE_TRUSTED_GOALS, без опций и `VAR=`) по одному
    Makefile files (make_files), в порядке make: пререквизиты, затем рецепт; у строки сняты `@-+`, `$$` — `$`.
    None — разбор не сводит: другие слова, файлов не один или текст не прочтён, _make_rules — None, цель или
    пререквизит без правила или не в .PHONY (make искал бы неявное правило), `$` в строке рецепта."""
    if a[0] not in MAKES or len(a) < 2 or not set(a[1:]) <= MAKE_TRUSTED_GOALS or len(files) != 1 or not files[0][1]:
        return None
    parsed = _make_rules(files[0][1])
    if parsed is None:
        return None
    rules, phony = parsed
    order, seen = [], set()

    def visit(t):
        if t in seen:
            return True
        seen.add(t)
        if t not in rules or t not in phony or not all(visit(p) for p in rules[t][0]):
            return False
        order.append(t)
        return True

    if not all(visit(g) for g in a[1:]):
        return None
    out = []
    for line in (x for t in order for x in rules[t][1]):
        cmd = re.sub(r"^[ \t@+-]*", "", line or "")
        if line is None or "$" in cmd.replace("$$", ""):
            return None
        out += [cmd.replace("$$", "$")] if cmd.strip() else []
    return out


def trusted_make(a, files, found, coarse, written, classify, ctx):
    """SE-127: грубый признак Makefile (coarse) заменяют находки команд его рецептов (make_recipe) — каждая строка
    отдельно, как make запускает её в своём shell: classify(строка, *ctx, disk, имена записи команды и всех строк
    рецепта — запись прошлой строки видит следующая, линза backend #419, заметка 3). make_option уже отказал Makefile
    не с основной ветки origin, MAKEFLAGS, `--eval`, include, `$(shell`. Разбор не сводит или признака нет —
    (found, coarse) как были."""
    recipe = make_recipe(a, files) if coarse else None
    if recipe is None:
        return found, coarse
    w = set(written).union(*map(command_writes, recipe))
    return found + [f for c in recipe for f in classify(c, *ctx, True, w)], []
