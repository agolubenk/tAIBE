#!/usr/bin/env python3
"""
Проверка merge-guard: тесты слоя из чистой папки (SE-127, решение владельца A, taibe-d-se127-hooktests-1511).
Тест из .claude/hooks, .claude/scripts или eval/tools (SE-138) хук пускает без разбора текста, только если папка —
ровно её дерево на основной ветке origin и команда — простой запуск теста; `make check`/`make check-layer` — по
командам рецептов.
Запуск: python3 -I .claude/hooks/test_merge_guard_trust.py
"""
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import bash, check, finish, repo_on  # noqa: E402
import merge_guard_git  # noqa: E402
import merge_guard_launch as mg_launch  # noqa: E402
import merge_guard_make  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
MERGE = 'import os\nos.system("gh pr merge 1")\n'  # образец из текста тестов: обычный разбор видит мёрж
MAKEFILE = (".PHONY: check check-layer other\n"
            "WT_BASE ?= main\n"
            "check: check-layer\n"
            "check-layer:\n"
            "\t@for t in .claude/hooks/test_*.py .claude/scripts/test_*.py; do python3 \"$$t\" || exit 1; done\n"
            "\tbash .claude/hooks/test_y.sh\n"
            "other:\n"
            "\tgh pr merge 9\n")
LAYER = ((".claude/hooks/test_x.py", MERGE), (".claude/hooks/merge_guard_helper.py", "X = 1\n"),
         (".claude/hooks/test_y.sh", "gh pr merge 2\n"), (".claude/scripts/test_s.py", MERGE),
         ("sub/.claude/hooks/test_x.py", MERGE), ("tools/test_z.py", MERGE), ("Makefile", MAKEFILE),
         ("bad/Makefile", ".PHONY: check\ncheck:\n\tgh pr merge 5\n"), ("eval/tools/budget.py", "B = 1\n"))


def expect(label, ok):
    check(label, None if ok else "не так", False)


def git(d, *args):
    subprocess.run(["git", "-C", str(d), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True,
                   capture_output=True)


def layer_repo(prefix, home=True, origin=True, extra=(), drop=()):
    """Репозиторий с папками слоя на основной ветке origin (refs/remotes/origin/HEAD → main), в HOME_REPOS хука."""
    d = repo_on("main", prefix=prefix)
    for name, text in [f for f in LAYER if not f[0].startswith(tuple(drop))] + list(extra):
        (d / name).parent.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(text)
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", "layer")
    if origin:
        git(d, "update-ref", "refs/remotes/origin/main", "HEAD")
        git(d, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    if home:
        merge_guard_git.HOME_REPOS.append(str(d))
    return d


merge_guard_git.HOME_REPOS = []
ok = layer_repo("trust-ok-")
(ok / ".claude" / "hooks" / "__pycache__").mkdir()
(ok / ".claude" / "hooks" / "__pycache__" / "merge_guard_helper.cpython-313.pyc").write_bytes(b"\0")

for form in ("python3 .claude/hooks/test_x.py", "python3 -I .claude/hooks/test_x.py",
             "python3 -I -B -u .claude/hooks/test_x.py", "python3.12 .claude/hooks/test_x.py",
             "bash .claude/hooks/test_y.sh", "sh .claude/hooks/test_y.sh", "python3 -I .claude/scripts/test_s.py",
             'for t in .claude/hooks/test_*.py; do python3 "$t" || exit 1; done',
             'for t in .claude/hooks/test_*.py .claude/scripts/test_*.py; do python3 -I "$t" || exit 1; done',
             "cd .claude/hooks && python3 test_x.py", "python3 -I .claude/hooks/test_x.py 2>&1 | tail -5",
             "python3 -I .claude/hooks/test_x.py > out.txt", "make check", "make check-layer",
             "make check check-layer"):
    bash(f"чистая папка слоя, проход: {form!r}", form, False, cwd=ok)

# `python3 test_y.sh` — расширение не того запуска: доверия нет, решает разбор текста (`bash test_x.py` прошёл бы и
# до SE-127: текст Python в bash мёрж не запускает).
for form in ("python3 .claude/hooks/test_x.py; gh pr merge 1", "python3 .claude/hooks/test_y.sh",
             "python3 -W ignore .claude/hooks/test_x.py", "python3 -X dev .claude/hooks/test_x.py",
             "python3 .claude/hooks/test_x.py x", "python3 < .claude/hooks/test_x.py",
             "cat .claude/hooks/test_x.py | python3", "source .claude/hooks/test_y.sh", "bash -x .claude/hooks/test_y.sh",
             "bash .claude/hooks/test_y.sh x", "python3 sub/.claude/hooks/test_x.py", "python3 tools/test_z.py",
             "echo 1 > .claude/hooks/merge_guard_helper.py; python3 .claude/hooks/test_x.py",
             "echo 1 > json.py && python3 .claude/hooks/test_x.py",
             "cp a.pyc .claude/hooks/__pycache__/merge_guard_helper.cpython-313.pyc && python3 .claude/hooks/test_x.py",
             "cp -R ev/. .claude/hooks && python3 .claude/hooks/test_x.py",
             "git checkout -- .claude/hooks && python3 .claude/hooks/test_x.py",
             "make other", "make check other", "make -s check", "make check V=1", "make -C . check",
             "make -f Makefile check", "env .SHELLFLAGS=-ec make check", "env .RECIPEPREFIX=x make check",
             "cd bad && make check", "cp x .claude/hooks/merge_guard_helper.py && make check-layer"):
    bash(f"чистая папка слоя, отказ: {form!r}", form, True, cwd=ok)


def dirty(prefix, change, **kw):
    d = layer_repo(prefix, **kw)
    change(d / ".claude" / "hooks")
    return d


def link_same(h):  # ссылка на файл с теми же байтами: режим не 100644
    (h.parent.parent / "copy.py").write_text("X = 1\n")
    (h / "merge_guard_helper.py").unlink()
    (h / "merge_guard_helper.py").symlink_to(h.parent.parent / "copy.py")


def cache_link(h):
    (h.parent.parent / "cache").mkdir()
    (h / "__pycache__").symlink_to(h.parent.parent / "cache")


def cache_entry_link(h):
    (h / "__pycache__").mkdir()
    (h / "__pycache__" / "x.pyc").symlink_to(h / "merge_guard_helper.py")


def tools_link(h):  # eval/tools — ссылка на чистую копию: путь с ссылкой — не дерево ветки
    tools, copy = h.parent.parent / "eval" / "tools", h.parent.parent / "eval" / "copy"
    tools.rename(copy)
    tools.symlink_to(copy)


def tools_gone(h):  # на ветке есть, на диске нет: тест взял бы код по $TAIBE_ROOT
    tools = h.parent.parent / "eval" / "tools"
    (tools / "budget.py").unlink()
    tools.rmdir()


# Тесты слоя запускают и импортируют код из .claude/scripts и eval/tools (линза Claude к #419): грязная любая из них —
# отказ и тесту из чистой .claude/hooks.
for label, change, kw in (
        ("изменён eval/tools", lambda h: (h.parent.parent / "eval/tools/budget.py").write_text("B = 2\n"), {}),
        ("лишний файл в .claude/scripts", lambda h: (h.parent / "scripts/dams_common.py").write_text("X = 1\n"), {}),
        ("eval/tools — ссылка", tools_link, {}),
        ("нет eval/tools на диске", tools_gone, {}),
        ("изменён помощник", lambda h: (h / "merge_guard_helper.py").write_text("X = 2\n"), {}),
        ("изменён сам тест", lambda h: (h / "test_x.py").write_text(MERGE + "\n"), {}),
        ("лишний файл", lambda h: (h / "new.txt").write_text("x\n"), {}),
        ("удалён файл", lambda h: (h / "merge_guard_helper.py").unlink(), {}),
        ("ссылка вместо файла", link_same, {}),
        ("__pycache__ — ссылка", cache_link, {}),
        ("ссылка в __pycache__", cache_entry_link, {}),
        ("репозиторий не хука", lambda h: None, {"home": False}),
        ("нет origin/HEAD", lambda h: None, {"origin": False}),
        ("подпапка на ветке", lambda h: None, {"extra": ((".claude/hooks/lib/x.py", "X = 1\n"),)})):
    d = dirty("trust-dirty-", change, **kw)
    bash(f"грязная папка слоя ({label}): отказ теста", "python3 .claude/hooks/test_x.py", True, cwd=d)
    bash(f"грязная папка слоя ({label}): отказ make check-layer", "make check-layer", True, cwd=d)

# Инстанс без eval/tools (HR): тест слоя взял бы spawn_session.sh по $TAIBE_ROOT или $HOME — вне репозитория, текст не
# проверен (линза Claude #419, B1). Гейт — CI.
no_tools = layer_repo("trust-notools-", drop=("eval/",))
bash("нет eval/tools ни на диске, ни на ветке: отказ", "python3 .claude/hooks/test_x.py", True, cwd=no_tools)

# Тесты eval/tools — тоже тесты слоя (SE-138): CI гоняет их с тестами хуков, в тексте — те же образцы команд.
ev = layer_repo("trust-eval-", extra=(("eval/tools/test_t.py", MERGE),))
for form in ("python3 -I eval/tools/test_t.py", 'for t in eval/tools/test_*.py; do python3 -I "$t" || exit 1; done'):
    bash(f"SE-138, тест eval/tools из чистой папки — проход: {form!r}", form, False, cwd=ev)
(ev / "eval" / "tools" / "test_t.py").write_text(MERGE + "\n")
bash("SE-138, тест eval/tools с правкой — отказ", "python3 -I eval/tools/test_t.py", True, cwd=ev)

# Разбор: формы запуска и запись команды — без хука, функция целиком.
rt = getattr(merge_guard_git, "reviewed_test", None)
expect("есть merge_guard_git.reviewed_test (SE-127)", rt is not None)
if rt:
    h = os.path.realpath(ok / ".claude" / "hooks")
    px, py_sh, helper = h + "/test_x.py", h + "/test_y.sh", h + "/merge_guard_helper.py"
    for a, path, want in (
            (["python3", ".claude/hooks/test_x.py"], px, True), (["python3", "-I", "-B", ".claude/hooks/test_x.py"], px, True),
            (["python3", ".claude/hooks/test_*.py"], px, True), (["bash", ".claude/hooks/test_y.sh"], py_sh, True),
            (["python3"], px, False), (["python3", "-W", "ignore", ".claude/hooks/test_x.py"], px, False),
            (["python3", "-IB", ".claude/hooks/test_x.py"], px, False), (["python3", ".claude/hooks/test_x.py", "x"], px, False),
            (["bash", ".claude/hooks/test_x.py"], px, False), (["python3", ".claude/hooks/test_y.sh"], py_sh, False),
            (["zsh", ".claude/hooks/test_y.sh"], py_sh, False), (["source", ".claude/hooks/test_y.sh"], py_sh, False),
            (["./.claude/hooks/test_y.sh"], py_sh, False), (["/usr/bin/python3", ".claude/hooks/test_x.py"], px, False),
            (["python3", ".claude/hooks/merge_guard_helper.py"], helper, False),
            (["python3", ".claude/hooks/test_y.py"], px, False)):
        expect(f"reviewed_test {a} → {want}", rt(path, a, str(ok)) is want)
    for written, want in (({"out.txt"}, True), ({"merge_guard_helper.py"}, False), ({"/"}, False), ({"/x.py"}, False),
                          ({"m.cpython-313.pyc"}, False), ({"hooks"}, False), ({".claude"}, False), ({"."}, False),
                          ({"__pycache__"}, False), ({ok.name}, False), ({"json.py"}, False), ({"lib.sh"}, False),
                          ({"x.pth"}, False)):
        expect(f"reviewed_test: запись {written} → {want}", rt(px, ["python3", ".claude/hooks/test_x.py"], str(ok), written)
               is want)
    sub = os.path.realpath(ok / "sub" / ".claude" / "hooks" / "test_x.py")
    expect("reviewed_test: sub/.claude/hooks — не папка слоя", not rt(sub, ["python3", "sub/.claude/hooks/test_x.py"], str(ok)))

# Разбор Makefile: рецепты целей проверки; всё, что разбор не сводит, — None (решает грубый признак).
mr = getattr(merge_guard_make, "make_recipe", None)
expect("есть merge_guard_make.make_recipe (SE-127)", mr is not None)
if mr:
    def recipe(text, a=("make", "check")):
        return mr(list(a), [("Makefile", re.sub(r"(?m)^[ \t]*#.*$", "", text))])

    real = mr(["make", "check"], mg_launch.make_files(["make", "check"], str(REPO)))
    expect(f"make check по Makefile репозитория разобран: {str(real)[:80]}", real is not None)
    expect("рецепт check: python3 -I infra/checks/run.py", "python3 -I infra/checks/run.py" in (real or []))
    expect("рецепт check: цикл тестов слоя", any(c.startswith("for t in .claude/hooks/test_*.py") for c in real or []))
    layer = mr(["make", "check-layer"], mg_launch.make_files(["make", "check-layer"], str(REPO)))
    expect("make check-layer по Makefile репозитория разобран", layer is not None and set(layer) <= set(real or []))
    good = (".PHONY: check check-layer\nX ?= 1\ncheck: check-layer\n\t@echo $$HOME\n# c\ncheck-layer:\n\t-true\n\n"
            "\t+false\nother:\n\tgh pr merge 1\n")
    expect("порядок make, префиксы @-+ и $$", recipe(good) == ["true", "false", "echo $HOME"])
    expect("цель без рецепта — пусто", recipe(".PHONY: check\ncheck:\n") == [])
    expect("PATH ?= значение окружения не меняет", recipe(".PHONY: check\nPATH ?= /tmp/x\ncheck:\n\ttrue\n") == ["true"])
    expect("своё имя ?=", recipe(".PHONY: check\nSE127_OWN_X ?= 1\ncheck:\n\ttrue\n") == ["true"])
    for label, text, a in (
            ("$ в рецепте", ".PHONY: check\ncheck:\n\t@echo $(X)\n", None),
            ("export", ".PHONY: check\nexport X\ncheck:\n\ttrue\n", None),
            ("рецепт после ;", ".PHONY: check\ncheck: ; true\n", None),
            ("шаблон %", ".PHONY: check\n%:\n\ttrue\ncheck:\n\ttrue\n", None),
            ("::", ".PHONY: check\ncheck::\n\ttrue\n", None),
            (".ONESHELL", ".ONESHELL:\n.PHONY: check\ncheck:\n\ttrue\n", None),
            ("цель дважды", ".PHONY: check\ncheck:\n\ttrue\ncheck:\n\tfalse\n", None),
            ("пререквизит без правила", ".PHONY: check x\ncheck: x\n\ttrue\n", None),
            ("не .PHONY", "check:\n\ttrue\n", None),
            ("продолжение в рецепте", ".PHONY: check\ncheck:\n\techo a \\\n\tb\n", None),
            ("цель из переменной", ".PHONY: check\n$(T): x\ncheck:\n\ttrue\n", None),
            ("!=", ".PHONY: check\nX != true\ncheck:\n\ttrue\n", None),
            ("SHELL =", ".PHONY: check\nSHELL = /bin/bash\ncheck:\n\ttrue\n", None),
            (".SHELLFLAGS =", ".PHONY: check\n.SHELLFLAGS = -ec\ncheck:\n\ttrue\n", None),
            ("целевая переменная", ".PHONY: check\ncheck: SHELL = /x\n", None),
            ("order-only", ".PHONY: check x\nx:\n\ttrue\ncheck: | x\n\ttrue\n", None),
            ("$ в присваивании", ".PHONY: check\nX := $(Y)\ncheck:\n\ttrue\n", None),
            ("PATH = (имя из окружения)", ".PHONY: check\nPATH = /tmp/x\ncheck:\n\ttrue\n", None),
            ("PATH +=", ".PHONY: check\nPATH += /tmp/x\ncheck:\n\ttrue\n", None),
            ("BASH_ENV := (IMPLIED_VAR)", ".PHONY: check\nBASH_ENV := /tmp/x\ncheck:\n\ttrue\n", None),
            ("своё имя = (X=1 make check его экспортирует)", ".PHONY: check\nSE127_OWN_X = 1\ncheck:\n\ttrue\n", None),
            ("ifeq", ".PHONY: check\nifeq (a,a)\nendif\ncheck:\n\ttrue\n", None),
            ("табуляция до правила", "\ttrue\n.PHONY: check\ncheck:\n\ttrue\n", None),
            ("отступ пробелами", ".PHONY: check\ncheck:\n    true\n", None),
            ("другая цель", ".PHONY: wt-list\nwt-list:\n\tgit worktree list\n", ("make", "wt-list")),
            ("опция", ".PHONY: check\ncheck:\n\ttrue\n", ("make", "-s", "check")),
            ("VAR=", ".PHONY: check\ncheck:\n\ttrue\n", ("make", "check", "V=1")),
            ("цели нет", ".PHONY: x\nx:\n\ttrue\n", None)):
        expect(f"make_recipe: {label} — None", recipe(text, a or ("make", "check")) is None)
    expect("make_recipe: не make — None", mr(["awk", "check"], [("x", "check:\n")]) is None)
    expect("make_recipe: два файла — None", mr(["make", "check"], [("a", ".PHONY: check\ncheck:\n"), ("b", "")]) is None)
    tm = merge_guard_make.trusted_make
    expect("trusted_make без грубого признака — как было", tm(["make", "check"], [], [1], [], set(), None, ()) == ([1], []))
    seen = []
    tm(["make", "check"], [("Makefile", ".PHONY: check\ncheck:\n\ttrue\n\techo 1 > json.py\n")], [], [1], set(),
       lambda c, *x: seen.append(x[-1]) or [], ())
    expect("trusted_make: каждая строка видит записи всего рецепта", len(seen) == 2 and all("json.py" in w for w in seen))

finish(" — тесты слоя из чистой папки, SE-127")
