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
from merge_guard_shell import command_name, exact_name, launcher  # noqa: E402
from merge_guard_testkit import bash, check, finish, repo_on  # noqa: E402

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
    check(f"SE-90 command_name({word!r})", None if command_name(word) == want else command_name(word), False)
for word, want in (("CD", "CD"), ("/usr/bin/cd", "cd")):
    check(f"SE-90 exact_name({word!r})", None if exact_name(word) == want else exact_name(word), False)
for word, want in (("BASH", "sh"), ("Python3.12", "python"), ("NODE", "node"), ("swiftc", None)):
    check(f"SE-90 launcher({word!r})", None if launcher(word) == want else launcher(word), False)

if __name__ == "__main__":
    finish(" — инструмент под другим именем")
