# -*- coding: utf-8 -*-
"""Источники Нерва (П7): GitHub, очередь владельца, хвосты транскриптов, память, хаб.

Каждый опрос пишет события в журнал с ключом идемпотентности; повторный проход ничего не дублирует.
Тексты заметок владельца, входящих и комментариев PR в журнал не попадают — только id, вид и метки.
"""
import glob
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone

import quorum
from journal import ALL, DIGEST, NERVOUS

STOP_RE = re.compile(r"\b(стоп|откат|откати|rollback)\b", re.I)
LIMIT_TEXT_RE = re.compile(r"hit your .*?limit", re.I | re.S)
MEM_RE = re.compile(r"free percentage:\s*(\d+)%")
KEY_RE = re.compile(r"ключ реестра ([\w-]+)")


def run(cmd, stdin=None, timeout=30):
    p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


# ---------- GitHub ----------

def _gh_list(repo, etag):
    """Открытые PR с условным запросом. Возвращает (список | None при 304, новый etag)."""
    cmd = ["gh", "api", "-i", f"repos/{repo}/pulls?state=open&per_page=50"]
    if etag:
        cmd[2:2] = ["-H", f"If-None-Match: {etag}"]
    code, out, err = run(cmd)
    head, _, body = out.partition("\r\n\r\n") if "\r\n\r\n" in out else out.partition("\n\n")
    if " 304 " in head.split("\n", 1)[0]:
        return None, etag
    if code != 0:
        raise RuntimeError(f"gh pulls: {(err or head).strip()[:200]}")
    m = re.search(r"(?im)^etag:\s*(.+?)\s*$", head)
    return json.loads(body), (m.group(1) if m else "")


def _gh_comments(repo, n):
    code, out, err = run(["gh", "api", f"repos/{repo}/issues/{n}/comments?per_page=100"])
    if code != 0:
        raise RuntimeError(f"gh comments #{n}: {err.strip()[:200]}")
    return json.loads(out)


def _gh_view(repo, n):
    # --repo обязателен: без него gh берёт репозиторий из рабочей папки демона (tAIBE), а не из конфига (SE-40).
    code, out, err = run(["gh", "pr", "view", str(n), "--repo", repo,
                          "--json", "files,statusCheckRollup,state,mergedAt"])
    if code != 0:
        raise RuntimeError(f"gh pr view {repo}#{n}: {err.strip()[:200]}")
    d = json.loads(out)
    checks = [c.get("conclusion") or c.get("status") or c.get("state") for c in d.get("statusCheckRollup") or []]
    return [f["path"] for f in d.get("files") or []], checks, d.get("state"), d.get("mergedAt")


# rev 2 (SE-40): состояние rev 1 могло застрять — PR без author/checks и влитые PR в prs. При первом проходе
# нового кода etag сбрасывается: полный список разбирает их заново.
GH_STATE_REV = 2


def poll_github(ctx):
    g = ctx.cfg["github"]
    st = ctx.state.setdefault("github", {"etag": "", "prs": {}})
    if st.get("rev") != GH_STATE_REV:
        st["etag"], st["rev"] = "", GH_STATE_REV
    prs, etag = _gh_list(g["repo"], st.get("etag", ""))
    known = st["prs"]
    fails = []
    if prs is None:
        # 304: список не менялся, но CI мог доехать у PR, ждущего только CI. Сбой — повтор на следующем проходе
        # сам (await_ci не снят), etag не трогаем.
        for n, p in known.items():
            if p.get("await_ci"):
                try:
                    _check_pr(ctx, int(n), p, p["head"], refresh=True)
                except Exception as e:  # noqa: BLE001 — один PR не обрывает проход
                    fails.append(f"#{n}: {e}")
        _raise_fails(fails)
        return
    open_now = set()
    for pr in prs:
        n = pr["number"]
        open_now.add(str(n))
        p = known.setdefault(str(n), {"head": "", "updated": "", "seen": [], "changes_by": []})
        # «author» — признак разобранного PR: в rev 1 head и updated писались до сбоя _gh_view (SE-40).
        if p["updated"] == pr["updated_at"] and p["head"] == pr["head"]["sha"] and "author" in p:
            continue
        if not p["head"]:
            ctx.emit(f"gh:new:{n}", "pr.new", DIGEST, ["coord"], f"#{n} открыт: {pr['title'][:80]}", "github")
        elif p["head"] != pr["head"]["sha"] and p.get("changes_by"):
            roles = sorted({r for r in (quorum.role_of_lens(l, g["lens_roles"]) for l in p["changes_by"]) if r})
            ctx.emit(f"gh:newhead:{n}:{pr['head']['sha']}", "pr.newhead", DIGEST, roles or ["coord"],
                     f"#{n}: новая голова {pr['head']['sha'][:9]} после changes ({', '.join(p['changes_by'])})",
                     "github")
        try:
            _check_pr(ctx, n, p, pr["head"]["sha"])
        except Exception as e:  # noqa: BLE001 — один PR не обрывает проход
            fails.append(f"#{n}: {e}")
            continue
        p["updated"] = pr["updated_at"]  # только после разбора: упавший PR не считается увиденным
    for n in [k for k in known if k not in open_now]:
        try:
            _, _, _, merged = _gh_view(g["repo"], int(n))
        except Exception as e:  # noqa: BLE001 — PR остаётся в prs, повтор на следующем проходе
            fails.append(f"#{n}: {e}")
            continue
        word = "влит" if merged else "закрыт"
        ctx.emit(f"gh:closed:{n}", "pr.closed", DIGEST, ["coord"], f"#{n} {word}", "github")
        del known[n]
    # etag — только после чистого прохода: иначе 304 спрячет недоразобранные PR до следующего изменения списка.
    st["etag"] = "" if fails else etag
    _raise_fails(fails)


def _raise_fails(fails):
    if fails:
        raise RuntimeError(f"PR с ошибкой: {len(fails)}; " + "; ".join(fails))


def _check_pr(ctx, n, p, head, refresh=False):
    g = ctx.cfg["github"]
    head_changed = p["head"] != head
    comments = _gh_comments(g["repo"], n)
    if head_changed or refresh or "author" not in p:
        files, checks, _, _ = _gh_view(g["repo"], n)
        p["author"] = quorum.author_role(files, g["path_roles"])
        p["checks"] = checks
    p["head"] = head  # после запросов: при сбое голова не считается увиденной
    verdicts = []
    for c in comments:
        v = quorum.parse_verdict(c.get("body"), g["lens_roles"])
        if not v:
            continue
        verdicts.append(v)
        if v["verdict"] == "changes" and quorum.on_head(v["sha"], head):
            ctx.emit(f"gh:verdict:{c['id']}", "pr.changes", DIGEST, [p["author"]],
                     f"#{n}: changes от «{v['lens']}» на {v['sha'][:9]}", "github")
    ok, approved, changes, ci = quorum.quorum(verdicts, head, p.get("checks") or [], g["min_lenses"])
    p["changes_by"] = changes
    p["await_ci"] = len(approved) >= g["min_lenses"] and not changes and ci == "pending"
    if ok:
        ctx.emit(f"gh:quorum:{n}:{head}", "pr.quorum", NERVOUS, g["quorum_to"],
                 f"#{n} собран: approve {', '.join(approved)} на {head[:9]}, CI {ci}", "github")


# ---------- Очередь владельца ----------

def _oq_get(ctx, collection):
    url = f"{ctx.cfg['queue']['url'].rstrip('/')}/api/oq/v1/db/{collection}"
    code, out, err = run(["curl", "-sS", "-f", "-m", "20", "-H", "@-", url],
                         stdin=f"Authorization: Bearer {ctx.oq_token()}\n")
    if code != 0:
        raise RuntimeError(f"очередь {collection}: {err.strip()[:120]}")
    return json.loads(out)["docs"]


def route_source(source, rules, default="coord"):
    for pat, role in rules:
        if re.search(pat, source or "", re.I):
            return role
    return default


def poll_queue(ctx):
    q = ctx.cfg["queue"]
    items = {d["id"]: d.get("data") or {} for d in _oq_get(ctx, "items")}
    for c in _oq_get(ctx, "checks"):
        it = items.get(c["id"])
        a = c.get("data") or {}
        if not it or it.get("kind") == "inbox" or not a.get("at"):
            continue
        if not (a.get("done") is True or a.get("choice") is not None or a.get("note")):
            continue
        opt = next((o for o in it.get("options") or [] if o.get("id") == a.get("choice")), None)
        label = (opt or {}).get("label", "")[:60] or str(a.get("choice") or ("сделано" if a.get("done") else "—"))
        role = route_source(str(it.get("source", "")), q["source_roles"])
        ctx.emit(f"oq:answer:{c['id']}:{a['at']}", "owner.answer", NERVOUS, [role],
                 f"ответ владельца {c['id']}: {label}{' · есть заметка' if a.get('note') else ''}", "queue")
    for iid, it in items.items():
        if it.get("kind") != "inbox" or it.get("archived"):
            continue
        ib = it.get("inbox") or {}
        stop = bool(STOP_RE.search(ib.get("text", "")))
        urgent = ib.get("urgency") == "now" or ib.get("severity") == "critical"
        meta = " · ".join(x for x in (ib.get("type"), ib.get("urgency"), ib.get("severity")) if x)
        if stop:
            ctx.emit(f"oq:stop:{iid}", "owner.stop", NERVOUS, [ALL],
                     f"входящее {iid}: стоп/откат от владельца — прочитать oq_get", "queue")
        ctx.emit(f"oq:inbox:{iid}", "owner.inbox", NERVOUS if urgent else DIGEST, ["coord"],
                 f"входящее {iid} ({meta})", "queue")


# ---------- Транскрипты: роли и лимиты ----------

def _first_prompt(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i > 60:
                    break
                if '"type":"user"' not in line and '"type": "user"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                c = (o.get("message") or {}).get("content")
                t = c if isinstance(c, str) else " ".join(
                    b.get("text", "") for b in c or [] if isinstance(b, dict))
                if "ключ реестра" in t:
                    return t
    except OSError:
        pass
    return ""


def map_roles(ctx):
    """Роль → самый свежий транскрипт сессии с «ключ реестра <ключ>». Кэш по пути."""
    t = ctx.cfg["team"]
    cache = ctx.state.setdefault("transcripts", {})
    horizon = ctx.now.timestamp() - t["active_hours"] * 3600
    best = {}
    for p in glob.glob(os.path.join(t["project_dir"], "*.jsonl")):
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        if mt < horizon:
            continue
        if p not in cache:
            m = KEY_RE.search(_first_prompt(p))
            cache[p] = m.group(1) if m else ""
        role = cache[p]
        if role in t["roles"] and (role not in best or mt > best[role][1]):
            best[role] = (p, mt)
    for p in [k for k in cache if not os.path.exists(k)]:
        del cache[p]
    return best


def active_roles(ctx):
    return sorted(map_roles(ctx))


def poll_system(ctx):
    s = ctx.cfg["system"]
    mp = shutil.which("memory_pressure")
    if mp:
        try:
            m = MEM_RE.search(subprocess.run([mp], capture_output=True, text=True, timeout=10).stdout)
        except (OSError, subprocess.SubprocessError):
            m = None
        if m:
            free = int(m.group(1))
            hour = ctx.now.strftime("%Y%m%d%H")
            if free < s["mem_critical"]:
                ctx.emit(f"sys:mem:crit:{hour}", "sys.memory", NERVOUS, ["release", "coord"],
                         f"память Mac: свободно {free}% — тяжёлое не запускать", "system")
            elif free < s["mem_warn"]:
                ctx.emit(f"sys:mem:warn:{hour}", "sys.memory", DIGEST, ["release"],
                         f"память Mac: свободно {free}%", "system")
    hub = ctx.state.setdefault("hub", {"fails": 0, "down_since": ""})
    _, out, _ = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "5", s["hub_health"]], timeout=10)
    if out.strip() == "200":
        if hub["down_since"]:
            ctx.emit(f"sys:hub:up:{hub['down_since']}", "sys.hub", DIGEST, ["release"],
                     f"хаб MCP снова отвечает (лежал с {hub['down_since'][11:16]})", "system")
        hub.update(fails=0, down_since="")
    else:
        hub["fails"] += 1
        if hub["fails"] >= 2 and not hub["down_since"]:
            hub["down_since"] = ctx.now.astimezone(ctx.tz).isoformat(timespec="minutes")
            ctx.emit(f"sys:hub:down:{hub['down_since']}", "sys.hub", NERVOUS, ["release"],
                     "хаб MCP :3050 не отвечает два прохода — npm run mcp-hub:status", "system")


def recent_limit_texts(project_root, since, tail):
    """Отказы по лимиту в хвостах транскриптов, изменённых после since: [(ts, text, path)]."""
    out = []
    floor = since.timestamp()
    for p in glob.glob(os.path.join(project_root, "*", "*.jsonl")):
        try:
            if os.path.getmtime(p) < floor:
                continue
            size = os.path.getsize(p)
            with open(p, "rb") as f:
                if size > tail:
                    f.seek(size - tail)
                data = f.read()
        except OSError:
            continue
        for raw in data.split(b"\n"):
            if b"isApiErrorMessage" not in raw or b"limit" not in raw:
                continue
            try:
                o = json.loads(raw)
            except ValueError:
                continue
            ts = _ts(o.get("timestamp"))
            c = (o.get("message") or {}).get("content")
            text = str(c[0].get("text", "")) if isinstance(c, list) and c and isinstance(c[0], dict) else ""
            if o.get("isApiErrorMessage") and ts and ts >= since and LIMIT_TEXT_RE.search(text):
                out.append((ts, text, p))
    return out


def _ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def utcnow():
    return datetime.now(timezone.utc)


def minutes_ago(now, m):
    return now - timedelta(minutes=m)
