#!/usr/bin/env python3
"""
Проверка merge-guard: интерактивный zsh с кодом со stdin (SE-85). У него `interactive_comments` выключен, и `#` в
строках со stdin — буква: `echo a # ; $G $A $B 1` выполняет и команду за `;`. Хук снимал `# …` как комментарий, а
имени настройки (`histchars`, `interactive_comments`) в тексте нет — детектор SE-77 молчал. Теперь такой запуск
разбирается и без снятия комментариев (keep, как после `histchars`).

Формы и ответы zsh 5.9 / bash 3.2 проверены 14.11 исполнением с пустым ZDOTDIR (безобидный `echo HIT`).
Код со stdin не из файла (`printf … | zsh -i`, `<<<`) хук не видит и для bash — это не SE-85.

Запуск: python3 -I .claude/hooks/test_merge_guard_zsh.py  (только эти проверки; все — test_merge_guard.py)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_launch import syntax_only  # noqa: E402
from merge_guard_shell import comments_off  # noqa: E402
from merge_guard_testkit import bash, check, finish, repo_on  # noqa: E402

se85 = repo_on("main", "se85")
Y = "G=gh A=pr B=me\nB=${B}rge\necho a # ; $G $A $B 1\n"  # действие из переменных: признака в комментарии нет
(se85 / "y.sh").write_text(Y)
(se85 / "ok.sh").write_text("echo a # ; echo ok\n")
# zsh выполняет команду за `#`: отказ.
for form in ("zsh -f -i -s < y.sh", "zsh -i < y.sh", "zsh -fi < y.sh", "zsh -if < y.sh", "/bin/zsh -i < y.sh",
             "cat y.sh | zsh -i", "cat y.sh | zsh -f -i -s", "zsh -f -l -i < y.sh", "zsh -f -ix < y.sh",
             "zsh -f -xi < y.sh", "zsh -f -o shinstdin -i < y.sh", "zsh -f -i -- < y.sh", "zsh -f -i - < y.sh",
             "zsh -f -o interactive -s < y.sh", "zsh -f -o INTER_ACTIVE -s < y.sh", "zsh -f -ointeractive -s < y.sh",
             "zsh -f --interactive -s < y.sh", "zsh -f --INTERACTIVE < y.sh",
             "zsh -fi <<'E'\n" + Y + "E", "zsh -fi <<E\n" + Y.replace("$", "\\$") + "E",
             "cat <<'E' | zsh -i\n" + Y + "E", "cd . && zsh -i < y.sh"):
    bash(f"SE-85: интерактивный zsh, `#` со stdin — буква: {form[:34]!r}", form, True, cwd=se85)
# `#` — комментарий (файл скрипта, `-c`, без `-i`, bash, sh) или за `#` нет действия: проход.
for form in ("zsh -f -i y.sh", "zsh -f -i -c \"$(cat y.sh)\"", "zsh -f < y.sh", "zsh -f -s < y.sh", "zsh y.sh",
             "bash -i < y.sh", "sh -i < y.sh", "cat y.sh | bash -i", "zsh -i < ok.sh", "cat ok.sh | zsh -fi",
             "zsh -fi <<'E'\necho a # ; echo ok\nE", "bash -i <<'E'\n" + Y + "E"):
    bash(f"SE-85: `#` — комментарий или действия нет: {form[:34]!r}", form, False, cwd=se85)
# Опции zsh читаются не как у bash. У zsh остаток связки после `o` — имя опции (`-onocorrect`), у bash `-o` берёт
# следующий аргумент, остаток — флаги (`bash -oc errexit 'код'` — это `-c`). У zsh `-O` — флаг (у bash — `-O shopt`),
# `exec` — обратная к noexec опция (`-n -o exec` выполняет), в имени не важны регистр и `_`, есть `--имя`. Хук читал всё
# по-bash: `n` в `-onocorrect` — «только синтаксис», `-O x.sh y.sh` — файл y.sh (проверено 14.11 исполнением).
(se85 / "x.sh").write_text("gh pr merge 1\n")
for form in ("zsh -f -onocorrect x.sh", "zsh -onocorrect x.sh", "zsh -fonocorrect x.sh", "zsh -f -onocorrect < x.sh",
             "zsh -f -o nocorrect x.sh", "zsh -f -n -o exec x.sh", "zsh -f -n -oexec x.sh", "zsh -f -noexec x.sh",
             "zsh -f -n -o E_XEC x.sh", "zsh -f -n --exec x.sh", "zsh -f -n +onoexec x.sh", "zsh -f -O x.sh ok.sh",
             "zsh -f -fO x.sh ok.sh"):
    bash(f"SE-85: zsh выполнит файл скрипта — он разбирается: {form!r}", form, True, cwd=se85)
for form in ("zsh -f -fonoexec x.sh", "zsh -f -oNO_EXEC x.sh", "zsh -f -n x.sh", "zsh -f -onocorrect -c 'echo ok'",
             "zsh -f --no-exec x.sh", "zsh -f +o exec x.sh", "zsh -f +oexec x.sh", "zsh -f -Onocorrect x.sh",
             "zsh -f -O -n x.sh"):
    bash(f"SE-85: zsh только проверит синтаксис или код в `-c`: {form!r}", form, False, cwd=se85)
for opts, zsh, want in ((["-onocorrect"], True, False), (["-fonoexec"], True, True), (["-on", "noexec"], False, True),
                        (["-o", "noexec"], True, True), (["+o", "noexec"], True, False), (["-n", "-o", "exec"], True, False),
                        (["-noexec"], True, False), (["--NO_EXEC"], True, True), (["-O", "-n"], True, True),
                        (["-O", "-n"], False, False), (["-n", "-o", "exec"], False, True)):
    check(f"SE-85 syntax_only: {opts} zsh={zsh}", None if syntax_only(opts, zsh) == want else syntax_only(opts, zsh), False)
for argv, want in ((["zsh", "-i"], True), (["zsh", "-fi"], True), (["zsh", "-o", "INTER_ACTIVE"], True),
                   (["zsh", "--interactive"], True), (["zsh", "-ointeractive"], True), (["/bin/zsh", "-xi"], True),
                   (["zsh", "-f", "-s"], False), (["bash", "-i"], False), (["sh", "-i"], False),
                   (["zsh", "--emulate", "sh"], False)):
    check(f"SE-85 comments_off: {argv}", None if comments_off(argv) == want else comments_off(argv), False)

if __name__ == "__main__":
    finish(" — интерактивный zsh")
