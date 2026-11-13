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
            team = ctx.cfg["team"]["roles"]
            roles = sorted({r for r in (quorum.role_of_lens(l, g["lens_roles"], team) for l in p["changes_by"]) if r})
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
        v = quorum.parse_verdict(c.get("body"), g["lens_roles"], ctx.cfg["team"]["roles"])
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

# ETag и последний список — в памяти процесса: демон `nerve.py run` живёт весь процесс, Ctx — один проход. Тег на
# диске без документов после рестарта дал бы 304 без данных; рестарт стоит один полный запрос. url → (etag, docs, meta).
_OQ_CACHE = {}
# RFC 9110 etagc: без пробелов и управляющих символов — тег уходит обратно строкой заголовка в stdin curl.
_OQ_TAG_RE = re.compile(r'^(W/)?"[\x21\x23-\x7e]*"$')


def _oq_get(ctx, collection):
    """Список коллекции условным сжатым запросом: 304 — прежние docs из памяти, без тела. Возвращает (docs, meta);
    meta — {"total", "limit"}, когда консоль обрезала список потолком (поле truncated ответа), иначе {}."""
    url = f"{ctx.cfg['queue']['url'].rstrip('/')}/api/oq/v1/db/{collection}"
    cached = _OQ_CACHE.get(url)
    headers = f"Authorization: Bearer {ctx.oq_token()}\n" + (f"If-None-Match: {cached[0]}\n" if cached else "")
    code, out, err = run(["curl", "-sS", "-f", "--compressed", "-m", "20", "-H", "@-",
                          "-w", "\n%{http_code} %{size_download} %{size_header} %{size_request} %header{etag}", url],
                         stdin=headers)
    if code != 0:
        raise RuntimeError(f"очередь {collection}: {err.strip()[:120]}")
    body, _, tail = out.rpartition("\n")
    status, down, head, req, etag = (tail.split(" ", 4) + [""] * 5)[:5]
    _oq_count(ctx, sum(int(x or 0) for x in (down, head, req)))
    if status == "304":
        if not cached:
            raise RuntimeError(f"очередь {collection}: 304 без запомненного списка")
        return cached[1], cached[2]
    j = json.loads(body)
    meta = {k: j.get(k) for k in ("total", "limit")} if j.get("truncated") is True else {}
    etag = etag.strip()
    # curl < 7.84 не знает %header{} и печатает его как есть — такой «тег» не шлём, просто опрашиваем без 304.
    if _OQ_TAG_RE.match(etag):
        _OQ_CACHE[url] = (etag, j["docs"], meta)
    else:
        _OQ_CACHE.pop(url, None)
    return j["docs"], meta


# Дельта очереди (OPS-50, HR #623 — GET /api/oq/v1/changes): полный список один раз, дальше — только изменённые
# документы и удалённые id после курсора. Состояние — в памяти процесса, как _OQ_CACHE: после рестарта — один полный
# список. Включается `queue.delta: true`; без него и при сбое /changes — прежний список /db/:col (_oq_get).
_OQ_DELTA = {}
_OQ_DELTA_COLS = ("checks", "items")
_OQ_FULL_EVERY = 12 * 3600      # полный список раз в 12 ч — страховка от правки базы консоли мимо журнала событий
_OQ_DELTA_BACKOFF = 1800        # /changes не ответил (не 410) — 30 мин прежний список, потом новая попытка


def _oq_curl(ctx, url):
    """(HTTP-код, тело) одного запроса к очереди; байты — в счётчик. Без -f: 410 — ответ консоли, а не сбой curl."""
    code, out, err = run(["curl", "-sS", "--compressed", "-m", "20", "-H", "@-",
                          "-w", "\n%{http_code} %{size_download} %{size_header} %{size_request}", url],
                         stdin=f"Authorization: Bearer {ctx.oq_token()}\n")
    if code != 0:
        raise RuntimeError(f"очередь /changes: {err.strip()[:120]}")
    body, _, tail = out.rpartition("\n")
    status, down, head, req = (tail.split(" ", 3) + [""] * 4)[:4]
    _oq_count(ctx, sum(int(x or 0) for x in (down, head, req)))
    return status, body


def _oq_delta(ctx, now):
    """{коллекция: (docs, meta)} по /changes: дельта от курсора; нет курсора, 410 или пора — полный список."""
    st = _OQ_DELTA
    base = f"{ctx.cfg['queue']['url'].rstrip('/')}/api/oq/v1/changes?col={','.join(_OQ_DELTA_COLS)}"
    if st.get("base") != base or now - st.get("full_at", 0) >= _OQ_FULL_EVERY:
        st.clear()
    if st.get("cursor"):
        status, body = _oq_curl(ctx, f"{base}&since={st['cursor']}")
        if status == "200":
            j = json.loads(body)
            for col in _OQ_DELTA_COLS:
                ch, docs = j["changes"][col], st["docs"][col]
                for i in ch["removed"]:
                    docs.pop(i, None)
                for d in ch["docs"]:
                    docs[d["id"]] = d
            st["cursor"] = j["cursor"]
            return _oq_view(st)
        if status != "410":
            raise RuntimeError(f"очередь /changes: HTTP {status}")
    status, body = _oq_curl(ctx, base)
    if status != "200":
        raise RuntimeError(f"очередь /changes (полный список): HTTP {status}")
    j = json.loads(body)
    if j.get("full") is not True or not isinstance(j.get("cursor"), str):
        raise RuntimeError("очередь /changes: ответ без full и cursor")
    lists = j["collections"]
    st.clear()
    st.update(base=base, cursor=j["cursor"], full_at=now,
              docs={col: {d["id"]: d for d in lists[col]["docs"]} for col in _OQ_DELTA_COLS},
              meta={col: ({k: lists[col].get(k) for k in ("total", "limit")} if lists[col].get("truncated") is True
                          else {}) for col in _OQ_DELTA_COLS})
    return _oq_view(st)


def _oq_view(st):
    """Списки как у /db/:col: свежие первыми; meta — обрезка потолком последнего полного списка."""
    return {col: (sorted(st["docs"][col].values(), key=lambda d: d.get("updatedAt") or 0, reverse=True),
                  st["meta"][col]) for col in _OQ_DELTA_COLS}


def _oq_lists(ctx):
    """{коллекция: (docs, meta)} для items и checks. Дельта — если включена и не на паузе; сбой дельты (старая консоль
    без /changes, сеть, разбор) — пауза _OQ_DELTA_BACKOFF и прежний список в этом же проходе."""
    now = ctx.now.timestamp()
    if ctx.cfg["queue"].get("delta") and now >= _OQ_DELTA.get("off_until", 0):
        try:
            return _oq_delta(ctx, now)
        except (RuntimeError, ValueError, KeyError, TypeError, AttributeError) as e:
            _OQ_DELTA.clear()
            _OQ_DELTA["off_until"] = now + _OQ_DELTA_BACKOFF
            ctx.emit(f"oq:delta:{ctx.now.astimezone(ctx.tz):%Y-%m-%d}", "queue.delta", DIGEST, ["release"],
                     f"дельта очереди /changes не работает ({str(e)[:160]}) — Нерв на прежнем полном списке, "
                     f"повтор через {_OQ_DELTA_BACKOFF // 60} мин", "queue")
    return {col: _oq_get(ctx, col) for col in ("items", "checks")}


def _oq_count(ctx, n):
    """Байты опроса очереди по дням (сжатое тело, заголовки ответа и запрос — как по сети; TLS-рукопожатие нового
    процесса curl, около 4 КБ на вызов по оценке, curl не сообщает) — приёмка фазы 0 «Нерв ≤ 50 МБ в сутки».
    prev — итог прошлого дня: его видно в state.json без журнала."""
    b = ctx.state.setdefault("queue", {}).setdefault("bytes", {})
    day = ctx.now.astimezone(ctx.tz).strftime("%Y-%m-%d")
    if b.get("day") != day:
        if b.get("day"):
            b["prev"] = {"day": b["day"], "n": b.get("n", 0), "calls": b.get("calls", 0)}
            _oq_bytes_watch(ctx, b["prev"])
        b.update(day=day, n=0, calls=0)
    b["n"] += n
    b["calls"] += 1


# Байт на вызов curl сверх счётчика: новое TLS-соединение на каждый процесс; curl его не сообщает — оценка фазы 0.
_OQ_TLS_EST = 4096


def _oq_bytes_watch(ctx, prev):
    """Итог прошлых суток с оценкой TLS выше порога (по умолчанию 40 МБ при цели 50) — в сводку release, раз в неделю:
    ежедневный повтор — шум. С дельтой /changes (OPS-50) порог — признак, что дельта выключена или на паузе."""
    warn = ctx.cfg["queue"].get("bytes_warn", 40_000_000)
    tls = prev["calls"] * _OQ_TLS_EST
    if prev["n"] + tls > warn:
        year, week, _ = datetime.strptime(prev["day"], "%Y-%m-%d").isocalendar()
        ctx.emit(f"oq:bytes:{year}-W{week:02d}", "queue.bytes", DIGEST, ["release"],
                 f"Нерв: {(prev['n'] + tls) / 1e6:.1f} МБ опроса очереди за {prev['day']} (из них TLS ≈ {tls / 1e6:.1f}, "
                 f"оценка; порог {warn / 1e6:.0f}, цель ≤ 50) — проверь дельту /changes: queue.delta включён, сводка "
                 f"queue.delta молчит (OPS-50)",
                 "queue")


def _oq_watch(ctx, collection, meta):
    """Обрезка потолком — сразу роли release: ответы владельца на выпавшие пункты Нерв не видит."""
    if meta:
        ctx.emit(f"oq:capped:{collection}:{ctx.now.astimezone(ctx.tz):%Y-%m-%d}", "queue.capped", NERVOUS, ["release"],
                 f"очередь {collection}: консоль отдала {meta.get('limit')} из {meta.get('total')} — ответы владельца "
                 f"на старые пункты Нерв не видит, нужен /changes", "queue")


def route_source(source, rules, default="coord"):
    for pat, role in rules:
        if re.search(pat, source or "", re.I):
            return role
    return default


def poll_queue(ctx):
    q = ctx.cfg["queue"]
    lists = _oq_lists(ctx)
    item_docs, item_meta = lists["items"]
    checks, check_meta = lists["checks"]
    _oq_watch(ctx, "items", item_meta)
    _oq_watch(ctx, "checks", check_meta)
    items = {d["id"]: d.get("data") or {} for d in item_docs}
    product = {d["id"]: d.get("product") for d in item_docs}       # v2-lite (#95): продукт документа, если есть
    for c in checks:
        it = items.get(c["id"])
        a = c.get("data") or {}
        if not it or it.get("kind") == "inbox" or not a.get("at"):
            continue
        if not (a.get("done") is True or a.get("choice") is not None or a.get("note")):
            continue
        opt = next((o for o in it.get("options") or [] if o.get("id") == a.get("choice")), None)
        label = (opt or {}).get("label", "")[:60] or str(a.get("choice") or ("сделано" if a.get("done") else "—"))
        # R-6: продукт пункта — по `queue.match` (id содержит `-taibe-`), не по папке сессии-автора; роль — его правилами.
        target = ctx.for_item(c["id"], product.get(c["id"]))
        role = route_source(str(it.get("source", "")), target.cfg["queue"]["source_roles"])
        _emit_to(ctx, target, f"oq:answer:{c['id']}:{a['at']}", "owner.answer", NERVOUS, [role],
                 f"ответ владельца {c['id']}: {label}{' · есть заметка' if a.get('note') else ''}", "queue")
    for iid, it in items.items():
        if it.get("kind") != "inbox" or it.get("archived"):
            continue
        ib = it.get("inbox") or {}
        stop = bool(STOP_RE.search(ib.get("text", "")))
        urgent = ib.get("urgency") == "now" or ib.get("severity") == "critical"
        meta = " · ".join(x for x in (ib.get("type"), ib.get("urgency"), ib.get("severity")) if x)
        # R-7: продукт входящего задал владелец (v2-lite) — его coord и его стоп; не задан — coord продукта по
        # умолчанию, стоп во все журналы (продукт неизвестен).
        own = ctx.for_item(iid, product.get(iid)) if product.get(iid) else None
        if stop:
            for target in [own] if own else [ctx, *(ctx.peers or {}).values()]:
                _emit_to(ctx, target, f"oq:stop:{iid}", "owner.stop", NERVOUS, [ALL],
                         f"входящее {iid}: стоп/откат от владельца — прочитать oq_get", "queue")
        _emit_to(ctx, own or ctx, f"oq:inbox:{iid}", "owner.inbox", NERVOUS if urgent else DIGEST, ["coord"],
                 f"входящее {iid} ({meta})", "queue")


def _emit_to(ctx, target, *args):
    """Запись в журнал своего или другого продукта; сбой другого продукта не останавливает обход очереди."""
    if target is ctx:
        return ctx.emit(*args)
    import nerve
    return nerve.peer_emit(target, lambda p: p.emit(*args))


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
    # R-9: сессии в worktree получают свою папку проекта (`<project_dir>-worktrees-<track>-<topic>`).
    paths = glob.glob(os.path.join(t["project_dir"], "*.jsonl")) + \
        glob.glob(os.path.join(t["project_dir"].rstrip("/") + "-worktrees-*", "*.jsonl"))
    for p in paths:
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        if mt < horizon:
            cache.pop(p, None)          # кэш — только свежих: worktree-папок сотни (R-9), state.json пишется каждый проход
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
    # OPS-44: хаб и Serena — release и coord, команда из папки tAIBE; LaunchAgent хаба — раз в сутки release.
    hub = ctx.state.setdefault("hub", {"fails": 0, "down_since": ""})
    _probe_watch(ctx, hub, "hub", "хаб MCP :3050", _http_code(s["hub_health"]) == "200")
    probes = ctx.state.setdefault("probes", {})
    for url in s.get("serena_mcp") or []:
        port = url.split("://", 1)[-1].split("/", 1)[0].rsplit(":", 1)[-1]
        st = probes.setdefault(f"serena:{port}", {"fails": 0, "down_since": ""})
        # Serena отдаёт MCP по streamable HTTP: на голый GET — 4xx, это «слушает»; 000 — порт закрыт.
        _probe_watch(ctx, st, f"serena:{port}", f"Serena :{port}", _http_code(url) not in ("", "000"))
    day = ctx.now.astimezone(ctx.tz).strftime("%Y%m%d")
    for label in _launch_agents_missing(s.get("launch_agents") or []):
        ctx.emit(f"sys:agent:{label}:{day}", "sys.hub", DIGEST, ["release"],
                 f"LaunchAgent {label} не загружен — хаб не поднимется сам после входа в систему; {HUB_HINT}",
                 "system")


HUB_HINT = "в папке tAIBE: npm run mcp-hub:status"


def _http_code(url):
    """HTTP-код ответа или «000» (нет соединения); тело не читается."""
    _, out, _ = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "5", url], timeout=10)
    return out.strip()


def _probe_watch(ctx, st, key, title, ok):
    """Два прохода подряд без ответа — нервное событие release и coord; ожил — сводка release."""
    if ok:
        if st.get("down_since"):
            ctx.emit(f"sys:{key}:up:{st['down_since']}", "sys.hub", DIGEST, ["release"],
                     f"{title} снова отвечает (лежал с {st['down_since'][11:16]})", "system")
        st.update(fails=0, down_since="")
        return
    st["fails"] = st.get("fails", 0) + 1
    if st["fails"] >= 2 and not st.get("down_since"):
        st["down_since"] = ctx.now.astimezone(ctx.tz).isoformat(timespec="minutes")
        ctx.emit(f"sys:{key}:down:{st['down_since']}", "sys.hub", NERVOUS, ["release", "coord"],
                 f"{title} не отвечает два прохода — {HUB_HINT}", "system")


def _launch_agents_missing(labels):
    """Метки LaunchAgent, которых нет в gui-домене пользователя (launchctl print ≠ 0). Нет launchctl, сбой или зависание
    вызова — метка не проверена, а не «не загружена»."""
    if not labels or not shutil.which("launchctl"):
        return []
    missing = []
    for label in labels:
        try:
            rc = run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], timeout=10)[0]
        except (OSError, subprocess.SubprocessError):
            continue
        if rc != 0:
            missing.append(label)
    return missing


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
