#!/usr/bin/env python3
"""
Проверка merge-guard: инструмент под другим именем (SE-90). APFS не различает регистр: `GIT push …`, `/usr/bin/Gh pr …`,
`BASH x.sh` запускают git, gh, bash, а хук сравнивал имя с учётом регистра и пропускал (сверено линзой Контроля 14.11
на 8da831687: exec rc 0). Встроенные команды shell регистр различают: `CD x` — /usr/bin/cd в подоболочке, папка та же.

Запуск: python3 -I .claude/hooks/test_merge_guard_alias.py  (только эти проверки; все — test_merge_guard.py)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_files import GH_MOVED, GH_WRITTEN, command_writes  # noqa: E402
from merge_guard_shell import command_name, exact_name, launcher  # noqa: E402
from merge_guard_testkit import bash, check, finish, repo_on, same  # noqa: E402

se90 = repo_on("main", "se90")
(se90 / "x.sh").write_text("gh pr merge 1\n")
(se90 / "x.py").write_text("import os\nos.system('gh pr merge 1')\n")
(se90 / "sub").mkdir()
(se90 / "sub" / "x.sh").write_text("echo ok\n")
# (0) Регистр имени: внешнюю команду APFS найдёт в любом регистре — отказ, как у имени в нижнем.
for form in ("Gh pr merge 1", "GH pr merge 1", "GIT push origin HEAD:main", "/usr/bin/GIT push origin HEAD:main",
             "/opt/homebrew/bin/Gh pr merge 1", "SUDO gh pr merge 1", "Env gh pr merge 1", "COMMAND gh pr merge 1",
             "BASH x.sh", "Zsh x.sh", "PYTHON3 x.py", "Bash -c 'gh pr merge 1'", "cat x.sh | SH",
             "CD sub; bash x.sh", "XARGS -I{} gh pr merge {} < /dev/null", "=GH pr merge 1"):
    bash(f"SE-90: имя команды в другом регистре: {form!r}", form, True, cwd=se90)
for form in ("cd sub; bash x.sh", "Echo gh pr merge 1", "GIT status", "Gh pr view 1", "CD sub; echo ok"):
    bash(f"SE-90: регистр — проход: {form!r}", form, False, cwd=se90)
for word, want in (("GIT", "git"), ("/usr/bin/Gh", "gh"), ("=ZSH", "zsh"), ("`Bash", "bash")):
    check(f"SE-90 command_name({word!r})", same(command_name(word), want), False)
for word, want in (("CD", "CD"), ("/usr/bin/cd", "cd")):
    check(f"SE-90 exact_name({word!r})", same(exact_name(word), want), False)
for word, want in (("BASH", "sh"), ("Python3.12", "python"), ("NODE", "node"), ("swiftc", None)):
    check(f"SE-90 launcher({word!r})", same(launcher(word), want), False)
# Слова перед `cd` (dir_words, линза Контроля на 22ae0a3f3): внешняя обёртка или другой регистр — папка shell та же,
# `command`, `time -p` и zsh-модификаторы — bash и zsh расходятся (сверено exec), папка неизвестна. Голый push из main.
se90f = repo_on("feature/x", "se90f")
for pre in ("Builtin", "Command", "Time", "Nohup", "Env", "Sudo", "Nice", "nohup", "env", "exec", "command", "time -p",
            "noglob", "nocorrect", "-", "repeat 1"):
    bash(f"SE-90: `{pre} cd` к ветке feature — папка shell та же или неизвестна", f"{pre} cd {se90f}; git push", True,
         cwd=se90)
for pre in ("", "builtin ", "time ", "A=1 ", "! "):
    bash(f"SE-90: `{pre}cd` к ветке feature — папка сменилась, проход", f"{pre}cd {se90f}; git push", False, cwd=se90)
# В скрипте с диска «неизвестна» от расхождения bash и zsh не сбрасывается на прежнюю папку (так — только `cd "$ROOT"`):
# из ветки feature `command cd M` и `noglob cd M` переводят shell в main (линза Контроля на bbe88f7e0).
for name, text, shell, deny in (("c.sh", f"command cd {se90} && git push\n", "bash", True),
                                ("n.sh", f"noglob cd {se90}\ngit push\n", "zsh", True),
                                ("p.sh", f"echo | cd {se90}\ngit push\n", "zsh", True),
                                ("nohup.sh", f"nohup cd {se90}\ngit push\n", "bash", False)):
    (se90f / name).write_text(text)
    bash(f"SE-90: скрипт с диска {name} ({shell}) из ветки feature", f"{shell} {name}", deny, cwd=se90f)
# Записи команды (merge_guard_files): имя сравнивается свёрнутым — запись видна и у имени в другом регистре.
for text, want in (("CP a.sh b.sh", {"a.sh", "b.sh"}), ("NPM pkg set scripts.t=x", {"package.json"}),
                   ("TAR -xf a.tar -C ~/.config/gh", {GH_WRITTEN}), ("UNZIP -o a.zip -d ~/.config/gh", {GH_WRITTEN}),
                   ("BASH -c 'echo x > m.sh'", {"m.sh"}), ("EVAL 'echo x > m.sh'", {"m.sh"}),
                   ("ENV -i gh pr view 1", {GH_MOVED}), ("SUDO gh pr view 1", {GH_MOVED}),
                   ("/usr/bin/Sudo gh pr view 1", {GH_MOVED})):
    got = command_writes(text)
    check(f"SE-90 command_writes({text!r})", None if want <= got else sorted(got), False)
bash("SE-90: запись `CP` видна — скрипт переписан той же командой", "CP x.sh sub/x.sh; bash sub/x.sh", True, cwd=se90)

if __name__ == "__main__":
    finish(" — инструмент под другим именем")
