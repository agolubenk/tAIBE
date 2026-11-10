#!/usr/bin/env python3
"""Сводка карточек t-boards продукта для «Хода работ» очереди владельца — `work/cards-stats` (OPS-38).

Спека формата — раздел `work/cards-stats` в `infra/ops-console/server/queue/page.html`:
`{kind: 'stats', at, bugs: {critical, high, medium, low, none}, tasks: {P0, P1, P2, P3, none}, inPlan, notInPlan,
halfBaked, history: [{d, bugs, tasks, inPlan}]}`. Прежнюю `work/notion-stats` писал скрипт сессии по Notion; Notion
заморожен (R-084), поэтому сводка — по доскам продукта.

Откуда что (только GET, ключ продукта — тот же, что у консилиума, `<хост>/.claude/council/tboards.json`):
- проекты пространства — `GET /api/project`;
- карточки и колонки — `GET /api/task/tasks/{проект}?status=<slug>` по каждой колонке (как `Client.board`);
- ошибки и их severity — `GET /api/forest/{пространство}/bugs?projectId=` одним вызовом на проект;
- «в плане» — ключ карточки есть в `cards` открытой строки `work` очереди (GET `/db/work`).
Открытая карточка — не в финальной колонке (`isFinal` или slug из `sources.tboards.final_slugs`) и без `completedAt`.
`halfBaked` — 0: флага нет в списках доски, а мета по карточке — запрос на каждую (больше бюджета ключа).

Запуск (Mac, хост продукта): `TAIBE_HOST_ROOT=<папка продукта> python3 infra/ai-council/cards_stats.py [--write]`.
Без `--write` — только печать. Токен очереди — env `OQ_TOKEN` или связка ключей macOS (`hr-helper-mcp`/`OQ_TOKEN`),
адрес — env `OQ_URL` (по умолчанию ops-консоль HR). История — одна точка на день (UTC), не больше 400.

Доска продукта (GET `/products` очереди: `default` и `boards` продуктов). Сводка несёт `ws` — slug пространства ключа:
по нему страница относит её к продукту. Доска продукта по умолчанию пишет `work/cards-stats` (история та же), другая
доска — `work/cards-stats-<ws>`. Без `boards` в ответе (консоль до этой версии) — прежний `work/cards-stats` без `ws`.
С ним же — карта доски `work/boards-<ws>` для группировки «Хода работ» (`page-lanes.ts`): `{kind: 'boards', ws, name,
at, projects: [{slug, name}], sectors: [{id, name, keys}], partial}`. Секторы — активные `GET /api/forest/{ws}/sectors`;
ключи — корни и ветки их деревьев (`GET /api/forest/{ws}/trees/{root}`) в пределах бюджета ключа; что не влезло —
только корень из `GET /api/forest/{ws}/trees`, и `partial: true`.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import config as config_mod  # noqa: E402  — кладёт .claude/scripts слоя в sys.path
import pipeline_settings  # noqa: E402
import tboards  # noqa: E402

OQ_URL = os.environ.get("OQ_URL", "https://ops.admin.hrhelper.space/api/oq/v1").rstrip("/")
DOC_ID = "cards-stats"
SEVERITIES = ("critical", "high", "medium", "low")
PRIORITIES = ("P0", "P1", "P2", "P3")
HISTORY_MAX = 400
FINAL_DONE_STATUSES = ("done", "dropped", "cancelled")
BOARDS_PREFIX = "boards-"
SECTORS_MAX, SECTOR_KEYS_MAX, BUDGET_RESERVE = 60, 300, 2


def queue_token() -> str:
    token = os.environ.get("OQ_TOKEN", "").strip()
    if token:
        return token
    try:
        out = subprocess.run(["security", "find-generic-password", "-s", "hr-helper-mcp", "-a", "OQ_TOKEN", "-w"],
                             capture_output=True, text=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        raise SystemExit("нет токена очереди: env OQ_TOKEN или связка ключей hr-helper-mcp/OQ_TOKEN") from None
    return out.stdout.strip()


def queue_call(method: str, path: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{OQ_URL}{path}", data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        # python.org Python на macOS без своего хранилища CA: тот же контекст, что у клиента досок (проверка включена).
        ctx = pipeline_settings._tls_context() or ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404 and method == "GET":
            return {}
        raise SystemExit(f"очередь: {method} {path} → HTTP {exc.code} {exc.read()[:200]!r}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        # Сеть или DNS: одна строка с причиной и код 1, без трассировки — запуск по расписанию читает журнал.
        reason = getattr(exc, "reason", exc)
        raise SystemExit(f"очередь недоступна: {method} {path} — {reason}") from None


def board_cards(client: tboards.Client, final_slugs: set[str]) -> list[dict]:
    """Открытые карточки всех проектов пространства: {key, bug, severity, priority}."""
    cards: list[dict] = []
    for pid, project in client.projects().items():
        slug = str(project.get("slug") or "")
        bugs = client.get("/api/forest/{}/bugs", client.workspace, query={"projectId": pid})
        severity = {str(b.get("taskId")): str(b.get("severity") or "") for b in bugs or [] if isinstance(b, dict)}
        for t in project_tasks(client, pid, final_slugs):
            tid = str(t.get("id"))
            cards.append({"key": f"{slug}-{t.get('number')}", "bug": tid in severity,
                          "severity": severity.get(tid) or "", "priority": tboards.PRIORITY.get(str(t.get("priority") or ""))})
    return cards


def project_tasks(client: tboards.Client, project_id: str, final_slugs: set[str]) -> list[dict]:
    """Открытые задачи проекта: список доски без фильтра статуса, все страницы по 100 (запрос на страницу, а не на
    колонку — иначе 11 проектов × 15 колонок не влезают в лимит ключа). Финальная колонка — `isFinal` или slug."""
    open_tasks: list[dict] = []
    page, pages = 1, 1
    while page <= pages:
        data = client.get("/api/task/tasks/{}", project_id, query={"limit": 100, "page": page})
        data = data if isinstance(data, dict) else {}
        for col in (data.get("data") or {}).get("columns") or []:
            if not isinstance(col, dict) or col.get("isFinal") or str(col.get("slug") or "") in final_slugs:
                continue
            open_tasks += [t for t in col.get("tasks") or [] if isinstance(t, dict) and not t.get("completedAt")]
        try:
            pages = max(1, min(int((data.get("pagination") or {}).get("totalPages") or 1), 50))
        except (TypeError, ValueError):
            pages = 1
        page += 1
    return open_tasks


def board_target(meta: dict, ws: str) -> tuple[str, bool]:
    """Id сводки и есть ли у консоли доски продуктов. Доска продукта по умолчанию — `cards-stats`, другая — свой id."""
    products = meta.get("products") if isinstance(meta, dict) else None
    if not isinstance(products, list) or not any(isinstance(p, dict) and "boards" in p for p in products):
        return DOC_ID, False
    home = [b for p in products if isinstance(p, dict) and p.get("slug") == meta.get("default") for b in p.get("boards") or []]
    return (DOC_ID if ws in home else f"{DOC_ID}-{ws}"), True


def sector_name(raw) -> str:
    """«Sector: <заголовок корня> +15» → заголовок: префикс и число деревьев сверх первого — шум на дорожке Ганта."""
    name = str(raw or "").strip()
    if name.lower().startswith("sector:"):
        name = name[len("sector:"):].strip()
    name = name.rsplit(" +", 1)[0] if name.rsplit(" +", 1)[-1].isdigit() else name
    return name[:120] or "сектор"


def board_map(client: tboards.Client, now: dt.datetime) -> dict:
    """Карта доски для группировки «Хода работ»: проекты и активные секторы с ключами карточек их деревьев."""
    projects = client.projects()
    slug_of = {str(pid): str(p.get("slug") or "") for pid, p in projects.items()}
    trees = client.get("/api/forest/{}/trees", client.workspace)
    trees = trees if isinstance(trees, dict) else {}
    root_key = {str(t.get("id")): f"{t.get('projectSlug')}-{t.get('number')}" for t in trees.get("trees") or []
                if isinstance(t, dict) and t.get("projectSlug") and isinstance(t.get("number"), int)}
    partial = bool(trees.get("truncated"))
    sectors = []
    for s in (client.get("/api/forest/{}/sectors", client.workspace, query={"status": "active"}) or [])[:SECTORS_MAX]:
        if not isinstance(s, dict) or not s.get("id"):
            continue
        keys: set[str] = set()
        for rid in s.get("treeIds") or []:
            rid = str(rid)
            if client.calls >= client.budget - BUDGET_RESERVE:
                partial = True
                if rid in root_key:
                    keys.add(root_key[rid])
                continue
            tree = client.get("/api/forest/{}/trees/{}", client.workspace, rid)
            tree = tree if isinstance(tree, dict) else {}
            partial = partial or bool(tree.get("truncated"))
            for b in tree.get("branches") or []:
                slug = slug_of.get(str(b.get("projectId"))) if isinstance(b, dict) else ""
                if slug and isinstance(b.get("number"), int):
                    keys.add(f"{slug}-{b['number']}")
        sectors.append({"id": str(s["id"]), "name": sector_name(s.get("name")), "keys": sorted(keys)[:SECTOR_KEYS_MAX]})
    return {"kind": "boards", "ws": client.slug, "name": client.name, "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "projects": sorted(({"slug": slug, "name": str(p.get("name") or "")} for p in projects.values()
                                if (slug := str(p.get("slug") or ""))), key=lambda p: p["slug"]),
            "sectors": sectors, "partial": partial}


def put_doc(token: str, doc_id: str, data: dict) -> int | None:
    """Запись документа work с ifVersion прошлой версии (если она есть): параллельная запись не теряется молча."""
    prev = queue_call("GET", f"/db/work/{doc_id}", token) or {}
    body = {"data": data}
    if prev.get("version") is not None:
        body["ifVersion"] = prev["version"]
    return queue_call("PUT", f"/db/work/{doc_id}", token, body).get("version")


def plan_keys(work_docs: list[dict]) -> set[str]:
    keys: set[str] = set()
    for doc in work_docs:
        d = doc.get("data") or {}
        if d.get("kind") or d.get("archived") or d.get("status") in FINAL_DONE_STATUSES:
            continue
        for c in d.get("cards") or []:
            if isinstance(c, dict) and isinstance(c.get("key"), str):
                keys.add(c["key"])
    return keys


def build_stats(cards: list[dict], in_plan_keys: set[str], prev: dict, now: dt.datetime) -> dict:
    bugs = {s: 0 for s in (*SEVERITIES, "none")}
    tasks = {p: 0 for p in (*PRIORITIES, "none")}
    for c in cards:
        if c["bug"]:
            bugs[c["severity"] if c["severity"] in SEVERITIES else "none"] += 1
        else:
            tasks[c["priority"] if c["priority"] in PRIORITIES else "none"] += 1
    in_plan = sum(1 for c in cards if c["key"] in in_plan_keys)
    day = now.strftime("%Y-%m-%d")
    history = [h for h in (prev.get("history") or []) if isinstance(h, dict) and h.get("d") != day]
    history.append({"d": day, "bugs": sum(bugs.values()), "tasks": sum(tasks.values()), "inPlan": in_plan})
    history = sorted(history, key=lambda h: str(h.get("d")))[-HISTORY_MAX:]
    return {"kind": "stats", "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "t-boards: открытые карточки продукта",
            "bugs": bugs, "tasks": tasks, "inPlan": in_plan, "notInPlan": len(cards) - in_plan, "halfBaked": 0,
            "history": history}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="work/cards-stats по t-boards продукта (OPS-38)")
    ap.add_argument("--write", action="store_true", help="записать в очередь (без флага — только печать)")
    args = ap.parse_args(argv)
    cfg = config_mod.load(strict=False)
    final_slugs = set(cfg.get("sources.tboards.final_slugs", []) if cfg else []) or {"done", "closed"}
    token = queue_token()
    meta = queue_call("GET", "/products", token)
    now = dt.datetime.now(dt.timezone.utc)
    boards = None
    try:
        with tboards.build(cfg, budget=95) as client:
            cards = board_cards(client, final_slugs)
            ws = str(getattr(client, "slug", "") or "")
            doc_id, with_boards = board_target(meta, ws) if ws else (DOC_ID, False)
            if with_boards:
                try:
                    boards = board_map(client, now)
                except tboards.TBoardsError as exc:
                    # Карта — для группировки; без неё сводка всё равно пишется.
                    print(f"карта доски не собрана: {exc}", file=sys.stderr)
    except tboards.TBoardsError as exc:
        raise SystemExit(f"доски: {exc}") from None
    work = queue_call("GET", "/db/work", token)
    docs = work.get("docs", work) if isinstance(work, dict) else work
    # Прошлая сводка — отдельным чтением по id: в длинном списке work её может не оказаться, и история начнётся заново.
    prev_doc = queue_call("GET", f"/db/work/{doc_id}", token) or {}
    stats = build_stats(cards, plan_keys(docs or []), prev_doc.get("data") or {}, now)
    if with_boards:
        stats["ws"] = ws
    print(json.dumps({k: stats[k] for k in ("at", "bugs", "tasks", "inPlan", "notInPlan")}, ensure_ascii=False))
    if boards:
        print(f"карта доски {ws}: проектов {len(boards['projects'])}, секторов {len(boards['sectors'])}"
              + (" (не полностью: бюджет ключа)" if boards["partial"] else ""))
    if not args.write:
        print("пробный прогон: в очередь не записано (--write записывает)")
        return 0
    body = {"data": stats}
    if prev_doc.get("version") is not None:
        body["ifVersion"] = prev_doc["version"]
    res = queue_call("PUT", f"/db/work/{doc_id}", token, body)
    print(f"записано: work/{doc_id} v{res.get('version')}")
    if boards:
        print(f"записано: work/{BOARDS_PREFIX}{ws} v{put_doc(token, BOARDS_PREFIX + ws, boards)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
