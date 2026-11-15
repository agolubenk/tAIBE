"""
make для pre-tool-use-merge-guard.py поверх разбора merge_guard_launch (make_files, опции make): make_option — причина,
по которой разбор не видит, что прочтёт или запустит make (хук отказывает с ней вместо LOST_DIR); make_hint — прямые
команды целей Makefile для сообщения об отказе (SE-105). Решений не принимает: отдаёт причину и строку, решает хук.
"""
import os
import re

from merge_guard_launch import (INCLUDE_ESCAPE, MAKE_BASE, MAKE_ENV, MAKE_TEXT, MAKEFLAGS_ARG, MAKES, NOT_ASCII,
                                _make_opts, _make_where, make_files)
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
MAKEFLAGS_WHY = ("MAKEFILES, MAKEFLAGS или GNUMAKEFLAGS (и VPATH, GPATH) из окружения: файлы MAKEFILES, папки поиска "
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
    предел дизайна: только грубый признак (хук)."""
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
