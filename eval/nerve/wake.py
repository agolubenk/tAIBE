"""SE-187: подъём ролей после лимита аккаунта — очередью, не всех разом.

Решение владельца 19.11 17:15 (комментарий `g1xdhvkl…` на SE-187): в сброс 15:00 11 ролей проснулись одновременно,
каждая заново записала в кэш свой контекст 220–270K — около $20 из $45 окна. Поэтому:
1. Сначала coord каждого продукта, потом роли по одной в порядке `team_status.ORDER`. После роли, которую разбудил
   Enter, — пауза `budget.unstick_pause_s` (instances/_shared.json). Роль без клавиш паузы не стоит.
2. Роль без открытого задания (D7: нет события TASK_KINDS ей или всем с момента лимита − `budget.wake_task_lookback_s`,
   4 ч: роль посреди задания, пришедшего до лимита, тоже открыта — Контроль 20.11 08:38, B1) Enter не получает:
   меню закрывается Esc, текст не вводится. Тап роли за время лимита истёк (Monitor живёт 30 мин), поэтому будит
   её Нерв: линия ждёт в st["wake"]["later"], первое задание роли ставит её в конец очереди — Enter с той же
   паузой, ключ `limit:unstick:<подъём>:task:<линия>`. Отложенные линии живут до нового подъёма. coord будится всегда.
3. Пауза владельца (`team_plan.py pause`, ответ «pause» в очереди) или окно 5 ч на `budget.warn_at` — очередь стоит.

Клавиши и экран — `eval/tools/limit_unstick.py`. Здесь — очередь в `state.budget.wake`, ключи журнала, D2 и D7.
Ключ линии `limit:unstick:<подъём>:<линия>` — общий с A: очередь, построенная заново после сбоя прохода, линию с
ключом пропускает, второго текста нет (условие 3 Контроля). Новый подъём заменяет очередь старого: ключи у подъёмов
разные, его роли проходят по новому ключу.
"""
import glob
import os
from datetime import datetime, timedelta

import budget
from journal import ALL, DIGEST, read_from

MARGIN = timedelta(minutes=5)  # отказ за 5 мин до лимита — уже «после лимита»
LOOKBACK_S = 4 * 3600  # budget.wake_task_lookback_s по умолчанию: задание за 4 ч до лимита открывает роль (D7)
TASK_KINDS = ("assign", "reply", "review", "lens", "task")  # coord 20.11 01:52: всё, что адресует роли работу
LATER = "task:"  # ключ линии, разбуженной заданием после подъёма: limit:unstick:<подъём>:task:<линия>
NO_TASK = "no open task"  # исход limit_unstick при wake=False


def _dt(s):
    return datetime.fromisoformat(str(s).replace("Z", "+00:00")) if s else None


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def _slug(c):
    """Продукт контекста в очереди (state переживает перезапуск демона). Без instances/ slug нет — repo_root."""
    return c.cfg.get("slug") or c.cfg.get("repo_root") or ""


def all_ctxs(ctx):
    return [ctx] + list((ctx.peers or {}).values())


def _emit_safe(c, *args, **kw):
    """Запись в журнал продукта: сбой другого продукта не валит бюджет (как nerve.peer_emit)."""
    try:
        return c.emit(*args, **kw)
    except Exception:  # noqa: BLE001
        return False


def fresh(ctxs, pre, line):
    """Ключа линии за этот подъём нет ни в одном журнале продуктов (S4, A)."""
    return all(pre + line not in c.journal.keys for c in ctxs)


def product_of(ctxs, path):
    """SE-187 B: продукт панели — самый длинный repo_root, внутри которого путь панели; иначе продукт по умолчанию."""
    best, n = ctxs[0], -1
    for c in ctxs:
        root = str(c.cfg.get("repo_root") or "").rstrip("/")
        if root and (path == root or path.startswith(root + "/")) and len(root) > n:
            best, n = c, len(root)
    return best


def stuck_after(ctx, hit, reset):
    """D2 (условие 4 Контроля). stuck(сессия): '' — последняя полная запись assistant в хвосте транскрипта — отказ по
    лимиту этого подъёма (время отказа ≥ hit − 5 мин, его сброс — тем же разбором, что у бюджета, — равен reset);
    None — сессия стоит не из-за этого лимита; 'no-transcript' — проверить нельзя (нет sessionId или транскрипта,
    транскрипт не менялся с лимита — устарел после --resume, в хвосте нет полной записи assistant)."""
    floor, want = _dt(hit) - MARGIN, _dt(reset)

    def stuck(sess):
        sid = str(sess.get("sessionId") or "")
        if len(sid) != 36 or not all(ch in "0123456789abcdef-" for ch in sid):
            return "no-transcript"
        paths = glob.glob(os.path.join(ctx.projects_root, "*", sid + ".jsonl"))
        try:
            path = max(paths, key=os.path.getmtime) if paths else ""
            if not path or os.path.getmtime(path) < floor.timestamp():
                return "no-transcript"
            last = budget.last_assistant(path)
        except OSError:
            return "no-transcript"
        if not last or not last[0]:
            return "no-transcript"
        ts, text = last
        m = budget.LIMIT_RE.search(text) if text else None
        if not m or ts < floor:
            return None
        return "" if budget.parse_reset(m.group(2), ts.astimezone(ctx.tz)) == want else None
    return stuck


def open_roles(c, since, off=0):
    """D7: роли продукта, которым после since пришло событие TASK_KINDS. ({роль или ALL}, новый offset журнала)."""
    recs, off = read_from(c.journal.path, off)
    out = set()
    for r in recs:
        ts = _dt(r.get("ts"))
        if r.get("kind") in TASK_KINDS and ts and ts >= since:
            out.update(r.get("to") or [])
    return out, off


def start(ctx, st, tag, hit, reset, label):
    """Подъём: очередь панелей ролей в st["wake"]. Первый шаг — в этом же проходе (`step` после окна 5 ч)."""
    if not ctx.deliver or not ctx.cfg["budget"].get("unstick"):  # выключатель — budget.unstick в instances/_shared.json
        return
    pre, ctxs, old = f"limit:unstick:{tag}:", all_ctxs(ctx), st.get("wake")
    same = bool(old and old["tag"] == tag)  # тот же подъём ещё раз (сброс и A в одном проходе)
    rows = old["rows"] if same else []
    try:
        import limit_unstick
        import team_status
        done = {r[2] for r in rows}
        panes = [p for p in limit_unstick.role_panes() if fresh(ctxs, pre, p[0]) and p[0] not in done]
    except Exception as e:  # noqa: BLE001 — tmux недоступен: роли ждут владельца, как до SE-174
        ctx.emit(f"{pre}error", "nerve.error", DIGEST, ["release"], f"подъём не начат: {type(e).__name__}: "
                 f"{e}"[:200], "budget")
        return
    if old and not same:  # C: итог прерванного подъёма — до замены очереди; уже записанный журнал не повторит
        summary(ctxs, f"limit:unstick:{old['tag']}:", old)
    order = {r: i for i, r in enumerate(team_status.ORDER)}
    panes.sort(key=lambda p: (p[1] != "coord", order.get(p[1], len(order)), p[0]))
    st["wake"] = {"tag": tag, "hit": hit, "reset": reset, "label": label, "rows": rows, "scan": {},
                  "next": old["next"] if same else "", "later": old.get("later", []) if same else [],
                  "lines": [[p[0], p[1], _slug(product_of(ctxs, p[4]))] for p in panes]}


def step(ctx, st, now_l, warn):
    """Шаг очереди: панели по одной, пока очередная не получит Enter; после неё — пауза. warn — окно 5 ч на warn_at.
    Новый лимит до конца очереди — очередь стоит: её заменит подъём этого лимита. Очередь кончилась — итог (C);
    отложенные линии (D7) ждут задания в st["wake"]["later"] до нового подъёма."""
    w = st.get("wake")
    if not w or warn or st.get("limit") or (w["next"] and now_l < _dt(w["next"])):
        return
    pre, ctxs = f"limit:unstick:{w['tag']}:", all_ctxs(ctx)
    by = {_slug(c): c for c in ctxs}
    try:
        import limit_unstick
        if limit_unstick.owner_paused():
            return
        requeue(ctx, w, by)
        while w["lines"]:
            line, role, slug, *later = w["lines"].pop(0)
            c, p = by.get(slug, ctx), pre + LATER if later else pre
            if not fresh(ctxs, p, line):
                continue
            opened = role == "coord" or bool({role, ALL} & opened_roles(ctx, w, by, slug))  # отложенная — тоже
            rows = limit_unstick.unstick(lambda ln: fresh(ctxs, p, ln), stuck=stuck_after(ctx, w["hit"], w["reset"]),
                                         only={line}, wake=opened)
            woke = [record(c, p, w, d, " (задание после подъёма)" if later else "") for d in rows]
            if not opened:  # D7: Esc без Enter — линия ждёт задания роли
                w["later"] += [[d["line"], role, slug] for d in rows if d["action"].endswith(NO_TASK)]
            if any(woke):
                w["next"] = _iso(now_l + timedelta(seconds=ctx.cfg["budget"].get("unstick_pause_s", 180)))
                return
    except Exception as e:  # noqa: BLE001 — tmux или ps недоступны: очередь снята, роли ждут владельца
        _emit_safe(ctx, f"{pre}error", "nerve.error", DIGEST, ["release"], f"подъём прерван: {type(e).__name__}: "
                   f"{e}"[:200], "budget")
        w["later"] = []
    summary(ctxs, pre, w)  # ключ итога один на подъём: проход с одними отложенными линиями его не повторит
    st["wake"] = w if w["later"] else None


def opened_roles(ctx, w, by, slug):
    """D7: роли продукта с заданием с момента лимита − lookback (не меньше MARGIN); журнал читается дальше по offset."""
    scan = w["scan"].setdefault(slug, {"off": 0, "open": []})
    back = max(MARGIN, timedelta(seconds=ctx.cfg["budget"].get("wake_task_lookback_s", LOOKBACK_S)))
    got, scan["off"] = open_roles(by.get(slug, ctx), _dt(w["hit"]) - back, scan["off"])
    scan["open"] = sorted(set(scan["open"]) | got)
    return set(scan["open"])


def requeue(ctx, w, by):
    """Отложенная линия, роли которой пришло задание, — в конец очереди: Enter с той же паузой и ключом LATER.
    Роль в open после своей линии значит, что задание пришло позже: иначе её разбудили бы в первый раз."""
    keep = []
    for line, role, slug in w["later"]:
        if {role, ALL} & opened_roles(ctx, w, by, slug):
            w["lines"].append([line, role, slug, True])
        else:
            keep.append([line, role, slug])
    w["later"] = keep


def record(c, pre, w, d, why=""):
    """Строка линии в журнал продукта (B), строка в итог (C). True — роль разбудил Enter."""
    what = {"menu": "меню лимита", "idle": "ввод после лимита"}
    if d["kind"]:
        _emit_safe(c, pre + d["line"], "limit.unstick", DIGEST, ["coord"],
                   f"{d['role'] or 'роль'} ({d['line']}, панель {d['pane']}), {w['label']}{why}: {what[d['kind']]} — "
                   f"{d['action']}" + (f"; sha256 {d['sha256'][:16]}" if d["sha256"] else ""), "budget",
                   sha256=d["sha256"])
    w["rows"].append([_slug(c), d["role"], d["line"], d["action"]])
    return bool(d.get("woke"))


def summary(ctxs, pre, w):
    """C: итог подъёма в каждом продукте, и пустой."""
    for c in ctxs:
        mine = [r for r in w["rows"] if r[0] == _slug(c)]
        text = f"{w['label']}: панели ролей {len(mine)}" + "".join(
            f"{'; ' if i else ' — '}{role or 'роль'} {line}: {action}" for i, (_, role, line, action) in enumerate(mine))
        _emit_safe(c, pre + "summary", "limit.unstick", DIGEST, ["coord"], text[:1500], "budget")


def due(ctx, st, now_l):
    """A: сброс после раннего подъёма — ещё один подъём с ключом сброса. Если стоит новый лимит с более поздним
    сбросом, роли ждут его: старый пункт снимается без подъёма."""
    items, keep, cur = st.get("unstick_due") or [], [], st.get("limit")
    for d in items:
        if now_l < _dt(d["reset"]):
            keep.append(d)
        elif not (cur and _dt(cur["reset"]) > _dt(d["reset"])):
            start(ctx, st, d["reset"], d["hit"], d["reset"], f"сброс {_dt(d['reset']):%d.%m %H:%M} после раннего "
                  f"подъёма")
    if items:
        st["unstick_due"] = keep
