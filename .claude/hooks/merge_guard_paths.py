"""
Защищённые файлы и код интерпретаторов для merge-guard (pre-tool-use-merge-guard.py): законы, настройки хуков и реестр
сессий (protected_path) и что код python/node/… пишет и запускает (interp_found) — из команды, heredoc и скрипта с
диска.
"""
import os
import re
from pathlib import Path

from merge_guard_gh import GIT_PUSH, INTERP_SEP, classify_interp, push_target
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
    f = p.casefold()  # APFS: `.CLAUDE/settings.json` — тот же файл (SE-94, HR IS-245); на Linux худшее — ложный отказ
    home = os.path.realpath(HOME_CLAUDE).casefold()
    if f == os.path.join(home, "sessions") or f.startswith(os.path.join(home, "sessions") + "/"):
        return p
    if f in (os.path.join(home, "settings.json"), os.path.join(home, "settings.local.json")):
        return p
    for root in roots:
        claude = os.path.join(os.path.realpath(root), ".claude").casefold()
        if os.path.dirname(f) == claude and os.path.basename(f) in GUARDED_CLAUDE_FILES:
            return p
        if any(f == os.path.join(claude, d) or f.startswith(os.path.join(claude, d) + "/")
               for d in GUARDED_CLAUDE_DIRS):
            return p
    return None


INTERP_WRITE = re.compile(r"""open\([^\n]*?,\s*(mode\s*=\s*)?['"][wax][+bt]*['"]|write_text|write_bytes|writeFile"""
                          r"""|appendFile|unlink|remove\(|rename|replace\(|rmSync|rmtree""")
# Путь собран из частей: '.claude' и защищённое имя отдельными строками (os.path.join, Path / …).
JOINED_CLAUDE = re.compile(r"""['"]\.claude['"].{0,80}?['"]"""
                           r"""(rules|hooks|settings(\.local)?\.json|merge-guard(\.local)?\.json)['"/]""", re.S | re.I)


# Присваивание пути переменной (python, js, perl): `p = '.claude/settings.json'`, `const S = path.join(…)`.
PATH_VAR = re.compile(r"\s*(?:(?:const|let|var|my|our)\s+)?\$?([A-Za-z_]\w*)\s*(?::[^=\n]*)?=(?!=)")
READS = re.compile(r"\.read|read_text|readFile|load|open\(|glob|listdir|scandir|walk|exists|is_?file|stat\(")
CLAUDE_LITERAL = re.compile(r"[\w./~-]*\.claude/[\w./-]+", re.I)  # SE-94: `.CLAUDE/rules` — тот же путь на APFS
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
    tmp_path и tmpdir. Имя, которому где-то присвоено иное (`root = REPO`), — не временное. Слово в комментарии или
    строке (`root = Path.cwd()  # not tempfile`) — не в счёт (mask)."""
    values = {}
    for ln in map(mask, lines):
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


IDENT = re.compile(r"(?<![\w.])[A-Za-z_]\w*")  # `self.marks` — одно имя `self`: атрибут после точки не в счёт
KWARG = re.compile(r"(?<![\w.])[A-Za-z_]\w*\s*=(?!=)")  # `check=True`: ключ аргумента — не значение
CALLEE = re.compile(r"[\w.]+\s*\Z")
CONST = {"True", "False", "None"}
# `$B`, `${B}`, `$(…)`, `` `…` `` в команде push: значение даёт shell (env, os.putenv), разбор его не видит
SHELL_SUB = re.compile(r"\$[{(\w@*]|`")
PUSH_VALUE = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}  # опции push со значением следующим словом
SELF_REF = {"HEAD", "@", "+HEAD", "+@", ":", "+:"}  # `:` — matching: все ветки, которые есть с обеих сторон
# Белый список push из скрипта, когда цель есть в тексте (линза Контроля на 8b04e8322, координатор 20:13): назначение
# выбирает и состояние git — refmap, symref, upstream, include, — а способов его задать больше, чем перечислишь (B2–B4).
# Чистый текст (clean): git — только push и команды для чтения, нет окружения, записи в файл и следов настройки git.
READ_ONLY = {"push", "status", "log", "diff", "show", "rev-parse", "ls-files"}
GIT_CALL = re.compile(rf"\bgit\b(?:{INTERP_SEP}([\w-]+))?")  # без подкоманды — `.git/`, `"git"` в переменной, `git -c`
STATE = re.compile(
    r"\bGIT_[A-Z0-9_]+|\benviron\b|\bputenv\b|\bprocess\.env\b|\benv\s*=|\bHOME\b|gitconfig|\[remote\b|\bref:\s*refs/"
    r"|\bopen\([^,)]*,(?!\s*(?:mode\s*=\s*)?['\"][rbt]*['\"]|\s*(?:encoding|errors|newline)\s*=)"
    r"|\bmode\s*=\s*['\"][rbt]*[wax+]|\.open\((?!\s*\)|\s*['\"][rbt]*['\"])|\bO_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b"
    r"|(?<!stdout)(?<!stderr)\.write(?:_text|_bytes|lines)?\(|\bshutil\."
    r"|\bos\.(?:symlink|link|rename|replace|truncate)\b|\.(?:symlink_to|hardlink_to|rename|touch)\("
    r"|\bfs\.(?!(?:promises\.)?(?:read|exists|stat|lstat|access|realpath)\w*\()"
    r"|\b(?:writeFile|appendFile|writeSync|openSync|createWriteStream|symlink|link|rename|copyFile|cp|truncate)"
    r"(?:Sync)?\s*\(")
STRINGS = re.compile(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'|`[^`]*`|' + LITERAL.pattern)  # и строки на несколько строк
SHELL_WRITE = re.compile(r">|\b(?:tee|cp|mv|ln|install|dd|truncate|rsync)\b|\bsed\b[^\n]*\s-i")  # shell в строке


def clean(text):
    """Текст не меняет состояние git, которое выбирает ветку push: git — только push и команды для чтения (READ_ONLY),
    нет окружения, записи в файл (код и shell в строках) и следов настройки (`[remote`, `ref: refs/`)."""
    if any(m.group(1) not in READ_ONLY for m in GIT_CALL.finditer(text)) or STATE.search(text):
        return False
    return not any(SHELL_WRITE.search(m.group(0)) for m in STRINGS.finditer(text))


def push_words(unit):
    """Слова git push в unit — удалённый и назначения, без флагов (и значений `-o`, `--repo`, …), до конца команды:
    `;`, `&`, `|`, конец строки, закрытая скобка. None — push в unit нет."""
    m = GIT_PUSH.search(unit)
    if not m:
        return None
    tail = re.split(r"[;&|\n\])}{]", unit[m.end():])[0]
    words, skip = [], False
    for w in re.findall(r"[^\s'\",\[\]()]+", tail):
        if skip:
            skip = False
        elif w.startswith("-"):
            skip = w in PUSH_VALUE
        else:
            words.append(w)
    return words


def implicit(unit):
    """У git push в unit нет назначения или назначение — `HEAD`/`@`/`:`: ветку задаёт состояние git (checkout,
    switch, upstream в git config другим оператором), а не текст команды (линза Контроля на b5d5a4168 и 60a54f72a)."""
    words = push_words(unit)
    return words is not None and (len(words) < 2 or bool(SELF_REF & set(words[1:])))


def explicit(unit):
    """Каждое назначение git push в unit — явное `src:dst` с непустым dst: его не меняют ни refmap, ни symref, ни
    upstream. Защищённый dst сюда не доходит — это цель в операторе (push_target)."""
    words = push_words(unit)
    return bool(words) and len(words) >= 2 and all(":" in w and w.split(":", 1)[1] for w in words[1:])


def mask(s):
    """Литералы в одну строку — пробелами внутри кавычек, комментарии `#` — пробелами: позиции те же. Префикс
    литерала (`f"…{x}"`, `r"…"`) остаётся словом — для opaque это имя."""
    s = LITERAL.sub(lambda m: m.group(0)[0] + " " * (len(m.group(0)) - 2) + m.group(0)[-1], s)
    return re.sub(r"#[^\n]*", lambda m: " " * len(m.group(0)), s)


def group(ms, pos):
    """(a, b, есть ли скобка): скобочная группа текста ms вокруг pos — от незакрытой скобки слева до её пары; скобки
    нет — весь текст."""
    depth = 0
    for a in range(pos - 1, -1, -1):
        d = DEPTH.get(ms[a], 0)
        if d > 0 and depth == 0:
            break
        depth -= d
    else:
        return 0, len(ms), False
    depth = 0
    for b in range(a, len(ms)):
        depth += DEPTH.get(ms[b], 0)
        if depth == 0:
            return a, b + 1, True
    return a, len(ms), True


def segment(ms, a, b):
    """Аргумент вокруг группы [a, b): соседние куски до `,` или скобки родительской группы (`[…] + rest`, `*flags`) —
    отрезки (left, end) слева и (b, right) справа. Позиции те же в тексте и в mask."""
    pa, pb, inner = group(ms, a)
    lo, hi = (pa + 1, pb - 1) if inner else (pa, pb)
    left, depth = a, 0
    while left > lo and not (depth == 0 and ms[left - 1] == ","):
        depth -= DEPTH.get(ms[left - 1], 0)
        left -= 1
    right, depth = b, 0
    while right < hi and not (depth == 0 and ms[right] == ","):
        depth += DEPTH.get(ms[right], 0)
        right += 1
    if not inner:  # оператор верхнего уровня: `cmd = […]` — имя слева от `=` не аргумент
        m = PATH_VAR.match(ms, left, a)
        left = m.end() if m else left
    end = a
    if ms[a:a + 1] == "(":  # `subprocess.run(…)`: имя вызываемой функции не аргумент
        m = CALLEE.search(ms, left, a)
        end = m.start() if m else a
    return (left, end), (b, right)


def opaque(s, pos, known=()):
    """В аргументах команды push у pos — имя или вызов, значение которых разбор не видит (`branch`, `rest`,
    `target()`, `*flags`, `f"…{x}"`, `"git push " + b`). Команда — список: её скобочная группа; команда — одна
    строка: этот литерал (`cwd=repo` рядом — другой аргумент). Push вне литерала и вне скобок — текст (строка
    docstring), не команда. known — имена, уже разобранные (cmds). Подстановка shell в аргументах (`"git push
    origin $B"`, `B` — из os.environ) и push без назначения или в `HEAD` (implicit) — тоже значение, которого
    разбор не видит (линза Контроля на 952c2e232 и b5d5a4168)."""
    ms = mask(s)
    a, b, inner = push_unit(s, ms, pos)
    if not inner and not known:
        return False
    if implicit(s[a:b]):
        return True
    (l1, r1), (l2, r2) = segment(ms, a, b)
    if any(SHELL_SUB.search(s[x:y]) for x, y in ((l1, r1), (a, b), (l2, r2))):
        return True
    text = KWARG.sub(" ", ms[a:b] + " " + ms[l1:r1] + " " + ms[l2:r2])
    return bool(set(IDENT.findall(text)) - CONST - set(known))


def push_unit(s, ms, pos):
    """(a, b, inner): команда push у pos — литерал, если push целиком в нём, иначе скобочная группа; inner — есть
    литерал или скобка (иначе push — текст, не команда)."""
    lit = next((m.span() for m in LITERAL.finditer(s) if m.start() <= pos < m.end()), None)
    if lit and GIT_PUSH.search(s[lit[0]:lit[1]]):
        return lit[0], lit[1], True
    return group(ms, pos)


def allowed(s, pos, tidy):
    """Push у pos в операторе s по белому списку, когда цель есть в тексте: аргументы — литералы (opaque — нет) и
    назначение явное `src:dst` (explicit) или текст чистый (tidy = clean всего текста). Иначе — отказ, как на base.
    Push-текст (строка shell на несколько строк, docstring) — тоже: без назначения или с `$B` — отказ."""
    a, b, _ = push_unit(s, mask(s), pos)
    unit = s[a:b]
    if implicit(unit) or SHELL_SUB.search(unit) or opaque(s, pos):
        return False
    return tidy or explicit(unit)


def push_found(lines, cwd):
    """Скрипт с диска: оператор (statement), где git push и цель (push_target), или None. По всему тексту правило
    давало ложный отказ тесту, где команда push — образец данных, а цель — опция или слово другого вызова (SE-138).
    Цель в переменной — тоже цель: имя, присвоенное в строке с целью, в операторе с git push; имя, присвоенное
    оператором с git push (`cmd = ["git", "push"]`), в операторе с целью. В аргументах push — имя, которое разбор
    не прослеживает (opaque: аргумент функции по умолчанию, кортеж, `append`, `return`, `*flags`), — правило base по
    всему тексту (SE-138 B1, линза backend на 3ce7170af). Цель где-то в тексте — push проходит только по белому
    списку (allowed): явное `src:dst` или чистый текст (B2–B4, линза Контроля на 8b04e8322)."""
    marks = [k for k, ln in enumerate(lines) if GIT_WORD.search(ln)]
    if not marks:
        return None
    text = "\n".join(lines)
    whole = push_target(text, cwd)
    tidy = bool(whole) and clean(text)
    hot = names_rx({m.group(1) for m in map(PATH_VAR.match, lines) if m and push_target(m.string, cwd)})
    cmds = set()
    for i, s in near(lines, marks):
        p = GIT_PUSH.search(s)
        if p:
            if push_target(s, cwd) or uses(hot, s) or (whole and not allowed(s, p.start(), tidy)):
                return s
            m = PATH_VAR.match(lines[i])
            cmds |= {m.group(1)} if m else set()
    rx = names_rx(cmds)
    users = [k for k, ln in enumerate(lines) if uses(rx, ln)] if rx else []
    return next((s for _, s in near(lines, users) if uses(rx, s) and (
        push_target(s, cwd) or uses(hot, s) or (whole and opaque(s, rx.search(s).start(), cmds)))), None)


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
