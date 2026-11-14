"""
heredoc для merge-guard (SE-83): где кончается тело — как у shell (cut_heredocs), что из тела получит читатель
(heredoc_text) и склейка строк для грубого признака (join_lines). Решений не принимает. Вынесено из merge_guard_shell
(он отдаёт эти имена хуку): у модуля — предел в 500 строк.
"""
import re

from merge_guard_vars import words

HEREDOC_OP = re.compile(r"(?<!<)<<(?!<)(-?)[ \t]*")  # `<<<` — строка, не heredoc
NAME_WORD = re.compile(r"[A-Za-z_]\w*")
HEREDOC_ESCAPE = re.compile(r"\\([$`\\\n])")
JOIN = re.compile(r"(?<!\\)((?:\\\\)*)\\\n")


def heredoc_word(line, i):
    """Метка heredoc с позиции i: (метка после снятия кавычек, была ли кавычка или `\\`, конец слова); нет — None.
    `<<\\E`, `<<"E"`, `<<E'F'`, `<<$'E'` — метка в кавычках: тело как есть."""
    word, quoted = "", False
    while i < len(line) and line[i] not in " \t;&|()<>":
        i += line.startswith(("$'", '$"'), i)
        c = line[i]
        if c in "'\"":
            j = line.find(c, i + 1)
            if j < 0:
                return None
            word, quoted, i = word + line[i + 1:j], True, j + 1
        elif c == "\\":
            word, quoted, i = word + line[i + 1:i + 2], True, i + 2
        else:
            word, i = word + c, i + 1
    return (word, quoted, i) if word or quoted else None


def line_end(cmd, i):
    """Конец строки cmd, которая начинается в i: позиция `\\n` или длина текста."""
    end = cmd.find("\n", i)
    return len(cmd) if end < 0 else end


def heredoc_line(cmd, i, join):
    """Строка тела с позиции i: (текст, начало следующей строки). join — метка без кавычек: строка с нечётной серией
    `\\` в конце склеивается со следующей до сравнения с меткой, как в shell."""
    end = line_end(cmd, i)
    text = cmd[i:end]
    while join and end < len(cmd) and (len(text) - len(text.rstrip("\\"))) % 2:
        nxt = line_end(cmd, end + 1)
        text, end = text[:-1] + cmd[end + 1:nxt], nxt
    return text, end + 1


def cut_heredocs(cmd):
    """Тела heredoc — отдельно: [(читатели, тело, раскрывает ли shell `$(…)` в теле)]. Читатели — argv команды с `<<`
    и команд после `|` в той же строке (`cat <<EOF | bash`); несколько `<<` в строке — тела подряд. Конец тела — как у
    shell (SE-83): строка, равная метке, у `<<-` — после ведущих табов; пробелы метку не дают. У метки без кавычек
    строка с `\\` в конце сначала склеивается со следующей. Строки-метки нет — shell читает тело до конца текста:
    тогда оно — тело для читателей и остаётся в тексте (`<<` мог быть в кавычках)."""
    from merge_guard_shell import normalize  # shell импортирует этот модуль
    out, bodies, i = [], [], 0
    while i < len(cmd):
        k = cmd.find("<<", i)  # строки без `<<` — как есть, без разбора по строке
        if k < 0:
            out.append(cmd[i:])
            break
        head = cmd.rfind("\n", i, k) + 1 or i  # начало строки с `<<`
        out.append(cmd[i:head])
        end = line_end(cmd, head)
        line, i, at, parts = cmd[head:end], end + 1, 0, []
        for m in HEREDOC_OP.finditer(line):
            w = heredoc_word(line, m.end())
            if not w or m.start() < at:
                continue
            parts.append(line[at:m.start()])
            delim, quoted, at = w
            pre = re.sub(r"<<-?\s*\S+", " ", re.split(r"[;&|(]", line[:m.start()])[-1])
            readers = [a for a in (normalize(words(h)) for h in [pre] + line[at:].split("|")[1:]) if a]
            j, text, start = i, None, i
            while j < len(cmd) and text != delim:  # start — начало строки, которую сравниваем с меткой
                start, (text, j) = j, heredoc_line(cmd, j, not quoted)
                text = text.lstrip("\t") if m.group(1) else text
            found = text == delim
            bodies.append((readers, cmd[i:max(start - 1, i)] if found else cmd[i:], not quoted))
            parts.append("<< " + (delim if NAME_WORD.fullmatch(delim) else "E"))
            i = j if found else i
        out.append("".join(parts) + line[at:] + "\n" * (end < len(cmd)))
    return "".join(out), bodies


def heredoc_text(body, expands):
    """Что получит читатель heredoc (SE-83). Метка без кавычек — shell раскрыл в теле `\\$`, `` \\` ``, `\\\\` и снял
    `\\`+перевод строки: `g\\\\`⏎`h` придёт как `g\\`⏎`h`, и bash-читатель склеит слово `gh`. С кавычками — тело как есть."""
    return HEREDOC_ESCAPE.sub(lambda m: "" if m.group(1) == "\n" else m.group(1), body) if expands else body


def join_lines(text):
    """Склейка строк для грубого признака (SE-83): нечётная серия `\\` перед переводом строки теряет последнюю `\\` и
    перевод строки, без пробела; чётная — нет. Кавычек и комментариев не различает: лишняя склейка меняет лишь текст
    строки или комментария, признак от неё только виднее."""
    return JOIN.sub(r"\1", text)
