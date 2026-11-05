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
import subprocess
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
    if root == LAYER_ROOT:
        # Хаб без хоста подставляет сюда свою же папку: это режим по умолчанию, не внешний хост.
        return LAYER_ROOT
    if require and not (root / require).is_file():
        raise HostRootError(
            f"{ENV}={raw!r}: нет {require} — каталог не тот или данные хоста не созданы "
            f"(новый хост: создать пустой файл {require})")
    return root


def layer_version(root: Path = LAYER_ROOT) -> str:
    """Какой код слоя запущен: коммит и флаг грязного дерева. Устаревшая или правленая копия кода
    видна в статусе сразу, а не по странному поведению. Грязное — правки отслеживаемых файлов, как
    у `git describe --dirty`: неотслеживаемые не считаются. Индекс не пишется (`--no-optional-locks`)."""
    def git(*args: str) -> subprocess.CompletedProcess | None:
        try:
            return subprocess.run(["git", "--no-optional-locks", "-C", str(root), *args],
                                  capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return None
    head = git("rev-parse", "--short=12", "HEAD")
    if head is None or head.returncode != 0 or not head.stdout.strip():
        return "коммит неизвестен (нет git или не репозиторий)"
    diff = git("diff", "--quiet", "HEAD", "--")
    flag = {0: "чистое дерево", 1: "ГРЯЗНОЕ дерево"}.get(diff.returncode if diff else -1, "дерево не проверено")
    return f"{head.stdout.strip()} · {flag}"
