# -*- coding: utf-8 -*-
"""Авто-действия Нерва (П8, П10; d-pipe-nerve, владелец 28.10: «автозапуск и авто-действия делаем»).

1. Предвестник лимита: окно 5 ч израсходовано на warn_at от квоты окна → всем активным ролям «допиши шаг и
   work_state». Квота окна — медиана расхода до сбоя в последних волнах лимита (калибруется сама на каждой волне).
2. Лимит аккаунта сработал → тапы молчат до сброса; Координатору — одна строка.
3. Сброс лимита → активные роли будятся строкой «лимит снят». Если сброс ночью — в начале дня.
4. Недельный лимит → пункт владельцу в очереди (вид check), один на сброс.
Авто-пауза — по расходу и по факту отказа, не по 502: связь 502 с лимитом не доказана.
"""
import glob
import json
import os
from datetime import datetime, timedelta, timezone

import budget
import sources
from journal import DIGEST, NERVOUS


def _iso(dt):
    return dt.isoformat(timespec="minutes") if dt else ""


def _dt(s):
    return datetime.fromisoformat(s) if s else None


def calibrate_waves(ctx, meter, days=7):
    """Волны лимита окна за прошедшие дни: [{hit, reset, usd}], по одной на сброс."""
    out = []
    for ts, kind, reset in budget.find_limits(ctx.projects_root, ctx.now - timedelta(days=days), ctx.tz):
        if kind != "session" or not reset:
            continue
        out.append({"hit": _iso(ts.astimezone(ctx.tz)), "reset": _iso(reset),
                    "usd": round(meter.total(reset - timedelta(hours=5), ts), 2)})
    return out


def quota5(st, cfg):
    usd = [w["usd"] for w in st["waves"][-cfg["budget"]["waves_for_quota"]:] if w["usd"] > 0]
    q = budget.median(usd)
    return q if q else cfg["budget"]["quota5h_default"]


EVOLVE_DIR = os.path.expanduser(os.environ.get("EVOLVE_STATE_DIR") or "~/.claude/evolve")  # как daily_steps.STATE_DIR


def product_roots(ctx):
    """{slug: repo_root} всех продуктов instances/, и неактивных: их сессии тоже тратят окно (SE-66). Сломанный
    instances/ не останавливает бюджет: тогда только свой продукт, остальное — unattributed."""
    try:
        import products
        _, items = products.load()
        return {slug: d["repo_root"] for slug, d in items.items()}
    except (ImportError, OSError, ValueError, KeyError):
        return {ctx.cfg.get("slug") or "default": ctx.cfg.get("repo_root")}


def product_shares(meter, st_meter, share5, q, ws, now_l, evolve_dir=EVOLVE_DIR):
    """Поля mode.json о долях окна по продуктам (SE-66). Сначала только измерение: решения режима от них не зависят,
    поэтому сбой здесь режим и лимит не держит — вместо долей в mode.json причина (share5_by_error)."""
    try:
        by = meter.by_product(ws, now_l)
        overhead, unknown = budget.evolve_overhead(evolve_dir, ws, now_l)
        out = {"share5_by": budget.shares(share5, by, overhead, q)}
        if unknown:
            out["overhead_unknown"] = unknown
        since = _dt(st_meter.get("products_from"))
        if since:
            out.update(products_from=_iso(since.astimezone(now_l.tzinfo)), products_partial=since > ws)
        return out
    except Exception as e:  # noqa: BLE001 — измерение не валит poll_budget до write_mode
        return {"share5_by_error": f"{type(e).__name__}: {e}"[:200]}


def poll_budget(ctx):
    cfg = ctx.cfg
    b = cfg["budget"]
    st = ctx.state.setdefault("budget", {"meter": {}, "waves": [], "limit": None, "checked": "", "warned": ""})
    meter = budget.Meter(st["meter"], products=budget.Products(product_roots(ctx)))
    limits = meter.update(ctx.projects_root, ctx.now)
    if not st["waves"] and not st.get("calibrated"):
        st["waves"] = calibrate_waves(ctx, meter)
        st["calibrated"] = _iso(ctx.now)
    now_l = ctx.now.astimezone(ctx.tz)
    since = _dt(st["checked"]) or ctx.now - timedelta(minutes=b.get("first_pass_minutes", 30))
    for ts, text in limits:
        if ts >= since - timedelta(minutes=2):
            _on_limit(ctx, st, meter, ts, text)
    st["checked"] = _iso(ctx.now)

    lim = st.get("limit")
    if lim:
        hit = _dt(lim["hit"]) or now_l
        early = meter.total(hit + timedelta(minutes=2), now_l) >= b.get("lift_usd", 0.05)
        if now_l >= _dt(lim["resume"]) or early:
            why = "запросы снова проходят — похоже, сменили аккаунт" if early and now_l < _dt(lim["resume"]) \
                else f"сброс {lim['reset'][11:16]}"
            roles = sources.active_roles(ctx) or ["coord"]
            ctx.emit_account(f"limit:resume:{lim['reset']}", "limit.resume", NERVOUS, roles,
                     f"лимит снят ({why}): продолжай с work_state", "budget")
            st["limit"] = None
            # Сброс прошёл — Esc, и ночью тоже (resume там 08:30, а подъём идёт веткой early). До сброса — смена
            # аккаунта владельцем (SE-187 A): Esc своим ключом, а в сброс — ещё раз (подъём был ложный — роль снова
            # в меню): ключи подъёмов разные, Esc сброса не съеден.
            if now_l >= _dt(lim["reset"]):
                unstick_roles(ctx, lim["reset"], lim["hit"], f"сброс {_dt(lim['reset']):%d.%m %H:%M}")
            else:
                unstick_roles(ctx, f"early:{lim['hit']}", lim["hit"], f"ранний подъём (лимит {lim['hit'][11:16]}, "
                              f"сброс {_dt(lim['reset']):%d.%m %H:%M})")
                st.setdefault("unstick_due", []).append({"reset": lim["reset"], "hit": lim["hit"]})
            lim = None
    unstick_due(ctx, st, now_l)

    q = quota5(st, cfg)
    # Окно 5 ч начинается не раньше последнего отказа: дальше либо простой до сброса (расход 0),
    # либо другой аккаунт со свежим окном. И не раньше прошедшего сброса.
    marks = [d for w in st["waves"] for d in (_dt(w.get("hit")), _dt(w.get("reset"))) if d and d <= now_l]
    ws = budget.window_start(now_l, max(marks) if marks else None, 5)
    used = meter.total(ws, now_l)
    share5 = used / q if q else None
    warned = _dt(st.get("warned"))
    if (share5 is not None and share5 >= b["warn_at"] and not lim
            and (not warned or now_l - warned >= timedelta(hours=5))):
        roles = sources.active_roles(ctx) or ["coord"]
        if ctx.emit_account(f"budget:warn:{_iso(now_l)}", "budget.warn", NERVOUS, roles,
                    f"окно 5 ч израсходовано на {round(share5 * 100)}% (${used:.0f} из ~${q:.0f} до прошлых "
                    f"сбоев): допиши шаг, запиши work_state, тяжёлое не начинай", "budget"):
            st["warned"] = _iso(now_l)
    mode = budget.decide_mode(now_l, share5, _dt(lim["resume"]) if lim else None, cfg)
    mode.update(quota5=round(q, 1), used5=round(used, 1), window_from=_iso(ws),
                week_usd=round(meter.total(budget.week_start(now_l, *_week(cfg))), 1), at=_iso(now_l))
    mode.update(product_shares(meter, st["meter"], share5, q, ws, now_l))
    ctx.write_mode(mode)


def _week(cfg):
    w = cfg["budget"]["week_reset"]
    hh, mm = (int(x) for x in w["time"].split(":"))
    return w["weekday"], hh, mm


def unstick_due(ctx, st, now_l):
    """SE-187 A: сброс после раннего подъёма — ещё один вызов с ключом сброса. Если стоит новый лимит с более поздним
    сбросом, роли ждут его: старый пункт снимается без клавиш."""
    due, keep, cur = st.get("unstick_due") or [], [], st.get("limit")
    for d in due:
        if now_l < _dt(d["reset"]):
            keep.append(d)
        elif not (cur and _dt(cur["reset"]) > _dt(d["reset"])):
            unstick_roles(ctx, d["reset"], d["hit"], f"сброс {_dt(d['reset']):%d.%m %H:%M} после раннего подъёма")
    if due:
        st["unstick_due"] = keep


def _emit_safe(c, *args, **kw):
    """Запись в журнал продукта: сбой другого продукта не валит бюджет (как nerve.peer_emit)."""
    try:
        return c.emit(*args, **kw)
    except Exception:  # noqa: BLE001
        return False


def product_of(ctxs, path):
    """SE-187 B: продукт панели — самый длинный repo_root, внутри которого путь панели; иначе продукт по умолчанию."""
    best, n = ctxs[0], -1
    for c in ctxs:
        root = str(c.cfg.get("repo_root") or "").rstrip("/")
        if root and (path == root or path.startswith(root + "/")) and len(root) > n:
            best, n = c, len(root)
    return best


def stuck_after(ctx, hit):
    """SE-187 D2 (читает код Нерва): последняя запись assistant в транскрипте сессии — отказ по лимиту не раньше hit
    − 5 мин. Нет транскрипта или он не читается — False (клавиш нет)."""
    floor = _dt(hit) - timedelta(minutes=5)

    def stuck(sess):
        sid = str(sess.get("sessionId") or "")
        if len(sid) != 36 or not all(ch in "0123456789abcdef-" for ch in sid):
            return False
        for path in sorted(glob.glob(os.path.join(ctx.projects_root, "*", sid + ".jsonl"))):
            try:
                last = budget.last_assistant(path)
            except OSError:
                continue
            return bool(last and last[1] and last[0] and last[0] >= floor)
        return False
    return stuck


def unstick_roles(ctx, tag, hit, label):
    """SE-174: на подъёме закрыть меню лимита Claude Code в панелях ролей (eval/tools/limit_unstick.py); SE-187 D —
    разбудить сессию idle после отказа. Триггер — подъём в самом демоне, не событие журнала (S4). Один ключ на линию
    за подъём — во всех журналах продуктов. Строка линии и итог — в журнал продукта панели (B, C). Сбой не валит
    бюджет."""
    if not ctx.deliver or not ctx.cfg["budget"].get("unstick"):  # выключатель — budget.unstick в instances/_shared.json
        return
    pre = f"limit:unstick:{tag}:"
    ctxs = [ctx] + list((ctx.peers or {}).values())
    try:
        import limit_unstick
        rows = limit_unstick.unstick(lambda line: all(pre + line not in c.journal.keys for c in ctxs),
                                     stuck=stuck_after(ctx, hit))
    except Exception as e:  # noqa: BLE001 — tmux или ps недоступны: роли ждут владельца, как до SE-174
        ctx.emit(f"{pre}error", "nerve.error", DIGEST, ["release"], f"меню лимита не закрыто: {type(e).__name__}: "
                 f"{e}"[:200], "budget")
        return
    what = {"menu": "меню лимита", "idle": "ввод после лимита"}
    by = {id(c): [] for c in ctxs}
    for d in rows:
        c = product_of(ctxs, d["path"])
        by[id(c)].append(d)
        if d["kind"]:
            _emit_safe(c, pre + d["line"], "limit.unstick", DIGEST, ["coord"],
                       f"{d['role'] or 'роль'} ({d['line']}, панель {d['pane']}), {label}: {what[d['kind']]} — "
                       f"{d['action']}" + (f"; sha256 {d['sha256'][:16]}" if d["sha256"] else ""), "budget",
                       sha256=d["sha256"])
    for c in ctxs:  # C: итог в каждом продукте, и пустой
        mine = by[id(c)]
        text = f"{label}: панели ролей {len(mine)}" + ("".join(
            f"{'; ' if i else ' — '}{d['role'] or 'роль'} {d['line']}: {d['action']}" for i, d in enumerate(mine)))
        _emit_safe(c, pre + "summary", "limit.unstick", DIGEST, ["coord"], text[:1500], "budget")


def _on_limit(ctx, st, meter, ts, text):
    m = budget.LIMIT_RE.search(text)
    if not m:
        return
    kind = "weekly" if "weekly" in m.group(1).lower() else "session"
    ts_l = ts.astimezone(ctx.tz)
    reset = budget.parse_reset(m.group(2), ts_l)
    if not reset:
        return
    key = f"limit:{kind}:{_iso(reset)}"
    if key in ctx.journal.keys:
        return
    ctx.emit_account(key, "limit.hit", NERVOUS, ["coord"],
             f"лимит аккаунта ({'неделя' if kind == 'weekly' else 'окно 5 ч'}) в {ts_l:%H:%M}: команда стоит до "
             f"{reset:%d.%m %H:%M}, Нерв разбудит роли сам", "budget")
    if kind == "session" and all(w.get("reset") != _iso(reset) for w in st["waves"]):
        st["waves"].append({"hit": _iso(ts_l), "reset": _iso(reset),
                            "usd": round(meter.total(reset - timedelta(hours=5), ts), 2)})
        st["waves"] = st["waves"][-50:]
    resume = budget.resume_at(reset, ctx.cfg)
    cur = st.get("limit")
    if not cur or _dt(cur["resume"]) < resume:
        st["limit"] = {"kind": kind, "hit": _iso(ts_l), "reset": _iso(reset), "resume": _iso(resume)}
    if kind == "weekly" and ctx.cfg["queue"]["owner_items"] and ctx.deliver:
        owner_item(ctx, f"c-nerve-weekly-{reset:%Y%m%d}",
                   f"Нерв: недельный лимит Claude исчерпан, сброс {reset:%d.%m %H:%M}",
                   f"Отказ «hit your weekly limit» в {ts_l:%d.%m %H:%M}. Команда стоит до сброса.\n\n"
                   f"Нерв сам разбудит активные роли в {resume:%d.%m %H:%M}. Если нужен другой аккаунт раньше — "
                   f"переключите и отметьте «сделано».")


def owner_item(ctx, iid, title, body):
    """Пункт владельцу: сначала GET — существующий не перезаписывается."""
    base = f"{ctx.cfg['queue']['url'].rstrip('/')}/api/oq/v1/db/items/{iid}"
    hdr = f"Authorization: Bearer {ctx.oq_token()}\n"
    code, out, _ = sources.run(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "-m", "20", "-H", "@-", base],
                               stdin=hdr)
    if out.strip() == "200":
        return False
    data = {"data": {"kind": "check", "title": title[:200], "body": body, "added": ctx.now.astimezone(ctx.tz).strftime(
        "%Y-%m-%d"), "source": "nerve (supertick-eval/nerve, демон на Mac)"}}
    payload = os.path.join(ctx.state_dir, f"oq-{iid}.json")
    with open(payload, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    try:
        code, out, err = sources.run(["curl", "-sS", "-f", "-m", "20", "-X", "PUT", "-H", "@-", "-H",
                                      "Content-Type: application/json", "--data-binary", f"@{payload}", base],
                                     stdin=hdr)
    finally:
        os.remove(payload)
    if code != 0:
        raise RuntimeError(f"очередь PUT {iid}: {err.strip()[:120]}")
    return True


def utcnow():
    return datetime.now(timezone.utc)
