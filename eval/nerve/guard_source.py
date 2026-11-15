# -*- coding: utf-8 -*-
"""Читатель прогонов сторожей: результаты CI на ветке → маршрут пространства досок (TB-45, срез S45-4b, спека v0.8).

Спека — docs/specs/r100-permanent-questions.md, правило 7 и S45-4b. Здесь общая часть вариантов ключа A1 и A2 (пункт
владельца taibe-d-f453-fact-1511): чтение прогонов ветки, курсор, исходящий ящик тел POST /api/forest/{ws}/guard-runs,
разбор ответов и перечитывание красных. Сопоставляет сервер: список карточек Нерв не читает. Клиент досок (`post`),
ключ и место в POLLS — следующий шаг, после ответа владельца и маршрута S45-4a.

Чтение — один `gh api repos/<repo>/actions/runs?branch=…&created=>=<курсор>` не чаще раза в GUARD_EVERY. REST, а не
`gh run list`: путь файла workflow (`path`), по которому карточка называет сторожа, есть только в REST. Прогон весит
~14 КБ JSON (замер 15.11: 20 прогонов — 310 КБ), поэтому два ограничения. Курсор: читаются только прогоны, созданные
не раньше самого старого незавершённого, а если все завершены — самого нового. Повтор того же запроса идёт с
If-None-Match: пока прогоны не менялись, GitHub отвечает 304 без тела, и такой ответ не тратит лимит запросов.

Прочитанный результат ложится в ящик (`outbox`) — часть state.json, его пишет тот же проход, что двигает курсор.
Поэтому курсор и ETag двигаются сразу: прогон, который доски ещё не приняли, ждёт в ящике, а не в повторном чтении
(иначе после 429 или 401 тот же запрос с If-None-Match получил бы 304, и неотправленное ждало бы следующего push).
Прогон покидает ящик только по 2xx или по коду, который повтор не исправит (400, 413, 422). Правило v0.8 «пока
ящик не пуст, чтение без If-None-Match» здесь не нужно: ответ 304 не прячет неотправленное, оно уже в ящике.
"""
import json
import re
import urllib.parse
from datetime import datetime, timedelta, timezone

import sources
from journal import DIGEST, NERVOUS

GUARD_EVERY = 300                    # секунд между чтениями: сторожу хватает задержки до 5 минут (F-45-3)
GUARD_PER_PAGE = 50                  # прогонов за чтение; после долгого простоя Mac более старые пропускаются
FIRST_LOOKBACK = timedelta(hours=1)  # первое чтение — прогоны последнего часа, не вся история ветки
PENDING_MAX = timedelta(hours=6)     # незавершённый прогон старше не держит курсор, красный старше не перечитывается
SUMMARY_MAX = 500                    # предел `summary` маршрута в единицах UTF-16, как считает zod (правило 7)
OUTBOX_MAX = 200                     # тел в ящике (~0,5 КБ каждое): state.json пишется каждый проход
DRAIN_MAX = 50                       # POST за проход (60 с): лимит ключа — 100 запросов в минуту (auth.ts:742-746)
GREEN, RED = {"success"}, {"failure", "timed_out", "startup_failure"}
# cancelled, skipped, neutral, action_required, stale — не результат проверки: такой прогон не шлётся.
DROP = {400, 413, 422}               # тело не исправит повтор: прогон отбрасывается, событие координатору
DENIED = {401: ["coord", "release"], 403: ["coord", "release"], 404: ["coord"]}   # эпизод отказа, ящик ждёт
ANSWERED = DROP | set(DENIED) | {429}  # доски ответили: 429 — повтор позже; прочее не 2xx — сбой (5xx, сеть, неожиданный)
FAILS_MAX = 2                        # сбой дольше FAILS_MAX чтений подряд — событие координатору, одно на эпизод
ISO = "%Y-%m-%dT%H:%M:%SZ"
_HEAD_BODY = re.compile(r"\r?\n\r?\n")


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime(ISO)


def _day(ctx):
    return ctx.now.astimezone(timezone.utc).strftime("%Y-%m-%d")


def _state(ctx):
    st = ctx.state.setdefault("guard", {})
    for key, empty in (("seen", dict), ("outbox", list), ("hit", dict), ("reds", dict)):
        st.setdefault(key, empty())
    return st


def cut_utf16(text, limit=SUMMARY_MAX):
    """Не больше limit единиц UTF-16 (`length` в JS и zod); половина суррогатной пары отбрасывается."""
    return text.encode("utf-16-le")[:2 * limit].decode("utf-16-le", "ignore")


def _gh_get(path, etag=""):
    """`gh api -i <path>`: (etag, JSON) или None на 304. Сбой gh — RuntimeError."""
    cmd = ["gh", "api", "-i", path]
    if etag:
        cmd[3:3] = ["-H", f"If-None-Match: {etag}"]
    code, out, err = sources.run(cmd)
    if code != 0 and out.split(" ", 2)[1:2] == ["304"]:
        return None
    if code != 0:
        raise RuntimeError(f"gh {path.split('?', 1)[0]}: {(err or out).strip()[:200]}")
    head, body = _HEAD_BODY.split(out, 1)
    new_etag = next((ln.split(":", 1)[1].strip() for ln in head.splitlines() if ln.lower().startswith("etag:")), "")
    return new_etag, json.loads(body)


def _parse(r):
    return {"id": r["id"], "attempt": r.get("run_attempt") or 1, "path": r.get("path") or "",
            "name": r.get("name") or "", "number": r.get("run_number"), "status": r.get("status") or "",
            "conclusion": r.get("conclusion") or "", "url": r.get("html_url") or "", "sha": r.get("head_sha") or "",
            "created": r["created_at"], "updated": r.get("updated_at") or r["created_at"]}


def _gh_runs(repo, branch, since, etag=""):
    """Прогоны ветки, созданные не раньше since: (etag, total_count, прогоны) или None на 304."""
    q = urllib.parse.urlencode({"branch": branch, "created": f">={since}", "per_page": GUARD_PER_PAGE})
    got = _gh_get(f"repos/{repo}/actions/runs?{q}", etag)
    if got is None:
        return None
    new_etag, d = got
    runs = [_parse(r) for r in d.get("workflow_runs") or []]
    return new_etag, d.get("total_count", len(runs)), runs


def next_since(runs, since, now):
    """Курсор следующего чтения: created самого старого незавершённого прогона (он ещё даст результат), иначе —
    самого нового. Граница включительная: прогоны одного push создаются в одну секунду и приходят не все сразу."""
    floor = _iso(now - PENDING_MAX)
    pending = [r["created"] for r in runs if r["status"] != "completed" and r["created"] >= floor]
    if pending:
        return min(pending)
    return max([since] + [r["created"] for r in runs])


def to_body(run, repo, branch):
    """Тело POST /api/forest/{ws}/guard-runs (правило 7) или None, если прогон — не результат проверки.

    `path` — как в ответе GitHub, суффикс `@<ref>` срезает сервер; `source` ставит сервер по ключу вызывающего."""
    if run["status"] != "completed" or run["conclusion"] not in GREEN | RED:
        return None
    url = run["url"] + (f"/attempts/{run['attempt']}" if run["attempt"] > 1 else "")
    summary = f"{run['name']} #{run['number']}: {run['conclusion']} на {run['sha'][:9]} ({branch})"
    return {"repo": repo, "path": run["path"], "runUrl": url, "status": "green" if run["conclusion"] in GREEN else "red",
            "ranAt": run["updated"], "runCreatedAt": run["created"], "attempt": run["attempt"], "runId": run["id"],
            "summary": cut_utf16(summary)}


def _order(entry):
    """Порядок пары (runCreatedAt, attempt) и id прогона третьим ключом: push и schedule в одну секунду (N11)."""
    b = entry["body"]
    return b["runCreatedAt"], b["attempt"], entry["id"]


def _queue(st, run, repo, branch):
    """Кладёт результат прогона в ящик по порядку пары. True — положен; повтор «id:попытка» и не результат — нет."""
    key = f"{run['id']}:{run['attempt']}"
    body = to_body(run, repo, branch)
    if body is None or key in st["seen"]:
        return False
    st["seen"][key] = run["created"]
    st["outbox"].append({"id": run["id"], "body": body})
    st["outbox"].sort(key=_order)
    return True


def read_results(ctx, repo, branch):
    """Страница прогонов ветки → ящик: (число новых результатов, число прогонов вне страницы).

    Сбой gh — исключение, состояние не меняется: следующий проход прочитает то же."""
    st = _state(ctx)
    since = st.get("since") or _iso(ctx.now - FIRST_LOOKBACK)
    etag = st.get("etag", "") if st.get("etag_since") == since else ""
    got = _gh_runs(repo, branch, since, etag)
    st["at"] = _iso(ctx.now)
    if got is None:
        return 0, 0
    new_etag, total, runs = got
    queued = sum(_queue(st, run, repo, branch) for run in runs)
    st["since"] = next_since(runs, since, ctx.now)
    st["seen"] = {k: c for k, c in st["seen"].items() if c >= st["since"]}
    st["etag"], st["etag_since"] = new_etag, since
    return queued, max(0, total - len(runs))


def recheck(ctx, repo, branch):
    """Перезапуск (`run_attempt` растёт, `created_at` прежний) фильтр `created` не видит. Поэтому за чтение —
    `GET runs/{id}` с If-None-Match у самого нового красного с matched > 0 каждого path, не старше PENDING_MAX (N4):
    правило 7 перезапуск не последнего прогона всё равно не применит. Возвращает число новых попыток в ящике."""
    st = _state(ctx)
    floor = _iso(ctx.now - PENDING_MAX)
    queued = 0
    for path, red in list(st["reds"].items()):
        if red["ranAt"] < floor:
            del st["reds"][path]
            continue
        got = _gh_get(f"repos/{repo}/actions/runs/{red['id']}", red.get("etag", ""))
        if got is None:
            continue
        red["etag"], d = got
        run = _parse(d)
        if run["attempt"] > red.get("queued", red["attempt"]) and _queue(st, run, repo, branch):
            red["queued"] = run["attempt"]     # attempt — принятая досками попытка, queued — уже в ящике
            queued += 1
    return queued


def _bare(path):
    return path.split("@", 1)[0]


def _accepted(ctx, st, entry, matched):
    """2xx: путь запомнен как совпавший или ушёл в дайджест; красный с matched > 0 — кандидат на перечитывание."""
    b, path = entry["body"], _bare(entry["body"]["path"])
    if matched:
        st["hit"][path] = _day(ctx)
        red = st["reds"].get(path)
        if red is None or (b["runCreatedAt"], b["attempt"], entry["id"]) > (red["created"], red["attempt"], red["id"]):
            if b["status"] == "red":
                st["reds"][path] = {"id": entry["id"], "attempt": b["attempt"], "created": b["runCreatedAt"],
                                    "ranAt": b["ranAt"]}
            else:
                st["reds"].pop(path, None)
        return
    if st["hit"].pop(path, None):
        ctx.emit(f"guard:unmatched:{path}:{_day(ctx)}", "guard.unmatched", NERVOUS, ["coord"],
                 f"сторож {path}: прогон {b['runUrl']} больше не совпал ни с одной карточкой check — у карточки "
                 f"сменили или сняли ref? Дальше этот workflow идёт в суточный дайджест", "guard")
        return
    quiet = st.setdefault("quiet", {"day": _day(ctx), "paths": []})
    if path not in quiet["paths"]:
        quiet["paths"].append(path)


def flush_quiet(ctx):
    """Одна строка дайджеста координатору в сутки: workflow, прогоны которых не совпали ни с одной карточкой."""
    st = _state(ctx)
    quiet = st.get("quiet")
    if not quiet or quiet["day"] == _day(ctx):
        return
    if quiet["paths"]:
        ctx.emit(f"guard:quiet:{quiet['day']}", "guard.quiet", DIGEST, ["coord"],
                 f"сторожа {quiet['day']}: прогоны без карточки check ({len(quiet['paths'])}): "
                 f"{', '.join(sorted(quiet['paths']))}", "guard")
    st.pop("quiet")


def _denied(ctx, st, code):
    """Эпизод отказа: одно событие на эпизод, не на каждую попытку (НЕРВ МОЛЧИТ, eval/nerve/README.md:54)."""
    if st.get("denied"):
        return
    st["denied"] = {"since": _iso(ctx.now), "code": code}
    what = "неизвестное пространство" if code == 404 else "ключ записи прогонов отклонён"
    ctx.emit(f"guard:denied:{st['denied']['since']}", "guard.denied", NERVOUS, DENIED[code],
             f"сторожа: доски ответили {code} — {what}; {len(st['outbox'])} прогонов ждут в ящике, курсор стоит",
             "guard")


def _failed(ctx, st, code):
    """5xx, сеть и неожиданный код: дольше FAILS_MAX чтений подряд — одно событие координатору на эпизод (S45-4b).
    Неожиданный код считается так же: иначе ящик ждал бы молча."""
    fail = st.setdefault("fail", {"since": _iso(ctx.now), "n": 0})
    fail["n"], fail["code"] = fail["n"] + 1, code
    if fail["n"] == FAILS_MAX + 1:
        ctx.emit(f"guard:fail:{fail['since']}", "guard.fail", NERVOUS, ["coord"],
                 f"сторожа: доски не принимают прогоны {fail['n']} чтения подряд с {fail['since'][11:16]} "
                 f"(последний ответ: {code or 'нет ответа'}); {len(st['outbox'])} прогонов ждут в ящике", "guard")


def _answered(ctx, st):
    """Доски ответили: серия сбоев оборвана; если о ней было событие — строка восстановления в дайджест."""
    fail = st.pop("fail", None)
    if fail and fail["n"] > FAILS_MAX:
        ctx.emit(f"guard:fail:ok:{fail['since']}", "guard.fail", DIGEST, ["coord"],
                 f"сторожа: доски снова отвечают (сбой с {fail['since'][11:16]}, {fail['n']} чтений подряд)", "guard")


def drain(ctx, post):
    """Шлёт ящик по порядку пары, не больше DRAIN_MAX за проход. post(body) → (код HTTP, 0 — нет ответа; JSON или
    None). Отказ, 429, 5xx, сеть и неожиданный код — повтор через GUARD_EVERY; ящик ждёт, исключения нет.
    Возвращает число принятых досками прогонов."""
    st = _state(ctx)
    if st.get("retry_at", "") > _iso(ctx.now):
        return 0
    st.pop("retry_at", None)
    done = 0
    while st["outbox"] and done < DRAIN_MAX:
        entry = st["outbox"][0]
        code, data = post(entry["body"])
        if not 200 <= code < 300 and code not in ANSWERED:
            _failed(ctx, st, code)
            st["retry_at"] = _iso(ctx.now + timedelta(seconds=GUARD_EVERY))
            return done
        _answered(ctx, st)
        if 200 <= code < 300:
            st["outbox"].pop(0)
            done += 1
            if st.get("denied"):
                was = st.pop("denied")
                ctx.emit(f"guard:denied:ok:{was['since']}", "guard.denied", DIGEST, DENIED[was["code"]],
                         f"сторожа: доски снова принимают прогоны (отказ {was['code']} с {was['since'][11:16]})",
                         "guard")
            _accepted(ctx, st, entry, int((data or {}).get("matched") or 0))
        elif code in DROP:
            st["outbox"].pop(0)
            ctx.emit(f"guard:drop:{code}:{_day(ctx)}", "guard.drop", NERVOUS, ["coord"],
                     f"сторожа: доски ответили {code} на прогон {entry['body']['runUrl']} — прогон отброшен, повтор "
                     f"не исправит тело: {json.dumps(data, ensure_ascii=False)[:200]}", "guard")
        else:
            if code in DENIED:
                _denied(ctx, st, code)
            st["retry_at"] = _iso(ctx.now + timedelta(seconds=GUARD_EVERY))
            return done
    return done


def _trim(ctx, st):
    """Ящик не растёт без предела в долгом отказе: самые старые по паре уходят, событие одно в сутки."""
    lost = len(st["outbox"]) - OUTBOX_MAX
    if lost <= 0:
        return
    del st["outbox"][:lost]
    ctx.emit(f"guard:overflow:{_day(ctx)}", "guard.overflow", DIGEST, ["coord", "release"],
             f"сторожа: ящик больше {OUTBOX_MAX} прогонов — {lost} самых старых отброшены, не дойдут до досок", "guard")


def poll(ctx, repo, branch, post):
    """Проход читателя: раз в GUARD_EVERY — страница прогонов ветки и перечитывание красных; каждый проход —
    дайджест прошлых суток и ящик."""
    st = _state(ctx)
    at = st.get("at")
    if not at or (ctx.now - datetime.strptime(at, ISO).replace(tzinfo=timezone.utc)).total_seconds() >= GUARD_EVERY:
        since = st.get("since") or _iso(ctx.now - FIRST_LOOKBACK)
        _, skipped = read_results(ctx, repo, branch)
        if skipped:
            ctx.emit(f"guard:skipped:{since}", "guard.skipped", DIGEST, ["coord"],
                     f"сторожа: {skipped} прогонов {branch} с {since} не вошли в страницу {GUARD_PER_PAGE} — "
                     f"не отправлены (долгий простой Mac?)", "guard")
        recheck(ctx, repo, branch)
        _trim(ctx, st)
    flush_quiet(ctx)
    return drain(ctx, post)
