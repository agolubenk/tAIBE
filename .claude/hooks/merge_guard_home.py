"""
Файлы в домашней папке, которые выполняются до текста команды (SE-98, перенос HR IS-245): реестр и окружение сессий,
снимки shell и файлы запуска shell. Запись в них даёт имя, функцию или alias следующей команде Bash любой сессии до
хука, поэтому merge-guard (pre-tool-use-merge-guard.py) считает их защищёнными. Решений о командах здесь нет.
"""
import os
import re

# ~/.claude/<папка>: реестр сессий (кто Контроль), снимок shell и окружение сессии (их shell выполняет до команды).
GUARDED_HOME_DIRS = ("sessions", "shell-snapshots", "session-env")
GUARDED_HOME_FILES = ("settings.json", "settings.local.json")
# Файлы запуска shell (в ~ и в $ZDOTDIR): задают имена, функции и alias до текста команды — хук их не видит.
SHELL_INIT = {".zshenv", ".zshrc", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".profile"}

# Код интерпретатора с записью: путь в домашнюю папку собран как угодно (`os.environ['HOME'] + '/.zshenv'`,
# `$ENV{HOME}."/.claude/shell-snapshots"`) — признак защищённого файла сам путь, без учёта регистра (APFS).
# Запись не из python/node (HR Контроль 91, F3): perl, ruby, php, awk, osascript и копирование — режим `>`/`>>`/`+<`
# строкой (`open(F, ">>", f)`), вывод в файл (`print … >> "f"`), `.open('a')`, write/syswrite/fwrite/binwrite,
# file_put_contents, O_WRONLY…, копия, перенос и ссылка (shutil, File::Copy, FileUtils, fs.cpSync). Дополняет
# INTERP_WRITE хука.
MORE_WRITES = (r"""|['"]\s*(\+<|\+?>{1,2})|>{1,2}\s*['"$(/~]|\.open\(\s*(mode\s*=\s*)?['"][wax]|(?<!\w)(sys|f|bin)?write\b"""
               r"""|WriteStream|put_contents|O_(WRONLY|RDWR|APPEND|CREAT|TRUNC)"""
               r"""|\b(copy\w*|move|(sym)?link(Sync)?|truncate|cpSync)\s*\(|FileUtils""")
HOME_WRITE = re.compile(r"\.claude/(sessions|shell-snapshots|session-env)\b"
                        rf"|(?<![\w.])({'|'.join(re.escape(n) for n in sorted(SHELL_INIT))})(?![\w.])", re.I)


def _under(f, d):
    return f == d or f.startswith(d + "/")


def home_protected(f, home_claude):
    """f — realpath пути, приведённый casefold(); home_claude — папка ~/.claude. Защищён ли путь в домашней папке."""
    home = os.path.realpath(home_claude).casefold()
    if any(_under(f, os.path.join(home, d)) for d in GUARDED_HOME_DIRS):
        return True
    if f in {os.path.join(home, n) for n in GUARDED_HOME_FILES}:
        return True
    dots = {os.path.realpath(os.path.expanduser(d)).casefold()
            for d in ("~", os.environ.get("ZDOTDIR") or "~", os.path.dirname(os.path.realpath(home_claude)))}
    return os.path.basename(f) in SHELL_INIT and os.path.dirname(f) in dots
