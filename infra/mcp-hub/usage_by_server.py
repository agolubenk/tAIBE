#!/usr/bin/env python3
"""Замер вызовов MCP по серверу и продукту (OPS-43): что из хаба и прямых подключений реально вызывают.

Запуск: python3 -I infra/mcp-hub/usage_by_server.py [--days 7] [--hub-log PATH] [--projects DIR]

- Транскрипты Claude Code (`<projects>/*/*.jsonl` и `<projects>/*/*/subagents/*.jsonl`): блоки tool_use с именем
  `mcp__<подключение>__<инструмент>`. `mcp__hub__<сервер>_1mcp_<инструмент>` — вызов через хаб, остальное — прямое
  подключение (`.mcp.json`, user scope, плагин). Продукт — по папке проекта (HR, tAIBE, AION, прочее).
- Журнал хаба (`--hub-log`): строки `tool.routed` по серверу у всех клиентов хаба (Claude Code, Codex, VS Code, ...).
  Клиента 1mcp в журнал не пишет (маска `<private>`), поэтому разбивки по клиенту нет.

Печатает только счётчики; входы инструментов не читаются и не печатаются.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import time
from collections import Counter, defaultdict
from datetime import datetime

PRODUCTS = (("hr-helper", "HR"), ("taibe", "tAIBE"), ("aion", "AION"))
COLUMNS = ["HR", "tAIBE", "AION", "прочее"]
ROUTED = re.compile(r'message="tool\.routed".*?\\"server\\":\\"([^\\"]+)\\"')
DEFAULT_LOG = os.path.expanduser("~/Library/Logs/hr-helper-mcp-hub/hub.log")


def classify(name):
    """`mcp__hub__t-boards_1mcp_get_task` -> ('hub', 't-boards'); `mcp__github__x` -> ('direct', 'github')."""
    if not name.startswith("mcp__") or "__" not in name[5:]:
        return None
    conn, tool = name[5:].split("__", 1)
    if conn == "hub":
        return "hub", tool.split("_1mcp_", 1)[0] if "_1mcp_" in tool else "?"
    return "direct", conn


def product(folder):
    """Продукт по папке проекта: ключ, который стоит раньше всех (тема worktree идёт после имени репозитория)."""
    f = folder.lower()
    hits = [(f.find(key), name) for key, name in PRODUCTS if key in f]
    return min(hits)[1] if hits else "прочее"


def epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def transcripts(root):
    return glob.glob(os.path.join(root, "*", "*.jsonl")) + glob.glob(os.path.join(root, "*", "*", "subagents", "*.jsonl"))


def count_transcripts(root, since):
    """{('hub'|'direct', сервер): Counter(продукт -> вызовы)} за время после since (epoch)."""
    table, seen = defaultdict(Counter), set()
    for path in transcripts(root):
        if os.path.getmtime(path) < since:
            continue
        prod = product(os.path.relpath(path, root).split(os.sep)[0])
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"tool_use"' not in line or "mcp__" not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                t = epoch(o.get("timestamp"))
                if t is not None and t < since:
                    continue
                for b in (o.get("message") or {}).get("content") or []:
                    if not isinstance(b, dict) or b.get("type") != "tool_use" or b.get("id") in seen:
                        continue
                    seen.add(b.get("id"))
                    kind = classify(b.get("name") or "")
                    if kind:
                        table[kind][prod] += 1
    return table


def count_routed(lines, since):
    """(Counter сервер -> вызовы, время первой учтённой строки) по строкам журнала хаба."""
    routed, first = Counter(), None
    for line in lines:
        m = ROUTED.search(line)
        if not m:
            continue
        t = epoch(line[:24])
        if t is not None and t < since:
            continue
        first = first or line[:16]
        routed[m.group(1)] += 1
    return routed, first


def render(table, days, routed=None, first=None):
    out = ["Claude Code, транскрипты за %g дн." % days]
    for title, kind in (("сервер хаба", "hub"), ("прямое подключение", "direct")):
        rows = sorted(((srv, c) for (k, srv), c in table.items() if k == kind), key=lambda kv: -sum(kv[1].values()))
        out.append("| %s | %s | всего |" % (title, " | ".join(COLUMNS)))
        out.append("|---|%s---:|" % ("---:|" * len(COLUMNS)))
        out += ["| %s | %s | %d |" % (srv, " | ".join(str(c[p]) for p in COLUMNS), sum(c.values())) for srv, c in rows]
    if routed is not None:
        out.append("Журнал хаба, tool.routed с %s (все клиенты):" % (first or "—"))
        out += ["| %s | %d |" % (srv, n) for srv, n in routed.most_common()] or ["(вызовов нет)"]
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--projects", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--hub-log", default=DEFAULT_LOG, help="журнал хаба; пусто — без журнала")
    a = ap.parse_args(argv)
    since = time.time() - a.days * 86400
    table = count_transcripts(a.projects, since)
    routed = first = None
    if a.hub_log and os.path.exists(a.hub_log):
        with open(a.hub_log, encoding="utf-8", errors="replace") as fh:
            routed, first = count_routed(fh, since)
    print(render(table, a.days, routed, first))


if __name__ == "__main__":
    main()
