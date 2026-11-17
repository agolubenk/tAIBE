"""`gh` подпроцессом — только белый список (R-1 п. 3): `pr view|checks|list`, `run list|view`, `api` только GET.

`gh api -f k=v` без `-X` сам переходит на POST, а `gh api graphql` всегда POST. Поэтому у `api` — белый список флагов,
а не список запретов: `-X`/`--method`, `-f`/`-F`/`--field`/`--raw-field`, `--input`, слитые формы (`-XPOST`,
`--method=PATCH`) и любой незнакомый флаг — NotAllowed. Заголовок — только `Accept`. Тайм-аут — 2 с (R-7)."""
import json
import os
import subprocess

from . import NotAllowed, SourceDown

TIMEOUT = 2.0
READ = {("pr", "view"), ("pr", "checks"), ("pr", "list"), ("run", "list"), ("run", "view")}
NEVER = {"--web", "-w", "--watch"}   # браузер или ожидание — это не чтение за 2 с
API_FLAGS = {"--paginate": False, "--slurp": False, "-i": False, "--include": False, "-q": True, "--jq": True,
             "-t": True, "--template": True, "--cache": True, "-H": True, "--header": True}   # флаг → есть значение
FORMAT_FLAGS = {"-q", "--jq", "-t", "--template"}


def _check_api(rest):
    endpoint, i = None, 0
    while i < len(rest):
        a = rest[i]
        if a.startswith("-"):
            name, eq, value = a.partition("=")
            if name not in API_FLAGS:
                raise NotAllowed(f"gh api {name}: флага нет в белом списке (R-1)")
            if API_FLAGS[name] and not eq:
                i += 1
                if i >= len(rest):
                    raise NotAllowed(f"gh api {name}: нет значения")
                value = rest[i]
            if name in ("-H", "--header") and value.split(":", 1)[0].strip().lower() != "accept":
                raise NotAllowed("gh api: заголовок — только Accept")
        elif endpoint is None:
            endpoint = a
        else:
            raise NotAllowed("gh api: второй адрес")
        i += 1
    if not endpoint:
        raise NotAllowed("gh api: нет адреса")
    path = endpoint.lstrip("/").split("?", 1)[0]
    if path == "graphql" or "://" in endpoint:
        raise NotAllowed("gh api: graphql и полный URL не принимаются (graphql — всегда POST)")


def check(args):
    """None — вызов на чтение из белого списка; иначе NotAllowed с причиной."""
    if not args or not all(isinstance(a, str) for a in args):
        raise NotAllowed("gh: нужен список строк")
    if "--" in args:
        raise NotAllowed("gh: «--» не принимается")
    if tuple(args[:2]) in READ:
        bad = [a for a in args[2:] if a.partition("=")[0] in NEVER]
        if bad:
            raise NotAllowed(f"gh {args[0]} {args[1]} {bad[0]}: не чтение")
        return
    if args[0] == "api":
        _check_api(args[1:])
        return
    raise NotAllowed(f"gh {' '.join(args[:2])}: вне белого списка (R-1)")


def wants_json(args):
    if args[0] == "api":
        return not any(a.partition("=")[0] in FORMAT_FLAGS for a in args[1:])
    return any(a.partition("=")[0] == "--json" for a in args)


def run(args, *, timeout=TIMEOUT, runner=subprocess.run):
    """Вывод `gh <args>`: JSON — разобранный (`--json`, `api` без `--jq`/`--template`), иначе текст.
    Белый список проверяется до запуска. Отказ gh — SourceDown("gh", причина)."""
    check(args)
    env = dict(os.environ, GH_PROMPT_DISABLED="1", NO_COLOR="1")
    try:
        p = runner(["gh", *args], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, env=env)
    except subprocess.TimeoutExpired:
        raise SourceDown("gh", f"тайм-аут {timeout:g} с") from None
    except FileNotFoundError:
        raise SourceDown("gh", "нет команды gh") from None
    if p.returncode != 0:
        first = next((s.strip() for s in (p.stderr or "").splitlines() if s.strip()), "")
        raise SourceDown("gh", first[:120] or f"код {p.returncode}")
    if not wants_json(args):
        return p.stdout
    try:
        return json.loads(p.stdout or "null")
    except ValueError:
        raise SourceDown("gh", "ответ не JSON") from None
