"""
Защищённые файлы merge-guard: законы и настройки хуков (`.claude/rules`, `.claude/hooks`, `settings*.json`, список
Контроля) в основной папке и папке, откуда сессия грузит хуки, реестр сессий `~/.claude/sessions` (protected_path);
запись в них из кода python/node/… (interp_found). Решений не принимает. Вынесено из хука (SE-85): хук — у предела
в 500 строк.
"""
import os
import re
from pathlib import Path

from merge_guard_gh import classify_interp
from merge_guard_shell import is_lost

HOME_CLAUDE = Path.home() / ".claude"  # проверки подменяют (merge_guard_testkit)
PROJECT_DIR = Path(__file__).resolve().parents[2]
GUARDED_CLAUDE_FILES = {"settings.json", "settings.local.json", "merge-guard.json", "merge-guard.local.json"}
GUARDED_CLAUDE_DIRS = ("rules", "hooks")


def main_roots(project_dir=PROJECT_DIR):
    """Основная папка и папка, откуда сессия грузит хуки и законы (если её запустили в worktree)."""
    s = os.path.realpath(project_dir)
    return sorted({s.split("/worktrees/", 1)[0], s})


def protected_path(path_str, cwd, roots):
    if not path_str or path_str.startswith("-"):
        return None
    p = os.path.join(cwd, os.path.expanduser(path_str))
    if is_lost(p):  # `cd "$X" && echo > 01-base.md`: папка может оказаться .claude/rules — по имени файла не понять
        return f"{path_str} после cd в папку, которую разбор не видит (пишите по абсолютному пути),"
    p = os.path.realpath(p)
    home = os.path.realpath(HOME_CLAUDE)
    if p == os.path.join(home, "sessions") or p.startswith(os.path.join(home, "sessions") + "/"):
        return p
    if p in (os.path.join(home, "settings.json"), os.path.join(home, "settings.local.json")):
        return p
    for root in roots:
        claude = os.path.join(os.path.realpath(root), ".claude")
        if os.path.dirname(p) == claude and os.path.basename(p) in GUARDED_CLAUDE_FILES:
            return p
        if any(p == os.path.join(claude, d) or p.startswith(os.path.join(claude, d) + "/") for d in GUARDED_CLAUDE_DIRS):
            return p
    return None


INTERP_WRITE = re.compile(r"""open\([^\n]*?,\s*(mode\s*=\s*)?['"][wax][+bt]*['"]|write_text|write_bytes|writeFile|appendFile|unlink|remove\(|rename|replace\(|rmSync|rmtree""")
# Путь собран из частей: '.claude' и защищённое имя отдельными строками (os.path.join, Path / …).
JOINED_CLAUDE = re.compile(r"""['"]\.claude['"].{0,80}?['"](rules|hooks|settings(\.local)?\.json|merge-guard(\.local)?\.json)['"/]""", re.S)
# Присваивание пути переменной (python, js, perl): `p = '.claude/settings.json'`, `const S = path.join(…)`.
PATH_VAR = re.compile(r"\s*(?:(?:const|let|var|my|our)\s+)?\$?([A-Za-z_]\w*)\s*(?::[^=\n]*)?=(?!=)")
READS = re.compile(r"\.read|read_text|readFile|load|open\(|glob|listdir|scandir|walk|exists|is_?file|stat\(")


def path_vars(lines, cwd, roots):
    """Имена переменных, которым присвоен защищённый путь (не содержимое файла: строки с чтением не берутся)."""
    names = set()
    for ln in lines:
        m = PATH_VAR.match(ln)
        if m and not READS.search(ln) and (JOINED_CLAUDE.search(ln) or any(
                protected_path(x.group(0), cwd, roots) for x in re.finditer(r"[\w./~-]*\.claude/[\w./-]+", ln))):
            names.add(m.group(1))
    return names


def interp_found(text, cwd, roots, by_line=False):
    """Код python/node/…: защищённая команда в subprocess и запись в защищённые файлы. by_line — скрипт с диска:
    запись и защищённый путь ищутся в одной строке (или путь в переменной из path_vars), иначе любой скрипт, который
    читает законы и пишет своё, — отказ."""
    found = []
    kind = classify_interp(["_", text], cwd)
    if kind:
        found.append((kind, text[:120]))
    chunks = text.splitlines() if by_line else [text]
    names = path_vars(chunks, cwd, roots) if by_line else set()
    for chunk in chunks:
        if not INTERP_WRITE.search(chunk):
            continue
        hit = next((n for n in names if re.search(rf"(?<![\w.]){re.escape(n)}\b", chunk)), None)
        if hit:
            found.append(("file", f".claude/… (путь в переменной {hit} — правьте через Edit)"))
        for m in re.finditer(r"[\w./~-]*\.claude/[\w./-]+", chunk):
            p = protected_path(m.group(0), cwd, roots)
            if p:
                found.append(("file", p))
        if JOINED_CLAUDE.search(chunk):
            found.append(("file", ".claude/… (путь собран из частей — правьте через Edit)"))
    return found
