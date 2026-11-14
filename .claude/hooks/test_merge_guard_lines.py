#!/usr/bin/env python3
"""
Проверка merge-guard: склейка строк (SE-83) — `\\`+перевод строки bash снимает целиком (`g\\`⏎`h` — слово `gh`), а
`\\\\`⏎ — экранированная `\\` и конец строки. Раньше склейка шла пробелом и без учёта `\\\\`: оба пути прятали команду.
Тело heredoc без кавычек у метки читатель получает после раскрытия `\\` (`\\\\` → `\\`, `\\`⏎ снят), имена записей в
теле — тоже; разбор без снятия комментариев (SE-77) склеивает строки так же. Конец тела heredoc — как у shell.

Запуск: python3 -I .claude/hooks/test_merge_guard_lines.py  (только эти проверки; все — test_merge_guard.py)
"""
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_comments import strip_comments  # noqa: E402
from merge_guard_shell import cut_heredocs, heredoc_text, join_lines  # noqa: E402
from merge_guard_testkit import bash, check, finish, repo_on  # noqa: E402

se83 = repo_on("main", "se83")
JOINS = {"esc.sh": "echo \\\\\ngh pr merge 1\n", "esc-var.sh": "G=gh\necho \\\\\n$G pr merge 1\n",
         "name.sh": "g\\\nh pr merge 1\n", "arg.sh": "gh pr me\\\nrge 1\n",
         "hd.sh": "cat <<E | bash\ng\\\\\nh pr merge 1\nE\n",  # без кавычек у метки: `\\` → `\`, читатель склеит
         "hd-q.sh": "cat <<'E' | bash\ng\\\nh pr merge 1\nE\n", "hd-q-esc.sh": "cat <<'E' | bash\necho \\\\\ngh pr merge 1\nE\n",
         "odd.sh": "echo \\\\\\\ngh pr merge 1\n",  # `\\` и склейка: следующая строка — аргумент echo
         "ok.sh": "echo \\\\\necho ok\n", "ok-sq.sh": "echo 'a\\\nb'\n", "ok-hd.sh": "cat <<E\necho \\\\\nE\n"}
for name, text in JOINS.items():
    (se83 / name).write_text(text)
    deny = name not in ("odd.sh", "ok.sh", "ok-sq.sh", "ok-hd.sh")
    for form in (text, f"bash {name}", f"source {name}", f"bash < {name}", "bash -c " + shlex.quote(text),
                 "eval " + shlex.quote(text)):
        bash(f"SE-83: {name} — {form[:30]!r}", form, deny, cwd=se83)
# zsh 5.9 (проверено 14.11): после `histchars='!^%'` `#` — буква, и `ec\`⏎`ho` за ним — команда `echo`. Разбор без
# снятия комментариев (raw, SE-77) склеивает так же.
(se83 / "r.zsh").write_text("histchars='!^%'\necho a # ; g\\\nh pr merge 1\n")
for form in ("histchars='!^%'\necho a # ; g\\\nh pr merge 1", "histchars='!^%'; eval 'echo a # ; g\\\nh pr merge 1'",
             "source r.zsh", "zsh r.zsh"):
    bash(f"SE-83: склейка за `#` после смены знака комментария — {form[:30]!r}", form, True, cwd=se83)
bash("SE-83: склейка за `#` после смены знака — безобидная команда", "histchars='!^%'\necho a # ; ec\\\nho ok", False)
# Имя записи в теле heredoc — как его прочтёт bash: `m\\`⏎`.sh` без кавычек у метки и `m\`⏎`.sh` в кавычках — `m.sh`.
(se83 / "m.sh").write_text("echo ok\n")  # старый безобидный файл на диске
for form in ("cat <<E | bash\necho gh pr merge 1 > m\\\\\n.sh\nE\nbash m.sh",
             "cat <<'E' | bash\necho gh pr merge 1 > m\\\n.sh\nE\nbash m.sh"):
    bash(f"SE-83: запись в heredoc со склейкой имени — не старый m.sh: {form[:24]!r}", form, True, cwd=se83)
bash("SE-83: та же запись без запуска — проход", "cat <<E | bash\necho gh pr merge 1 > m\\\\\n.sh\nE", False, cwd=se83)
bash("SE-83: запись другого файла, запуск старого — проход", "cat <<E | bash\necho echo ok > n\\\\\n.sh\nE\nbash m.sh",
     False, cwd=se83)
# Конец heredoc — как у shell (линза Контроля на c023a9d6c): строка, равная метке (`<<-` — после ведущих табов), у метки
# без кавычек — после склейки `\`⏎; метки нет — тело до конца текста. Иначе строки за «концом» хука shell отдаёт
# читателю, а хук разбирает их как верхний уровень, где `g\\`⏎`h` — не `gh` (или наоборот: код — как данные).
# bash 3.2 и zsh 5.9 выполняют все формы с отказом (проверено 14.11 поддельным gh).
ACT = "g\\\\\nh p\\\\\nr me\\\\\nrge 1"
for name, text, deny in (
        ("A: `\\`⏎ перед меткой", f"cat <<E | bash\necho x\\\nE\n{ACT}\nE", True),
        ("C: то же, bash <<E", f"bash <<E\necho x\\\nE\n{ACT}\nE", True),
        ("I: <<-, табы, `\\`⏎ перед меткой", f"cat <<-E | bash\n\techo x\\\n\tE\n{ACT}\n\tE", True),
        ("K: ` E` — не метка", f"cat <<E | bash\necho a\n E\n{ACT}\nE", True),
        ("L: `E ` — не метка", f"cat <<E | bash\necho a\nE \n{ACT}\nE", True),
        ("M: <<- снимает только табы", f"cat <<-E | bash\necho a\n E\n{ACT}\nE", True),
        ("G: метка из `E\\` и пустой строки", "cat <<E >/dev/null\nx\nE\\\n\ngh pr merge 1\nE", True),
        ("метки нет — тело до конца текста", f"cat <<E | bash\n{ACT}\n E", True),
        ("два heredoc в строке — тела подряд", f"cat <<A <<B | bash\nx\nA\n{ACT}\nB", True),
        ("два heredoc в разных командах строки", f"cat <<A; bash <<B\nx\nA\n{ACT}\nB", True),
        ("`<<\\E` — метка в кавычках: без склейки", "cat <<\\E | bash\necho x\\\nE\ngh pr merge 1", True),
        ("`<<\"E\"F` — метка EF", "cat <<\"E\"F >/dev/null\nx\nE\ngh pr merge 1\nEF", False),
        ("E: `\\`⏎ перед меткой, в теле echo", "cat <<E | bash\necho x\\\nE\necho ok\nE", False),
        ("F: читателя нет", f"cat <<E > f.txt\necho x\\\nE\n{ACT}\nE", False),
        ("H: G с меткой в кавычках", "cat <<'E' >/dev/null\nx\nE\\\n\ngh pr merge 1\nE", False),
        ("J: <<'E', в данных команда", "cat <<'E' > f.txt\ngh pr merge 1\nE", False),
        ("N: ` E`, в теле echo", "cat <<E | bash\necho a\n E\necho b\nE", False),
        ("метки нет, читателя нет", "cat <<E > f.txt\nsome text\n E", False)):
    bash(f"SE-83 конец heredoc: {name}", text, deny, cwd=se83)
for text, want in (("g\\\nh", "gh"), ("echo \\\\\nx", "echo \\\\\nx"), ("echo 'a\\\nb'", "echo 'a\\\nb'"),
                   ("echo \"a\\\nb\"", "echo \"ab\""), ("echo $'a\\\nb'", "echo $'a\\\nb'"), ("a \\\n#b", "a "),
                   ("a\\\n#b", "a#b"), ("# x \\\nb", "\nb")):
    check(f"SE-83 strip_comments склеивает как bash: {text!r}", None if strip_comments(text, True) == want else
          strip_comments(text, True), False)
check("SE-83 heredoc_text: без кавычек у метки `\\\\` → `\\`, `\\`⏎ снят",
      None if heredoc_text("g\\\\\nh \\$x a\\\nb", True) == "g\\\nh $x ab" else "нет", False)
check("SE-83 heredoc_text: метка в кавычках — тело как есть", None if heredoc_text("g\\\\\nh", False) == "g\\\\\nh"
      else "нет", False)
for text, want in (("cat <<E >/dev/null\nx\nE\\\n\ny\nE", ("cat << E >/dev/null\ny\nE", ["x"])),
                   ("cat <<'E'\na\\\nE\nb", ("cat << E\nb", ["a\\"])), ("cat <<-E\n\tx\n\tE\ny", ("cat << E\ny", ["\tx"])),
                   ("cat <<E\nx\n E", ("cat << E\nx\n E", ["x\n E"]))):
    got = cut_heredocs(text)
    check(f"SE-83 cut_heredocs: конец тела как у shell: {text!r}",
          None if (got[0], [b for _, b, _ in got[1]]) == want else got, False)
check("SE-83 join_lines: нечётная серия — склейка, чётная — нет",
      None if join_lines("gh \\\npr a\\\\\nb c\\\\\\\nd") == "gh pr a\\\\\nb c\\\\d" else "нет", False)

if __name__ == "__main__":
    finish(" — склейка строк")
