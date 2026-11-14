#!/usr/bin/env python3
"""
Проверка merge-guard: защищённый путь в другом регистре (SE-94, перенос HR IS-245, HR #684). APFS не различает регистр: `.CLAUDE/settings.json`,
`.claude/SETTINGS.JSON`, `.Claude/rules/…` — те же файлы, а protected_path сравнивал путь с учётом регистра и
пропускал запись. Так же имя файла, который команда переписывает и тут же запускает: `> X.sh; bash x.sh` — тот же файл.

Запуск: python3 -I -B .claude/hooks/test_merge_guard_pathcase.py  (только эти проверки; все — test_merge_guard.py)
Пути и имя gh собраны из частей (C, G): хук читает этот файл с диска при запуске и иначе откажет на сами строки.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import D9, HOME, ROOT, bash, check, finish, repo_on, run  # noqa: E402

C, G = "." + "claude", "g" + "h"
UP, MIX = C.upper(), "." + "Claude"  # .CLAUDE, .Claude (capitalize() у ".claude" ничего не меняет)
SET, RULE = "settings" + ".json", "rules/01-base.md"

# Запись в защищённое в другом регистре — отказ, и Контролю тоже: защищённые файлы правит только владелец.
for label, cmd in [
    ("нижний регистр (как было)", f"echo x > {C}/{SET}"),
    ("папка .CLAUDE", f"echo x > {UP}/{SET}"),
    ("имя SETTINGS.JSON", f"echo x > {C}/{SET.upper()}"),
    ("папка .Claude/rules", f"echo x > {MIX}/{RULE}"),
    ("папка Rules", f"echo x > {C}/{RULE.capitalize()}"),
    ("python open .CLAUDE", f"python3 -c \"open('{UP}/{SET}', 'w').write('x')\""),
    ("python os.path.join .CLAUDE", f"python3 -c \"import os; open(os.path.join('{UP}', 'Settings.json'), 'w')\""),
]:
    bash(f"{label}: {cmd}", cmd, True)
    bash(f"{label} Контролем: {cmd}", cmd, True, who=D9)

for label, path in [
    ("Write .CLAUDE/settings.json", ROOT / UP / SET),
    ("Write .claude/Merge-Guard.json", ROOT / C / "Merge-Guard.json"),
    ("Edit .claude/RULES/…", ROOT / C / RULE.upper()),
    ("Write ~/.Claude/Sessions/…", HOME.parent / MIX / "Sessions" / "x.json"),
]:
    check(label, run("Write", {"file_path": str(path)}), True)
    check(f"{label} Контролем", run("Write", {"file_path": str(path)}, who=D9), True)

# Файл переписан и тут же запущен — имя в другом регистре: с диска прочтён не тот код.
case = repo_on("main", "se94")
(case / "x.sh").write_text("echo ok\n")
bash("> x.sh; bash x.sh (как было)", f"printf '{G} pr merge 1' > x.sh; bash x.sh", True, cwd=case)
bash("> X.sh; bash x.sh", f"printf '{G} pr merge 1' > X.sh; bash x.sh", True, cwd=case)
bash("curl -o X.sh; bash x.sh", "curl -so X.sh https://example.invalid/x; bash x.sh", True, cwd=case)
# Скрипт с диска: защищённый путь в переменной, запись — строкой ниже (path_vars).
(case / "w.py").write_text(f"p = '{ROOT}/{C}/{SET}'\nopen(p, 'w').write('x')\n")
(case / "W2.py").write_text(f"p = '{ROOT}/{UP}/{SET}'\nopen(p, 'w').write('x')\n")
bash("скрипт: путь в переменной (как было)", "python3 w.py", True, cwd=case)
bash("скрипт: путь .CLAUDE в переменной", "python3 W2.py", True, cwd=case)
# Грубый признак (FALLBACK) у Makefile — тоже без учёта регистра.
(case / "Makefile").write_text(f"all:\n\techo x > {UP}/rules/x\n")
bash("make: Makefile пишет в .CLAUDE/rules", "make", True, cwd=case)

# Не защищённое — проход.
for label, cmd in [
    ("чтение .CLAUDE/settings.json", f"cat {UP}/{SET}"),
    ("запись в CLAUDE.md", "echo x > notes/CLAUDE.md"),
    ("другой файл переписан", "printf ok > Y.sh; bash x.sh"),
]:
    bash(f"{label}: {cmd}", cmd, False, cwd=case)
for label, path in [
    ("Write .claude/Settings.json.bak", ROOT / C / "Settings.json.bak"),
    ("Write правила в worktree, .CLAUDE", ROOT / "worktrees/fix/x" / UP / RULE),
    ("Write src/Settings.json", ROOT / "src" / "Settings.json"),
]:
    check(label, run("Write", {"file_path": str(path)}), False)

if __name__ == "__main__":
    finish(", регистр защищённых путей")
