"""
SE-98: merge-guard tAIBE стережёт файлы домашней папки, которые shell выполняет до команды (перенос HR IS-245):
~/.claude/{sessions,shell-snapshots,session-env}, файлы запуска shell в ~ и в $ZDOTDIR, запись из кода
интерпретатора (HOME_WRITE) и признак в FALLBACK. Запуск: python3 .claude/hooks/test_merge_guard_home.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import TMP, bash, check, finish, mg  # noqa: E402

os.environ["ZDOTDIR"] = str(TMP / "zd0")  # файлы запуска shell машины тесту не нужны
home = TMP / "home"
snap = home / ".claude" / "shell-snapshots" / "s.sh"
env_file = home / ".claude" / "session-env" / "sid" / "hook-1.sh"

# Запись из shell: перенаправление, tee, cp — в каждый защищённый путь.
for form in ("echo 'export G=gh' >> ~/.zshenv", "echo 'alias m=x' >> ~/.zshrc", "echo x > ~/.bash_profile",
             "echo x >> ~/.profile", f"echo G=gh >> {snap}", f"echo G=gh >> {env_file}",
             f"echo G=gh >> {TMP}/zd0/.zshenv", f"echo G=gh >> {home}/.zshrc", "echo x >> ~/.ZSHRC",
             f"cp g.sh {snap}", f"echo x | tee -a {home}/.zprofile"):
    bash(f"SE-98 отказ: {form!r}", form, True)

# Запись из кода интерпретатора: путь собран из окружения.
for form in ("perl -e 'open(F, \">>$ENV{HOME}/.claude/shell-snapshots/s.sh\"); print F \"G=gh\"'",
             "python3 -c \"import os; open(os.path.expanduser('~/.zshenv'), 'a').write('G=gh')\"",
             "python3 -c \"import os; open(os.environ['HOME'] + '/.bashrc', 'w').write('x')\"",
             "node -e \"require('fs').appendFileSync(process.env.HOME + '/.claude/session-env/x', 'G=gh')\""):
    bash(f"SE-98 отказ, интерпретатор: {form!r}", form, True)

# Чтение и похожие имена — проход.
for form in ("cat ~/.zshrc", "grep alias ~/.zshrc", "awk '{print}' ~/.zshrc", "echo x >> notes.zshrc.md",
             "echo x >> ./profile.txt", "ls ~/.claude/shell-snapshots", "python3 -c \"print(open('/etc/hosts').read())\""):
    bash(f"SE-98 проход: {form!r}", form, False)
snap.parent.mkdir(parents=True, exist_ok=True)
snap.write_text("x=1\n")  # файл есть: иначе путь в коде — NOT_YET (признак FALLBACK), а не чтение
for form in (f"ruby -e 'puts File.read(\"{snap}\")'", f"perl -e 'open(F, \"<\", \"{snap}\"); print <F>'",
             f"perl -ne 'print if /G/' {snap}"):
    bash(f"SE-98 проход, чтение интерпретатором: {form!r}", form, False)
snap.unlink()
for form in (f"ruby -e 'File.write(\"{snap}\", \"G=gh\")'", f"awk 'BEGIN{{print \"G=gh\" >> \"{snap}\"}}'",
             f"python3 -c \"import shutil; shutil.copy('g.sh', '{snap}')\""):
    bash(f"SE-98 отказ, запись интерпретатором: {form!r}", form, True)

# Модуль: путь вне ~ и $ZDOTDIR с тем же именем — не защищён.
check("SE-98 .zshrc в чужой папке не защищён", mg.home_protected(str(TMP / "repo" / ".zshrc").casefold(), mg.HOME_CLAUDE) or None, False)
check("SE-98 ~/.claude/session-env защищён", mg.home_protected(str(env_file.resolve()).casefold(), mg.HOME_CLAUDE) or None, True)
check("SE-98 FALLBACK видит ~/.zshenv", mg.FALLBACK.search("echo >> ~/.zshenv") or None, True)
check("SE-98 FALLBACK не видит .zshrc.md", mg.FALLBACK.search("notes.zshrc.md") or None, False)

os.environ.pop("ZDOTDIR")
finish(" — файлы ~, которые shell выполняет до команды (SE-98)")
