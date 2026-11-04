"""Корень host-проекта для ИИ-контура слоя (консилиум, DAMS RAG, GLM-клиент).

Код слоя — промпты, схемы, config.toml, скрипты — читается от своего пути (`LAYER_ROOT`). Данные —
council.db и логи консилиума, индекс DAMS, ключи, docs/plans/done, код продукта для поиска — лежат
в корне продукта-хоста. Хост задаётся env `TAIBE_HOST_ROOT` (абсолютный путь); без него хост — сам
слой, и поведение репозитория без хоста не меняется.

Неверный хост — громкая ошибка на старте процесса, а не тихая пустая база: консилиум, поднятый на
чужом или несуществующем каталоге, создал бы новую council.db рядом и молча работал бы без корпуса.
"""
from __future__ import annotations

import os
from pathlib import Path

ENV = "TAIBE_HOST_ROOT"
LAYER_ROOT = Path(__file__).resolve().parents[2]


class HostRootError(RuntimeError):
    """`TAIBE_HOST_ROOT` задан, но каталог хоста не годится."""


def host_root(require: str = "") -> Path:
    """Корень хоста: env `TAIBE_HOST_ROOT` или `LAYER_ROOT`, если env пуст.

    `require` — путь файла от корня хоста, без которого процесс работать не должен (council.db,
    индекс DAMS). Проверяется только при заданном env: у слоя без хоста данные создаются на месте.
    """
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return LAYER_ROOT
    root = Path(raw).expanduser()
    if not root.is_absolute():
        raise HostRootError(f"{ENV}={raw!r}: нужен абсолютный путь (относительный зависит от cwd процесса)")
    root = root.resolve()
    if not root.is_dir():
        raise HostRootError(f"{ENV}={raw!r}: каталога нет")
    if require and not (root / require).is_file():
        raise HostRootError(
            f"{ENV}={raw!r}: нет {require} — каталог не тот или данные хоста не созданы "
            f"(новый хост: создать пустой файл {require})")
    return root
