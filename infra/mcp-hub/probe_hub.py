#!/usr/bin/env python3
"""Проба живого хаба 1mcp — только чтение: какие серверы отдали tools и на чей код смотрят serena и dams-rag.

После переключения хаба на код слоя (TAIBE_HOST_ROOT) проверяет то, чего не видно по счёту tools:
serena индексирует продукт-хост, а не слой; dams-rag ищет в индексе хоста; ai-council отвечает без ошибки
(база хоста открыта, пустая база не создана).

    python3 -I infra/mcp-hub/probe_hub.py --require ai-council,owner-queue,dams-rag,serena,git \\
        --symbol issueWebHandoffTicket=auth.controller.ts \\
        --symbol-path apps/backend/src/modules/auth/auth.controller.ts \\
        --route web-handoff-ticket=auth.controller.ts

Код 1 — хоть одна проверка не прошла. Вызывает только find_symbol (напрямую в serena), project_search и
council_queue_status.
"""
import argparse
import json
import sys
import time
import urllib.request

FAILS: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f" — {str(detail)[-400:]}"))
    if not ok:
        FAILS.append(name)


class Hub:
    def __init__(self, url: str, timeout: float) -> None:
        self.url, self.timeout, self.sid, self.seq = url, timeout, None, 0

    def post(self, body: dict) -> dict | None:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.sid:
            headers["mcp-session-id"] = self.sid
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            self.sid = resp.headers.get("mcp-session-id") or self.sid
            raw = resp.read().decode()
        if raw.lstrip().startswith("{"):
            return json.loads(raw)
        events = [json.loads(line[5:]) for line in raw.splitlines() if line.startswith("data:") and line[5:].strip()]
        return events[-1] if events else None

    def rpc(self, method: str, params: dict) -> dict:
        self.seq += 1
        res = self.post({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params}) or {}
        if "error" in res:
            raise RuntimeError(res["error"])
        return res.get("result", {})

    def open(self) -> None:
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "probe_hub", "version": "1"}})
        self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, tool: str, args: dict) -> tuple[bool, str]:
        res = self.rpc("tools/call", {"name": tool, "arguments": args})
        text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        return not res.get("isError"), text


def pair(raw: str) -> tuple[str, str]:
    name, sep, expect = raw.partition("=")
    if not sep or not name or not expect:
        raise argparse.ArgumentTypeError(f"нужно ИМЯ=ОЖИДАЕМОЕ, получено {raw!r}")
    return name, expect


def serena_symbol(args: argparse.Namespace) -> None:
    """find_symbol — напрямую в serena, не через хаб: у хаба на вызов ~60 с, а холодный LSP большого монорепо
    грузится дольше 5 минут (04.11: первый вызов после рестарта). Повтор, пока не истечёт --serena-wait."""
    name, expect = args.symbol
    call_args = {"name_path_pattern": name}
    if args.symbol_path:
        call_args["relative_path"] = args.symbol_path
    deadline, last = time.monotonic() + args.serena_wait, ""
    while True:
        try:
            serena = Hub(args.serena_url, args.serena_wait + 30)
            serena.open()
            ok, last = serena.call("find_symbol", call_args)
            if ok and expect in last:
                break
        except Exception as exc:  # noqa: BLE001 — LSP ещё грузится или serena не ответила
            ok, last = False, repr(exc)
        if time.monotonic() >= deadline:
            break
        time.sleep(15)
    check(f"serena находит символ хоста {name} → {expect}", ok and expect in last, last)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--url", default="http://127.0.0.1:3050/mcp")
    ap.add_argument("--timeout", type=float, default=120)
    ap.add_argument("--require", default="", help="серверы через запятую: у каждого хоть один tool")
    ap.add_argument("--symbol", type=pair, help="serena find_symbol: СИМВОЛ=фрагмент пути файла хоста")
    ap.add_argument("--symbol-path", help="relative_path для find_symbol (файл или каталог хоста) — быстрее")
    ap.add_argument("--serena-url", default="http://127.0.0.1:9121/mcp")
    ap.add_argument("--serena-wait", type=float, default=900, help="сколько ждать прогрева LSP, с")
    ap.add_argument("--route", type=pair, help="dams-rag project_search (api_route): ЗАПРОС=фрагмент пути")
    args = ap.parse_args()

    hub = Hub(args.url, args.timeout)
    try:
        hub.open()
        tools = [t["name"] for t in hub.rpc("tools/list", {}).get("tools", [])]
    except Exception as exc:  # noqa: BLE001 — хаб не ответил: это и есть результат пробы
        check(f"хаб {args.url} отвечает", False, exc)
        return 1
    counts: dict[str, int] = {}
    for name in tools:
        server = name.split("_1mcp_")[0]
        counts[server] = counts.get(server, 0) + 1
    print("      tools:", json.dumps(counts, sort_keys=True, ensure_ascii=False))
    for server in filter(None, (s.strip() for s in args.require.split(","))):
        check(f"{server}: tools есть", counts.get(server, 0) > 0, counts.get(server, 0))

    if args.symbol:
        serena_symbol(args)
    probes = []
    if args.route:
        probes.append(("dams-rag находит маршрут хоста", "dams-rag_1mcp_project_search",
                       {"query": args.route[0], "doc_type": "api_route"}, args.route[1]))
    if "ai-council" in counts:
        probes.append(("ai-council отвечает без ошибки (база хоста открыта)", "ai-council_1mcp_council_queue_status",
                       {}, None))
    for title, tool, call_args, expect in probes:
        if tool not in tools:
            check(title, False, f"нет tool {tool}")
            continue
        try:
            ok, text = hub.call(tool, call_args)
        except Exception as exc:  # noqa: BLE001
            ok, text = False, repr(exc)
        check(title, ok and (expect is None or expect in text), text)

    print(f"\n{'OK' if not FAILS else 'FAILED'}: {len(FAILS)} провалов")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
