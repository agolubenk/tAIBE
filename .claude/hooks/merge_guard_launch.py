"""
Код, который команда запускает из файла, не названного как скрипт (для pre-tool-use-merge-guard.py): `npm run X`,
`npm install`, `turbo run X` — скрипты package.json (с хуками жизненного цикла и пакетами workspaces), `make` — рецепты
Makefile и его include, `awk -f F` — программа awk и её @include; `BASH_ENV=F`, `NODE_OPTIONS='-r F'`, `MAKEFILES=F`,
`--script-shell F` — файл, который команда запустит сама (implied_commands). Решений не принимает: отдаёт тексты и
команды, разбирает их хук. Текст None — папка не видна (LOST, см. merge_guard_dirs): что делать, решает хук.
"""
import glob
import json
import os
import re

from merge_guard_files import open_regular
from merge_guard_shell import LOST, device, is_lost, words

PKG_TOOLS = {"npm", "pnpm", "yarn", "bun", "turbo"}
RUN = {"run", "run-script", "rum", "urn"}
SHORT = {"test": ["test"], "t": ["test"], "tst": ["test"], "start": ["start"], "stop": ["stop"],
         "restart": ["stop", "restart", "start"]}
INSTALL = ["install", "prepublish", "prepare"]  # и preinstall/postinstall… — pre/post добавляет package_scripts
LIFECYCLE = {**{w: INSTALL for w in (
    "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci",
    "clean-install", "ic", "install-clean", "isntall-clean", "update", "up", "upgrade", "udpate", "uninstall",
    "unlink", "remove", "rm", "r", "un", "link", "ln", "rebuild", "rb", "dedupe", "ddp", "prune")},
    **{w: INSTALL + ["test"] for w in ("it", "cit", "install-test", "install-ci-test", "clean-install-test", "sit")},
    "pack": ["pack", "prepare"], "publish": ["publish", "prepublishOnly", "pack", "prepare"], "version": ["version"]}
RECURSIVE = {"-r", "--recursive", "--filter", "-F", "--filter-prod", "-w", "--workspace", "--workspaces", "-ws",
             "--ws", "--all"}
RECURSIVE_WORDS = {"workspace", "workspaces", "recursive", "multi", "m"}
PKG_DIR_FLAGS = {"--prefix", "-C", "--dir", "--cwd"}  # npm, pnpm, pnpm, yarn — папка пакета
PKG_VALUED = PKG_DIR_FLAGS | {"-w", "--workspace", "--filter", "-F", "--filter-prod", "--loglevel", "--userconfig",
                              "--cache", "--registry", "--script-shell"}
NPM_CALL = {"-c", "--call"}  # `npm exec -c '…'`, `npx -c '…'`; у pnpm `-c` — флаг без значения
MAKES = {"make", "gmake"}
# Длинные опции GNU make 3.81–4.4 (NEWS): getopt_long берёт точное имя или однозначный префикс (SE-128).
MAKE_LONG = ("always-make", "assume-new", "assume-old", "check-symlink-times", "debug", "directory", "dry-run",
             "environment-overrides", "eval", "file", "help", "ignore-errors", "include-dir", "jobs", "jobserver-auth",
             "jobserver-fds", "jobserver-style", "just-print", "keep-going", "load-average", "makefile", "max-load",
             "new-file", "no-builtin-rules", "no-builtin-variables", "no-keep-going", "no-print-directory",
             "no-silent", "old-file", "output-sync", "print-data-base", "print-directory", "question", "quiet",
             "recon", "shuffle", "silent", "stop", "sync-mutex", "temp-stdin", "touch", "trace", "version",
             "warn-undefined-variables", "what-if")
# Опции make с обязательным значением: иначе значение (`--jobserver-auth -f`) читалось бы как опция.
MAKE_VALUED = {"-C", "--directory", "-f", "--file", "--makefile", "--temp-stdin", "-I", "--include-dir", "-E", "--eval",
               "-o", "--old-file", "--assume-old", "-W", "--what-if", "--new-file", "--assume-new", "--jobserver-auth",
               "--jobserver-fds", "--jobserver-style", "--sync-mutex"}
MAKE_OPTIONAL = {"-j", "-l", "-O"}  # необязательное значение: в связке — её остаток (`-lf ok.mk` — `-l f`, make 3.81)
MAKEFILES =("GNUmakefile", "makefile", "Makefile")
MAKE_INCLUDE = re.compile(r"(?m)^[ \t]*(?:-include|sinclude|include)[ \t]+(.+)$")
AWKS = {"awk", "gawk", "mawk", "nawk"}
AWK_INCLUDE = re.compile(r"""@include\s+"([^"]+)\"""")
FILES_MAX = 32  # include/@include и пакетов workspaces за одну команду — больше разбор не читает
WS_MAX = 256
TEXT_MAX = 4 * 1024 * 1024
IMPLIED_VAR = re.compile(r"(BASH_ENV|ENV|MAKEFILES|(?:GNU)?MAKEFLAGS|NODE_OPTIONS"  # `ИМЯ+=` shell тоже экспортирует
                         r"|(?i:npm_config_node_options|npm_config_script_shell))\+?=(.*)", re.S)
# Опции make, от которых зависит, какой текст make прочтёт (make_files), и переменные, от которых — что прочтёт и
# запустит: в MAKEFLAGS они — отказ (SE-133). Метка — слово, которого shell не передаст (в словах нет NUL).
MAKE_READS = {"-C", "--directory", "-f", "--file", "--makefile", "--temp-stdin", "-I", "--include-dir", "-E", "--eval",
              "?"}
MAKEFLAGS_DEF = re.compile(r"(?:MAKEFILES|SHELL|\.SHELLFLAGS|(?:GNU)?MAKEFLAGS)\s*[:+?!]*=")
MAKEFLAGS_ARG = "\0MAKEFLAGS"
# Строка --eval, которая запускает или читает то, чего разбор не видит (SE-135): подстановка `$`, рецепт (`;`,
# табуляция, `.RECIPEPREFIX`), `!=`, `define`, `export`, shell рецептов и файлы make — и в целевой переменной.
EVAL_RUNS = re.compile(r"[$;\t]|!=|\.RECIPEPREFIX|\.EXPORT_ALL_VARIABLES|\b(?:define|export)\b"
                       r"|(?<![\w.])(?:MAKEFILES|SHELL|\.SHELLFLAGS|(?:GNU)?MAKEFLAGS)\s*[:+?!]*=")
MAKE_VAR = re.compile(r"(?:MAKEFILES|SHELL|\.SHELLFLAGS)\s*[:+?!]*=")  # в строке make; MAKEFLAGS= — make_flags
NODE_PRELOAD = {"-r", "--require", "--import", "--loader", "--experimental-loader"}


def _read(path):
    f = open_regular(path)
    if f is None:
        return None
    try:
        with f:
            return f.read().decode("utf-8", errors="replace") if os.fstat(f.fileno()).st_size <= TEXT_MAX else None
    except OSError:
        return None


def read_names(a):
    """Имена файлов, которые команда прочтёт как код, хотя в ней их нет: package.json у npm/pnpm/yarn/…, Makefile у
    make. Названные явно (`make -f`, `awk -f`) — в путях make_files/awk_programs."""
    node_run = a[0] == "node" and any(w == "--run" or w.startswith("--run=") for w in a)
    return {"package.json"} if a[0] in PKG_TOOLS | {"npx"} or node_run else set(MAKEFILES) if a[0] in MAKES else set()


def _long(x, names):
    """`--k…[=v]` как у getopt_long: точное имя или однозначный префикс из names → `--имя[=v]`, иначе None."""
    key, eq, val = x[2:].partition("=")
    hits = [n for n in names if n == key] or [n for n in names if n.startswith(key)]
    return "--" + hits[0] + eq + val if len(hits) == 1 else None


def _options(a, valued, short=False, names=(), optional=()):
    """(значения опций по имени, остальные слова) для `--k v`, `--k=v`, `-k v`, `-k=v`; short — ещё связки getopt
    (`-sCsub`, `-vx=1`, `-F:`: значение — остаток связки или следующее слово; optional — опции с необязательным
    значением: остаток связки — их значение, SE-135). Опции без значения отбрасываются,
    после `--` — всё слова. names — все длинные опции команды: слово `--k…` на месте опции (не значение) раскрывается
    как у getopt_long (`--dir=sub` → `--directory=sub`), неоднозначное или неизвестное — в values["?"] (SE-128)."""
    values, rest, i = {}, [], 1
    while i < len(a):
        x = a[i]
        if names and x.startswith("--") and x != "--":
            full = _long(x, names)
            if full is None:
                values.setdefault("?", []).append(x)
                i += 1
                continue
            x = full
        key, eq, val = x.partition("=")
        nxt = a[i + 1] if i + 1 < len(a) else ""
        if x == "--":
            rest += a[i + 1:]
            break
        if x.startswith("--") and eq and key in valued:
            values.setdefault(key, []).append(val)
        elif x in valued:
            values.setdefault(x, []).append(nxt)
            i += 1
        elif short and re.fullmatch(r"-[^-].+", x):
            j = next((j for j in range(1, len(x)) if "-" + x[j] in valued or "-" + x[j] in optional), None)
            if j is not None and "-" + x[j] in valued:
                values.setdefault("-" + x[j], []).append(x[j + 1:] or nxt)
                i += 0 if x[j + 1:] else 1
        elif x.startswith("-") and eq and key in valued:
            values.setdefault(key, []).append(val)
        elif not x.startswith("-") or x == "-":
            rest.append(x)
        i += 1
    return values, rest


def _script_names(tool, rest):
    """Имена скриптов package.json, которые запустит команда: после `run` (где бы он ни стоял — перед ним может быть
    значение неизвестной опции), `npm test`/`start`/…, хуки install/pack/publish/version; у pnpm, yarn, bun и turbo
    `pnpm build` — тоже скрипт, поэтому имена — все слова. Лишнее имя прочитает лишний скрипт, а не пропустит нужный."""
    if tool == "yarn" and not rest:
        return INSTALL
    i = next((k for k, w in enumerate(rest) if w in RUN), None)
    names = rest[i + 1:] if i is not None else []
    names += SHORT.get(rest[0], []) + LIFECYCLE.get(rest[0], []) if rest else []
    names += [w for w in rest if w not in RUN] if tool != "npm" else []
    return list(dict.fromkeys(names))


def _workspaces(base):
    """Папки пакетов workspaces (`workspaces` в package.json, pnpm-workspace.yaml) от корня вверх от base; корень —
    первым. `**` читается как `*`: глубже разбор не идёт."""
    d = os.path.realpath(base)
    while True:
        pkg = _read(os.path.join(d, "package.json"))
        try:
            ws = json.loads(pkg).get("workspaces") if pkg else None
        except (ValueError, AttributeError):
            ws = None
        ws = ws.get("packages") if isinstance(ws, dict) else ws
        yaml = _read(os.path.join(d, "pnpm-workspace.yaml"))
        if yaml is not None:
            ws = re.findall(r"""(?m)^\s*-\s*['"]?([^'"\s#]+)""", yaml.split("packages:", 1)[-1])
        if isinstance(ws, list):
            dirs = [p for g in ws if isinstance(g, str) and not g.startswith("!")
                    for p in sorted(glob.glob(os.path.join(d, g.replace("**", "*")))) if os.path.isdir(p)]
            return [d] + list(dict.fromkeys(dirs))[:WS_MAX]
        if os.path.dirname(d) == d:
            return [os.path.realpath(base)]
        d = os.path.dirname(d)


def _turbo_tasks(names, base):
    """Имена и их dependsOn из turbo.json (tasks или pipeline; `^build`, `pkg#build`) — замыкание."""
    try:
        conf = json.loads(_read(os.path.join(base, "turbo.json")) or "{}")
        tasks = conf.get("tasks") or conf.get("pipeline") or {}
    except (ValueError, AttributeError):
        return names
    out, queue = [], list(names)
    while queue and len(out) < FILES_MAX * 2:
        n = queue.pop(0)
        if n in out:
            continue
        out.append(n)
        for k, t in tasks.items() if isinstance(tasks, dict) else ():
            if (k == n or k.endswith("#" + n)) and isinstance(t, dict) and isinstance(t.get("dependsOn"), list):
                queue += [x.lstrip("^").rsplit("#", 1)[-1] for x in t["dependsOn"] if isinstance(x, str)]
    return out


def package_scripts(a, cwd):
    """[(папка пакета, текст скрипта)] для `npm run X`, `npm test`, `npm install`, `pnpm X`, `yarn`, `turbo run X`,
    `node --run X`, `npm exec -c '…'`: X, preX и postX из ближайшего package.json вверх от папки (`--prefix`, `-C`,
    `--dir`, `--cwd`); с `-r`, `--filter`, `-w`, `workspace…` и для install — ещё из каждого пакета workspaces.
    Папка не видна — [(папка, None)]."""
    if a[0] == "node":  # `node --run X` (Node 22+) — scripts.X
        x = next((a[k + 1] if w == "--run" and k + 1 < len(a) else w[6:] for k, w in enumerate(a)
                  if w == "--run" or w.startswith("--run=")), None)
        a = ["npm", "run", x] if x else a
    if a[0] not in PKG_TOOLS | {"npx"}:
        return []
    values, rest = _options(a, PKG_VALUED | (NPM_CALL if a[0] in ("npm", "npx") else set()))
    calls = values.get("-c", []) + values.get("--call", [])
    if calls and (a[0] == "npx" or rest[:1] in (["exec"], ["x"])):  # строка shell
        return [(cwd, c) for c in calls]
    names = _script_names(a[0], rest) if a[0] != "npx" else []
    if not names:
        return []
    base = os.path.join(cwd, *[os.path.expanduser(d) for d in sum((values.get(k, []) for k in PKG_DIR_FLAGS), [])])
    if is_lost(base):
        return [(base, None)]
    names = _turbo_tasks(names, base) if a[0] == "turbo" else names
    every = (a[0] == "turbo" or any(x.partition("=")[0] in RECURSIVE for x in a[1:])
             or rest[:1] and (rest[0] in RECURSIVE_WORDS or rest[0] in LIFECYCLE) or a[0] == "yarn" and not rest)
    out = []
    for d in _workspaces(base) if every else [base]:
        pkg = _nearest(d, "package.json")
        try:
            scripts = json.loads(_read(pkg) or "{}").get("scripts") if pkg else None
        except (ValueError, AttributeError):  # испорченный package.json npm не запустит
            continue
        if not pkg or not isinstance(scripts, dict):
            continue
        for n in names:
            out += [(os.path.dirname(pkg), scripts[k]) for k in (f"pre{n}", n, f"post{n}")
                    if isinstance(scripts.get(k), str)]
    return list(dict.fromkeys(out))


def _nearest(d, name):
    d = os.path.realpath(d)
    while True:
        if os.path.isfile(os.path.join(d, name)):
            return os.path.join(d, name)
        if os.path.dirname(d) == d:
            return None
        d = os.path.dirname(d)


def _read_tree(paths, includes):
    """[(путь, текст)] файлов и того, что они включают (includes(путь, текст) → пути), не больше FILES_MAX;
    путь от невидимой папки — (путь, None)."""
    out, queue, seen = [], list(paths), set()
    while queue and len(seen) < FILES_MAX:
        p = queue.pop(0)
        if p in seen:
            continue
        seen.add(p)
        t = None if is_lost(p) else _read(p)
        if t is not None or is_lost(p):
            out.append((p, t))
            queue += includes(p, t) if t is not None else []
    return out


def _make_opts(a):
    """Опции make как у getopt_long (SE-128); `-j`, `-l`, `-O` в связке берут её остаток (SE-135)."""
    return _options(a, MAKE_VALUED, short=True, names=MAKE_LONG, optional=MAKE_OPTIONAL)


def _make_where(values, cwd):
    """(папка make после `-C`, названные Makefile, строки `--eval`/`-E`, папки поиска include — она и `-I`)."""
    d = os.path.join(cwd, *[os.path.expanduser(x) for x in values.get("-C", []) + values.get("--directory", [])])
    named = sum((values.get(k, []) for k in ("-f", "--file", "--makefile", "--temp-stdin")), [])
    dirs = [d] + [os.path.join(d, os.path.expanduser(x)) for x in values.get("-I", []) + values.get("--include-dir", [])]
    return d, named, values.get("-E", []) + values.get("--eval", []), dirs


def make_files(a, cwd):
    """[(путь, текст без строк-комментариев)] того, что прочтёт make: `-f F` (после `-C D`), иначе первый из
    GNUmakefile/makefile/Makefile, и их include/-include/sinclude (от папки make и `-I`). `make -n` не исключение:
    `$(shell …)` выполняется при чтении. Имя include с `$` — не видно (остаток). Строка `--eval`/`-E` — тоже текст
    Makefile (путь `--eval`), её include читаются. Длинные опции — как у getopt_long (SE-128); неоднозначная или
    неизвестная — папка не видна (LOST): у make 3.81 `--o` — это `--old-file`, и его значение `-f` уже не опция."""
    if a[0] not in MAKES:
        return []
    values, _ = _make_opts(a)
    if "?" in values:
        return [(LOST, None)]
    d, named, evals, dirs = _make_where(values, cwd)
    evals = [("--eval", re.sub(r"(?m)^[ \t]*#.*$", "", t)) for t in evals]
    paths = [os.path.join(d, os.path.expanduser(f)) for f in named] or (
        [d] if is_lost(d) else [next((os.path.join(d, m) for m in MAKEFILES if os.path.isfile(os.path.join(d, m))), "")])

    def includes(_, text):
        found = []
        for name in (n for m in MAKE_INCLUDE.finditer(text) for n in m.group(1).split() if "$" not in n):
            found += next((h for h in (sorted(glob.glob(os.path.join(x, os.path.expanduser(name)))) for x in dirs)
                           if h), [])
        return found

    roots = [p for p in paths if p] + [h for _, t in evals for h in includes(None, re.sub(r"#.*", "", t))]
    return [(p, None if t is None else re.sub(r"(?m)^[ \t]*#.*$", "", t))
            for p, t in _read_tree(roots, lambda p, t: includes(p, re.sub(r"#.*", "", t)))] + evals


# Причины отказа хука (launched) вместо LOST_DIR: папка видна, не разобрана опция.
MAKE_OPTION = ("длинная опция make, которую разбор не раскрывает однозначно (`--d`, `--frob`): какой Makefile make "
               "прочтёт, не видно — напишите опцию полностью (`--directory=…`)")
MAKEFLAGS_WHY = ("MAKEFILES, MAKEFLAGS или GNUMAKEFLAGS из окружения: файлы MAKEFILES, опция или переменная в MAKEFLAGS, "
                 "от которой зависит, что make прочтёт и запустит (`-I`, `-C`, `-f`, `--eval`, `MAKEFILES=`, `SHELL=`), "
                 "или кавычка, `\\`, `$` в MAKEFLAGS (слова и подстановки make делит иначе, чем shell): папку make "
                 "(`-C`, `cd`) разбор с ними не сводит — передайте опции в командной строке make, файлы — через `-f`")
MAKE_STDIN = ("Makefile из потока, а не из файла (`-f -`, `-f /dev/stdin`, FIFO, ссылка на устройство, "
              "`include /dev/stdin` в `--eval`): его текст разбор не видит — запишите Makefile в файл и передайте `-f`")
MAKE_EVAL = ("строка `--eval`/`-E` с `$`, рецептом (`;`, табуляция, `.RECIPEPREFIX`), `!=`, `define`, `export` или "
             "`SHELL=`, `.SHELLFLAGS=`, `MAKEFILES=`: что она прочтёт и запустит, разбор не видит — передайте это "
             "Makefile-файлом (`-f`)")
MAKE_VAR_WHY = ("переменная make в командной строке, от которой зависит, чем make запустит рецепты и что прочтёт "
                "(`SHELL=`, `.SHELLFLAGS=`, `MAKEFILES=` — от папки после `-C`): разбор этого не видит — уберите её, "
                "файл make передайте через `-f`")


def _stream(p):
    """make прочтёт путь как поток, а не файл: устройство (кроме /dev/null), FIFO, папка, битая ссылка (SE-135)."""
    return not is_lost(p) and os.path.realpath(p) != os.devnull and (
        device(p, "/") or os.path.lexists(p) and not os.path.isfile(p))


def make_option(a, cwd):
    """Причина, по которой разбор не видит, что прочтёт или запустит make, иначе "": метка make_flags (SE-133);
    длинная опция, которую getopt_long не раскроет однозначно (`--d`, `--o`, `--frob`, SE-128); Makefile из потока
    (`-f -`, устройство, FIFO, `include /dev/stdin` в `--eval`); строка `--eval` с EVAL_RUNS; `SHELL=`, `.SHELLFLAGS=`,
    `MAKEFILES=` в строке make (SE-135). Рецепты Makefile на диске — предел дизайна: только грубый признак (хук)."""
    if a[0] not in MAKES:
        return ""
    if MAKEFLAGS_ARG in a:
        return MAKEFLAGS_WHY
    values, rest = _make_opts(a)
    if "?" in values:
        return MAKE_OPTION
    d, named, evals, dirs = _make_where(values, cwd)
    paths = [os.path.join(d, os.path.expanduser(f)) for f in named] + [
        os.path.join(x, os.path.expanduser(n)) for t in evals for m in MAKE_INCLUDE.finditer(t)
        for n in m.group(1).split() for x in dirs]
    if "-" in named or any(map(_stream, paths)):
        return MAKE_STDIN
    if any(map(EVAL_RUNS.search, evals)):
        return MAKE_EVAL
    return MAKE_VAR_WHY if any(map(MAKE_VAR.match, rest)) else ""


def _awk_file(name, cwd):
    """Файл awk: как назван или с `.awk` (gawk ищет так же)."""
    p = os.path.join(cwd, os.path.expanduser(name))
    return next((q for q in (p, p + ".awk") if os.path.isfile(q)), p)


def awk_programs(a, cwd):
    """[(откуда, текст)] программы awk: файлы `-f F`, `-E F`, `-i F` (gawk), строки `-e`/`--source`, иначе первое
    слово без опции, и всё, что они подключают через `@include "x"`."""
    if a[0] not in AWKS:
        return []
    values, rest = _options(a, {"-f", "--file", "-e", "--source", "-v", "--assign", "-F", "--field-separator",
                                "-i", "--include", "-l", "--load", "-E", "--exec"}, short=True)
    progs = sum((values.get(k, []) for k in ("-f", "--file", "-E", "--exec")), [])
    libs = values.get("-i", []) + values.get("--include", [])
    inline = values.get("-e", []) + values.get("--source", []) or ([] if progs else rest[:1])

    def includes(_, text):
        return [_awk_file(n, cwd) for n in AWK_INCLUDE.findall(text)]

    files = _read_tree([_awk_file(f, cwd) for f in progs + libs], includes)
    extra = _read_tree([f for t in inline for f in includes(None, t)], includes)
    return files + [("awk", t) for t in inline] + [x for x in extra if x not in files]


def implied_commands(argvs):
    """Команды, которые запустит сама команда, по её словам (префикс, `env …`, `export …`, опция): `BASH_ENV=F`/`ENV=F`
    — bash и sh выполнят F до своей команды, в том числе внутри `npm run`; `MAKEFILES=F` — make прочтёт F от своей
    папки после `-C` (сверено с make 3.81), её разбор не сводит — отказ с причиной, как у
    `MAKEFLAGS=-Idir`, `MAKEFLAGS='MAKEFILES=F'` (make_flags, SE-133, SE-135);
    `NODE_OPTIONS='-r F'` (`--require`, `--import`, `--loader`) — node загрузит F; `--script-shell F` и
    `npm_config_script_shell=F` — npm запустит скрипты через F. Разбирается при присваивании, а не при запуске."""
    out = []
    for a in argvs:
        for k, x in enumerate(a):
            m = IMPLIED_VAR.fullmatch(x)
            name, val = (m.group(1), m.group(2)) if m else ("", "")
            if name in ("BASH_ENV", "ENV") and val:
                out.append(["bash", val])
            elif name == "MAKEFILES":
                out += [["make", MAKEFLAGS_ARG]] if val.split() else []
            elif name.endswith("MAKEFLAGS"):
                out += make_flags(val)
            elif name.lower() in ("node_options", "npm_config_node_options"):
                ws = words(val) + [""]
                out += [["node", ws[j + 1] if w in NODE_PRELOAD else w.partition("=")[2]] for j, w in enumerate(ws)
                        if w in NODE_PRELOAD or "=" in w and w.partition("=")[0] in NODE_PRELOAD]
            elif name.lower() == "npm_config_script_shell" and val:
                out.append([val, "-c", "true"])
            if x == "--script-shell" and k + 1 < len(a) or x.startswith("--script-shell="):
                out.append([a[k + 1] if x == "--script-shell" else x.partition("=")[2], "-c", "true"])
    return [list(v) for v in dict.fromkeys(tuple(v) for v in out if v[0] and v[-1])]


def make_flags(val):
    """`MAKEFLAGS=…`, `GNUMAKEFLAGS=…` — опции и переменные make из окружения: `-I` и `MAKEFILES=` (в том числе после
    `--`) make слушает (сверено с make 3.81), `--eval`/`-E` и GNUMAKEFLAGS — make 4.x (assumed, по документации).
    Путь из них make берёт от своей папки после `-C` команды или `cd` раньше в строке — разбор их не сводит. Поэтому
    опция чтения (MAKE_READS; `-C`/`-f` make из окружения не слушает — с запасом) или MAKEFILES=, SHELL=, .SHELLFLAGS=
    дают команду `make` с меткой: хук отказывает с причиной MAKEFLAGS_WHY (make_option). Прочие переменные (`CC=`)
    — как в командной строке make: рецепты разбор проверяет только грубым признаком. Первое слово без `-` и без `=`
    make читает как связку коротких опций (`MAKEFLAGS=sIinc` — `-sIinc`). Слова make делит только по пробелам:
    кавычка для него — обычный символ, `\\ ` склеивает слова, `$(Y)` раскрывается из окружения (make 3.81) — такое
    значение тоже отказ."""
    if re.search(r"[\"'\\$]", val):
        return [["make", MAKEFLAGS_ARG]]
    ws = val.split()
    if ws and not ws[0].startswith("-") and "=" not in ws[0]:
        ws[0] = "-" + ws[0]
    values, rest = _make_opts(["make"] + ws)
    return [["make", MAKEFLAGS_ARG]] if MAKE_READS & set(values) or any(map(MAKEFLAGS_DEF.match, rest)) else []


def syntax_only(opts):
    """Оболочка только проверит синтаксис файла (`bash -n x.sh`, `-o noexec`): `-n`/`+n` и `-o`/`+o noexec` bash
    применяет по порядку, решает последнее (`-n +n`, `+no noexec` — запуск, сверено с bash 3.2); интерактивный bash
    (`-i`, `--rcfile`, `--init-file`) `-n` не слушает. opts — слова до файла скрипта."""
    on, names = False, []  # names — знак у каждого `o` связки, `None` у `O`: их значения идут следующими словами
    for x in opts:
        if names:
            sign = names.pop(0)
            on = sign == "-" if sign and x == "noexec" else on
        elif x in ("--rcfile", "--init-file") or re.fullmatch(r"[-+][a-zA-Z]*i[a-zA-Z]*", x):
            return False
        elif re.fullmatch(r"[-+][a-zA-Z]+", x):
            on = x[0] == "-" if "n" in x else on
            names += [x[0] if c == "o" else None for c in x[1:] if c in "oO"]
    return on
