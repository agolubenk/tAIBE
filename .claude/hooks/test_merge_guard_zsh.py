#!/usr/bin/env python3
"""
Проверка merge-guard: маска zsh с `(…)` на месте слова у записи (SE-194, после IS-249 #508). Bash-инструмент запускает
/bin/zsh: `echo x > .cl(a)ude/<файл>` пишет в папку слоя, а разбор делил слово и видел цель `.cl`.

Запуск: python3 -I -B .claude/hooks/test_merge_guard_zsh.py
Пути собраны из частей (C, SET): хук читает этот файл с диска при запуске и иначе откажет на сами строки.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import TMP, bash, finish  # noqa: E402

C, SET = "." + "claude", "settings" + ".json"
G = f"{C[:3]}(a){C[4:]}"  # маска zsh: находит папку слоя
O = TMP / "zsh"  # чужая папка
O.mkdir(parents=True)

for label, cmd in [
    ("перенаправление >", f"echo x > {G}/{SET}"),
    (">> и (a|b) в начале слова", f"echo x >> ({C}|zz)/{SET}"),
    ("&>", f"echo x &> {G}/{SET}"),
    (">|", f"echo x >| {G}/{SET}"),
    ("tee -a после трубы", f"printf x | tee -a {G}/{SET}"),
    ("touch", f"touch {G}/{SET}"),
    ("dd of=", f"dd if=/dev/null of={G}/{SET}"),
    ("sed -i", f"sed -i s/a/b/ {G}/{SET}"),
    ("git checkout --", f"git checkout -- {G}/{SET}"),
    ("env tee — команда за обёрткой", f"env tee {G}/{SET} < /dev/null"),
    ("rm после <(…): слова внешней команды — после `)`", f"rm -rf <(true) {G}"),
    ("rm после 2>&1: перенаправление команду не обрывает", f"rm 2>&1 -rf {G}"),
    ("rm в $(…)", f"x=$(rm -rf {G})"),
    ("квалификатор у цели cp", f"cp {O}/a {C}/*(.)"),
]:
    bash(f"SE-194, отказ — {label}: {cmd}", cmd, True)

for label, cmd in [
    ("$(…) в имени цели", f"echo x > {O}/out-$(date +%s).log"),
    ("подоболочка после rm", f"rm -f {O}/a; (cd {O} && ls)"),
    ("функция f()", f"f() {{ rm -f {O}/a; }}"),
    ("массив", f"arr=(a b); echo x > {O}/a"),
    ("(( … )) в if", f"if (( 2 > 1 )); then echo x > {O}/a; fi"),
    ("шаблон в [[ ]]", f"[[ x == (a|b) ]] && echo x > {O}/a"),
    ("<(…) у diff", f"diff <(echo a) <(echo b) > {O}/d"),
    (">(…) у tee", f"echo x | tee >(cat) {O}/a"),
    ("скобки в кавычках", f"echo 'fix(x)' > {O}/a"),
    ("шаблон case", f"case x in (a) echo y > {O}/a;; esac"),
    ("маска у чтения", "ls (a|b)"),
]:
    bash(f"SE-194, проход — {label}: {cmd}", cmd, False)

finish(", SE-194: маска zsh `(…)` у записи")
