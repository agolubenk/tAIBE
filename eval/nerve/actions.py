# -*- coding: utf-8 -*-
"""Авто-действия Нерва (П8, П10; d-pipe-nerve, владелец 28.10: «автозапуск и авто-действия делаем»).

1. Предвестник лимита: окно 5 ч израсходовано на warn_at от квоты окна → всем активным ролям «допиши шаг и
   work_state». Квота окна — медиана расхода до сбоя в последних волнах лимита (калибруется сама на каждой волне).
2. Лимит аккаунта сработал → тапы молчат до сброса; Координатору — одна строка.
3. Сброс лимита → активные роли будятся строкой «лимит снят». Если сброс ночью — в начале дня.
4. Недельный лимит → пункт владельцу в очереди (вид check), один на сброс.
Авто-пауза — по расходу и по факту отказа, не по 502: связь 502 с лимитом не доказана.
"""
import json
import os
from datetime import datetime, timedelta, timezone

import budget
import sources
from journal import NERVOUS


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


def poll_budget(ctx):
    cfg = ctx.cfg
    b = cfg["budget"]
    st = ctx.state.setdefault("budget", {"meter": {}, "waves": [], "limit": None, "checked": "", "warned": ""})
    meter = budget.Meter(st["meter"])
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
            getattr(ctx, "emit_account", ctx.emit)(f"limit:resume:{lim['reset']}", "limit.resume", NERVOUS, roles,
                     f"лимит снят ({why}): продолжай с work_state", "budget")
            st["limit"] = None
            lim = None

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
        if getattr(ctx, "emit_account", ctx.emit)(f"budget:warn:{_iso(now_l)}", "budget.warn", NERVOUS, roles,
                    f"окно 5 ч израсходовано на {round(share5 * 100)}% (${used:.0f} из ~${q:.0f} до прошлых "
                    f"сбоев): допиши шаг, запиши work_state, тяжёлое не начинай", "budget"):
            st["warned"] = _iso(now_l)
    mode = budget.decide_mode(now_l, share5, _dt(lim["resume"]) if lim else None, cfg)
    mode.update(quota5=round(q, 1), used5=round(used, 1), window_from=_iso(ws),
                week_usd=round(meter.total(budget.week_start(now_l, *_week(cfg))), 1), at=_iso(now_l))
    ctx.write_mode(mode)


def _week(cfg):
    w = cfg["budget"]["week_reset"]
    hh, mm = (int(x) for x in w["time"].split(":"))
    return w["weekday"], hh, mm


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
    getattr(ctx, "emit_account", ctx.emit)(key, "limit.hit", NERVOUS, ["coord"],
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
