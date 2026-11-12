"""Автоуборка сессий (решение владельца 06.11; правила после ревью линз #82) — свой модуль lineage.py (лимит 500 строк).

  lineage.py reap --auto [--apply] [--ack-minutes 30] [--auto-idle-hours 8] [--window-minutes 10] [--keep-cwd DIR]
      по умолчанию сухо: список «что снял бы и почему»; в журнал — только изменения плана. --apply работает только
      из launchd владельца (XPC_SERVICE_NAME = space.hrhelper.reaper) и не под сессией claude. Это защита от ошибки,
      не от умысла сессии того же пользователя. Снимает только:
        ack    — предшественника, чей наследник принял: квитанция проверена как у сторожа retire (наследник жив, это
                 claude той же линии, не в дереве предшественника) и ей не меньше --ack-minutes;
        idle   — сессию, которую открыл spawn_session.sh (есть запись линии), простой ≥ --auto-idle-hours, статус idle;
                 открытые владельцем вручную — никогда;
        window — окно линии, когда claude этой линии уже нет: в записи код выхода 0 (не --keep) не меньше
                 --window-minutes назад, одна вкладка, тот же tty, в ней только shell. Окна без записи — никогда.
      Для ack и idle одинаково: не держатель роли (как team_status.py live), в папке нет незакоммиченного, коммитов
      не на remote и stash этой ветки. Перед снятием статус и «несохранённое» проверяются заново.
      Никогда: своя сессия и её предки, busy, чужой проект (вне --root), сессия не в Terminal, сессия ровно в общем
      корне проектов (--keep-cwd; по умолчанию папка над основным checkout слоя — там постоянный мост).
  lineage.py reap --auto --summary [--since-hours 24]
      читаемая сводка журнала за период: прогоны, кого снял бы (снял) и почему, итоги действий. Без сырого JSONL.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import lineage as L
import lineage_reap as R
import lineage_retire as LR
from lineage_close import CLOSE_IDLE_SCRIPT, LIST_SCRIPT, closable_exit

LABEL = "space.hrhelper.reaper"
JOURNAL_MAX = 1 << 20  # байт: больше — журнал уходит в .1 и начинается заново


def parse_stamp(s):
    try:
        return datetime.strptime(str(s), "%Y-%m-%dT%H:%M:%S%z").timestamp()
    except (TypeError, ValueError):
        return None


def parse_lstart(s):
    """lstart из ps (C_ENV: TZ=UTC, LC_ALL=C) → секунды эпохи."""
    try:
        return datetime.strptime(L.norm(s), "%a %b %d %H:%M:%S %Y").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def terminal_start(procs):
    starts = [parse_lstart(p.start) for p in procs.values() if "/Terminal.app/Contents/MacOS/Terminal" in p.command]
    starts = [s for s in starts if s is not None]
    return min(starts) if starts else None


def keep_dirs(extra):
    """Общий корень проектов (папка над основным checkout слоя: ~/Desktop/Development, там мост) и --keep-cwd."""
    main = R.git_root(os.path.dirname(os.path.realpath(__file__)))
    cands = ([os.path.dirname(main)] if main else []) + list(extra)
    return {os.path.realpath(os.path.expanduser(c)) for c in cands if c}


def line_record(line):
    """Запись линии, которую spawn_session.sh сделал при открытии окна Terminal; иначе None."""
    if not L.valid_line(line or ""):
        return None
    rec = L.read_json(L.lfile(line, ".json"))
    return rec if isinstance(rec, dict) and rec.get("terminal") == "terminal" and rec.get("line") == line else None


def verified_ack(sx, procs, r):
    """(линия наследника, минут с квитанции) — если квитанции можно верить, как сторожу retire; иначе None."""
    line = r["line"]
    for child, f in L.child_acks(line or ""):
        a = L.read_json(f) or {}
        s = procs.get(a.get("pid") if isinstance(a.get("pid"), int) else -1)
        if LR.successor_problem(sx, procs, r["proc"], s, a, child):
            continue
        at = parse_stamp(a.get("at"))
        if at is None:
            try:
                at = f.stat().st_mtime
            except OSError:
                continue
        return child, max(0.0, sx.now() - at) / 60
    return None


def role_holders(rows):
    """pid держателей ролей — как team_status.py live, отдельно по каждому продукту (основной checkout папки)."""
    import team_status as T  # noqa: E402 — team_status сам импортирует lineage_reap
    by_root = {}   # (основной checkout, продукт генома): роль HR в worktree tAIBE не держит роль tAIBE (OPS-25)
    for r in rows:
        if r["role"]:
            root = R.git_root(r["cwd"]) or os.path.realpath(r["cwd"] or "/")
            by_root.setdefault((root, r.get("product", "")), []).append(r)
    return {r["pid"] for group in by_root.values() for r in T.live_roles(group).values()}


def criterion(sx, procs, r, a):
    """(ack|idle|None, почему) — какой критерий подходит, до общих проверок сохранности."""
    ack = verified_ack(sx, procs, r)
    if ack:
        child, age = ack
        if age >= a.ack_minutes:
            return "ack", f"наследник {child} принял {age:.0f} мин назад"
        return None, f"квитанция {child} свежая ({age:.0f} < {a.ack_minutes:g} мин)"
    if r["status"] != "idle":
        return None, "ждёт ввода"
    if line_record(r["line"]) is None:
        return None, "открыта не spawn_session.sh — простой не в счёт"
    if r["idle_h"] < a.auto_idle_hours:
        return None, f"простой {r['idle_h']:.1f} < {a.auto_idle_hours:g} ч"
    return "idle", f"простой {r['idle_h']:.0f} ч, сессия spawn_session.sh"


def decide(sx, procs, r, ctx, a):
    """(действие ack|idle|None, почему). Защиты — до критериев, проверки сохранности — после: обе сильнее критерия."""
    if r["pid"] in ctx["protect"]:
        return None, "своя сессия"
    if os.path.realpath(r["cwd"] or "/nonexistent") in ctx["keep"]:
        return None, "общий корень проектов (мост)"
    if not R.under(r["cwd"], ctx["roots"]):
        return None, "чужой проект"
    if r["status"] not in ("idle", "waiting"):
        return None, f"статус {r['status']}"
    where = L.host(procs, r["proc"])
    if where != "terminal":
        return None, f"не в Terminal ({where}) — только руками"
    kind, why = criterion(sx, procs, r, a)
    if kind is None:
        return None, why
    if r["pid"] in ctx["holders"]:
        return None, "держатель роли"
    lost = sx.unsaved(r["cwd"])
    if lost:
        return None, f"{lost} в папке"
    return kind, why + ", не держатель роли, в папке всё сохранено"


def parse_windows(out):
    wins = {}
    for ln in (out or "").splitlines():
        t = ln.split("\t")
        if len(t) >= 5 and t[0].isdigit():
            wins[t[0]] = {"tabs": int(t[1]) if t[1].isdigit() else 0, "tty": t[2], "busy": t[3] == "true",
                          "procs": [x.lstrip("-") for x in t[4].split(",") if x]}
    return wins


def window_why(sx, rec, w, tstart, claude_ttys, a):
    """Почему окно записи rec не закрывать ('' — можно)."""
    tty = rec["tty"]
    at, exited = parse_stamp(rec.get("at")), parse_stamp(rec.get("exited_at"))
    why = closable_exit(rec)
    if why:
        return why
    if exited is None or sx.now() - exited < a.window_minutes * 60:
        return f"claude вышел меньше {a.window_minutes:g} мин назад"
    if tty in claude_ttys:
        return "на tty живой claude"
    if at is None or at < tstart:
        return "запись старше запуска Terminal (id окна мог смениться)"
    if w["tty"] != tty:
        return f"в окне другой tty ({w['tty']})"
    if w["tabs"] != 1:
        return f"вкладок {w['tabs']}"
    if w["busy"] or any(x not in L.SHELLS for x in w["procs"]):
        return "в окне идёт процесс"
    return ""


def window_plan(sx, procs, rows, a):
    """Окна линий, у которых claude уже нет. Записи без id окна или tty не рассматриваются: по одному tty можно
    закрыть чужую новую вкладку, получившую тот же tty. Окна без записи линии не видны вовсе."""
    recs = [rec for line, _f in L.line_records()
            for rec in [line_record(line)]
            if rec and str(rec.get("window_id") or "").isdigit() and str(rec.get("tty") or "").startswith("/dev/tty")]
    tstart = terminal_start(procs)
    if not recs or tstart is None:
        return []  # нет записей или Terminal не запущен — окон нет
    live = {r["line"] for r in rows if r["line"]}
    claude_ttys = {"/dev/" + p.tty for p in procs.values() if L.argv0(p) == "claude"}
    wins = parse_windows(sx.osa(LIST_SCRIPT))
    plan = []
    for rec in recs:
        w = wins.get(str(rec["window_id"]))
        if w is None or rec["line"] in live:
            continue  # окна уже нет или claude линии жив (его решает строка сессии)
        why = window_why(sx, rec, w, tstart, claude_ttys, a)
        plan.append({"kind": None if why else "window", "line": rec["line"], "wid": str(rec["window_id"]),
                     "tty": rec["tty"], "why": why or "claude линии вышел с кодом 0, в окне только shell"})
    return plan


def private_append(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(text)


def journal(entry):
    path = L.ldir() / "reap-auto.jsonl"
    try:
        if path.stat().st_size > JOURNAL_MAX:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass
    private_append(path, json.dumps({"at": L.stamp(), **entry}, ensure_ascii=False) + "\n")


def plan_changed(sig):
    """Сухой режим пишет журнал, только когда план изменился; счётчик прогонов — в reap-auto.plan.json (0600)."""
    path = L.ldir() / "reap-auto.plan.json"
    old = L.read_json(path) or {}
    changed = old.get("sig") != sig
    L.write_json(path, {"sig": sig, "runs": int(old.get("runs") or 0) + 1, "last_run": L.stamp(),
                        "changed_at": L.stamp() if changed else old.get("changed_at")})
    return changed


def show(rows, wplan, a, roots, keep, out=None):
    out = out or sys.stdout
    mode = "ДЕЙСТВУЮ (--apply)" if a.apply else "сухо — ничего не снимаю"
    print(f"автоуборка, {mode}: квитанция ≥ {a.ack_minutes:g} мин · простой ≥ {a.auto_idle_hours:g} ч · окно ≥ "
          f"{a.window_minutes:g} мин после выхода\n  свои проекты: {', '.join(roots) or '—'}; не трогаю папки: "
          f"{', '.join(sorted(keep)) or '—'}", file=out)
    for r in sorted(rows, key=lambda r: (r["auto"] is None, -r["idle_h"])):
        what = ("СНЯТЬ: " if r["auto"] else "оставить: ") + r["auto_why"]
        print(f"{r['pid']:>6}  {r['name'][:20]:<20} {r['status'][:8]:<8} {r['idle_h']:>5.1f}ч  "
              f"{(r['role'] or '—'):<8} {what} · {r['cwd']}", file=out)
    for w in wplan:
        what = ("ЗАКРЫТЬ: " if w["kind"] else "оставить: ") + w["why"]
        print(f"  окно {w['wid']} {w['tty']} линии {w['line']}: {what}", file=out)


def recheck(sx, r):
    """Перед самым снятием: ход мог начаться, в папке могло появиться несохранённое."""
    st = sx.status(r["pid"])
    if st not in (("idle",) if r["auto"] == "idle" else ("idle", "waiting")):
        return f"пропуск: статус стал {st}"
    lost = sx.unsaved(r["cwd"])
    return f"пропуск: {lost} в папке" if lost else ""


def act(sx, rows, wplan, protect, log):
    for r in [r for r in rows if r["auto"]]:
        result = recheck(sx, r)
        if not result:
            log(f"— {r['pid']} {r['name']} ({r['auto_why']})")
            result = "снята" if LR.take_down(sx, r["proc"], r["line"], protect, log) else "отказ"
        journal({"mode": "apply", "kind": r["auto"], "pid": r["pid"], "name": r["name"], "line": r["line"],
                 "cwd": r["cwd"], "why": r["auto_why"], "result": result})
    for w in [w for w in wplan if w["kind"]]:
        res = sx.osa(CLOSE_IDLE_SCRIPT, w["tty"], w["wid"])
        log(f"окно {w['wid']} {w['tty']}: {res}")
        if res.startswith("closed"):
            LR.hup_tty(sx, w["tty"][len("/dev/"):], log)
        journal({"mode": "apply", "kind": "window", "line": w["line"], "wid": w["wid"], "tty": w["tty"],
                 "why": w["why"], "result": res})


def apply_refusal(procs):
    if os.environ.get("XPC_SERVICE_NAME") != LABEL:
        return f"--apply — только из launchd владельца ({LABEL}); без --apply — список"
    if L.ancestor_claude(procs, os.getpid()) is not None:
        return "--apply — не из-под сессии claude"
    return ""


def cmd_auto(sx, a):
    if a.summary:
        return cmd_summary(a)
    roots, keep = R.own_roots(a.root), keep_dirs(a.keep_cwd)
    procs, rows = R.scan(sx, a.idle_hours, True, roots, a.superseded_idle_hours)
    if a.apply and apply_refusal(procs):
        return L.die(apply_refusal(procs))
    ctx = {"protect": R.ancestors(procs, os.getpid()), "roots": roots, "keep": keep, "holders": role_holders(rows)}
    for r in rows:
        r["auto"], r["auto_why"] = decide(sx, procs, r, ctx, a)
    wplan = window_plan(sx, procs, rows, a)
    show(rows, wplan, a, roots, keep)
    todo = [r for r in rows if r["auto"]]
    wtodo = [w for w in wplan if w["kind"]]
    summary = {"sessions": len(rows), "ack": sum(r["auto"] == "ack" for r in todo),
               "idle": sum(r["auto"] == "idle" for r in todo), "windows": len(wtodo)}
    if not a.apply:
        sig = sorted([[r["auto"], r["pid"], L.norm(r["start"])] for r in todo] + [["window", w["line"], w["wid"]]
                                                                                    for w in wtodo])
        if plan_changed(sig):
            for r in todo:
                journal({"mode": "dry", "kind": r["auto"], "pid": r["pid"], "name": r["name"], "line": r["line"],
                         "cwd": r["cwd"], "why": r["auto_why"]})
            for w in wtodo:
                journal({"mode": "dry", "kind": "window", "line": w["line"], "wid": w["wid"], "tty": w["tty"],
                         "why": w["why"]})
            journal({"mode": "dry", "summary": summary})
        print(f"\nсессий {summary['sessions']}; снял бы: {len(todo)} (квитанция {summary['ack']}, простой "
              f"{summary['idle']}), окон закрыл бы: {len(wtodo)}. Снимает только launchd владельца "
              f"(reaper_launchd.sh install --apply); сводка — reap_sessions.sh --auto --summary")
        return 0
    before = sx.metrics()
    act(sx, rows, wplan, ctx["protect"], L.make_log(sys.stdout))
    after = sx.metrics()
    journal({"mode": "apply", "summary": summary, "claude": [before["claude"], after["claude"]],
             "terminal_windows": [before["terminal_windows"], after["terminal_windows"]]})
    pruned = R.prune_lineage_dir(a.prune_days)
    print(f"claude: {before['claude']} → {after['claude']}; окон Terminal: {before['terminal_windows']} → "
          f"{after['terminal_windows']}; записей линий удалено: {pruned}\nswap до:    {before['swap']}\n"
          f"swap после: {after['swap']}")
    return 0


def read_journal(since):
    out = []
    for name in ("reap-auto.jsonl.1", "reap-auto.jsonl"):
        try:
            text = (L.ldir() / name).read_text(encoding="utf-8")
        except OSError:
            continue
        for ln in text.splitlines():
            try:
                e = json.loads(ln)
            except ValueError:
                continue
            at = parse_stamp(e.get("at"))
            if isinstance(e, dict) and at is not None and at >= since:
                out.append(e)
    return out


def cmd_summary(a, out=None):
    """Сводка для владельца: что снял бы (или снял) за период — по одной строке на сессию или окно."""
    out = out or sys.stdout
    since = time.time() - a.since_hours * 3600
    entries = read_journal(since)
    state = L.read_json(L.ldir() / "reap-auto.plan.json") or {}
    seen = {}
    for e in entries:
        if e.get("summary") or not e.get("kind"):
            continue
        key = (e["mode"], e["kind"], e.get("pid") or e.get("wid"), e.get("line"))
        first = seen.get(key, {}).get("first", e["at"])
        seen[key] = {**e, "first": first, "n": seen.get(key, {}).get("n", 0) + 1}
    changes = sum(1 for e in entries if e.get("summary") and e.get("mode") == "dry")
    applied = [e for e in entries if e.get("summary") and e.get("mode") == "apply"]
    print(f"автоуборка за {a.since_hours:g} ч: прогонов всего {state.get('runs', 0)} (последний "
          f"{state.get('last_run') or '—'}), изменений плана {changes}, прогонов с --apply {len(applied)}", file=out)
    if not seen:
        print("  кандидатов не было", file=out)
    for (mode, kind, ident, line), e in sorted(seen.items(), key=lambda kv: kv[1]["first"]):
        who = f"окно {ident} линии {line}" if kind == "window" else f"{e.get('name') or ident} (pid {ident})"
        verb = "снял бы" if mode == "dry" else "снято"
        res = f" → {e['result']}" if e.get("result") else ""
        print(f"  {verb}: {who} — {e.get('why')}{res}; впервые {e['first'][11:16]}, раз {e['n']}", file=out)
    return 0
