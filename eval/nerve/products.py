#!/usr/bin/env python3
"""products.py — продукты инстанса (OPS-25 Ф1, план docs/plans/roadmap/nerve-per-product.md).

  python3 -I eval/nerve/products.py list              продукты: slug, active, папка, репо, * — по умолчанию
  python3 -I eval/nerve/products.py render [--check]  собрать eval/nerve/config.json; --check — только сравнить
  python3 -I eval/nerve/products.py get <slug|default> <поле.через.точку>   значение поля (для sh-скриптов)

Файлы — `instances/` в корне tAIBE: `_shared.json` (Mac и установка: бюджет, режимы, опрос очереди, доски установки,
`default_product`) и `<slug>.json` (поля продукта: папка, репо, роли, раскладка путей, транскрипты, маршрут очереди).
`config.json` — `_shared` ⊕ продукт по умолчанию, байт-в-байт как прежний ручной файл: его по-прежнему читают
Нерв, сборщик геномов и настройки пайплайна. Порядок ключей задаёт шаблон здесь, а не файлы-источники.
Лист, который есть в обоих файлах, поле не в своём файле, похожая на ключ строка, чужая роль — ошибка, а не
переопределение. Только stdlib.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
INSTANCES = os.path.join(ROOT, "instances")
CONFIG = os.path.join(HERE, "config.json")
ROLES_TABLE = os.path.join(ROOT, "eval", "pipeline", "genome", "roles.json")
SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,30}[a-z0-9]$")

# Порядок ключей config.json (R-1 спеки M1). Вложенные объекты вне этого списка идут целиком из одного файла.
TOP = ("repo_root", "product_tree", "layer_home", "interval_seconds", "sources", "team", "github", "queue", "system",
       "budget", "circadian", "tap", "boards")
NESTED = {
    "team": ("projects_root", "project_dir", "roles", "active_hours"),
    "github": ("repo", "min_lenses", "quorum_to", "path_roles", "lens_roles"),
    "queue": ("url", "secret_cmd", "owner_items", "delta", "source_roles"),
    "boards": ("url", "product", "workspace", "note"),
}
# Где живёт поле: путь или его префикс. Поля продукта, которых нет в config.json (slug, title, active, queue.match,
# council), render не выводит. `council` читает консилиум (infra/ai-council/product.py, Ф2 OPS-23).
PRODUCT = ("slug", "title", "active", "repo_root", "product_tree", "team.project_dir", "team.roles", "team.active_hours",
           "github", "queue.source_roles", "queue.match", "council")
SHARED = ("default_product", "layer_home", "interval_seconds", "sources", "team.projects_root", "queue.url",
          "queue.secret_cmd", "queue.owner_items", "queue.delta", "system", "budget", "circadian", "tap", "boards")
REQUIRED = ("slug", "repo_root", "product_tree", "team.project_dir", "team.roles", "team.active_hours", "github.repo",
            "github.path_roles", "github.lens_roles", "queue.source_roles")
# R-2 спеки M1: значение, похожее на ключ, в публичном git не живёт — только secret_cmd.
# Длинный base64 — без «/» в начале: абсолютный путь из одних букв и «/» тоже длинный.
SECRET_RE = re.compile(r"^(sk-|ghp_|github_pat_|xox[a-z]-|AKIA)|-----BEGIN|^eyJ[\w-]+\.[\w-]+\.[\w-]+$|^[A-Za-z0-9+][A-Za-z0-9+/]{39,}={0,2}$")
# Относительный путь из строчных сегментов (`apps/backend/src/modules/integrations/telegram`, поле council) — не ключ:
# base64 ключа из 40+ знаков без единой заглавной буквы почти невероятен, а префиксы ключей (ghp_, AKIA, eyJ, xox*-)
# сюда не попадают — в них заглавные буквы или нет «/».
REL_PATH_RE = re.compile(r"^[a-z0-9._-]+(?:/[a-z0-9._-]+)+$")


class ProductError(ValueError):
    pass


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except OSError as e:
        raise ProductError(f"{os.path.relpath(path, ROOT)}: не читается ({e.strerror})") from None
    except ValueError as e:
        raise ProductError(f"{os.path.relpath(path, ROOT)}: не JSON ({e})") from None
    if not isinstance(data, dict):
        raise ProductError(f"{os.path.relpath(path, ROOT)}: ожидался объект")
    return data


def leaves(d, prefix=""):
    """Пути листьев: вложенные объекты раскрываются, списки и скаляры — листья."""
    for k, v in d.items():
        p = f"{prefix}{k}"
        if isinstance(v, dict) and v:
            yield from leaves(v, p + ".")
        else:
            yield p, v


def _under(path, allowed):
    return any(path == a or path.startswith(a + ".") for a in allowed)


def _check_file(name, data, own, other, other_name):
    for path, value in leaves(data):
        if not _under(path, own):
            where = other_name if _under(path, other) else "ни в одном файле (поле не известно render)"
            raise ProductError(f"instances/{name}: поле {path} — место ему: {where}")
        for s in value if isinstance(value, list) else [value]:
            for x in s if isinstance(s, list) else [s]:
                if isinstance(x, str) and SECRET_RE.search(x) and not REL_PATH_RE.match(x):
                    raise ProductError(f"instances/{name}: {path} похоже на ключ — в git только secret_cmd")


def _get(d, path):
    for k in path.split("."):
        if not isinstance(d, dict) or k not in d:
            return None
        d = d[k]
    return d


def merge(shared, product):
    """`_shared` ⊕ продукт: рекурсивно по объектам; лист в обоих — ошибка."""
    out = json.loads(json.dumps(shared))
    for k, v in product.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            for kk in v:
                if kk in out[k]:
                    raise ProductError(f"поле {k}.{kk} есть и в _shared, и в продукте")
            out[k] = {**out[k], **v}
        elif k in out:
            raise ProductError(f"поле {k} есть и в _shared, и в продукте")
        else:
            out[k] = v
    return out


def _roles_known():
    try:
        return set(_read(ROLES_TABLE)["roles"])
    except (ProductError, KeyError):
        return None


def _check_roles(slug, cfg):
    roles = cfg["team"]["roles"]
    known = _roles_known()
    if known is not None and not set(roles) <= known:
        raise ProductError(f"{slug}: роли {sorted(set(roles) - known)} нет в eval/pipeline/genome/roles.json")
    for field in ("github.path_roles", "github.lens_roles", "queue.source_roles"):
        for pair in _get(cfg, field) or []:
            if pair[1] not in roles:
                raise ProductError(f"{slug}: {field} ведёт на роль «{pair[1]}», её нет у продукта")
    for role in cfg["github"].get("quorum_to") or []:
        if role not in roles:
            raise ProductError(f"{slug}: github.quorum_to — роль «{role}», её нет у продукта")


def load(instances=INSTANCES):
    """→ (shared, {slug: product}). Проверяет каждый файл; ошибка — ProductError с файлом и полем."""
    shared = _read(os.path.join(instances, "_shared.json"))
    _check_file("_shared.json", shared, SHARED, PRODUCT, "файл продукта instances/<slug>.json")
    products = {}
    for name in sorted(os.listdir(instances)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        slug = name[:-5]
        data = _read(os.path.join(instances, name))
        _check_file(name, data, PRODUCT, SHARED, "instances/_shared.json")
        if data.get("slug") != slug or not SLUG_RE.match(slug):
            raise ProductError(f"instances/{name}: slug «{data.get('slug')}» — нужен «{slug}» формата {SLUG_RE.pattern}")
        for path in REQUIRED:
            if _get(data, path) is None:
                raise ProductError(f"instances/{name}: нет обязательного поля {path}")
        products[slug] = data
    default = shared.get("default_product")
    if not isinstance(default, str) or default not in products:
        raise ProductError(f"instances/_shared.json: default_product «{default}» — нет файла instances/{default}.json")
    for slug, data in products.items():
        _check_roles(slug, merge(shared, data))
    return shared, products


def config_for(slug, shared=None, products=None):
    """Полный конфиг продукта (как config.json, плюс slug, title, active, queue.match)."""
    if shared is None:
        shared, products = load()
    if slug not in products:
        raise ProductError(f"нет продукта «{slug}»: {', '.join(sorted(products))}")
    cfg = merge(shared, products[slug])
    cfg.setdefault("active", True)
    return cfg


def _ordered(cfg):
    out = {}
    for k in TOP:
        if k not in cfg:
            raise ProductError(f"render: нет поля {k}")
        v = cfg[k]
        if k in NESTED:
            extra = set(v) - set(NESTED[k])
            if extra:
                raise ProductError(f"render: {k}.{sorted(extra)[0]} не знает шаблон config.json")
            v = {kk: v[kk] for kk in NESTED[k] if kk in v}
        out[k] = v
    return out


def render_text(shared=None, products=None):
    if shared is None:
        shared, products = load()
    cfg = config_for(shared["default_product"], shared, products)
    return json.dumps(_ordered(cfg), ensure_ascii=False, indent=2) + "\n"


def product_dir(slug, state_dir, default):
    """Папка журнала и курсоров продукта: продукт по умолчанию — сама папка состояния Нерва (без переноса), другие —
    `products/<slug>/` в ней (план OPS-25, «Модель»)."""
    if not SLUG_RE.match(slug or ""):
        raise ProductError(f"slug «{slug}» не подходит под {SLUG_RE.pattern}")
    return state_dir if slug == default else os.path.join(state_dir, "products", slug)


def write_atomic(path, text):
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def main(argv=None):
    p = argparse.ArgumentParser(prog="products")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    r = sub.add_parser("render")
    r.add_argument("--check", action="store_true")
    g = sub.add_parser("get")
    g.add_argument("slug")
    g.add_argument("field")
    a = p.parse_args(argv)
    try:
        shared, products = load()
        if a.cmd == "get":
            slug = shared["default_product"] if a.slug == "default" else a.slug
            cfg = config_for(slug, shared, products)   # нет продукта — ошибка, а не эхо slug
            value = slug if a.field == "slug" else _get(cfg, a.field)
            if value is None:
                raise ProductError(f"{slug}: нет поля {a.field}")
            print(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
            return 0
        if a.cmd == "list":
            for slug, d in products.items():
                mark = "*" if slug == shared["default_product"] else " "
                print(f"{mark} {slug:12} active={str(d.get('active', True)).lower():5} {d['repo_root']}  {d['github']['repo']}")
            return 0
        text = render_text(shared, products)
    except ProductError as e:
        print(f"products: {e}", file=sys.stderr)
        return 1
    try:
        with open(CONFIG, encoding="utf-8") as f:
            current = f.read()
    except OSError:
        current = None
    if a.check:
        if current == text:
            print("config.json совпадает с instances/")
            return 0
        print("config.json не совпадает с instances/: правьте instances/ и запустите products.py render", file=sys.stderr)
        return 1
    if current != text:
        write_atomic(CONFIG, text)
        print("config.json собран из instances/")
    else:
        print("config.json уже совпадает")
    return 0


if __name__ == "__main__":
    sys.exit(main())
