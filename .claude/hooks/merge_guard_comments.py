"""
Где bash точно видит комментарий, для merge-guard (strip_comments в merge_guard_shell, SE-75). Простой разбор кавычек
там не знает вложенности (`"$(cut -f1 "$f")"`, `$((…))`, `${…}`) и потому оставляет комментарий с `'` (`# Docker's …`):
если разбор ошибся, `'` закрыл бы строку bash. Здесь — разбор со стеком вложенности; на всём, чего он не моделирует,
уверенность теряется до конца текста. Решений не принимает; без импорта других модулей merge-guard.
Ещё здесь — признак, что текст может сменить сам знак комментария (comment_char_may_change, SE-77).
"""
import re

SEPARATORS = " \t\n;&|()<>"
# `case` в `$(…)`: `)` шаблона закрыла бы подстановку (bash 3.2); `alias`: текст псевдонима (`alias q="'"`) меняет
# разбор следующих строк — zsh раскрывает псевдонимы и в скриптах.
WORDS = re.compile(r"(case|alias)(?=[\s;&|()<>]|$)")
NAME = re.compile(r"[A-Za-z0-9_@*#?$!-]")  # `$NAME`, `$1`, `$@` внутри `${…}`
BRACE_LOST = set("'\"`{\\")  # в `${…}` кавычки и `\` разные версии bash разбирают по-разному
# Знак комментария меняют: третий знак `histchars` у zsh — для строк скрипта ниже, `eval` и `source` после него
# (у `zsh -c` и `eval` весь текст разобран до присваивания); в интерактивном bash (`bash -i`) — `shopt -u
# interactive_comments`, `+O interactive_comments`, `set +o interactive-comments`: `#` там — буква. Имя ищется в
# тексте без всего, кроме латинских букв и цифр: `hist""chars`, `${:-hist}chars`, `NO_INTERACTIVE_COMMENTS`.
COMMENT_CHAR = (b"histchars", b"interactivecomments")
NOT_ALNUM = bytes(c for c in range(128) if not chr(c).isalnum())


def comment_char_may_change(text):
    """Текст называет настройку, которая меняет знак комментария (COMMENT_CHAR). Тогда `#` в нём и в том, что
    shell разберёт после, — то ли комментарий, то ли код: разбирать надо обоими способами. Имя, собранное в
    переменной или выводе команды (`${h}chars`, `$(…)`), не видно."""
    flat = text.encode("ascii", "ignore").lower().translate(None, NOT_ALNUM)  # 4 МБ — 12–50 мс
    return any(name in flat for name in COMMENT_CHAR)


CHANGED = "\0comment-char"  # в written команды: настройка знака комментария уже была (comment_char_seen)


def comment_char_seen(written, text, outer):
    """Настройка знака комментария была до скрипта text: во внешней команде (`histchars=…; source x`) или в скрипте,
    который команда прочла раньше (`source a.zsh; source b.zsh`, `source a.zsh; eval …`: настройка живёт в оболочке).
    Скрипт, который её называет, отмечается в written (CHANGED) — для всего, что команда разберёт после него."""
    before = CHANGED in (written or ()) or comment_char_may_change(outer)
    if written is not None and comment_char_may_change(text):
        written.add(CHANGED)
    return before


def sure_comments(cmd):
    """Позиции `#`, с которых bash и zsh точно начинают комментарий на верхнем уровне — вне кавычек и любых скобок:
    `$(…)`, `(…)`, `((…))`, `${…}`. Уверенность теряется до конца текста на: обратных кавычках; heredoc (тело могло
    остаться в тексте); `$[…]`; `#` и `case` в `$(…)` и `(…)` (bash 3.2 и 5 разбирают по-разному, `(#i)x` — маска
    zsh); кавычках и `\\` в `((…))` и `${…}`; `(` сразу за словом, кроме `f()` и `x=(…)` (extglob `!(…)`, маска zsh
    `x(…)`: `#` и `'` там — часть слова); `#` сразу за `)`; `alias`; незакрытой кавычке."""
    sure, stack, i, word, n = set(), [], 0, False, len(cmd)  # стек: ["D"] — "…", ["S", скобки] — $(…), ["A", скобки]
    while i < n:
        c, kind, depth = cmd[i], stack[-1][0] if stack else "T", len(stack)
        if kind == "D":  # внутри "…" `'` и `#` — буквы, `\` экранирует следующий знак
            if c == "`":
                return sure
            if c == '"':
                stack.pop()
            j, w = expansion(cmd, i, stack) if c == "$" else i + (2 if c == "\\" else 1), True
        elif kind == "A":  # ((…)), $((…)): `#` — основание числа (16#ff)
            if c in "'\"`\\":
                return sure
            j, w = expansion(cmd, i, stack) if c == "$" else paren(stack, c, i), True
        elif c == "#" and cmd[i - 1:i] == ")":  # `(( 1 ))#`, `(a)#`: комментарий или буква — не угадываем
            return sure
        elif c == "#" and not word:
            if kind == "S":
                return sure
            sure.add(i)
            end = cmd.find("\n", i)
            i = n if end < 0 else end
            continue
        elif c == "\\":  # `\`+перевод строки — склейка, слово не начинает
            j, w = i + 2, word or cmd[i + 1:i + 2] != "\n"
        elif c == "`" or cmd.startswith(("$[", "<<"), i) and not cmd.startswith("<<<", i) or not word and (
                (m := WORDS.match(cmd, i)) and (m.group(1) == "alias" or kind == "S")):
            return sure
        else:
            j = top_level(cmd, i, stack, word)
            w = c not in SEPARATORS or len(stack) < depth  # `)` подстановки слово не кончает: `$(true)#`
        if j is None:
            return sure
        i, word = j, w and not (len(stack) > depth and stack[-1][0] == "S")  # тело `$(` начинается с команды
    return sure


def top_level(cmd, i, stack, word):
    """Знак или конструкция вне кавычек (уровень T или S) с позиции i: новая позиция, None — уверенность потеряна."""
    c = cmd[i]
    if c == "'":
        j = cmd.find("'", i + 1)
        return None if j < 0 else j + 1
    if cmd.startswith("$'", i):  # в $'…' `\'` — экранированная кавычка
        j = i + 2
        while j < len(cmd) and cmd[j] != "'":
            j += 2 if cmd[j] == "\\" else 1
        return None if j >= len(cmd) else j + 1
    if c == '"':
        stack.append(["D"])
        return i + 1
    if c == "$":
        return expansion(cmd, i, stack)
    if cmd.startswith("((", i) and not word:
        stack.append(["A", 2])
        return i + 2
    if c == "(":  # за словом: `f()` — функция, `x=(…)` — массив, прочее — шаблон; иначе подоболочка или группа
        if word and cmd[i - 1] != "=":  # маски zsh `(#i)x`, `(a|#b)`: `#` там — не комментарий, поэтому
            return i + 2 if cmd.startswith("()", i) else None  # подоболочка — как `$(…)`: `#` в ней — потеря
        stack.append(["S", 1])
        return i + 1
    if cmd.startswith(("<(", ">(", "=("), i) and not (c == "=" and word):  # `=(…)` zsh — в начале слова
        stack.append(["S", 1])
        return i + 2
    if cmd.startswith("<<<", i):
        return i + 3
    return paren(stack, c, i) if stack else i + 1


def paren(stack, c, i):
    """`(` и `)` в `$(…)` и `((…))`: глубина скобок; на нуле — конец конструкции."""
    if c in "()":
        stack[-1][1] += 1 if c == "(" else -1
        if stack[-1][1] == 0:
            stack.pop()
    return i + 1


def expansion(cmd, i, stack):
    """`$…` с позиции i: `$((` и `$(` — в стек, `${…}` — до `}`, если внутри нет кавычек, `\\` и вложенных `${`, `$(`;
    новая позиция, None — уверенность потеряна."""
    if cmd.startswith("$((", i):
        stack.append(["A", 2])
        return i + 3
    if cmd.startswith("$(", i):
        stack.append(["S", 1])
        return i + 2
    if cmd.startswith("$[", i):
        return None
    if not cmd.startswith("${", i):
        return i + 1
    j = i + 2
    while j < len(cmd) and cmd[j] != "}":
        if cmd[j] in BRACE_LOST or cmd[j] == "$" and not NAME.match(cmd, j + 1):
            return None
        j += 1
    return None if j >= len(cmd) else j + 1
