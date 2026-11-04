#!/usr/bin/env python3
"""AI Council — сборка графа проекта (graphify) одной командой. Только stdlib + graphify.

    python3 infra/ai-council/graph_build.py            # собрать graphify-out/graph.json
    python3 infra/ai-council/graph_build.py --status   # что уже собрано

Зачем отдельный модуль. `/graphify` — агентный скилл: он умеет и семантическое извлечение
(LLM читает документы, статьи, картинки), и разметку сообществ словами. Ни то, ни другое из
демона не запускается — там нужен агент. Но для КОДА извлечение полностью детерминированное:
AST, без единого вызова модели и без ключей (SKILL.md §3, Part A). Именно эта часть и нужна
консилиуму: граф даёт связность («что ещё сломается»), а не красивые названия кластеров.

Поэтому здесь собран code-only маршрут скилла, шаг в шаг:
    Part A  — AST-извлечение по списку файлов из .graphify_detect.json
    Part B  — пропускается (fast path для корпуса без документов), пишется пустой файл:
              Part C читает его безусловно и без него падает FileNotFoundError
    Part C  — слияние AST + семантики в .graphify_extract.json
    Step 4  — build → cluster → analyze → export в graph.json

Что НЕ делается и почему: семантические узлы из документов (нужен LLM) и человеческие имена
сообществ (Step 5, тоже LLM). Сообщества остаются под номерами. Если нужен полный граф с
названиями — это `/graphify` в Claude Code, кнопка в UI его не заменяет и не притворяется им.

Интерпретатор берётся из `graphify-out/.graphify_python` — тот же, которым скилл ставил
пакет. Системный python3 модуля `graphify` не видит, и это не ошибка окружения: скилл
намеренно держит свой venv.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from config import REPO_ROOT  # noqa: E402 — граф строится по коду хоста

OUT_DIR = REPO_ROOT / "graphify-out"
GRAPH_JSON = OUT_DIR / "graph.json"
DETECT = OUT_DIR / ".graphify_detect.json"
PYTHON_MARKER = OUT_DIR / ".graphify_python"
PRISMA_JSON = OUT_DIR / ".graphify_prisma.json"
PRISMA_SCHEMA = REPO_ROOT / "apps" / "backend" / "prisma" / "schema.prisma"

_PRISMA_BLOCK_RE = re.compile(r"^(model|enum)\s+(\w+)\s*\{")
_PRISMA_SCALARS = {"String", "Int", "Float", "Boolean", "DateTime", "Json",
                    "Bytes", "Decimal", "BigInt"}


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def interpreter() -> str:
    """Python, в котором установлен пакет graphify."""
    if PYTHON_MARKER.is_file():
        candidate = PYTHON_MARKER.read_text(encoding="utf-8").strip()
        if candidate and Path(candidate).exists():
            return candidate
    return sys.executable


def _run(code: str, label: str) -> tuple[bool, str]:
    """Шаг конвейера отдельным процессом — graphify живёт в своём интерпретаторе."""
    proc = subprocess.run([interpreter(), "-c", code], cwd=str(REPO_ROOT),
                          capture_output=True, text=True, timeout=1800)
    output = (proc.stdout or "").strip()
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        tail = detail[-1] if detail else "без сообщения"
        return False, f"{label}: {tail}"
    if output:
        log(f"  {output.splitlines()[-1]}")
    return True, output


def status() -> dict:
    info = {
        "graph_exists": GRAPH_JSON.is_file(),
        "detect_exists": DETECT.is_file(),
        "python": interpreter(),
        "nodes": 0, "edges": 0, "built_at": None,
    }
    if GRAPH_JSON.is_file():
        info["built_at"] = int(GRAPH_JSON.stat().st_mtime)
        try:
            data = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
            info["nodes"] = len(data.get("nodes") or [])
            info["edges"] = len(data.get("edges") or data.get("links") or [])
        except (OSError, ValueError):
            pass
    if DETECT.is_file():
        try:
            detect = json.loads(DETECT.read_text(encoding="utf-8"))
            files = detect.get("files", {}) or {}
            info["code_files"] = len(files.get("code") or [])
            info["other_files"] = sum(len(v or []) for k, v in files.items() if k != "code")
        except (OSError, ValueError):
            pass
    return info


def detect_files() -> tuple[bool, str]:
    """Список файлов корпуса. Пересобирается, если его нет: без него Part A не знает,
    что извлекать. Берём тот же обход, что и скилл, — collect_files по корню репозитория."""
    if DETECT.is_file():
        return True, "детекция уже есть"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    return _run(
        "import json\n"
        "from pathlib import Path\n"
        "from graphify.extract import collect_files\n"
        f"root = Path({str(REPO_ROOT)!r})\n"
        "files = [str(p) for p in collect_files(root)]\n"
        f"Path({str(DETECT)!r}).write_text(json.dumps("
        "{'files': {'code': files, 'document': [], 'paper': [], 'image': []}},"
        " ensure_ascii=False), encoding='utf-8')\n"
        "print(f'детекция: {len(files)} файлов кода')",
        "детекция файлов")


def _parse_prisma_models() -> dict:
    """Part A2 (план §3а) — модели/enum Prisma как узлы графа. Stdlib построчный парсер,
    не AST: `schema.prisma` — свой DSL, а не Python/TS, которые извлекает graphify.
    Ломается на экзотике синтаксиса (multi-line @@relation, комментарии внутри блока
    поля) — молча возвращает пустой результат, не исключение: упавший шаг не должен
    ронять сборку графа (см. build())."""
    if not PRISMA_SCHEMA.is_file():
        return {"nodes": [], "edges": [], "model_names": []}
    try:
        lines = PRISMA_SCHEMA.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {"nodes": [], "edges": [], "model_names": []}

    model_names: set[str] = set()
    enum_names: set[str] = set()
    for raw in lines:
        m = _PRISMA_BLOCK_RE.match(raw.strip())
        if m:
            (model_names if m.group(1) == "model" else enum_names).add(m.group(2))

    rel_path = str(PRISMA_SCHEMA.relative_to(REPO_ROOT))
    nodes = [{"id": f"prisma:{name}", "label": name, "kind": "prisma_model",
              "community": "backend", "source_file": rel_path}
             for name in sorted(model_names)]
    nodes += [{"id": f"prisma:{name}", "label": name, "kind": "prisma_enum",
               "community": "backend", "source_file": rel_path}
              for name in sorted(enum_names)]

    edges: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    current: str | None = None
    in_model = False
    for raw in lines:
        line = raw.strip()
        m = _PRISMA_BLOCK_RE.match(line)
        if m:
            current, in_model = m.group(2), m.group(1) == "model"
            continue
        if line == "}":
            current, in_model = None, False
            continue
        if not in_model or current is None or not line:
            continue
        if line.startswith("//") or line.startswith("@@"):
            continue                            # @@relation/@@index/@@map — не поле
        parts = line.split()
        if len(parts) < 2:
            continue
        field_type = parts[1].rstrip("?").rstrip("[]")
        relation = None
        if field_type in model_names and field_type != current:
            relation = "prisma_relation"
        elif field_type in enum_names:
            relation = "contains"
        if relation is None:
            continue
        triple = (f"prisma:{current}", f"prisma:{field_type}", relation)
        if triple not in seen:
            seen.add(triple)
            edges.append({"source": triple[0], "target": triple[1], "relation": relation})

    return {"nodes": nodes, "edges": edges, "model_names": sorted(model_names)}


def _file_container_ids(ast_nodes: list[dict]) -> dict[str, str]:
    """Путь файла (относительно REPO_ROOT) → id узла-контейнера файла в AST-графе — тот
    же критерий агрегации, что gateway.py::_graph_index использует на уровне файлов
    (label узла совпадает с basename его source_file)."""
    out: dict[str, str] = {}
    for node in ast_nodes:
        source = node.get("source_file") or ""
        label = node.get("label") or node.get("norm_label") or ""
        if source and label == source.rsplit("/", 1)[-1]:
            out.setdefault(source, str(node.get("id") or ""))
    return out


def _prisma_reference_edges(model_names: list[str], ast_nodes: list[dict]) -> list[dict]:
    """Привязка модели к коду: `git grep` (детерминированно, без LLM) — до 5 файлов на
    модель → рёбра references модель↔файл. Паттерн буквально по плану — `prisma.<model>.`
    (первая буква имени модели в нижнем регистре, как Prisma client называет свойство);
    находит только доступ через `this.prisma.<model>.`, не через алиасы `prismaRead`/
    `dbRead`/`db` — сознательное ограничение детерминированного грепа, не бага.

    Один вызов `git grep` с паттерном на модель (`-e` на каждую, OR), не N вызовов —
    358 моделей отдельными процессами держали бы сборку графа лишним минимal (~56с в
    измерении на этом репозитории); одним проходом — доли секунды. Отличить, какая
    модель совпала в какой строке, можно уже локально — `-F`-паттерны с обязательной
    завершающей точкой не являются подстроками друг друга при разных именах моделей
    (после общего префикса имени сразу расходится следующий символ)."""
    if not model_names:
        return []
    file_ids = _file_container_ids(ast_nodes)
    patterns = {name: f"prisma.{name[:1].lower() + name[1:]}." for name in model_names}
    args = ["git", "grep", "-n", "-F"]
    for pattern in patterns.values():
        args += ["-e", pattern]
    try:
        proc = subprocess.run(args, cwd=str(REPO_ROOT), capture_output=True, text=True,
                               timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode not in (0, 1):             # 1 = нет совпадений, не ошибка
        return []

    hits: dict[str, set[str]] = {}
    for line in proc.stdout.splitlines():
        parts = line.split(":", 2)                # path:lineno:content
        if len(parts) < 3:
            continue
        path, content = parts[0], parts[2]
        for name, pattern in patterns.items():
            if pattern in content:
                hits.setdefault(name, set()).add(path)

    edges: list[dict] = []
    for name, paths in hits.items():
        for path in sorted(paths)[:5]:
            node_id = file_ids.get(path)
            if node_id:
                edges.append({"source": f"prisma:{name}", "target": node_id,
                              "relation": "references"})
    return edges


def build_prisma_layer() -> dict:
    """Собирает узлы/рёбра Prisma-слоя и файловые references одним вызовом — читает
    `.graphify_ast.json` (уже на диске после Part A) напрямую, не через venv graphify:
    парсинг schema.prisma и `git grep` — чистый stdlib, отдельный интерпретатор не нужен."""
    layer = _parse_prisma_models()
    ast_path = OUT_DIR / ".graphify_ast.json"
    if layer["model_names"] and ast_path.is_file():
        try:
            ast_nodes = json.loads(ast_path.read_text(encoding="utf-8")).get("nodes") or []
        except (OSError, ValueError):
            ast_nodes = []
        if ast_nodes:
            layer["edges"] += _prisma_reference_edges(layer["model_names"], ast_nodes)
    return {"nodes": layer["nodes"], "edges": layer["edges"]}


def build() -> tuple[bool, str]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ok, why = detect_files()
    if not ok:
        return False, why

    log("Part A — AST-извлечение (без LLM)")
    ok, why = _run(
        "import json\n"
        "from pathlib import Path\n"
        "from graphify.extract import collect_files, extract\n"
        f"out = Path({str(OUT_DIR)!r})\n"
        "detect = json.loads((out / '.graphify_detect.json').read_text(encoding='utf-8'))\n"
        "code_files = []\n"
        "for f in detect.get('files', {}).get('code', []):\n"
        "    p = Path(f)\n"
        "    code_files.extend(collect_files(p) if p.is_dir() else [p])\n"
        "if code_files:\n"
        f"    result = extract(code_files, cache_root=Path({str(REPO_ROOT)!r}))\n"
        "else:\n"
        "    result = {'nodes': [], 'edges': [], 'input_tokens': 0, 'output_tokens': 0}\n"
        "(out / '.graphify_ast.json').write_text("
        "json.dumps(result, ensure_ascii=False), encoding='utf-8')\n"
        "print(f'AST: {len(result[\"nodes\"])} узлов, {len(result[\"edges\"])} связей')",
        "AST-извлечение")
    if not ok:
        return False, why

    log("Part A2 — Prisma-модели (stdlib построчный парсер)")
    try:
        prisma_layer = build_prisma_layer()
    except Exception as exc:                                     # noqa: BLE001
        log(f"  Prisma-слой пропущен: {type(exc).__name__}: {exc}")
        prisma_layer = {"nodes": [], "edges": []}
    PRISMA_JSON.write_text(json.dumps(prisma_layer, ensure_ascii=False), encoding="utf-8")
    log(f"  Prisma: {len(prisma_layer['nodes'])} узлов, {len(prisma_layer['edges'])} связей")

    log("Part B — пропуск (корпус только из кода), пишу пустую семантику")
    ok, why = _run(
        "import json\n"
        "from pathlib import Path\n"
        f"Path({str(OUT_DIR / '.graphify_semantic.json')!r}).write_text(json.dumps("
        "{'nodes': [], 'edges': [], 'hyperedges': [], "
        "'input_tokens': 0, 'output_tokens': 0}), encoding='utf-8')\n"
        "print('семантика: пусто (нужен агент /graphify)')",
        "пустая семантика")
    if not ok:
        return False, why

    log("Part C — слияние")
    ok, why = _run(
        "import json\n"
        "from pathlib import Path\n"
        f"out = Path({str(OUT_DIR)!r})\n"
        "ast = json.loads((out / '.graphify_ast.json').read_text(encoding='utf-8'))\n"
        "sem = json.loads((out / '.graphify_semantic.json').read_text(encoding='utf-8'))\n"
        "prisma_path = out / '.graphify_prisma.json'\n"
        "prisma = (json.loads(prisma_path.read_text(encoding='utf-8'))\n"
        "          if prisma_path.is_file() else {'nodes': [], 'edges': []})\n"
        "seen = {n['id'] for n in ast['nodes']}\n"
        "nodes = list(ast['nodes'])\n"
        "for n in sem['nodes'] + prisma['nodes']:\n"
        "    if n['id'] not in seen:\n"
        "        nodes.append(n); seen.add(n['id'])\n"
        "merged = {'nodes': nodes, "
        "'edges': ast['edges'] + sem['edges'] + prisma['edges'],\n"
        "          'hyperedges': sem.get('hyperedges', []),\n"
        "          'input_tokens': 0, 'output_tokens': 0}\n"
        "(out / '.graphify_extract.json').write_text("
        "json.dumps(merged, ensure_ascii=False), encoding='utf-8')\n"
        "print(f'слито: {len(nodes)} узлов, {len(merged[\"edges\"])} связей')",
        "слияние")
    if not ok:
        return False, why

    log("Step 4 — построение, кластеризация, экспорт")
    ok, why = _run(
        "import json\n"
        "from pathlib import Path\n"
        "from graphify.build import build_from_json\n"
        "from graphify.cluster import cluster, score_all\n"
        "from graphify.analyze import god_nodes\n"
        "from graphify.export import to_json\n"
        f"out = Path({str(OUT_DIR)!r})\n"
        "extraction = json.loads((out / '.graphify_extract.json').read_text(encoding='utf-8'))\n"
        f"G = build_from_json(extraction, root={str(REPO_ROOT)!r}, directed=True)\n"
        # Гвард скилла (#1392): пустое извлечение не должно затирать хороший граф.
        "if G.number_of_nodes() == 0:\n"
        "    raise SystemExit('граф пуст — извлечение не дало узлов')\n"
        # cluster() отдаёт {сообщество: [узлы]}, а не {узел: сообщество} — считать
        # сообщества по values() нельзя, они списки и не хешируются.
        "communities = cluster(G)\n"
        "cohesion = score_all(G, communities)\n"
        "gods = god_nodes(G)\n"
        "to_json(G, communities, str(out / 'graph.json'))\n"
        "(out / '.graphify_analysis.json').write_text(json.dumps("
        "{'communities': {str(k): v for k, v in (cohesion or {}).items()},\n"
        " 'god_nodes': [str(g) for g in (gods or [])[:50]]}, ensure_ascii=False),"
        " encoding='utf-8')\n"
        "print(f'граф: {G.number_of_nodes()} узлов, {G.number_of_edges()} связей, "
        "{len(communities)} сообществ')",
        "построение графа")
    if not ok:
        return False, why

    info = status()
    return True, (f"граф собран: {info['nodes']} узлов, {info['edges']} связей. "
                  f"Сообщества под номерами — человеческие названия даёт только "
                  f"агентный /graphify")


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — сборка графа проекта")
    parser.add_argument("--status", action="store_true", help="что уже собрано")
    args = parser.parse_args()

    if args.status:
        print(json.dumps(status(), ensure_ascii=False, indent=2))
        return 0

    started = time.time()
    ok, message = build()
    if not ok:
        print(f"✗ {message}", file=sys.stderr)
        return 1
    log(f"✓ {message} — за {time.time() - started:.0f}s")

    # Узлы графа сразу попадают в корпус консилиума: собрали граф — он тут же
    # доступен как источник улик, без отдельного шага переиндексации.
    try:
        sys.path.insert(0, str(HERE))
        import config as config_mod
        import context_service as cs
        from store import Store
        cfg = config_mod.load(strict=False)
        with Store() as store:
            indexed = cs.index_graph(store, cfg)
            store.event("graph.built", "", json.dumps(status(), ensure_ascii=False))
        log(f"в базу знаний добавлено узлов: {indexed}")
    except Exception as exc:                                    # noqa: BLE001
        log(f"граф собран, но индексация в корпус не прошла: {type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
