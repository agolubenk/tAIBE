"""
heredoc для merge-guard (SE-83, SE-87): какой `<<` shell читает как оператор и где кончается тело (cut_heredocs), что
из тела получит читатель (heredoc_text) и склейка строк для грубого признака (join_lines). Решений не принимает.
Вынесено из merge_guard_shell (он отдаёт эти имена хуку): у модуля — предел в 500 строк.
"""
import bisect
import re

from merge_guard_vars import words

NAME_WORD = re.compile(r"[A-Za-z_]\w*")
HEREDOC_ESCAPE = re.compile(r"\\([$`\\\n])")
JOIN = re.compile(r"(?<!\\)((?:\\\\)*)\\\n")
SPEC = re.compile(r"<<-?\s*\S+")
SEP = " \t\n;&|()<>"
LEX = re.compile(r"[\\'\"`#()\n$<}\[\]]")
SQ, ANSI = re.compile(r"[^']*"), re.compile(r"(?:\\.|[^'\\])*", re.S)
CODE = {"top", "sub", "par", "bt"}  # здесь `<<` — оператор: вне кавычек, комментария, `$((…))`, `$[…]`, `${…}`


def skip(cmd, i):
    """Позиция после склеек `\\`⏎ с i: shell снимает их до разбора, `<\\`⏎`<` и `$\\`⏎`((` — те же `<<` и `$((`."""
    while cmd.startswith("\\\n", i):
        i += 2
    return i


def peek(cmd, i):
    """Знак с позиции i после склеек `\\`⏎ (или пусто)."""
    i = skip(cmd, i)
    return cmd[i:i + 1]


def word_start(cmd, i):
    """Слово начинается в i (`#` — комментарий, `((` — арифметика): перед ним, без склеек, — начало текста или разделитель."""
    j = i - 1
    while j > 0 and cmd[j] == "\n":
        k = j
        while k > 0 and cmd[k - 1] == "\\":
            k -= 1
        if (j - k) % 2 == 0:
            break
        j -= 2
    return j < 0 or cmd[j] in SEP


def heredoc_word(cmd, i):
    """Метка heredoc с позиции i: (метка после снятия кавычек, была ли кавычка или `\\`, конец слова); нет — None.
    `<<\\E`, `<<"E"`, `<<E'F'`, `<<$'E'` — метка в кавычках: тело как есть. `\\`⏎ в метке — склейка, не кавычка."""
    word, quoted = "", False
    while i < len(cmd) and cmd[i] not in SEP:
        if cmd.startswith("\\\n", i):
            i += 2
            continue
        i += cmd.startswith(("$'", '$"'), i)
        c = cmd[i]
        if c in "'\"":
            j = cmd.find(c, i + 1)
            if j < 0:
                return None
            word, quoted, i = word + cmd[i + 1:j], True, j + 1
        elif c == "\\":
            word, quoted, i = word + cmd[i + 1:i + 2], True, i + 2
        else:
            word, i = word + c, i + 1
    return (word, quoted, i) if word or quoted else None


def op_at(cmd, i):
    """`<<` или `<<-` с позиции i, склейки внутри — как у shell: (метка, в кавычках, `<<-`, конец метки); иначе None."""
    j = skip(cmd, i + 1)
    if cmd[j:j + 1] != "<" or cmd[i - 1:i] == "<":
        return None
    j = skip(cmd, j + 1)
    if cmd[j:j + 1] == "<":  # `<<<` — строка, не heredoc
        return None
    dash = cmd[j:j + 1] == "-"
    j += dash
    while cmd[j:j + 1] in (" ", "\t") or cmd.startswith("\\\n", j):
        j += 1 + (cmd[j] == "\\")
    w = heredoc_word(cmd, j)
    return w and (w[0], w[1], dash, w[2])


def region_ops(cmd, a, b):
    """`<<` в кавычках или комментарии cmd[a:b]: оператором не считается (SE-87), тело — только читателям."""
    found, k = [], cmd.find("<", a, b)
    while k >= 0:
        op = op_at(cmd, k)
        found += [(k,) + op + (False,)] if op else []
        k = cmd.find("<", k + 1, b)
    return found


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


def body_end(cmd, b, delim, quoted, dash, memo):
    """Строка-метка тела с позиции b: (её начало, начало следующей строки); нет — None. Логические строки текста —
    один раз на разбор (memo): иначе каждый `<<` без метки читал бы текст до конца, n²."""
    key = (not quoted, dash)
    if key not in memo:
        index, starts, i = {}, set(), 0
        while i < len(cmd):
            start, (t, i) = i, heredoc_line(cmd, i, not quoted)
            starts.add(start)
            index.setdefault(t.lstrip("\t") if dash else t, []).append((start, i))
        memo[key] = index, starts
    index, starts = memo[key]
    if b in starts or b >= len(cmd):
        found = index.get(delim, [])
        k = bisect.bisect_left(found, (b,))
        return found[k] if k < len(found) else None
    j = b  # b внутри склеенной строки (комментарий с `\\` в конце не продолжается) — по строкам
    while j < len(cmd):
        start, (t, j) = j, heredoc_line(cmd, j, not quoted)
        if (t.lstrip("\t") if dash else t) == delim:
            return start, j
    return None


def line_bodies(cmd, ops, line, last, e, bodies, memo):
    """Тела heredoc логической строки cmd[line:e] (ops — её `<<`) — в bodies [(читатели, тело, раскрывает)]; ответ —
    текст cmd[last:e+1] без тел и с `<< метка` на месте оператора и где продолжить разбор. Читатели — команда с `<<`
    и команды после `|` до конца логической строки. Тело — до строки, равной метке (у `<<-` — после ведущих табов; у
    метки без кавычек строка с `\\` в конце сначала склеивается со следующей); строки-метки нет — до конца текста, и
    текст остаётся. `<<` не оператор (certain — нет) — текст остаётся, тело — только читателям-shell и интерпретаторам."""
    from merge_guard_shell import launcher, normalize  # shell импортирует этот модуль
    text, at, i = [], last, e + 1
    for k, delim, quoted, dash, end, certain in ops:
        pre = SPEC.sub(" ", re.split(r"[;&|(]", JOIN.sub(r"\1", cmd[line:k]))[-1])
        post = JOIN.sub(r"\1", cmd[end:e]).split("|")[1:]
        readers = [a for a in (normalize(words(h)) for h in [pre] + post) if a]
        if not certain and not any(launcher(r[0]) for r in readers):
            continue  # `$((1<<2))`, `# <<E`: текст и так разобран как команды, читать тело некому
        b = i if certain else e + 1
        hit = body_end(cmd, b, delim, quoted, dash, memo)
        if hit:
            bodies.append((readers, cmd[b:max(hit[0] - 1, b)], not quoted))
        elif (not quoted) in memo["eof"]:  # тело до конца текста уже есть: это — его хвост, читатели — к нему
            first = memo["eof"][not quoted]
            first += [r for r in readers if r not in first]
        else:
            memo["eof"][not quoted] = readers
            bodies.append((readers, cmd[b:], not quoted))
        if certain:
            text += [cmd[at:k], "<< " + (delim if NAME_WORD.fullmatch(delim) else "E")]
            at, i = end, hit[1] if hit else i
    return "".join(text) + cmd[at:e + 1], i


def cut_heredocs(cmd):
    """Тела heredoc — отдельно: (текст без тел, [(читатели, тело, раскрывает ли shell `$(…)` в теле)]).
    `<<` — оператор, только если shell его так читает (SE-87): не в `'…'`/`"…"`/`$'…'`, не в комментарии, не в
    `$((…))`/`((…))`/`$[…]`/`${…}`; в `$(…)` и `` `…` `` — да, и внутри `"…"`. Иначе текст под ним — команды, а тело
    (вдруг знак комментария другой, SE-77) — только читателям. Строка с `<<` — логическая: `\\`⏎ её продолжает (SE-83)."""
    last_lt = max(cmd.rfind("<<"), cmd.rfind("<\\\n"))
    if last_lt < 0:
        return cmd, []
    out, bodies, ops, stack, memo = [], [], [], [["top", 0]], {"eof": {}}
    i = last = line = 0
    while i < len(cmd) and (ops or i <= last_lt):
        m = LEX.search(cmd, i)
        if not m:
            break
        k, c, ctx = m.start(), m.group(), stack[-1]
        i, code = k + 1, ctx[0] in CODE
        if c == "\\":
            i = k + 2
        elif c == "\n" and code:
            if ops:
                text, i = line_bodies(cmd, ops, line, last, k, bodies, memo)
                ops, last = [], i
                out.append(text)
            line = i
        elif c in "'$" and (code or ctx[0] == "brace") and (c == "'" or peek(cmd, k + 1) == "'"):
            j = skip(cmd, k + 1) + 1 if c == "$" else k + 1
            e = (ANSI if c == "$" else SQ).match(cmd, j).end()
            ops += region_ops(cmd, j, e)
            i = e + 1
        elif c == "$":
            j = skip(cmd, k + 1)
            n = cmd[j:j + 1]
            arith = n == "(" and peek(cmd, j + 1) == "("
            if n and n in "([{":
                stack.append(["arith", 2] if arith else [{"(": "sub", "[": "arithb", "{": "brace"}[n], 1])
                i = skip(cmd, j + 1) + 1 if arith else j + 1
        elif c == '"' and ctx[0] != "arith":
            stack.pop() if ctx[0] == "dq" else stack.append(["dq", 0])
        elif c == "`":
            stack.pop() if ctx[0] == "bt" else stack.append(["bt", 0])
        elif c in "([" and ctx[0] in ("arith", "arithb"):
            ctx[1] += c == "(" if ctx[0] == "arith" else c == "["
        elif c == "(" and code:
            arith = word_start(cmd, k) and peek(cmd, k + 1) == "("
            stack.append(["arith", 2] if arith else ["par", 1])
            i = skip(cmd, k + 1) + 1 if arith else k + 1
        elif c in ")]}" and len(stack) > 1:
            if ctx[0] in ("arith", "arithb"):
                ctx[1] -= c == (")" if ctx[0] == "arith" else "]")
                stack.pop() if ctx[1] <= 0 else None
            elif ctx[0] in ("sub", "par") and c == ")" or ctx[0] == "brace" and c == "}":
                stack.pop()
        elif c == "#" and code and word_start(cmd, k):
            i = line_end(cmd, k)
            ops += region_ops(cmd, k, i)
        elif c == "<":
            op = op_at(cmd, k)
            if op:
                ops.append((k,) + op + (code,))
                i = op[3]
    if ops:
        text, last = line_bodies(cmd, ops, line, last, len(cmd), bodies, memo)
        out.append(text)
    return "".join(out) + cmd[last:], bodies


def heredoc_text(body, expands):
    """Что получит читатель heredoc (SE-83). Метка без кавычек — shell раскрыл в теле `\\$`, `` \\` ``, `\\\\` и снял
    `\\`+перевод строки: `g\\\\`⏎`h` придёт как `g\\`⏎`h`, и bash-читатель склеит слово `gh`. С кавычками — тело как есть."""
    return HEREDOC_ESCAPE.sub(lambda m: "" if m.group(1) == "\n" else m.group(1), body) if expands else body


def join_lines(text):
    """Склейка строк для грубого признака (SE-83): нечётная серия `\\` перед переводом строки теряет последнюю `\\` и
    перевод строки, без пробела; чётная — нет. Кавычек и комментариев не различает: лишняя склейка меняет лишь текст
    строки или комментария, признак от неё только виднее."""
    return JOIN.sub(r"\1", text)
