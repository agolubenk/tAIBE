#!/usr/bin/env python3
"""Итоговый конфиг хаба 1mcp из шаблона `infra/mcp-hub/mcp.json` (зовёт `mcp-hub.sh`, только stdlib).

  render — итоговый конфиг в stdout. Невключённые коннекторы убраны: `disabled: true` 1mcp на лету не
           применяет. `${TAIBE_HOST_ROOT}` заменяется на корень хоста. Остальные `${VAR}` (HR_HELPER_ROOT,
           SERENA_HTTP_PORT, GITHUB_PAT) остаются, их на запуске подставляет 1mcp из окружения хаба.
           С `--live <живой mcp.json>` работает предохранитель: если живой конфиг обслуживает другой хост,
           выход с кодом 3, ничего не печатается. Обычно так бывает, когда в окружении забыли TAIBE_HOST_ROOT,
           а sync молча перевёл бы git, postgres и council на папку слоя.
  drift  — для `status`: что sync поменял бы в `--live`. Без вывода — расхождений нет.
  host   — хост, который обслуживает `--live`: путь одной строкой; несколько разных — по строке на каждый;
           пусто — живого конфига нет или хоста в нём не видно. `--host-root` не нужен. Его зовёт `mcp-hub.sh`,
           когда TAIBE_HOST_ROOT не задан: хост берётся из живого конфига, а не молча становится папкой слоя.

Хост живого конфига читается там, где в шаблоне стоит `${TAIBE_HOST_ROOT}`. `${HR_HELPER_ROOT}` в обоих
конфигах перед сравнением заменяется на `--serve-root`: в живом конфиге он бывает и литералом.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

HOST_VAR = "${TAIBE_HOST_ROOT}"
SERVE_VAR = "${HR_HELPER_ROOT}"
HOST_CHANGE_ENV = "MCP_HUB_HOST_CHANGE"
EXIT_BAD_INPUT = 2
EXIT_HOST_MISMATCH = 3


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def enabled_connectors(path: str) -> set[str]:
    if not path or not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip()}


def substitute(node, var: str, value: str):
    """Заменить `var` во всех строках дерева (ключи не трогаются)."""
    if isinstance(node, str):
        return node.replace(var, value)
    if isinstance(node, list):
        return [substitute(item, var, value) for item in node]
    if isinstance(node, dict):
        return {key: substitute(item, var, value) for key, item in node.items()}
    return node


def render(template: dict, enabled: set[str], host_root: str) -> dict:
    cfg = json.loads(json.dumps(template))
    servers = cfg.get("mcpServers", {})
    for name, server in list(servers.items()):
        if "connector" in server.get("tags", []):
            if name in enabled:
                server["disabled"] = False
            else:
                del servers[name]
    return substitute(cfg, HOST_VAR, host_root)


def live_hosts(template: dict, live: dict, serve_root: str) -> dict[str, str]:
    """Хосты живого конфига: {"<сервер>.<путь>": путь} там, где в шаблоне стоит `${TAIBE_HOST_ROOT}`."""
    found: dict[str, str] = {}
    live = substitute(live, SERVE_VAR, serve_root)

    def walk(tmpl, cur, where: str) -> None:
        if isinstance(tmpl, str):
            if HOST_VAR not in tmpl or not isinstance(cur, str):
                return
            parts = [re.escape(part) for part in tmpl.replace(SERVE_VAR, serve_root).split(HOST_VAR)]
            match = re.fullmatch("(.+)".join(parts), cur)
            # Только абсолютный путь: при сдвиге args на месте хоста может оказаться флаг.
            if match and all(group.startswith("/") for group in match.groups()):
                found[where] = match.group(1)
        elif isinstance(tmpl, list) and isinstance(cur, list):
            for i, item in enumerate(tmpl[: len(cur)]):
                walk(item, cur[i], f"{where}[{i}]")
        elif isinstance(tmpl, dict) and isinstance(cur, dict):
            for key, item in tmpl.items():
                if key in cur:
                    walk(item, cur[key], f"{where}.{key}" if where else key)

    walk(template.get("mcpServers", {}), live.get("mcpServers", {}), "")
    return found


def host_mismatch(template: dict, live: dict, host_root: str, serve_root: str) -> list[str]:
    """Пусто — хост тот же или в живом конфиге его не видно; иначе — другие хосты живого конфига."""
    hosts = set(live_hosts(template, live, serve_root).values())
    return sorted(hosts - {host_root})


def drift(template: dict, enabled: set[str], live: dict, host_root: str, serve_root: str) -> list[str]:
    other = host_mismatch(template, live, host_root, serve_root)
    if other:
        return [
            f"⚠ живой конфиг хаба обслуживает хост {', '.join(other)}, а сейчас TAIBE_HOST_ROOT={host_root}:"
            f" sync сменил бы хост. Тот же хост: TAIBE_HOST_ROOT={other[0]} npm run mcp-hub:sync"
        ]
    want = substitute(render(template, enabled, host_root), SERVE_VAR, serve_root).get("mcpServers", {})
    have = substitute(live, SERVE_VAR, serve_root).get("mcpServers", {})
    lines = []
    changed = sorted(name for name in want.keys() & have.keys() if want[name] != have[name])
    added = sorted(want.keys() - have.keys())
    removed = sorted(have.keys() - want.keys())
    if changed:
        lines.append(f"⚠ sync перепишет из шаблона: {', '.join(changed)}")
    if added:
        lines.append(f"⚠ sync добавит: {', '.join(added)}")
    if removed:
        lines.append(f"⚠ sync уберёт: {', '.join(removed)}")
    if lines:
        lines.append("  применить: npm run mcp-hub:sync")
    return lines


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("mode", choices=("render", "drift", "host"))
    parser.add_argument("--template", required=True)
    parser.add_argument("--connectors", default="")
    parser.add_argument("--host-root", default="", help="обязателен для render и drift")
    parser.add_argument("--serve-root", required=True)
    parser.add_argument("--live", default="", help="живой mcp.json; пусто — нет")
    args = parser.parse_args(argv)
    if args.mode != "host" and not args.host_root:
        parser.error(f"{args.mode}: нужен --host-root")

    try:
        template = load_json(args.template)
        enabled = enabled_connectors(args.connectors)
        live = load_json(args.live) if args.live and os.path.exists(args.live) else None
    except (OSError, ValueError) as exc:  # битый JSON или нет доступа — одной строкой, без трейсбека
        print(f"✗ render_config.py {args.mode}: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT

    if args.mode == "host":
        if live is not None:
            for host in sorted(set(live_hosts(template, live, args.serve_root).values())):
                print(host)
        return 0

    if args.mode == "drift":
        if live is not None:
            for line in drift(template, enabled, live, args.host_root, args.serve_root):
                print(line)
        return 0

    if live is not None and os.environ.get(HOST_CHANGE_ENV) != "1":
        other = host_mismatch(template, live, args.host_root, args.serve_root)
        if other:
            print(
                f"✗ хаб: живой конфиг обслуживает хост {', '.join(other)}, а sync собрал бы его для"
                f" {args.host_root} (TAIBE_HOST_ROOT не задан или другой).\n"
                f"  Тот же хост: TAIBE_HOST_ROOT={other[0]} npm run mcp-hub:sync\n"
                f"  Сменить хост осознанно: {HOST_CHANGE_ENV}=1 TAIBE_HOST_ROOT=<путь> npm run mcp-hub:sync",
                file=sys.stderr,
            )
            return EXIT_HOST_MISMATCH
    print(json.dumps(render(template, enabled, args.host_root), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
