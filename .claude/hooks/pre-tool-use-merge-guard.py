#!/usr/bin/env python3
"""
PreToolUse — merge-guard (d-merge-guard-3010, «да» владельца 30.10).

Только сессия «Контроля»: мёрж PR, деплой руками (workflow_dispatch, повтор прогона) и запись в защищённую ветку (main, master, основная ветка remote, protected) мимо PR.
Любой сессии нельзя: подписываться в очереди владельца чужим именем, править в основной папке законы и настройки
хуков (`.claude/rules`, `.claude/hooks`, `settings*.json`, список Контроля) и реестр сессий `~/.claude/sessions`.

Кто «Контроль» — `.claude/merge-guard.json` (`control`). Локально его перекрывает `.claude/merge-guard.local.json`
(вне git, правит владелец руками после раскладки сессий). Запись — имя сессии, как в ListAgents, или её sessionId.
Имя берётся из реестра `~/.claude/sessions/<pid>.json` по `session_id`, который присылает сам Claude Code.

Модель угрозы — исполнительный, но забывчивый агент, а не противник: тот же пользователь ОС может переписать файлы.
Команды разбираются по argv (merge_guard_shell), а не по подстроке: `grep "gh pr merge"` проходит. Защищённая
операция при неясной личности или испорченном списке — отказ. Всё прочее — пропуск без вывода.
"""
import itertools
import json
import os
import re
import sys
from pathlib import Path

HOME_CLAUDE = Path.home() / ".claude"
PROJECT_DIR = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_git import classify_git, start_budget  # noqa: E402
from merge_guard_dirs import DIR_CMDS, copy_state, dir_step, new_state, resolve_dirs  # noqa: E402
from merge_guard_files import BLIND_RUN, command_writes, opaque, rewritten, write_targets  # noqa: E402
from merge_guard_gh import classify_gh, classify_http, classify_interp, hooks_off  # noqa: E402
from merge_guard_launch import (awk_programs, implied_commands, make_files, package_scripts, read_names,  # noqa: E402
                                syntax_only)
from merge_guard_mcp import WRITE_OP, classify_mcp, mcp_op, mcp_paths, oq_identity, oq_merge_write  # noqa: E402
from merge_guard_expand import NAMES_MAX, brace_argv, qualifier_code  # noqa: E402
from merge_guard_vars import BLIND, VAR, words  # noqa: E402
from merge_guard_identity import MAIN_ROOT, control_verdict, live_sessions, load_control  # noqa: E402,F401 MAIN_ROOT — тесту
from merge_guard_shell import (LOST, PARTIAL, PROC, SCRIPT_EXT, SHELLS, SUBST, cat_files, command_name,  # noqa: E402
                               CHANGED, comment_char_may_change, comment_char_seen, cut_heredocs, cut_substitutions, device, dir_vars, expand_vars, expand_word, is_lost,
                               launch_args, launcher, normalize, note_vars, proc_files, read_script, settle,
                               split_commands, strip_comments, strip_prefix, subst_code, SUBST_AT, tokens_before_error,
                               uncommented)


GUARDED_CLAUDE_FILES = {"settings.json", "settings.local.json", "merge-guard.json", "merge-guard.local.json"}
GUARDED_CLAUDE_DIRS = ("rules", "hooks")

# Если разбор упал — защищённой считается команда, где есть хоть один из этих признаков.
FALLBACK = re.compile(
    r"gh\s+pr\s+merge|gh\s+workflow\s+run|gh\s+run\s+rerun|\bgit\b[^\n;|&]*\bpush\b|/merge\b|mergePullRequest"
    r"|/dispatches|\.claude/(rules|hooks|settings|merge-guard|sessions)"
)
# Конфиг git из окружения: его содержимое хук не видит.
GIT_ENV = re.compile(r"\b(GIT_CONFIG\w*|GIT_DIR|GIT_COMMON_DIR|HOME|XDG_CONFIG_HOME)=")


# ---------- защищённые файлы ----------

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


# ---------- решение ----------

def is_interp(word):
    return launcher(word) not in (None, "sh")


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


SOURCE = {"source", "."}
NOT_YET = "файл с кодом ещё не записан или его переписывает та же команда, а в команде признак защищённого действия"


STDIN = "код из stdin с признаком защищённого действия"
HEREDOC = ""  # в stdin_files: stdin — тело heredoc, его код виден и разобран classify_heredoc
UNPARSED = "скрипт не разобрать (кавычки не сошлись), а в нём признак защищённого действия"
# `x='a[$(…)]'; echo $((x))`: bash вычисляет значение переменной в арифметике и выполняет `$(…)` из него, так же
# eval, `${x@P}`, `bash -c "$x"`. Подстановка в кавычках с признаком — отложенный код, отказ.
DEFERRED = "подстановка в кавычках с признаком защищённого действия — её выполнят арифметика, eval или `${…@P}`"
SUBS = "\0subst"  # ключ procs: тексты $(…) этой команды по номеру (subst_code), словом команды не бывает
LOST_DIR = "код из папки, которую разбор не видит (`cd \"$X\"`, `cd $(…)`), — запускайте его по абсолютному пути"
UNSEEN = {"big": "скрипт больше 4 МБ — хук его не проверит", "lost": LOST_DIR}


def runs_code(a, exe, cwd, roots, depth, git_env, whole, stdin_files=(), procs=None):
    """Shell или интерпретатор берёт код из файла (`bash x.sh`, `./x.sh`, `source x`, `python3 -W… x.py`) — файл
    разбирается; у интерпретатора — ещё и каждый аргумент, похожий на скрипт, чтобы промах разбора опций не прятал файл.
    Код из stdin — файлы stdin_files (`bash < x.sh`, `cat x.sh | bash`, см. classify_bash) разбираются так же; None среди
    них — stdin не из файла (`echo … | bash`, `<<<`, `cat - x.sh`), и тогда — ещё и грубый признак по команде.
    Код не виден — решает грубый признак: stdin не из файла или файл не прочесть (`bash < <(…)`, FIFO) —
    по команде без тел heredoc (их разбирает classify_heredoc), файла ещё нет или его переписывает та же команда
    (`cat > x.sh <<EOF … bash x.sh`) — по всей команде с телами. whole = (без тел, с телами, текст с диска, имена
    файлов, которые команда пишет, — см. written_names, внешняя команда (без тел, с телами): у `$(bash x.sh)` запись и
    признак — в ней). Скрипт `/dev/stdin`, `/dev/fd/N` — тоже stdin;
    скрипт `<(…)` — файлы, которые выводит команда подстановки (procs, см. proc_files). Код не виден и признака
    в команде нет — грубый признак по файлам, которые команда называет (named_found)."""
    fam = launcher(a[0])
    mod, blind = None, False
    stdin_files = [g for f in stdin_files for g in (expand_word(f, cwd) if f else [f])]  # `bash < m.s?`
    if fam is None and a[0] not in SOURCE:  # ./x.sh — по первой строке
        scripts, interp = [exe], None
    else:
        code, stdin, first, module, end = launch_args(a) if fam else (False, False, a[1] if len(a) > 1 else None, None, 1)
        opts = a[1:end]
        if fam == "sh" and syntax_only(opts):  # `bash -n x.sh` — только синтаксис; BASH_ENV — implied_commands
            return []
        if code and fam == "sh":
            return eval_code(first or "", cwd, roots, depth, git_env, whole, procs)
        mod = module.replace(".", "/") if module else None
        named_stdin = first == "-" or bool(first and device(first, cwd))  # `bash /dev/stdin`, `source /dev/fd/0`
        if named_stdin or (stdin and fam == "sh"):  # `bash -s x`: x — аргумент, код из stdin
            first = None
        via = (procs or {}).get(first)  # `bash <(cat x.sh)`, `source <(…)`: код — вывод команды подстановки
        # `.` и `source` без файла stdin не читают: bash отвечает «filename argument required»
        from_stdin = stdin or named_stdin or (fam is not None and not (first or mod or code))
        blind = (from_stdin and (not stdin_files or None in stdin_files)) or bool(via and None in via)
        if (blind or (from_stdin and HEREDOC in stdin_files)) and FALLBACK.search(whole[0]):  # `bash -s gh … <<EOF`
            return [(STDIN, whole[0][:120])]
        scripts = ([mod + ".py", mod + "/__main__.py"] if mod else [f for f in via if f] if via
                   else [first] if first else [])
        if fam not in (None, "sh"):
            scripts += [x for x in a[1:] if SCRIPT_EXT.search(x) and x != first]
        scripts += [f for f in stdin_files if f] if from_stdin else []
        scripts = [g for s in scripts for g in expand_word(s, cwd)]  # `bash m*.sh`, `source {a,b}.sh` — что выберет shell
        scripts = [os.path.join(s, "__main__.py") if fam == "python" and os.path.isdir(os.path.join(
            cwd, os.path.expanduser(s))) else s for s in scripts]  # `python3 pkg` — папка с __main__.py
        interp = fam not in (None, "sh")
    found, seen = [], False
    for s in scripts:
        state, path, text = read_script(s, cwd)  # переписанный той же командой — как ненаписанный, но и текущий разбор
        seen = seen or (state != "missing" and not rewritten([s], whole[3] or ()))
        found += [(UNSEEN[state], s)] if state in UNSEEN else []
        if text is None:
            if s in stdin_files and FALLBACK.search(whole[0]):
                found.append((STDIN, whole[0][:120]))
            continue
        first_line = text.split("\n", 1)[0]
        is_interp_script = interp if interp is not None else (
            first_line.startswith("#!") and bool(re.search(r"python|node|perl|ruby|osascript", first_line)))
        try:  # разобран до ошибки — находки этой части и грубый признак по тексту скрипта: в `bash x.sh` его нет
            got, partial = settle(script_found(text, is_interp_script, cwd, roots, depth, git_env, path, comment_char_seen(whole[3], text, whole[4][1])))
        except Exception:
            got, partial = [], True
        found += got
        if partial and FALLBACK.search(text if is_interp_script else uncommented(text)):
            found.append((UNPARSED, s))
    if scripts and opaque(scripts, whole[3] or ()) and not whole[2]:  # `git switch x && bash m.sh` — с диска прочтён не тот код
        found.append((BLIND_RUN, scripts[0]))
    elif scripts and not seen and FALLBACK.search(whole[4][1]):
        found.append((NOT_YET, scripts[0]))
    elif blind or (scripts and not seen and not mod and not whole[2]):  # `python3 -m pytest` — модуль библиотеки;
        found += named_found(whole[4][0 if blind else 1], cwd)  # в скрипте с диска нет файла — чаще имя из переменной, а не скрытый код
    return found


def subst_files(code, cwd, roots, depth, git_env, whole, procs):
    """(код, находки): вывод `$(cat f)`/`$(< f)` в code — текст f (subst_code); файл не прочесть или его переписывает
    та же команда — находки разбора, как у `source f` (runs_code: грубый признак). Вывод не из файлов не виден."""
    text, unseen = subst_code(code, (procs or {}).get(SUBS, ()), cwd, lambda f: rewritten([f], whole[3] or ()))
    return text, [x for f in unseen for x in runs_code(["source", f], "source", cwd, roots, depth, git_env, whole)]


def eval_code(code, cwd, roots, depth, git_env, whole, procs):
    """Строка, которую shell выполнит как код (eval, `sh -c`, `emulate -c`): `eval "$(cat e.sh)"` — как `source e.sh`,
    `eval "$(ssh-agent -s)"` — вывод не виден, как прежде."""
    text, found = subst_files(code, cwd, roots, depth, git_env, whole, procs)
    return found + classify_bash(text, cwd, roots, depth + 1, git_env, *whole[2:])


NAMED = "код не виден, а команда называет файл с признаком защищённого действия"
WORD = re.compile(r"[^\s;&|()<>'\"=:`$]+")


def named_found(text, cwd):
    """Код не виден: `exec 3< x; bash /dev/fd/3`, `tac x | bash`, `bash $(echo x)`, `cp x y && bash y`, ссылка на
    /dev/stdin — его мог дать любой файл, который команда называет; грубый признак — по ним. text — команда без тел
    heredoc, когда не виден stdin: их код виден и разобран (classify_heredoc), а stdin читателя heredoc — не «не виден»
    (HEREDOC); с телами, когда файл переписан: копировать может и тело (`bash <<EOF cp m y EOF … $(bash y)`)."""
    found = []
    for w in list(dict.fromkeys(WORD.findall(text)))[:64]:
        body = None if device(w, cwd) else read_script(w, cwd)[2]  # FIFO и устройства read_script не открывает
        if body is not None and FALLBACK.search(uncommented(body)):
            found.append((NAMED, w))
    return found


def script_found(text, interp, cwd, roots, depth, git_env, path=True, keep=False):
    """Скрипт с диска (path — его путь: от него `$(dirname "$0")`, см. resolve_dirs): shell — как команды (keep — см. classify_bash), интерпретатор — построчно с путями в переменных (interp_found)."""
    if interp:
        return interp_found(text, cwd, roots, by_line=True)
    return classify_bash(text, cwd, roots, depth + 1, git_env, disk=path, keep=keep)


COARSE = "Makefile или программа awk с признаком защищённого действия"


def launched(a, cwd, roots, depth, git_env, whole):
    """Код из файла, который команда не называет скриптом (merge_guard_launch): скрипты package.json — как команды
    shell из папки пакета, Makefile и awk — грубым признаком. Этот файл переписывает та же команда
    (`printf … > package.json; npm run x`) — ещё и грубый признак, как у скрипта, которого нет (runs_code)."""
    found, files = [], make_files(a, cwd) + awk_programs(a, cwd)
    for d, text in package_scripts(a, cwd):  # текст None — папка пакета не видна (LOST)
        found += [(LOST_DIR, d)] if text is None else classify_bash(text, d, roots, depth + 1, git_env, disk=True)
    read = read_names(a) | {p for p, _ in files}
    if rewritten(read, whole[3] or ()):
        found += ([(NOT_YET, a[0])] if FALLBACK.search(whole[4][1]) else [] if whole[2] else
                  [(BLIND_RUN, a[0])] if opaque(read, whole[3]) else named_found(whole[4][1], cwd))
    return found + [(LOST_DIR if text is None else COARSE, p) for p, text in files if text is None or FALLBACK.search(text)]


def classify_heredoc(readers, body, expands, cwd, roots, depth, git_env, disk=False, written=None, outer=None):
    found = []
    for r in readers:
        if r[0] in SHELLS and not any(re.fullmatch(r"-[a-z]*c[a-z]*", x) for x in r[1:]):
            found += classify_bash(body, cwd, roots, depth + 1, git_env, disk, written, outer)
        elif is_interp(r[0]):
            found += interp_found(body, cwd, roots)
    if expands:  # метка без кавычек: $(…) и `…` в теле shell выполнит, кто бы ни читал
        for inner in cut_substitutions(body, quotes=False)[1]:
            found += classify_bash(inner, cwd, roots, depth + 1, git_env, disk, written, outer)
    return found


FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}


def classify_argv(a, cwd, roots, depth, git_env, whole=("", "", False, None, ("", "")), exe="", stdin_files=(), procs=None,
                  hid=()):
    """Одна команда после снятия обёрток. whole — исходная команда без тел heredoc и с ними (см. runs_code), exe — первое
    слово с путём, stdin_files — файлы, которые придут ей на stdin, hid — имена, заданные невидимо (BLIND)."""
    if a[0] == "eval":  # `eval -- 'gh pr merge 1'`: ведущий `--` bash и zsh пропускают
        code = a[2:] if a[1:2] == ["--"] else a[1:]
        return eval_code(" ".join(code), cwd, roots, depth, git_env, whole, procs) if code else []
    if a[0] == "emulate" and "-c" in a[1:-1]:  # zsh `emulate sh -c [--] 'строка'` — строка как команда
        rest = a[a.index("-c") + 1:]
        code = rest[1:] if rest[:1] == ["--"] else rest
        return eval_code(code[0], cwd, roots, depth, git_env, whole, procs) if code else []
    found = []
    if a[0] == "find":  # `find … -exec gh pr merge 1 \;`: `;` уже разделитель, хвост до `+` или конца
        for k in (k for k, x in enumerate(a) if x in FIND_EXEC):
            tail = list(itertools.takewhile(lambda y: y != "+", a[k + 1:]))
            if strip_prefix(tail):
                found += classify_argv(normalize(tail), cwd, roots, depth + 1, git_env, whole, strip_prefix(tail)[0])
    if launcher(a[0]) or a[0] in SOURCE or "/" in exe:
        found += runs_code(a, exe, cwd, roots, depth, git_env, whole, stdin_files, procs)
    if is_interp(a[0]):
        found += interp_found(" ".join(a[1:]), cwd, roots)
    found += launched(a, cwd, roots, depth, git_env, whole)
    written = whole[3] or ()
    http = lambda x: classify_http(x, cwd)  # noqa: E731
    kind = {"gh": lambda x: classify_gh(x, cwd, written), "curl": http, "wget": http, "http": http,
            "xh": http}.get(a[0], lambda _: None)(a)
    if a[0] == "git":
        kind = classify_git(a, cwd, env_config=git_env)
    if "$" in exe or SUBST in exe:  # имя не видно: `$GH pr merge 1`, `$(echo gh) pr merge 1`, `${G/x/gh}` — как gh, git, curl
        hidden = not whole[2] and (SUBST in exe or "*" in hid or any(n in hid for n in VAR.findall(exe)))  # не с диска
        if depth < 3 and SUBST_AT.search(exe):  # `$(cat c.txt)`, `x=$(cat c.txt); $x`: слова команды — текст файла
            text, more = subst_files(" ".join([exe] + a[1:]), cwd, roots, depth, git_env, whole, procs)
            b = [] if SUBST in text else strip_prefix(words(text))
            found += more + (classify_argv(normalize(b), cwd, roots, depth + 1, git_env, whole, b[0], stdin_files, procs,
                                           hid) if b else [])
        g = "blind" if hidden else True  # имя задано невидимо: голый push на main — тоже отказ (classify_git)
        kind = kind or (classify_gh(["gh"] + a[1:], cwd, written, guess=True)
                        or classify_git(["git"] + a[1:], cwd, env_config=git_env, guess=g) or classify_http(a, cwd))
        tail = strip_prefix(a[1:])  # `$X` раскроется и в пусто, и в префикс (`$SUDO`, `${DRY:+echo}`): `$X gh pr merge 1`
        if tail:
            found += classify_argv(normalize(tail), cwd, roots, depth, git_env, whole, tail[0], stdin_files, procs, hid)
    if kind:
        found.append((kind, " ".join(a)[:120]))
    if a[0] == "claude" and hooks_off(a):
        found.append(("file", "claude без хуков проекта (disableAllHooks, --setting-sources без project)"))
    for t in write_targets(a):
        p = protected_path(t, cwd, roots)
        if p:
            found.append(("file", p))
    return found


def classify_bash(cmd, cwd, roots, depth=0, git_env=False, disk=False, written=None, outer=None, part=False, keep=False, raw=None):
    """[(вид, подробность)] защищённых действий команды. git_env — конфиг git где-то задан окружением, disk — текст из скрипта на диске, а не из команды, written — имена файлов, которые уже пишет эта команда (дополняется), part —
    тело `$(…)` или кода маски: что для bash его начало — верхний уровень, не гарантировано, и комментарий с опасными знаками в нём остаётся (strip_comments, keep). Кавычки не сошлись — разбор до ошибки без комментариев и PARTIAL.
    Знак комментария мог смениться (keep — до этого текста: `histchars=…; source x`; текст или внешняя команда называют настройку — comment_char_may_change, SE-77) — разбор дважды: со снятыми комментариями и без (raw), находки обоих."""
    if raw is None and (keep or CHANGED in (written or ()) or comment_char_may_change(cmd + "\n" + (outer[1] if outer else ""))):  # только raw — код за `'` в комментарии
        return [f for r in (False, True) for f in classify_bash(cmd, cwd, roots, depth, git_env, disk, written, outer, part, keep, r)]
    fresh, written = written is None, set() if written is None else written
    git_env = git_env or bool(GIT_ENV.search(cmd))
    if depth > 3:  # глубже не разбираем: признак защищённого действия — отказ
        hit = FALLBACK.search(uncommented(cmd))
        return [("вложенная команда с признаком защищённого действия", cmd[:120])] if hit else []
    if fresh:  # все записи команды — до разбора `$(…)` и heredoc (они разбираются раньше); вложенным — уже от родителя
        written.update(command_writes(cmd) | ({CHANGED} if keep else set()))  # keep — и для `eval` в скрипте
    cmd, bodies = cut_heredocs(cmd)  # до снятия комментариев: в теле `'` — не кавычка, `#` — не комментарий
    bodies = [(r, b.replace("\\\n", " "), e) for r, b, e in bodies]
    cmd = (cmd if raw else strip_comments(cmd, True, None if part else FALLBACK.search)).replace("\\\n", " ")  # `\` строку не продолжает
    whole = (cmd, "\n".join([cmd] + [b for _, b, _ in bodies]), disk, written)
    whole += (outer or whole[:2],)
    cmd, inner = cut_substitutions(resolve_dirs(cmd, disk, cwd))
    procs = {f"{PROC}{k}": proc_files(body, cwd) for k, body in enumerate(inner) if f"{PROC}{k}" in cmd}
    procs[SUBS] = inner
    found = []
    for sub in inner:
        found += classify_bash(sub, cwd, roots, depth + 1, git_env, disk, written, whole[4], part=True)
    for readers, body, expands in bodies:
        found += classify_heredoc(readers, body, expands, cwd, roots, depth, git_env, disk, written, whole[4])
    for code in qualifier_code(cmd):  # zsh `ls *(e:'gh pr merge 1':)`
        found += classify_bash(code, cwd, roots, depth + 1, git_env, disk, written, whole[4], part=True)
    tokens, complete = tokens_before_error(cmd)
    found += [] if complete else [(PARTIAL, cmd[:120])]
    found += [(DEFERRED, t[:120]) for t in tokens if ("$(" in t or "`" in t) and FALLBACK.search(t)]
    env, prev, st, saved = dir_vars({}, cwd), ([], []), new_state(cwd), []
    fed = [r for readers, _, _ in bodies for r in readers]
    for argv, targets, sources, piped, (floor, level) in split_commands(tokens):
        if len(saved) > floor:  # `( cd x; … ); …` — подоболочка закрылась: папка и переменные — как до неё
            (st, env), cwd = saved[floor], saved[floor][0]["ds"][0]
            del saved[floor:]
        saved += [(copy_state(st), dict(env)) for _ in range(level - len(saved))]
        for t in targets:
            p = protected_path(t, cwd, roots)
            if p:
                found.append(("file", p))
        note_vars(argv, env)
        expanded, overflow = expand_vars(argv, env)
        braced, head = brace_argv(argv), strip_prefix(argv)  # скобки shell раскрывает до запуска: `{gh,pr,merge,1}`
        if braced is None and (FALLBACK.search(" ".join(argv)) or head and re.search(r"^(gh|git)$|[{$]", command_name(head[0]))):
            found.append((f"больше {NAMES_MAX} слов в раскрытии скобок у git, gh или с признаком защищённого действия",
                          " ".join(argv)[:120]))
        elif braced and braced != argv:  # решает и исходная форма, и раскрытая: в кавычках shell скобки не раскроет
            more, over = expand_vars(braced, env)
            expanded, overflow = expanded + more, overflow or over
        if overflow and FALLBACK.search(" ".join(argv)):
            found.append(("больше 16 вариантов подстановки с признаком защищённого действия", " ".join(argv)[:120]))
        for v in implied_commands(expanded):  # `BASH_ENV=m.sh bash -c true`, `NODE_OPTIONS='-r ./m.js' npm test`
            found += classify_argv(normalize(v), cwd, roots, depth, git_env, whole[:2] + (True,) + whole[3:],
                                  strip_prefix(v)[0])
        raws = [r for r in (strip_prefix(v) for v in expanded) if r]
        variants = [([command_name(r[0])] + r[1:], r[0]) for r in raws]
        stdin_files = [x for f in sources or (cat_files(*prev, cwd) if piped else []) for x in procs.get(f, [f])]
        stdin_files = stdin_files or ([HEREDOC] if argv in fed else [])
        prev = ([v for v, _ in variants], stdin_files)
        if any(v[0] in DIR_CMDS for v, _ in variants):
            new = dir_step([v for v, _ in variants], st, piped)
            if disk and is_lost(new):  # в скрипте с диска `cd "$ROOT"` в функциях и циклах обычен — папка прежняя
                st.update(new_state(cwd))
            else:
                cwd = new
            dir_vars(env, cwd, st["old"])
        for a, exe in ((v, e) for v, e in variants if v[0] not in DIR_CMDS):
            found += classify_argv(a, cwd, roots, depth, git_env, whole, exe, stdin_files, procs, env.get(BLIND, ()))
    return found


def decide(data, get_sessions=live_sessions, get_control=load_control, roots=None):
    """None — пропустить; иначе текст отказа. Реестр сессий и список Контроля читаются, только когда нужны."""
    tool = str(data.get("tool_name", ""))
    inp = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    cwd = str(data.get("cwd") or os.getcwd())
    sid = str(data.get("session_id", ""))
    roots = main_roots() if roots is None else roots
    start_budget()

    found, shell, code = [], [], None
    if tool in ("Bash", "Monitor"):
        shell = [str(inp.get("command", ""))]
    elif re.search(r"context-mode", tool) and mcp_op(tool) == "ctx_batch_execute":
        shell = [str(c.get("command", "")) for c in inp.get("commands") or [] if isinstance(c, dict)]
    elif re.search(r"context-mode", tool) and mcp_op(tool) in ("ctx_execute", "ctx_execute_file"):
        if inp.get("language") == "shell":
            shell = [str(inp.get("code", ""))]
        else:
            code = str(inp.get("code", ""))
    elif tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        p = protected_path(str(inp.get("file_path") or inp.get("notebook_path") or ""), cwd, roots)
        if p:
            found = [("file", p)]
    elif tool.startswith("mcp__"):
        kind = classify_mcp(tool, inp, cwd) or oq_merge_write(tool, inp)
        if kind:
            found = [(kind, tool)]
        if re.search(r"shell|command|terminal", mcp_op(tool)) and isinstance(inp.get("command"), str):
            shell = [inp["command"]]  # serena execute_shell_command и подобные
        if "github" not in tool.lower() and WRITE_OP.search(mcp_op(tool)):  # serena и др. правят файлы мимо Edit
            found += [("file", p) for v in mcp_paths(inp) for base in [cwd, *roots] if (p := protected_path(v, base, roots))]
        why = oq_identity(tool, inp, sid, get_sessions)
        if why:
            return f"merge-guard: {why}."
    for cmd in shell:
        try:  # разобрана до ошибки — находки этой части, и грубый признак, как у неразобранной
            (got, partial), why = settle(classify_bash(cmd, cwd, roots)), "кавычки не сошлись"
        except Exception as exc:
            (got, partial), why = ([], True), exc.__class__.__name__
        found += got
        if partial and FALLBACK.search(cmd):
            return f"merge-guard: команду не разобрать ({why}), а в ней признак защищённого действия. Разбейте её на простые команды."
    if code is not None:
        found += interp_found(code, cwd, roots)

    files = [d for k, d in found if k == "file"]
    if files:
        return (f"merge-guard: {files[0]} — законы, настройки хуков или реестр сессий. Правка только с «да» владельца: "
                "через PR из worktree или руками владельца.")
    ops = [(k, d) for k, d in found if k != "file"]
    if not ops:
        return None
    control, control_err = get_control()
    why = control_err or control_verdict(sid, get_sessions(), control)
    if why is None:
        return None
    return (f"merge-guard: {ops[0][0]} — только сессия «Контроля» (d-merge-guard-3010). {why}. "
            "Автор шлёт «PR #n, голова …» линзам, вливает Контроль; срочное — пункт владельцу. Список Контроля — "
            ".claude/merge-guard.json, локально .claude/merge-guard.local.json (правит владелец).")


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return
    try:
        reason = decide(data)
    except Exception as exc:  # сбой хука не должен ни пропускать мёрж, ни блокировать всё подряд
        cmd = json.dumps(data.get("tool_input"), ensure_ascii=False) if data.get("tool_name") != "Bash" else \
            str((data.get("tool_input") or {}).get("command", ""))
        reason = (f"merge-guard: сбой хука ({exc.__class__.__name__}), а в вызове признак защищённого действия."
                  if FALLBACK.search(cmd) or re.search(r"merge_pull_request|auto_merge", str(data.get("tool_name"))) else None)
    if reason:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}},
            ensure_ascii=False))


if __name__ == "__main__":
    main()
