"""Маска zsh с `(…)` на месте слова (IS-249, SE-194).

Bash-инструмент запускает /bin/zsh, а там `(…)` на месте слова — маска (`.cl(a)ude`, `(a|b)/x`, квалификатор `*(/)`),
а не подоболочка. Разбор (merge_guard_shell.tokenize) делит такое слово на команды и пути не видит:
`echo x > .cl(a)ude/settings.json` для него пишет в `.cl`. Отказ, не подражание (coord 13:46, #508).
"""
import os

from merge_guard_files import FAMILY, UNPACK, WRITE_ALL, WRITE_LAST, gnu
from merge_guard_shell import SEPARATORS

# пишут или удаляют (write_targets, link_findings); слово ищется во всей команде — и за обёрткой (`sudo tee`, `xargs rm`)
WRITERS = FAMILY | WRITE_ALL | WRITE_LAST | UNPACK | {"dd", "sed", "gsed", "perl", "ruby", "awk", "gawk", "curl",
                                                       "wget", "git"}


def zsh_group(tokens):
    """[(«file», что)]: `(` на месте слова у команды записи или у цели перенаправления (`>`, `>>`, `>|`, `<>`, `&>`).
    Не маска: `$(`, `x=(`, `=(`, `<(`, `>(`, `f()`, `function f()`, `(` после `;`/`&&`/`|`/перевода строки. Вложенные
    `(…)` — стек: после `)` снова слова внешней команды (`rm -rf <(true) .cl(a)ude`)."""
    stack, argv, op, target = [], [], False, False
    for t in tokens:
        if not (t and set(t) <= SEPARATORS):
            argv.append(t)
            op, target = False, op  # слово сразу после `>` — цель записи
            continue
        if t[0] == "(" and not (argv and argv[-1].endswith(("$", "="))) and not (t.startswith("()") and (
                len(argv) == 1 or argv[:1] == ["function"])) and (
                op or target or any(gnu(os.path.basename(w)) in WRITERS for w in argv)):
            return [("file", f"{' '.join(argv)[:80]} (форма маски zsh `(…)`, которую разбор не читает — назовите пути "
                             "словами, SE-194)")]
        if set(t) & set("<>") and not set(t) & set("()"):  # `>`, `>>`, `>|`, `>&`, `&>`, `<>`, `<`: команда та же
            op, target = ">" in t, False
            continue
        for ch in t:
            if ch == "(":
                stack.append((argv, op, target))
                argv, op, target = [], False, False
            elif ch == ")":
                argv, op, target = stack.pop() if stack else ([], False, False)
            elif ch in ";&|\n":
                argv, op, target = [], False, False
    return []
