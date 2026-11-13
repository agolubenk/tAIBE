#!/usr/bin/env python3
"""
Проверка merge-guard, SE-77: текст меняет знак комментария — zsh `histchars`, `interactive_comments` в `bash -i`.
Тогда `#` — то ли комментарий, то ли код, и хук разбирает текст обоими способами (classify_bash, keep и raw).

Запуск: python3 -I .claude/hooks/test_merge_guard_histchars.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_comments import comment_char_may_change  # noqa: E402
from merge_guard_testkit import D9, bash, check, finish, repo_on  # noqa: E402

# zsh 5.9 (проверено 14.11): после `histchars='!^%'` знак комментария — `%`, и `#` — буква. Действует на то, что
# разобрано после присваивания: `eval`, `source`, строки скрипта ниже. Текст `zsh -c` и `eval` разобран целиком до
# присваивания — в нём самом `#` ещё комментарий.
HIDE = "echo a # ; $G pr merge 1"
for form in (f"G=gh; histchars='!^%'; eval '{HIDE}'",
             f"histchars='!^%'\neval 'G=gh; {HIDE}'",
             f"typeset \"hist\"\"chars=!^%\"; eval 'G=gh; {HIDE}'",
             f"typeset ${{:-hist}}chars='!^%'; eval 'G=gh; {HIDE}'",
             f"HISTCHARS='!^%'; eval 'G=gh; {HIDE}'",
             f"bash -i -c 'shopt -u interactive_comments; eval \"G=gh; {HIDE}\"'",
             f"bash -i +O interactive_comments -c 'eval \"G=gh; {HIDE}\"'",
             f"bash -i -c 'set +o interactive-comments; eval \"G=gh; {HIDE}\"'"):
    bash(f"SE-77: знак комментария сменён — `#` не прячет код: {form!r}", form, True)

se77 = repo_on("main", "se77")
(se77 / "h.zsh").write_text(f"G=gh\n{HIDE}\n")  # сам скрипт настройку не называет — её задал вызывающий
(se77 / "s.zsh").write_text(f"histchars='!^%'\nG=gh\n{HIDE}\n")  # zsh читает скрипт по строкам
(se77 / "ok.zsh").write_text("histchars='!^%'\necho a # b\n")
(se77 / "a.zsh").write_text("histchars='!^%'\n")  # настройка живёт в оболочке и после `source a.zsh`
(se77 / "e.zsh").write_text(f"eval 'G=gh; {HIDE}'\n")
bash("SE-77: `source` после `histchars=…` в вызывающей команде", "histchars='!^%'; source h.zsh", True, cwd=se77)
bash("SE-77: `source` после скрипта, который задал настройку", "source a.zsh; source h.zsh", True, cwd=se77)
bash("SE-77: `eval` после скрипта, который задал настройку", f"source a.zsh; eval 'G=gh; {HIDE}'", True, cwd=se77)
bash("SE-77: `eval` внутри скрипта после настройки у вызывающего", "histchars='!^%'; source e.zsh", True, cwd=se77)
bash("SE-77: порядок — `source h.zsh` до настройки", "source h.zsh; source a.zsh", False, cwd=se77)
(se77 / "m.sh").write_text("echo ok\n")  # старый безобидный файл на диске — запись за `#` его заменяет
(se77 / "w.zsh").write_text("echo a # ; echo gh pr merge 1 > m.sh\nbash m.sh\n")
STALE = "echo a # ; echo gh pr merge 1 > m.sh"
bash("SE-77: запись за `#` после настройки — не старый m.sh", f"histchars='!^%'\n{STALE}; bash m.sh", True, cwd=se77)
bash("SE-77: та же запись в `eval`", f"histchars='!^%'; eval '{STALE}'; bash m.sh", True, cwd=se77)
bash("SE-77: та же запись в скрипте после настройки", "histchars='!^%'; source w.zsh", True, cwd=se77)
bash("SE-77: без настройки `#` — комментарий, m.sh старый", f"{STALE}; bash m.sh", False, cwd=se77)
bash("SE-77: скрипт zsh сам меняет знак комментария", "zsh s.zsh", True, cwd=se77)
bash("SE-77: тот же скрипт — Контролю можно", "zsh s.zsh", False, who=D9, cwd=se77)
bash("SE-77: безобидный скрипт с `histchars` — проход", "zsh ok.zsh", False, cwd=se77)
bash("SE-77: без смены знака комментарий снимается — проход", f"G=gh\n{HIDE}", False)
bash("SE-77: `source` без смены знака — проход", "source h.zsh", False, cwd=se77)
bash("SE-77: `histchars` и безобидный комментарий — проход", "histchars='!^%'; eval 'echo a # b'", False)
# Только «не снимать комментарии» было бы пропуском: zsh снимет `# it's`, а разбор без снятия спарил бы `'` с
# кавычкой ниже и спрятал строку с мёржем. Поэтому разбор дважды.
bash("SE-77: оставить комментарий — не прятать код за `'` в нём", ": histchars\nG=gh\necho x # it's\n$G pr merge 1\necho # '",
     True)

NAMES = ("histchars='!^%'", 'typeset "hist""chars=x"', "${:-hist}chars=x", "HISTCHARS=x", "h\\istchars=x",
         "shopt -u interactive_comments", "set +o interactive-comments", "setopt NO_INTERACTIVE_COMMENTS")
for text in NAMES:
    check(f"SE-77 comment_char_may_change — называет: {text!r}", None if comment_char_may_change(text) else text, False)
for text in ("echo history chars", "echo characters", "ls # comment", "interactive comment"):
    check(f"SE-77 comment_char_may_change — не называет: {text!r}", text if comment_char_may_change(text) else None, False)

if __name__ == "__main__":
    finish(" — SE-77, смена знака комментария")
