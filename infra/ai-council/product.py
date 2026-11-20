#!/usr/bin/env python3
"""Продукт консилиума (Ф2 OPS-23): поля `council` продукта. Только stdlib.

До Ф2 стек проекта в промпте ревью, карта «модуль → код», корни поиска по умолчанию и путь схемы Prisma были зашиты
под HR Helper (`review_prompts.py`, `retrieval.py`, `config.py`, `graph_build.py`). Теперь это поля продукта:

    {"stack": "…", "modules": {"<метка карточки>": ["<путь от корня>", …]},
     "default_roots": ["…"], "prisma_schema": "…"}

Поля лежат в одном из двух мест:
- в `instances/<slug>.json` → `council` (продукт с публичным кодом, например tAIBE);
- в файле репозитория продукта: `instances/<slug>.json` → `"council": {"file": "<путь от корня продукта>"}`. Так
  карта кода закрытого продукта не попадает в публичный репозиторий слоя (решение владельца
  `d-taibe-ops23-m1-publish-1411` = B). Файл читается от хоста, если хост — checkout продукта (или его worktree),
  иначе от `repo_root` продукта. Файла нет — поля пустые, `doctor` это показывает.
Смешивать нельзя: `file` рядом с другими полями — ошибка. Неизвестное поле — ошибка (опечатка не теряется молча).

Ключи `modules` — словарь модулей карточки (метки t-boards ∩ ключи → cards.modules); регистр и пробелы по краям не
различаются, повтор ключа — ошибка. Поля нет — шаг, которому оно нужно, пропускается (стек не называется, поиск идёт
от корня, слоя Prisma в графе нет).

Продукт определяется по порядку:
1. env `COUNCIL_PRODUCT` (slug);
2. `repo_root` продукта = корень хоста (`TAIBE_HOST_ROOT` или папка слоя);
3. корень хоста лежит внутри `repo_root` (worktree `worktrees/<track>/<topic>` основной папки);
4. имя папки хоста = имя папки `repo_root` ровно у одного продукта (checkout в CI).
Иначе продукта нет, поля пустые. Файлы `instances/` проверяет `eval/nerve/products.py` (тот же разбор, что у нерва).

`current()` не останавливает консилиум на импорте: ошибка в файлах продукта — одна строка в stderr и пустые поля.
Причину показывает `supervisor.py doctor` — он читает поля заново и ошибку не глотает.
"""
from __future__ import annotations

import functools
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

LAYER_ROOT = Path(__file__).resolve().parents[2]
for _dir in (LAYER_ROOT / "eval" / "nerve", LAYER_ROOT / ".claude" / "scripts"):
    if str(_dir) not in sys.path:
        sys.path.append(str(_dir))

import products as nerve_products  # noqa: E402
from host_root import host_root  # noqa: E402

ENV = "COUNCIL_PRODUCT"
FIELDS = ("stack", "modules", "default_roots", "prisma_schema")
FILE = "file"
NO_FILE = " (нет файла)"


class ProductError(Exception):
    pass


@dataclass(frozen=True)
class Council:
    slug: str = ""
    how: str = ""                     # env | host | worktree | basename | "" (не определён)
    stack: str = ""
    modules: dict[str, tuple[str, ...]] = field(default_factory=dict)
    default_roots: tuple[str, ...] = ()
    prisma_schema: str = ""
    source: str = ""                  # instances/<slug>.json | <файл продукта> | <файл>NO_FILE | "" (полей нет)


def _real(path) -> Path:
    try:
        return Path(str(path)).expanduser().resolve()
    except (OSError, RuntimeError):
        return Path(str(path))


def _products(instances: str | None) -> dict:
    try:
        return nerve_products.load(instances or nerve_products.INSTANCES)[1]
    except nerve_products.ProductError as exc:
        raise ProductError(str(exc)) from None


def _rel_path(src: str, where: str, value) -> str:
    """Путь от корня продукта: строка без «/» в начале и без «..» — поле не уводит поиск из репозитория."""
    if not isinstance(value, str) or not value.strip():
        raise ProductError(f"{src}: {where} — нужна непустая строка")
    value = value.strip()
    if value.startswith(("/", "~")) or ".." in Path(value).parts:
        raise ProductError(f"{src}: {where} = «{value}» — нужен путь от корня продукта")
    return value


def _fields(src: str, prefix: str, raw: dict) -> dict:
    """Проверенные поля. `src` — файл для сообщения, `prefix` — «council.» в instances, пусто в файле продукта."""
    unknown = sorted(set(raw) - set(FIELDS))
    if unknown:
        raise ProductError(f"{src}: неизвестное поле {', '.join(prefix + k for k in unknown)} — "
                           f"есть {', '.join(FIELDS)}")
    stack = raw.get("stack", "")
    if not isinstance(stack, str):
        raise ProductError(f"{src}: {prefix}stack — нужна строка")
    modules_raw = raw.get("modules") or {}
    if not isinstance(modules_raw, dict):
        raise ProductError(f"{src}: {prefix}modules — нужен объект «модуль → [пути]»")
    modules: dict[str, tuple[str, ...]] = {}
    for name, paths in modules_raw.items():
        if not isinstance(paths, list):
            raise ProductError(f"{src}: {prefix}modules.{name} — нужен список путей")
        key = name.strip().lower()
        if key in modules:
            raise ProductError(f"{src}: {prefix}modules.{name} — модуль «{key}» уже есть "
                               "(регистр и пробелы по краям не различаются)")
        modules[key] = tuple(_rel_path(src, f"{prefix}modules.{name}", p) for p in paths)
    roots = raw.get("default_roots") or []
    if not isinstance(roots, list):
        raise ProductError(f"{src}: {prefix}default_roots — нужен список путей")
    prisma = raw.get("prisma_schema", "")
    return {"stack": stack.strip(), "modules": modules,
            "default_roots": tuple(_rel_path(src, f"{prefix}default_roots", r) for r in roots),
            "prisma_schema": _rel_path(src, f"{prefix}prisma_schema", prisma) if prisma else ""}


def council_of(slug: str, how: str, data: dict, root: Path | None = None) -> Council:
    """Council продукта. `root` — корень checkout'а продукта, от него читается `council.file`. Неверный тип, путь
    или JSON — ProductError с файлом и полем (без абсолютных путей)."""
    src = f"instances/{slug}.json"
    raw = data.get("council") or {}
    if not isinstance(raw, dict):
        raise ProductError(f"{src}: council — нужен объект")
    if not raw:
        return Council(slug=slug, how=how)
    if FILE not in raw:
        return Council(slug=slug, how=how, source=src, **_fields(src, "council.", raw))
    if len(raw) > 1:
        raise ProductError(f"{src}: council.file и council.{', council.'.join(sorted(set(raw) - {FILE}))} — "
                           "поля в одном месте: в файле продукта или в instances")
    rel = _rel_path(src, "council.file", raw[FILE])
    path = Path(root) / rel if root else None
    if path is None or not path.is_file():
        return Council(slug=slug, how=how, source=rel + NO_FILE)
    where = f"{rel} ({slug})"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ProductError(f"{where}: не читается — {exc.strerror}") from None
    except ValueError as exc:
        raise ProductError(f"{where}: не JSON — {exc}") from None
    if not isinstance(loaded, dict):
        raise ProductError(f"{where}: нужен объект с полями {', '.join(FIELDS)}")
    return Council(slug=slug, how=how, source=rel, **_fields(where, "", loaded))


def resolve(host: Path, env=None, instances: str | None = None) -> tuple[str, str, dict]:
    """→ (slug, how, данные продукта); продукта нет — ("", "", {})."""
    env = os.environ if env is None else env
    products = _products(instances)
    want = env.get(ENV, "").strip()
    if want:
        if want not in products:
            raise ProductError(f"{ENV}={want}: нет файла instances/{want}.json")
        return want, "env", products[want]
    host = _real(host)
    roots = {slug: _real(data.get("repo_root", "")) for slug, data in products.items()}
    for slug, root in roots.items():
        if root == host:
            return slug, "host", products[slug]
    inside = [(len(root.parts), slug) for slug, root in roots.items() if root in host.parents]
    if inside:
        slug = max(inside)[1]
        return slug, "worktree", products[slug]
    same = [slug for slug, root in roots.items() if root.name == host.name]
    if len(same) == 1:
        return same[0], "basename", products[same[0]]
    return "", "", {}


def code_root(host: Path, how: str, data: dict) -> Path | None:
    """Корень checkout'а продукта для `council.file`: хост, если он и есть checkout продукта (host, worktree,
    basename или env с хостом в `repo_root`), иначе `repo_root`; продукта нет — None."""
    if not how:
        return None
    host = _real(host)
    repo = _real(data["repo_root"]) if data.get("repo_root") else None
    if how != "env" or (repo is not None and (repo == host or repo in host.parents)):
        return host
    return repo


def load(host: Path, env=None, instances: str | None = None) -> Council:
    slug, how, data = resolve(host, env, instances)
    return council_of(slug, how, data, code_root(host, how, data))


@functools.lru_cache(maxsize=1)
def current() -> Council:
    """Продукт процесса: хост — тот же, что у council.db (`host_root`). Считается один раз. Ошибка в файлах продукта —
    одна строка в stderr и пустые поля, консилиум и MCP стартуют; причину показывает `supervisor.py doctor`."""
    try:
        return load(host_root())
    except ProductError as exc:
        print(f"ai-council: поля council не прочитаны — {exc}. Шаги с ними пропускаются; причина — "
              "supervisor.py doctor", file=sys.stderr)
        return Council()


def product_root(slug: str, instances: str | None = None) -> Path:
    """`repo_root` продукта — для `doctor --product`, который сверяет пути с кодом этого продукта."""
    products = _products(instances)
    if slug not in products:
        raise ProductError(f"нет файла instances/{slug}.json")
    return _real(products[slug].get("repo_root", ""))
