"""
gh, curl и код интерпретаторов для merge-guard (pre-tool-use-merge-guard.py): мёрж PR, деплой руками и запись в
защищённую ветку (merge_guard_git.protected_branches) через `gh pr`/`gh api`/GraphQL/`gh workflow`, HTTP к
api.github.com и те же команды внутри subprocess-кода.
"""
import os
import re
import shlex

from merge_guard_files import GH_MOVED, GH_WRITTEN, open_regular, rewritten
from merge_guard_git import MAIN_WRITE, is_protected, mentions_protected
from merge_guard_mcp import DEPLOY, MERGE
from merge_guard_shell import SUBST, device


API_VALUE_FLAGS = {"-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache"}
API_FIELD_FLAGS = {"-f", "-F", "--field", "--raw-field", "--input"}
API_VALUED = API_VALUE_FLAGS | API_FIELD_FLAGS | {"-X", "--method"}
GH_BOOL = {"-h", "--help", "--version"}  # единственные флаги без значения у gh и его групп (pr, workflow, run, alias)
GH_BUILTIN = set("""agent-task alias api attestation auth browse cache codespace completion config copilot discussion
extension gist gpg-key help issue label licenses org pr preview project release repo ruleset run search secret skill
ssh-key status variable version workflow""".split())  # gh 2.100; иное слово — псевдоним, расширение или опечатка
GH_PROTECTED = (["pr", "merge"], ["workflow", "run"], ["run", "rerun"])
BODY_MAX = 1024 * 1024
GH_UNKNOWN = ("подкоманда gh не встроенная и не прочитанный псевдоним (нет в config.yml, конфиг не в простом виде или его "
              "меняет та же команда, shell-псевдоним, расширение, опечатка) — что выполнит gh, не видно")
GH_KEY = r"[A-Za-z0-9_][\w.-]*"
UNSEEN_BODY = "запрос GraphQL, тело которого не видно (stdin, файла ещё нет или он больше 1 МБ)"
VISIBILITY = "смена видимости репозитория (код, история и docs открываются разом и необратимо)"  # IS-124
VIS_JSON_KEY = r"\b(visibility|private)\b[\"']?\s*[:=]"
API_REPO = r"api\.github\.com/repos/[^/\s\"'?]+/[^/\s\"'?]+(?=[\s\"'?]|$)"  # сам репозиторий, не его ресурсы


def field_file(path, cwd=".", written=()):
    """Файл, содержимое которого gh отправит (`-F query=@file`, `--input file`): None — тело не видно: stdin (`@-`,
    `--input -`, `/dev/stdin`, `/dev/fd/N`), не обычный файл (FIFO), файла нет, его пишет та же команда (written —
    имена) или он больше BODY_MAX, иначе текст."""
    if path == "-" or device(path, cwd) or rewritten([path], written):
        return None
    f = open_regular(os.path.join(cwd, os.path.expanduser(path)))
    if f is None:
        return None
    with f:
        text = f.read(BODY_MAX + 1)
    return None if len(text) > BODY_MAX else text.decode("utf-8", errors="replace")


def api_args(args):
    """Аргументы `gh api` в виде «флаг значение» — как их разбирает pflag (cobra): `--input=f`, `-Fk=v`, `-F=k=v`,
    связка `-iF k=v`; значение флага — следующий аргумент, даже если начинается с `-`. После `--` — только слова."""
    out, i = [], 0
    while i < len(args):
        x, nxt = args[i], args[i + 1] if i + 1 < len(args) else ""
        name, eq, val = x.partition("=")
        if x == "--":
            return out + args[i + 1:]
        if x.startswith("--") and name in API_VALUED:
            out, i = out + ([name, val] if eq else [x, nxt]), i + (1 if eq else 2)
            continue
        if re.fullmatch(r"-[^-].*", x):
            j = next((j for j in range(1, len(x)) if "-" + x[j] in API_VALUED), None)
            if j is not None:
                rest = x[j + 1:]
                rest = rest[1:] if rest.startswith("=") and len(rest) > 1 else rest
                out, i = out + ["-" + x[j], rest or nxt], i + (1 if rest else 2)
                continue
        out, i = out + [x], i + 1
    return out


def contents_branch(fields):
    """Ветка записи `PUT …/contents/…`: значение поля branch (последнее), "@" — не видно (`-F branch=@f`,
    `-F branch={branch}` — gh подставит текущую ветку, тело из `--input`), None — не задана (ветка по умолчанию)."""
    branch = None
    for flag, raw, _ in fields:
        key, _, value = raw.partition("=")
        if flag == "--input":
            branch = "@"
        elif key == "branch":
            branch = "@" if flag in ("-F", "--field") and (value.startswith("@") or "{" in value) else value
    return branch


def repo_visibility(fields):
    """`PATCH repos/<o>/<r>` меняет видимость: поле visibility или private (`-f`, `-F`), такой ключ в теле `--input`
    или тело `--input` не видно (stdin, файла нет, больше 1 МБ)."""
    for flag, raw, body in fields:
        if flag == "--input" and (not body or re.search(VIS_JSON_KEY, body)):
            return True
        if flag != "--input" and raw.partition("=")[0] in ("visibility", "private"):
            return True
    return False


def classify_gh_api(a, cwd=".", written=()):
    a = a[:2] + api_args(a[2:])
    method, path, fields, unseen = None, None, [], False
    i = 2
    while i < len(a):
        t = a[i]
        nxt = a[i + 1] if i + 1 < len(a) else ""
        if t in ("-X", "--method"):
            method, i = nxt.upper(), i + 2
        elif t in API_FIELD_FLAGS:
            # `-f` шлёт значение как есть; `-F k=@f` — содержимое файла; `--input` — сам путь, тело запроса целиком
            value = nxt.partition("=")[2]
            ref = nxt if t == "--input" else value[1:] if t in ("-F", "--field") and value.startswith("@") else None
            body = "" if ref is None else field_file(ref, cwd, written)
            unseen = unseen or body is None
            fields.append((t, nxt, body or ""))
            i += 2
        elif t in API_VALUE_FLAGS:
            i += 2
        else:
            if not t.startswith("-") and path is None:
                path = t
            i += 1
    p = (path or "").split("?")[0].rstrip("/")
    blob = " ".join(a + [x for _, raw, body in fields for x in (raw, body)])
    if p == "graphql" or p.endswith("/graphql"):
        if unseen:
            return UNSEEN_BODY
        if re.search(r"\bupdateRepository\b", blob) and re.search(r"\bvisibility\b", blob):
            return VISIBILITY
        if re.search(r"\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b", blob):
            return MERGE
        if re.search(r"\b(createCommitOnBranch|updateRefs?|deleteRef)\b", blob) and mentions_protected(blob, cwd):
            return MAIN_WRITE
        if re.search(r"\b(updateBranchProtectionRule|deleteBranchProtectionRule)\b", blob):
            return MAIN_WRITE
        return None
    if (method or ("POST" if fields else "GET")) == "GET":
        return None
    if re.search(r"(?:^|/)repos/[^/]+/[^/]+$", p) and repo_visibility(fields):
        return VISIBILITY
    if re.search(r"/pulls/\d+/merge$", p) or p.endswith("/merges"):
        return MERGE
    if re.search(r"/dispatches$|/actions/runs/\d+/rerun(-failed-jobs)?$|/actions/jobs/\d+/rerun$", p):
        return DEPLOY
    if re.search(r"/rulesets", p):
        return MAIN_WRITE
    ref = re.search(r"/git/refs/heads/(.+)$|/branches/([^/]+)(?:/|$)", p)
    if ref and is_protected(ref.group(1) or ref.group(2), cwd):
        return MAIN_WRITE
    if "/contents/" in p:
        branch = contents_branch(fields)
        if branch is None or branch == "@" or is_protected(branch, cwd):
            return MAIN_WRITE
    return None


def gh_words(args):
    """Слова команды gh так, как подкоманду ищет cobra (stripFlags): `--x` и `-x` без `=` берут следующий аргумент
    значением — и неизвестный флаг тоже (`gh pr --subject x merge 1` — это pr merge, `gh -X PUT api …` — api), кроме
    GH_BOOL; `--` — конец. [(индекс, слово)]."""
    out, i = [], 0
    while i < len(args) and args[i] != "--":
        x = args[i]
        if x.startswith("-") and "=" not in x and (x.startswith("--") or len(x) == 2) and x not in GH_BOOL:
            i += 2
            continue
        out += [] if x.startswith("-") else [(i, x)]
        i += 1
    return out


def yaml_str(v):
    """Строка YAML в одну строку: '…' ('' — кавычка), "…" без `\\`, простая (` #…` — комментарий); None — иное: блок,
    якорь, тег, поток, экранирование, `: ` внутри."""
    v = v.strip(" ")
    m = re.fullmatch(r"'((?:[^']|'')*)'( +#.*)?|\"([^\"\\\\]*)\"( +#.*)?", v)
    if m:
        return m.group(1).replace("''", "'") if m.group(1) is not None else m.group(3)
    v = re.sub(r" +#.*", "", v)
    return None if not v or v[0] in "'\"#&*!|>{}[],%@`?:-" or ": " in v or v.endswith(":") else v


def gh_aliases(text):
    """Псевдонимы config.yml в том простом виде, в каком их пишет gh: один верхний `aliases:`, под ним строки
    `имя: значение` с одним отступом, верхние ключи — простые, значения в одну строку. None — файл не в этом виде:
    как его прочтёт YAML в gh, не видно (блок, многострочное значение, якорь, дубль, поток, табуляция)."""
    if re.search(r"[\x00-\x09\x0b\x0c\x0e-\x1f\x7f\x85\u2028\u2029\ufeff]", text):
        return None
    out, tops, block, ind = {}, set(), False, None
    for line in re.split(r"\r\n|\r|\n", text):
        body = line.lstrip(" ")
        if not body or body.startswith("#"):
            continue
        if line[0] != " ":
            m = re.fullmatch(rf"({GH_KEY}) *:(?: +(.*))?", line)
            v = m and (m.group(2) or "").strip(" ")
            if not m or m.group(1) in tops or v and not v.startswith("#") and (m.group(1) == "aliases" or yaml_str(v) is None):
                return None
            tops.add(m.group(1))
            block = m.group(1) == "aliases"
            continue
        if block:
            ind = ind or len(line) - len(body)
            m = re.fullmatch(rf" {{{ind}}}({GH_KEY}|'[^']*'|\"[^\"\\\\]*\") *: +(.*)", line)
            key = m and (m.group(1)[1:-1] if m.group(1)[0] in "'\"" else m.group(1))
            if not m or key in out or yaml_str(m.group(2)) is None:
                return None
            out[key] = yaml_str(m.group(2))
    return out


def gh_alias(name, written=()):
    """Раскрытие псевдонима gh так, как его прочтёт gh: config.yml из GH_CONFIG_DIR, XDG_CONFIG_HOME/gh, ~/.config/gh.
    False — псевдонима нет: конфиг прочитан (или его нет вовсе), расширения с тем же именем нет. None — не узнать:
    конфиг не в простом виде (gh_aliases), не читается или его пишет либо переносит та же команда (written: config.yml
    по имени, GH_MOVED, GH_WRITTEN; ANY не в счёт — его даёт и сам вызов псевдонима, а ANY + имя приходит только вместе с
    именем), расширение с тем же именем (у gh оно главнее)."""
    data = os.environ.get("GH_DATA_DIR") or os.path.join(
        os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "gh")
    if {"config.yml", GH_MOVED, GH_WRITTEN} & set(written) or os.path.lexists(os.path.join(data, "extensions", "gh-" + name)):
        return None
    home = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    path = os.path.join(os.environ.get("GH_CONFIG_DIR") or os.path.join(home, "gh"), "config.yml")
    f = open_regular(path)
    if f is None:
        return None if os.path.lexists(path) else False
    with f:
        text = f.read(BODY_MAX + 1)
    aliases = None if len(text) > BODY_MAX else gh_aliases(text.decode("utf-8", errors="replace"))
    return None if aliases is None else aliases.get(name, False)


def alias_tokens(exp, args):
    """Аргументы gh после раскрытия псевдонима — как expandAlias в gh: `$N` подставляется, пока в раскрытии есть `$`,
    остальное дописывается в конец. None — shell-псевдоним (`!…`), лишний `$N` (gh откажет), `#` или `\\` (google/shlex
    в gh читает их не как shlex в Python: `#` в начале слова — комментарий, `\\` в "…" экранирует любой символ)."""
    if exp.startswith("!"):
        return None
    extra = []
    for n, x in enumerate(args, 1):
        if "$" in exp:
            exp = exp.replace(f"${n}", x)
        else:
            extra.append(x)
    if re.search(r"\$\d|#|\\", exp):
        return None
    try:
        return shlex.split(exp) + extra
    except ValueError:
        return None


def alias_risky(rest):
    """`gh alias set имя раскрытие` (rest — после set): псевдонимом можно дойти до мёржа, деплоя или api — раскрытие
    shell (`!…`, `--shell`), из stdin, только флаги, `#` или `\\`, `$N` на месте подкоманды, не встроенная группа
    (другой псевдоним, расширение), api или префикс pr merge / workflow run / run rerun: хвост допишут при вызове
    (`gh p merge 1`)."""
    pos = [x for x in rest if x not in ("--clobber", "-s", "--shell", "-h", "--help", "--")]
    try:
        words = [w for _, w in gh_words(shlex.split(" ".join(pos[1:])))]  # `-` (stdin) — пустой список слов
    except ValueError:
        return True
    if {"-s", "--shell"} & set(rest) or re.search(r"#|\\", " ".join(pos[1:])) or not words:
        return True  # `#` и `\` google/shlex в gh читает иначе (alias_tokens)
    if "$" in " ".join(words[:2]) or words[0] not in GH_BUILTIN:
        return True  # `!…` — тоже не встроенная группа
    if words[0] == "api":
        return True
    return words[0] in ("pr", "workflow", "run") and (len(words) < 2 or words[:2] in GH_PROTECTED)


def classify_gh(a, cwd=".", written=(), depth=0, guess=False):
    """Защищённое действие gh. guess — имя команды не видно (`$X co 1`): слово, которого точно нет среди псевдонимов
    (gh_alias — False), — не gh, пропуск; псевдоним не узнать (None: конфиг не в простом виде, расширение) — отказ и
    здесь. Догадка учитывает из written только запись по пути конфига gh (GH_WRITTEN): `printf x > config.yml;
    $TOOL build` и `source common.sh; "$PY" x.py` в скриптах — обычное дело (так отказывал `pnpm dev`), а скрытое имя
    gh, конфиг в другой папке, подготовленный заранее, и псевдоним с именем аргумента разом — уже не забывчивость.
    Скобки shell (`gh pr {merge,} 1`) раскрыты до вызова."""
    args = a[1:]
    found = gh_words(args)
    words = [w for _, w in found]
    if words and words[0] not in GH_BUILTIN:  # `gh co 1` — псевдоним из config.yml: решаем по его раскрытию, как gh
        k = found[0][0]
        exp = gh_alias(words[0], set(written) & {GH_WRITTEN} if guess else written)
        if exp is None or exp is False:
            return None if guess and exp is False else GH_UNKNOWN
        tokens = None if depth > 2 else alias_tokens(exp, args[:k] + args[k + 1:])  # cobra отдаёт и то, что до имени
        return GH_UNKNOWN if tokens is None else classify_gh(["gh"] + tokens, cwd, written, depth + 1)
    if words[:2] == ["repo", "edit"] and any(re.match(r"--(visibility|accept-visibility-change-consequences)(=|$)", x)
                                             for x in args):
        return VISIBILITY
    if words[:2] == ["pr", "merge"]:
        return MERGE
    if words[:1] in (["pr"], ["workflow"], ["run"], ["alias"]) and re.search(rf"\$|{SUBST}", words[1] if words[1:] else ""):
        return GH_UNKNOWN  # `gh pr $X 1`: слово действия не видно — в группе, где есть merge, run, rerun, import
    if words[:2] in (["workflow", "run"], ["run", "rerun"]):
        return DEPLOY
    if words[:1] == ["api"]:  # флаги api — все аргументы, кроме самого слова, и те, что стоят до него
        k = found[0][0]
        return classify_gh_api(["gh", "api"] + args[:k] + args[k + 1:], cwd, written)
    if words[:2] == ["alias", "import"] or words[:2] == ["alias", "set"] and alias_risky(args[found[1][0] + 1:]):
        return MERGE  # псевдоним — обход по имени; `alias import` берёт их из файла или stdin
    return None


def classify_interp(a, cwd="."):
    """Защищённая команда, запущенная из python/node/… списком аргументов или строкой."""
    blob = " ".join(a[1:])
    q = r"[\"',\s\]\[]+"
    if re.search(rf"\bgh{q}repo{q}edit\b", blob) and "visibility" in blob:
        return VISIBILITY
    if re.search(rf"\bgh{q}pr{q}merge\b|mergePullRequest|/pulls/\d+/merge\b", blob):
        return MERGE
    if re.search(rf"\bgh{q}(workflow{q}run|run{q}rerun)\b|/dispatches\b", blob):
        return DEPLOY
    if re.search(rf"\bgit{q}push\b", blob) and (re.search(r"(?<![\w-])--(all|mirror)\b", blob) or
                                                 mentions_protected(blob, cwd)):
        return MAIN_WRITE
    return None


def classify_http(a, cwd="."):
    blob = " ".join(a)
    if "api.github.com" not in blob:
        return None
    if re.search(API_REPO, blob) and re.search(VIS_JSON_KEY, blob):
        return VISIBILITY
    if re.search(r"\bupdateRepository\b", blob) and re.search(r"\bvisibility\b", blob):
        return VISIBILITY
    if re.search(r"/pulls/\d+/merge\b|/merges\b|mergePullRequest", blob):
        return MERGE
    if re.search(r"/dispatches\b|/rerun", blob):
        return DEPLOY
    if "/contents/" in blob:
        return MAIN_WRITE
    refs = re.findall(r"/git/refs/heads/([\w./-]+)|/branches/([^/\s\"']+)/protection", blob)
    if any(is_protected(head or branch, cwd) for head, branch in refs):
        return MAIN_WRITE
    return None


def hooks_off(a):
    """Дочерний `claude` без хуков проекта: disableAllHooks или --setting-sources без project."""
    blob = " ".join(a)
    if "disableAllHooks" in blob:
        return True
    m = re.search(r"--setting-sources[= ](\S+)", blob)
    return bool(m and "project" not in m.group(1))
