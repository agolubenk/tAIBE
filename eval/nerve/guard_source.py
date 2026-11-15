# -*- coding: utf-8 -*-
"""Читатель прогонов сторожей: результаты CI на ветке → прогоны карточек `check` (TB-45, срез S45-4b).

Спека — docs/specs/r100-permanent-questions.md, правило 7 и F-45-3 = A (прогоны присылает Нерв). Здесь общая часть
вариантов ключа A1 и A2 (пункт владельца taibe-d-f453-fact-1511): чтение прогонов ветки, курсор, сопоставление
workflow → карточка и тело запроса POST /api/forest/{ws}/cards/{taskId}/guard-runs. Запись в доски и ключ — следующий
шаг, после ответа владельца и маршрута S45-4a; до него источник не стоит в POLLS.

Чтение — один `gh api repos/<repo>/actions/runs?branch=…&created=>=<курсор>` не чаще раза в GUARD_EVERY. REST, а не
`gh run list`: путь файла workflow (`path`), по которому карточка называет сторожа, есть только в REST. Прогон весит
~14 КБ JSON (замер 15.11: 20 прогонов — 310 КБ), поэтому два ограничения. Курсор: читаются только прогоны, созданные
не раньше самого старого незавершённого, а если все завершены — самого нового. Повтор того же запроса идёт с
If-None-Match: пока прогоны не менялись, GitHub отвечает 304 без тела, и такой ответ не тратит лимит запросов.
"""
import json
import re
import urllib.parse
from datetime import datetime, timedelta, timezone

import sources

GUARD_EVERY = 300                    # секунд между чтениями: сторожу хватает задержки до 5 минут (F-45-3)
GUARD_PER_PAGE = 50                  # прогонов за чтение; после долгого простоя Mac более старые пропускаются
FIRST_LOOKBACK = timedelta(hours=1)  # первое чтение — прогоны последнего часа, не вся история ветки
PENDING_MAX = timedelta(hours=6)     # незавершённый прогон старше не держит курсор: задание GitHub живёт до 6 ч
SUMMARY_MAX = 500                    # предел `summary` маршрута (правило 7)
GREEN, RED = {"success"}, {"failure", "timed_out", "startup_failure"}
# cancelled, skipped, neutral, action_required, stale — не результат проверки: такой прогон не шлётся.
ISO = "%Y-%m-%dT%H:%M:%SZ"
_HEAD_BODY = re.compile(r"\r?\n\r?\n")


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime(ISO)


def _gh_runs(repo, branch, since, etag=""):
    """Прогоны ветки, созданные не раньше since: (etag, total_count, прогоны) или None на 304."""
    q = urllib.parse.urlencode({"branch": branch, "created": f">={since}", "per_page": GUARD_PER_PAGE})
    cmd = ["gh", "api", "-i", f"repos/{repo}/actions/runs?{q}"]
    if etag:
        cmd[3:3] = ["-H", f"If-None-Match: {etag}"]
    code, out, err = sources.run(cmd)
    if code != 0 and out.split(" ", 2)[1:2] == ["304"]:
        return None
    if code != 0:
        raise RuntimeError(f"gh runs {repo}@{branch}: {(err or out).strip()[:200]}")
    head, body = _HEAD_BODY.split(out, 1)
    new_etag = next((ln.split(":", 1)[1].strip() for ln in head.splitlines() if ln.lower().startswith("etag:")), "")
    d = json.loads(body)
    runs = [{"id": r["id"], "attempt": r.get("run_attempt") or 1, "path": r.get("path") or "",
             "name": r.get("name") or "", "number": r.get("run_number"), "status": r.get("status") or "",
             "conclusion": r.get("conclusion") or "", "url": r.get("html_url") or "", "sha": r.get("head_sha") or "",
             "created": r["created_at"], "updated": r.get("updated_at") or r["created_at"]}
            for r in d.get("workflow_runs") or []]
    return new_etag, d.get("total_count", len(runs)), runs


def next_since(runs, since, now):
    """Курсор следующего чтения: created самого старого незавершённого прогона (он ещё даст результат), иначе —
    самого нового. Граница включительная: прогоны одного push создаются в одну секунду и приходят не все сразу."""
    floor = _iso(now - PENDING_MAX)
    pending = [r["created"] for r in runs if r["status"] != "completed" and r["created"] >= floor]
    if pending:
        return min(pending)
    return max([since] + [r["created"] for r in runs])


def to_guard_run(run, branch):
    """Тело POST …/guard-runs (правило 7) или None, если прогон — не результат проверки."""
    if run["status"] != "completed" or run["conclusion"] not in GREEN | RED:
        return None
    url = run["url"] + (f"/attempts/{run['attempt']}" if run["attempt"] > 1 else "")
    summary = f"{run['name']} #{run['number']}: {run['conclusion']} на {run['sha'][:9]} ({branch})"
    return {"status": "green" if run["conclusion"] in GREEN else "red", "runUrl": url,
            "summary": summary[:SUMMARY_MAX], "source": "nerve", "ranAt": run["updated"]}


def read_results(ctx, repo, branch):
    """Новые результаты проверок ветки: [(path workflow, тело прогона)] и число пропущенных прогонов.

    Состояние — ctx.state["guard"]: курсор, увиденные «id:попытка», etag последнего запроса и время чтения. Сбой gh —
    исключение, состояние не меняется: следующий проход прочитает то же."""
    st = ctx.state.setdefault("guard", {"seen": {}})
    at = st.get("at")
    if at and (ctx.now - datetime.strptime(at, ISO).replace(tzinfo=timezone.utc)).total_seconds() < GUARD_EVERY:
        return [], 0
    since = st.get("since") or _iso(ctx.now - FIRST_LOOKBACK)
    etag = st.get("etag", "") if st.get("etag_since") == since else ""
    got = _gh_runs(repo, branch, since, etag)
    st["at"] = _iso(ctx.now)
    if got is None:
        return [], 0
    new_etag, total, runs = got
    out = []
    for run in runs:
        key = f"{run['id']}:{run['attempt']}"
        body = to_guard_run(run, branch)
        if body is None or key in st["seen"]:
            continue
        st["seen"][key] = run["created"]
        out.append((run["path"], body))
    st["since"] = next_since(runs, since, ctx.now)
    st["seen"] = {k: c for k, c in st["seen"].items() if c >= st["since"]}
    st["etag"], st["etag_since"] = new_etag, since
    return out, max(0, total - len(runs))


def _guard_ref(params):
    g = (params or {}).get("guard") or {}
    return g.get("ref", "") if g.get("kind") == "ci" else ""


def match(results, cards):
    """Прогон → карточки `check`, чей сторож — этот файл workflow: [(taskId, тело прогона)].

    Карточка — запись ответа GET …/permanent: `taskId` и `permanenceParams.guard = {kind: "ci", ref}`; ref — путь
    файла (.github/workflows/eval-ci.yml) или его имя (eval-ci.yml). Один workflow может сторожить несколько карточек."""
    refs = [(c["taskId"], _guard_ref(c.get("permanenceParams"))) for c in cards]
    out = []
    for path, body in results:
        for task_id, ref in refs:
            if ref and (ref == path or ref == path.rsplit("/", 1)[-1]):
                out.append((task_id, body))
    return out
