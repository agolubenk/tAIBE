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
from merge_guard_shell import is_lost, words

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
MAKEFILES = ("GNUmakefile", "makefile", "Makefile")
MAKE_INCLUDE = re.compile(r"(?m)^[ \t]*(?:-include|sinclude|include)[ \t]+(.+)$")
AWKS = {"awk", "gawk", "mawk", "nawk"}
AWK_INCLUDE = re.compile(r"""@include\s+"([^"]+)\"""")
FILES_MAX = 32  # include/@include и пакетов workspaces за одну команду — больше разбор не читает
WS_MAX = 256
TEXT_MAX = 4 * 1024 * 1024
IMPLIED_VAR = re.compile(r"(BASH_ENV|ENV|MAKEFILES|NODE_OPTIONS|(?i:npm_config_node_options|npm_config_script_shell))"
                         r"=(.*)", re.S)
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


def _options(a, valued, short=False):
    """(значения опций по имени, остальные слова) для `--k v`, `--k=v`, `-k v`, `-k=v`; short — ещё связки getopt
    (`-sCsub`, `-vx=1`, `-F:`: значение — остаток связки или следующее слово). Опции без значения отбрасываются,
    после `--` — всё слова."""
    values, rest, i = {}, [], 1
    while i < len(a):
        x = a[i]
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
            j = next((j for j in range(1, len(x)) if "-" + x[j] in valued), None)
            if j is not None:
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


def make_files(a, cwd):
    """[(путь, текст без строк-комментариев)] того, что прочтёт make: `-f F` (после `-C D`), иначе первый из
    GNUmakefile/makefile/Makefile, и их include/-include/sinclude (от папки make и `-I`). `make -n` не исключение:
    `$(shell …)` выполняется при чтении. Имя include с `$` — не видно (остаток)."""
    if a[0] not in MAKES:
        return []
    values, _ = _options(a, {"-C", "--directory", "-f", "--file", "--makefile", "-I", "--include-dir", "-o",
                             "--old-file", "--assume-old", "-W", "--what-if", "--new-file", "--assume-new"}, short=True)
    d = os.path.join(cwd, *[os.path.expanduser(x) for x in values.get("-C", []) + values.get("--directory", [])])
    named = sum((values.get(k, []) for k in ("-f", "--file", "--makefile")), [])
    paths = [os.path.join(d, os.path.expanduser(f)) for f in named] or (
        [d] if is_lost(d) else [next((os.path.join(d, m) for m in MAKEFILES if os.path.isfile(os.path.join(d, m))), "")])
    dirs = [d] + [os.path.join(d, os.path.expanduser(x)) for x in values.get("-I", []) + values.get("--include-dir", [])]

    def includes(_, text):
        found = []
        for name in (n for m in MAKE_INCLUDE.finditer(text) for n in m.group(1).split() if "$" not in n):
            found += next((h for h in (sorted(glob.glob(os.path.join(x, os.path.expanduser(name)))) for x in dirs)
                           if h), [])
        return found

    return [(p, None if t is None else re.sub(r"(?m)^[ \t]*#.*$", "", t))
            for p, t in _read_tree([p for p in paths if p], lambda p, t: includes(p, re.sub(r"#.*", "", t)))]


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
    — bash и sh выполнят F до своей команды, в том числе внутри `npm run`; `MAKEFILES=F` — make прочтёт F;
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
                out += [["make", "-f", f] for f in val.split()]
            elif name.lower() in ("node_options", "npm_config_node_options"):
                ws = words(val) + [""]
                out += [["node", ws[j + 1] if w in NODE_PRELOAD else w.partition("=")[2]] for j, w in enumerate(ws)
                        if w in NODE_PRELOAD or "=" in w and w.partition("=")[0] in NODE_PRELOAD]
            elif name.lower() == "npm_config_script_shell" and val:
                out.append([val, "-c", "true"])
            if x == "--script-shell" and k + 1 < len(a) or x.startswith("--script-shell="):
                out.append([a[k + 1] if x == "--script-shell" else x.partition("=")[2], "-c", "true"])
    return [list(v) for v in dict.fromkeys(tuple(v) for v in out if v[0] and v[-1])]


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
