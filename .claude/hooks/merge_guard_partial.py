"""
Разбор до ошибки для merge-guard (pre-tool-use-merge-guard.py, SE-76): bash и zsh выполняют команды скрипта до места,
где разбор упал, поэтому находки этой части нужны и тогда.

Решений не принимает. Отдельный модуль — чтобы merge_guard_shell.py и хук оставались в пределе 500 строк (01-base).
"""
from merge_guard_crash import crash
from merge_guard_shell import _lexer

PARTIAL = "\0partial"  # находка-метка: текст разобран только до ошибки (tokens_before_error)


def tokens_before_error(cmd):
    """(слова, разобран ли весь текст): слова до места, где разбор упал, — кавычка не закрылась, `\\` в конце текста.
    bash (файл, stdin, `-c`, eval, source) и zsh со скрипта выполняют команды до такой ошибки (SE-76); среди слов —
    и начало команды, на которой разбор упал (лишний отказ, не пропуск)."""
    out = []
    try:
        for token in _lexer(cmd):
            out.append(token)
    except ValueError:
        return out, False
    return out, True


def settle(found):
    """(находки без меток PARTIAL, была ли метка) — грубый признак по неразобранному тексту решает вызывающий."""
    rest = [f for f in found if f[0] != PARTIAL]
    return rest, len(rest) < len(found)


def settled(run, where=""):
    """settle(run()) и почему разобран не весь текст. run() упал — (crash(exc, where), True, имя исключения): как у
    неразобранного, решает грубый признак; сбой не по кавычкам — ещё и находка «сбой хука»: роли отказ (SE-152)."""
    try:
        return (*settle(run()), "кавычки не сошлись")
    except Exception as exc:
        return crash(exc, where), True, exc.__class__.__name__
