#!/usr/bin/env python3
"""AI Council — дерево хоста для самопроверок (OPS-48). Только stdlib, сети и Ollama нет.

Проверке, которой нужны существующие и несуществующие файлы хоста (постановка, сверка M2, маски M7), дерево даёт
фикстура, а не каталог `TAIBE_HOST_ROOT`. Иначе итог зависит от checkout: HR_Helper-v2, дом слоя tAIBE, worktree.
Код хоста читают verifier, council_rounds и council_clean — каждый держит свою копию REPO_ROOT, поэтому подмена
идёт во всех трёх. Остальной корень (council.db, логи, ключи — config, store) не меняется.
"""
from __future__ import annotations

import contextlib
import importlib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

READERS = ("verifier", "council_rounds", "council_clean")


@contextlib.contextmanager
def host_tree(tmp: Path, files: dict[str, str], name: str = "host-tree"):
    """Дерево `tmp/name` с файлами `files` ({путь от корня: текст}) — корень кода хоста на время блока."""
    root = tmp / name
    root.mkdir(parents=True, exist_ok=True)
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    modules = [importlib.import_module(m) for m in READERS]
    saved = [m.REPO_ROOT for m in modules]
    clean = modules[READERS.index("council_clean")]
    for m in modules:
        m.REPO_ROOT = root
    clean._package.cache_clear()  # имена пакетов прочитаны из прежнего корня
    try:
        yield root
    finally:
        for m, old in zip(modules, saved):
            m.REPO_ROOT = old
        clean._package.cache_clear()
