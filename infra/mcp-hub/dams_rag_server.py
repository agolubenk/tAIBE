#!/usr/bin/env python3
"""DAMS RAG — MCP-фасад индекса проекта для клиентов общего хаба (infra/mcp-hub/).

Тот же поиск, что `python3 .claude/scripts/rag_query.py` (DAMS L3): Prisma-модели, REST-роуты,
Connect RPC, rules, specs, внешние OpenAPI. Claude Code получает его хуками и CLI; Copilot Chat,
Continue, Roo, Kimi и Codex — только через этот сервер. Только чтение: индекс пересобирается
`python3 .claude/scripts/index_rebuild.py`, не отсюда. GLM-rewrite запроса не делается — он
тратит отдельный ключ, а агент и так формулирует запрос по-английски.
"""
from __future__ import annotations

import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

ROOT = Path(__file__).resolve().parents[2]          # код слоя; данные — у хоста (TAIBE_HOST_ROOT)
sys.path.insert(0, str(ROOT / ".claude" / "scripts"))

from host_root import host_root  # noqa: E402

# Сервер хаба без индекса бесполезен: неверный TAIBE_HOST_ROOT — отказ на старте, а не
# «Индекс не найден» в каждом ответе. Без env — как раньше: индекс этого репозитория.
if host_root() != ROOT:
    host_root(require=".claude/rag/index.db")

from dams_common import (  # noqa: E402
    extract_search_terms,
    log_query,
    open_db,
    rebuild_hint,
    search,
    stale_counts,
)

mcp = FastMCP("DAMS RAG")


@mcp.tool()
def project_search(query: str, doc_type: str = "", module: str = "", limit: int = 8,
                   full: bool = False) -> str:
    """Поиск по карте кода HR Helper v2: Prisma-модели, REST-роуты, Connect RPC, правила
    проекта (.claude/rules), спеки модулей, OpenAPI Huntflow/hh.ru. Запрос — английские
    идентификаторы/термины (например "candidate merge duplicate"). doc_type: prisma_model |
    proto_rpc | api_route | rule_chunk | spec | openapi_endpoint; module: recruiting, wiki,
    telegram, ...; full=True — с полным текстом документа."""
    conn = open_db()
    if conn is None:
        return "Индекс не найден. Сборка: python3 .claude/scripts/index_rebuild.py"
    try:
        terms = extract_search_terms(query, limit=10)
        if not terms:
            return "Не удалось извлечь поисковые термины — нужны латинские идентификаторы."
        rows = search(conn, terms, limit=max(1, min(limit, 30)),
                      doc_type=doc_type or None, module=module or None)
        log_query(conn, query, "mcp", rows, "mcp")
        hint = rebuild_hint(stale_counts(conn, doc_type=doc_type or None))
    finally:
        conn.close()

    out = [f"⚠ {hint}\n"] if hint else []
    if not rows:
        out.append(f"Ничего не найдено (термины: {', '.join(terms)})")
        return "\n".join(out)
    for r in rows:
        mark = "" if r.get("status") == "active" else f" [{r.get('status')}]"
        out.append(f"[{r['doc_type']}|{r['module']}]{mark} {r['doc_id']}")
        out.append(f"  {r['title']}")
        if r.get("file_path"):
            out.append(f"  {r['file_path']}")
        if full:
            out.append("  ---")
            out.extend(f"  {line}" for line in (r["content"] or "").splitlines())
        out.append("")
    return "\n".join(out)


if __name__ == "__main__":
    mcp.run()
