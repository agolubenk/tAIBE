"""Потолок вывода (R-3): рецепт — до 1000 символов, свободный режим — до 4000. Обрезка — по символам (строка Python —
символы, а не байты UTF-8, поэтому кириллица не рвётся) на границе строки, с меткой «…+N строк: `--json > файл`».
Метка входит в потолок."""
RECIPE_LIMIT = 1000
FREE_LIMIT = 4000


def _label(rest):
    return f"…+{rest} строк: `--json > файл`"


def cap(text, limit=RECIPE_LIMIT):
    if len(text) <= limit:
        return text
    lines = text.split("\n")
    used, kept = 0, 0
    for i, line in enumerate(lines):
        need = used + len(line) + (1 if i else 0)   # строка и перевод строки перед ней
        if need + 1 + len(_label(len(lines) - i - 1)) > limit:
            break
        used, kept = need, i + 1
    if kept == 0:   # первая строка длиннее потолка: её начало, остальное — в метке
        room = max(0, limit - 1 - len(_label(len(lines) - 1)))
        return lines[0][:room] + "\n" + _label(len(lines) - 1)
    return "\n".join(lines[:kept]) + "\n" + _label(len(lines) - kept)
