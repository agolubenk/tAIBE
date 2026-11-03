"""
Папка shell для merge-guard (pre-tool-use-merge-guard.py): `cd`, `pushd`, `popd`, `dirs -c` по модели bash
(сверено с bash 3.2 и 5): стек ds, где ds[0] — текущая папка, и $OLDPWD. Цель, которую разбор не видит (`cd "$X"`
с неизвестной X, `cd $(…)`, `cd -` без известной прежней папки), — LOST: относительные пути от неё остаются
неизвестными, абсолютный `cd` возвращает к известной папке. Решений не принимает: что делать с LOST, решает хук.
"""
import os
import re

from merge_guard_shell import CURRENT, LOST, SUBST, is_lost

DIR_CMDS = {"cd", "pushd", "popd", "dirs"}
NUM = re.compile(r"[+-]\d+")


def new_state(cwd):
    return {"ds": [cwd], "old": None, "lost": False}


def copy_state(st):
    return {"ds": list(st["ds"]), "old": st["old"], "lost": st["lost"]}


def _target(x):
    return LOST if any(m in x for m in ("$", "`", SUBST, CURRENT)) else os.path.expanduser(x)


def _go(st, ds):
    """Перейти: новая папка — ds[0] от прежней (у `pushd -n` в стеке лежит слово как есть)."""
    prev = st["ds"][0]
    ds[0] = os.path.join(prev, ds[0])
    st["ds"], st["old"] = ds, prev


def _cd(st, args):
    args = [x for x in args if not re.fullmatch(r"-[LPe@]+", x)]
    args = args[1:] if args[:1] == ["--"] else args
    target = args[0] if args else "~"
    if target == "-":
        target = st["old"] or LOST
    _go(st, [_target(target)] + st["ds"][1:])


def _index(n, size):
    k = int(n[1:]) if n[0] == "+" else size - 1 - int(n[1:])
    return k if 0 <= k < size else None


def _pushd(st, args):
    """`pushd D` — D наверх и туда; `-n D` — D вторым, без перехода; без папки — обмен двух верхних; `+N`/`-N` —
    поворот стека. Номер вне стека и обмен при одной папке — ошибка bash, папка прежняя."""
    no_cd = "-n" in args
    args = [x for x in args if x != "-n"]
    ds = st["ds"]
    if args and not NUM.fullmatch(args[0]):
        target = (st["old"] or LOST) if args[0] == "-" else _target(args[0])
        if no_cd:
            st["ds"] = ds[:1] + [target] + ds[1:]
        else:
            _go(st, [target] + ds)
    elif no_cd:
        st["lost"] = st["lost"] or bool(args)  # `pushd -n +N` — стек разбор дальше не ведёт
    elif st["lost"]:
        _go(st, [LOST])
    elif args:
        k = _index(args[0], len(ds))
        if k is not None:
            _go(st, ds[k:] + ds[:k])
    elif len(ds) >= 2:
        _go(st, [ds[1], ds[0]] + ds[2:])


def _popd(st, args):
    """`popd` — снять верхнюю и перейти в следующую; `-n` — снять вторую; `+N`/`-N` — снять N-ю (`+0` — как `popd`).
    Одна папка в стеке или номер вне стека — ошибка bash, папка прежняя."""
    no_cd = "-n" in args
    args = [x for x in args if x != "-n"]
    ds = st["ds"]
    if st["lost"] and not no_cd:
        _go(st, [LOST])
    elif no_cd and args:
        st["lost"] = True
    elif len(ds) >= 2:
        k = _index(args[0], len(ds)) if args and NUM.fullmatch(args[0]) else (1 if no_cd else 0)
        if k == 0:
            _go(st, ds[1:])
        elif k is not None:
            st["ds"] = ds[:k] + ds[k + 1:]


def _step(a, st):
    if a[0] == "cd":
        _cd(st, a[1:])
    elif a[0] == "pushd":
        _pushd(st, a[1:])
    elif a[0] == "popd":
        _popd(st, a[1:])
    elif a[0] == "dirs" and "-c" in a[1:]:
        st["ds"], st["lost"] = st["ds"][:1], False


def dir_step(variants, st, piped=False):
    """Применить `cd`/`pushd`/`popd`/`dirs` ко всем вариантам подстановки (argv); прочие команды папку не меняют.
    Варианты разошлись или команда — последняя стадия конвейера (`… | cd x`: zsh сменит папку, bash — нет) — папка
    неизвестна. Возвращает новую папку shell."""
    results = []
    for a in variants:
        s = copy_state(st)
        if a and a[0] in DIR_CMDS:
            _step(a, s)
        results.append(s)
    if piped or any(r != results[0] for r in results[1:]):
        results = [{"ds": [LOST], "old": None, "lost": True}]
    st.update(results[0])
    return st["ds"][0]


# Папка самого скрипта: в тексте с диска shell подставит её на место этих форм.
SCRIPT_DIR = re.compile(r"""\$\(\s*dirname\s+(?:--\s+)?(?:"\$\{?(?:BASH_SOURCE(?:\[0\])?|0)\}?"|\$\{?(?:BASH_SOURCE(?:\[0\])?|0)\}?)\s*\)"""
                        r"""|\$\{(?:BASH_SOURCE(?:\[0\])?|0)%/\*\}""")
# `$(cd X && pwd)`: та же папка, что X от папки shell; X — слово без подстановок команд (`$VAR` можно).
CD_PWD = re.compile(r"""\$\(\s*cd\s+(?:-[LP]\s+)?(?:--\s+)?("(?:[^"$`]|\$(?!\())*"|'[^']*'|(?:[^\s;&|()$`'"]|\$(?!\())+)"""
                    r"""(?:\s+\d*>&?\s*[^\s$`;&|()<>'"]+)*\s*(?:&&|;)\s*pwd(?:\s+-[LP])?\s*\)""")
TOPLEVEL = re.compile(r"\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)")


def _toplevel(cwd):
    d = cwd
    while not os.path.exists(os.path.join(d, ".git")):
        if os.path.dirname(d) == d:
            return None
        d = os.path.dirname(d)
    return d


def resolve_dirs(cmd, script, cwd):
    """Подставить известные папки: `$(dirname "${BASH_SOURCE[0]}")`, `${0%/*}` — папка скрипта (script — путь скрипта
    с диска, иначе не подставляется), `$(git rev-parse --show-toplevel)` — корень репозитория папки cwd,
    `$(cd X && pwd)` — X от ${PWD} (X с `$VAR` в начале — как есть: значение переменной решит)."""
    if isinstance(script, str) and re.fullmatch(r"[\w./-]+", script):
        cmd = SCRIPT_DIR.sub(lambda _: os.path.dirname(script), cmd)
    top = None if is_lost(cwd) else _toplevel(cwd)
    cmd = TOPLEVEL.sub(lambda _: top, cmd) if top and re.fullmatch(r"[\w./-]+", top) else cmd

    def cd_pwd(m):
        x = m.group(1)
        x = x[1:-1] if x[:1] in "\"'" else x
        return os.path.normpath(x) if x.startswith("/") else x if x.startswith("$") else "${PWD}/" + x

    return CD_PWD.sub(cd_pwd, cmd)

