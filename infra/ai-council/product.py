#!/usr/bin/env python3
"""Продукт консилиума (Ф2 OPS-23): поля `council` из `instances/<slug>.json`. Только stdlib.

До Ф2 стек проекта в промпте ревью, карта «модуль → код», корни поиска по умолчанию и путь схемы Prisma были зашиты
под HR Helper (`review_prompts.py`, `retrieval.py`, `config.py`, `graph_build.py`). Теперь это поля продукта:

    "council": {"stack": "…", "modules": {"<метка карточки>": ["<путь от корня>", …]},
                "default_roots": ["…"], "prisma_schema": "…"}

Ключи `modules` — словарь модулей карточки (метки t-boards ∩ ключи → cards.modules). Поля нет — шаг, которому оно
нужно, пропускается (стек не называется, поиск идёт от корня, слоя Prisma в графе нет).

Продукт определяется по порядку:
1. env `COUNCIL_PRODUCT` (slug);
2. `repo_root` продукта = корень хоста (`TAIBE_HOST_ROOT` или папка слоя);
3. корень хоста лежит внутри `repo_root` (worktree `worktrees/<track>/<topic>` основной папки);
4. имя папки хоста = имя папки `repo_root` ровно у одного продукта (checkout в CI).
Иначе продукта нет, поля пустые. Файлы `instances/` проверяет `eval/nerve/products.py` (тот же разбор, что у нерва).
"""
from __future__ import annotations

import functools
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


def _real(path) -> Path:
    try:
        return Path(str(path)).expanduser().resolve()
    except (OSError, RuntimeError):
        return Path(str(path))


def _rel_path(slug: str, where: str, value) -> str:
    """Путь от корня продукта: строка без «/» в начале и без «..» — поле не уводит поиск из репозитория."""
    if not isinstance(value, str) or not value.strip():
        raise ProductError(f"instances/{slug}.json: council.{where} — нужна непустая строка")
    value = value.strip()
    if value.startswith(("/", "~")) or ".." in Path(value).parts:
        raise ProductError(f"instances/{slug}.json: council.{where} = «{value}» — нужен путь от корня продукта")
    return value


def council_of(slug: str, how: str, data: dict) -> Council:
    """Council из файла продукта. Неверный тип или путь — ProductError с файлом и полем."""
    raw = data.get("council") or {}
    if not isinstance(raw, dict):
        raise ProductError(f"instances/{slug}.json: council — нужен объект")
    stack = raw.get("stack", "")
    if not isinstance(stack, str):
        raise ProductError(f"instances/{slug}.json: council.stack — нужна строка")
    modules_raw = raw.get("modules") or {}
    if not isinstance(modules_raw, dict):
        raise ProductError(f"instances/{slug}.json: council.modules — нужен объект «модуль → [пути]»")
    modules: dict[str, tuple[str, ...]] = {}
    for name, paths in modules_raw.items():
        if not isinstance(paths, list):
            raise ProductError(f"instances/{slug}.json: council.modules.{name} — нужен список путей")
        modules[name.strip().lower()] = tuple(_rel_path(slug, f"modules.{name}", p) for p in paths)
    roots = raw.get("default_roots") or []
    if not isinstance(roots, list):
        raise ProductError(f"instances/{slug}.json: council.default_roots — нужен список путей")
    prisma = raw.get("prisma_schema", "")
    return Council(slug=slug, how=how, stack=stack.strip(), modules=modules,
                   default_roots=tuple(_rel_path(slug, "default_roots", r) for r in roots),
                   prisma_schema=_rel_path(slug, "prisma_schema", prisma) if prisma else "")


def resolve(host: Path, env=None, instances: str | None = None) -> tuple[str, str, dict]:
    """→ (slug, how, данные продукта); продукта нет — ("", "", {})."""
    env = os.environ if env is None else env
    try:
        _, products = nerve_products.load(instances or nerve_products.INSTANCES)
    except nerve_products.ProductError as exc:
        raise ProductError(str(exc)) from None
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


def load(host: Path, env=None, instances: str | None = None) -> Council:
    return council_of(*resolve(host, env, instances))


@functools.lru_cache(maxsize=1)
def current() -> Council:
    """Продукт процесса: хост — тот же, что у council.db (`host_root`). Считается один раз."""
    return load(host_root())


def product_root(slug: str, instances: str | None = None) -> Path:
    """`repo_root` продукта — для `doctor --product`, который сверяет пути с кодом этого продукта."""
    _, products = nerve_products.load(instances or nerve_products.INSTANCES)
    if slug not in products:
        raise ProductError(f"нет файла instances/{slug}.json")
    return _real(products[slug].get("repo_root", ""))
