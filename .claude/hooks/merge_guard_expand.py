"""
Раскрытия, которые shell делает до запуска команды, для merge-guard: скобки `{a,b}` и `{x..y}` (bash и zsh) и
код квалификатора маски zsh `e`. Решений не принимает; без импорта других модулей merge-guard.
"""
import re
import shlex

BRACE = re.compile(r"(?<!\$)\{([^{}]*,[^{}]*)\}")
SEQ = re.compile(r"(?<!\$)\{(-?\d+|.)\.\.(-?\d+|.)(?:\.\.(-?\d+))?\}")  # `{1..3}`, `{a..c}`; шаг — bash 4 и zsh
NAMES_MAX = 64
# Квалификатор маски zsh `e` исполняет строку: `ls *(e:'gh pr merge 1':)`, `*(.e{…})`, `x(#qe:…:)`. Скобка — сразу за
# словом, до `e` — только буквы квалификаторов (`require('a.json')`, `open(os.path…)` — не квалификатор), разделитель —
# любой знак или пара скобок.
QUAL_EVAL = re.compile(r"(?<=[^\s'\"(=$`])\((?:#q)?[-/.@=p*%rwxAIERWXsStfdlUGugamcLMTNDnoOY^\d]*e([^\w\s)'\"])")
PAIRS = {"(": ")", "[": "]", "{": "}", "<": ">"}


def qualifier_code(cmd):
    """Строки, которые zsh исполнит из квалификатора маски `e` (`*(e:'…':)`, `*(e{…})`), с одним слоем кавычек снятым.
    zsh ищет разделитель уже без кавычек (5.9: `*(e'.gh pr merge 1.')` — разделитель `.`, код исполняется), поэтому
    смотрим и сырую строку, и каждое слово без кавычек."""
    try:
        words = shlex.split(cmd)
    except ValueError:
        words = []
    out = []
    for text in [cmd, *words]:
        for m in QUAL_EVAL.finditer(text):
            end = text.find(PAIRS.get(m.group(1), m.group(1)), m.end())
            if end > 0:
                s = text[m.end():end]
                try:
                    code = " ".join(shlex.split(s))
                except ValueError:
                    code = s.replace("'", "").replace('"', "")
                if code not in out:
                    out.append(code)
    return out


def seq_parts(x, y, step):
    """`{x..y..шаг}`: числа или по одному символу; иное (`{1..ab}`) shell оставляет как есть — None."""
    num = all(re.fullmatch(r"-?\d+", v) for v in (x, y))
    if not num and (len(x) != 1 or len(y) != 1):
        return None
    a, b = (int(x), int(y)) if num else (ord(x), ord(y))
    s = (abs(int(step or 1)) or 1) * (1 if b >= a else -1)
    return [str(v) if num else chr(v) for v in range(a, b + (1 if s > 0 else -1), s)[:NAMES_MAX + 1]]


def brace_words(word):
    """Слова, в которые shell раскроет скобки: `{a,b}` и `{x..y}`. Пустые выпадают, как в bash. Больше NAMES_MAX —
    NAMES_MAX + 1 слово: по такому раскрытию решать нельзя."""
    todo, out = [word], []
    while todo and len(out) <= NAMES_MAX:
        w = todo.pop(0)
        m = BRACE.search(w) or SEQ.search(w)
        parts = (m.group(1).split(",") if m.re is BRACE else seq_parts(*m.groups())) if m else None
        if m and parts:
            todo[:0] = [w[:m.start()] + p + w[m.end():] for p in parts]
        elif w:
            out.append(w)
    return out


def brace_argv(argv):
    """argv, каким его получит команда после раскрытия скобок; None — слово раскрылось больше чем в NAMES_MAX слов.
    Слово с пробелом было в кавычках (shlex их уже снял), а в кавычках скобки не раскрываются — оно как есть."""
    out = []
    for w in argv:
        ws = brace_words(w) if "{" in w and not re.search(r"\s", w) else [w]
        if len(ws) > NAMES_MAX:
            return None
        out += ws
    return out
