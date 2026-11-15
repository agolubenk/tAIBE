"""
Защищённые файлы и код интерпретаторов для merge-guard (pre-tool-use-merge-guard.py): законы, настройки хуков и реестр
сессий (protected_path) и что код python/node/… пишет и запускает (interp_found) — из команды, heredoc и скрипта с
диска.
"""
import os
import re
from pathlib import Path

from merge_guard_gh import GIT_PUSH, classify_interp, push_target
from merge_guard_git import MAIN_WRITE
from merge_guard_shell import is_lost

HOME_CLAUDE = Path.home() / ".claude"
GUARDED_CLAUDE_FILES = {"settings.json", "settings.local.json", "merge-guard.json", "merge-guard.local.json"}
GUARDED_CLAUDE_DIRS = ("rules", "hooks")


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
        if any(p == os.path.join(claude, d) or p.startswith(os.path.join(claude, d) + "/")
               for d in GUARDED_CLAUDE_DIRS):
            return p
    return None


INTERP_WRITE = re.compile(r"""open\([^\n]*?,\s*(mode\s*=\s*)?['"][wax][+bt]*['"]|write_text|write_bytes|writeFile"""
                          r"""|appendFile|unlink|remove\(|rename|replace\(|rmSync|rmtree""")
# Путь собран из частей: '.claude' и защищённое имя отдельными строками (os.path.join, Path / …).
JOINED_CLAUDE = re.compile(r"""['"]\.claude['"].{0,80}?['"]"""
                           r"""(rules|hooks|settings(\.local)?\.json|merge-guard(\.local)?\.json)['"/]""", re.S)


# Присваивание пути переменной (python, js, perl): `p = '.claude/settings.json'`, `const S = path.join(…)`.
PATH_VAR = re.compile(r"\s*(?:(?:const|let|var|my|our)\s+)?\$?([A-Za-z_]\w*)\s*(?::[^=\n]*)?=(?!=)")
READS = re.compile(r"\.read|read_text|readFile|load|open\(|glob|listdir|scandir|walk|exists|is_?file|stat\(")
CLAUDE_LITERAL = re.compile(r"[\w./~-]*\.claude/[\w./-]+")
# Временная папка теста (SE-138): `.claude/…` от неё — не законы и настройки папки, от которой путь разрешил бы cwd.
TEMP = re.compile(r"tempfile|mkdtemp|TemporaryDirectory|gettempdir|tmp_path|tmpdir|self\.tmp\b")
WITH_AS = re.compile(r"\bas\s+([A-Za-z_]\w*)")
TEMP_BASE = re.compile(r"(?:(?<![\w.])(?:Path\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))\s*/|"
                       r"(?:join|joinpath)\(\s*([A-Za-z_]\w*)\s*,|(?<![\w.])([A-Za-z_]\w*)\.joinpath\()"
                       r"\s*[rRbBuUfF]{0,2}['\"]?\Z")
TEMP_DEPTH = 4  # `proj = root / "p"` от временной root — столько звеньев, дальше имя не временное


def names_rx(names):
    """Регэксп: имя из names словом (`x.tmp` — другое имя); имён нет — None."""
    return re.compile(r"(?<![\w.])(?:" + "|".join(map(re.escape, sorted(names))) + r")\b") if names else None


def uses(rx, text):
    return bool(rx and rx.search(text))


def temp_vars(lines):
    """Имена временных папок: присвоены из tempfile, mkdtemp, TemporaryDirectory, gettempdir, tmp_path, tmpdir,
    `self.tmp` или из такого имени (`proj = Path(self.tmp.name) / "proj"`), `with tempfile.… as d`; фикстуры
    tmp_path и tmpdir. Имя, которому где-то присвоено иное (`root = REPO`), — не временное."""
    values = {}
    for ln in lines:
        m = PATH_VAR.match(ln)
        for n, v in ([(m.group(1), ln[m.end():])] if m else []) + [(n, ln) for n in WITH_AS.findall(ln)
                                                                     if TEMP.search(ln)]:
            values.setdefault(n, []).append(v)
    temp = {"tmp_path", "tmpdir"} - set(values)
    for _ in range(TEMP_DEPTH):
        rx = names_rx(temp)
        more = {n for n, vs in values.items() if n not in temp and all(TEMP.search(v) or uses(rx, v) for v in vs)}
        if not more:
            break
        temp |= more
    return temp


def from_temp(before, literal, temps):
    """Литерал пути стоит после `<имя> / `, `Path(<имя>) / `, `join(<имя>, ` или `<имя>.joinpath(`, имя — временная
    папка (temp_vars), и путь не абсолютный (`tmp / "/x/.claude/…"` — уже не в ней)."""
    m = TEMP_BASE.search(before) if temps and not literal.startswith("/") else None
    return bool(m) and next(g for g in m.groups() if g) in temps


def claude_paths(chunk, cwd, roots, temps=()):
    """Защищённые пути куска кода: литералы `.claude/…` и путь из частей (JOINED_CLAUDE), кроме путей от временной
    папки (from_temp)."""
    out = [p for m in CLAUDE_LITERAL.finditer(chunk) if not from_temp(chunk[:m.start()], m.group(0), temps)
           for p in [protected_path(m.group(0), cwd, roots)] if p]
    if any(not from_temp(chunk[:m.start()], m.group(0), temps) for m in JOINED_CLAUDE.finditer(chunk)):
        out.append(".claude/… (путь собран из частей — правьте через Edit)")
    return out


def path_vars(lines, cwd, roots, temps=()):
    """Имена переменных, которым присвоен защищённый путь (не содержимое файла: строки с чтением не берутся)."""
    names = set()
    for ln in lines:
        m = PATH_VAR.match(ln)
        if m and not READS.search(ln) and claude_paths(ln, cwd, roots, temps):
            names.add(m.group(1))
    return names


STMT_MAX = 20  # строк в операторе: скобка в строке-литерале на несколько строк не растянет его на весь файл
LITERAL = re.compile(r"'[^'\n]*'|\"[^\"\n]*\"")  # литерал в одной строке: скобки в нём не в счёт
DEPTH = {"(": 1, "[": 1, "{": 1, ")": -1, "]": -1, "}": -1}
GIT_WORD = re.compile(r"\bgit\b")


def statement(lines, i):
    """Оператор со строки i: она и следующие, пока скобки не сойдутся и строка кончается `\\`, — до STMT_MAX строк."""
    depth, j = 0, i
    for j in range(i, min(len(lines), i + STMT_MAX)):
        depth += sum(DEPTH.get(c, 0) for c in LITERAL.sub("", lines[j]))
        if depth <= 0 and not lines[j].rstrip().endswith("\\"):
            break
    return "\n".join(lines[i:j + 1])


def near(lines, marks):
    """(i, оператор со строки i) для строк i не дальше STMT_MAX строк до отмеченных: оператор, в котором отмеченная
    строка, начинается среди них."""
    starts = sorted({i for k in marks for i in range(max(0, k - STMT_MAX + 1), k + 1)})
    return [(i, statement(lines, i)) for i in starts]


def push_found(lines, cwd):
    """Скрипт с диска: оператор (statement), где git push и цель (push_target), или None. По всему тексту правило
    давало ложный отказ тесту, где команда push — образец данных, а цель — опция или слово другого вызова (SE-138).
    Цель в переменной — тоже цель: имя, присвоенное в строке с целью, в операторе с git push; имя, присвоенное
    оператором с git push (`cmd = ["git", "push"]`), в операторе с целью."""
    marks = [k for k, ln in enumerate(lines) if GIT_WORD.search(ln)]
    if not marks:
        return None
    hot = names_rx({m.group(1) for m in map(PATH_VAR.match, lines) if m and push_target(m.string, cwd)})
    cmds = set()
    for i, s in near(lines, marks):
        if GIT_PUSH.search(s):
            if push_target(s, cwd) or uses(hot, s):
                return s
            m = PATH_VAR.match(lines[i])
            cmds |= {m.group(1)} if m else set()
    rx = names_rx(cmds)
    users = [k for k, ln in enumerate(lines) if uses(rx, ln)] if rx else []
    return next((s for _, s in near(lines, users) if uses(rx, s) and (push_target(s, cwd) or uses(hot, s))), None)


def interp_found(text, cwd, roots, by_line=False):
    """Код python/node/…: защищённая команда в subprocess и запись в защищённые файлы. by_line — скрипт с диска:
    запись и защищённый путь ищутся в одной строке (или путь в переменной из path_vars), иначе любой скрипт, который
    читает законы и пишет своё, — отказ; путь от временной папки (temp_vars) не защищён, git push — по операторам
    (push_found)."""
    found = []
    chunks = text.splitlines() if by_line else [text]
    kind = classify_interp(["_", text], cwd, push=not by_line)
    stmt = push_found(chunks, cwd) if by_line and not kind else None
    if kind or stmt:
        found.append((kind or MAIN_WRITE, (stmt or text)[:120]))
    temps = temp_vars(chunks) if by_line else set()
    names = path_vars(chunks, cwd, roots, temps) if by_line else set()
    for chunk in chunks:
        if not INTERP_WRITE.search(chunk):
            continue
        hit = next((n for n in names if re.search(rf"(?<![\w.]){re.escape(n)}\b", chunk)), None)
        if hit:
            found.append(("file", f".claude/… (путь в переменной {hit} — правьте через Edit)"))
        found += [("file", p) for p in claude_paths(chunk, cwd, roots, temps)]
    return found
