#!/usr/bin/env python3
"""Параметры бюджета окна: пути, окно сессии, выученные W_eff / H / T и их обучение — `ctx_budget.py learn`
по транскриптам ~/.claude/projects/* (решение и CLI сессии — ctx_budget.py).

Что учится (доли — от W_eff окна сессии):
  w_eff[окно]  точка автосжатия: медиана U последнего ответа перед автосжатием (compact_boundary, trigger=auto);
               в выборку — только сжатия с U/окно в 0,75–1,0 (вне полосы окно сессии было другим)
  reserve      окно − U перед сжатием (медиана) — для окон без своей истории
  handoff      цена передачи: от текста порога/бюджета (`<successor-threshold>`) или первого work_state после него
               до последнего usage сессии; только где был spawn_session.sh --handoff и не было сжатия
  tasks[роль]  цена задачи: куски между границами (git commit, gh pr create, смена статуса карточки,
               ctx_budget.py next|done) до передачи; куски < 0,5 % — та же граница; роль — из журнала бюджета,
               иначе по времени запуска линии (~/.claude/lineage, ≤ 120 с), иначе «-»; «*» — все
  calibration  факт/оценка задач из журнала бюджета: declared (заявлены через next) и history (по умолчанию)

Приватность: строки пользователя (реплики, выводы инструментов) не разбираются вовсе; из ответов модели берутся
только usage, метка времени, cwd (для окна сессии), имена инструментов и тип события — по фиксированным меткам в
команде Bash. Текст не сохраняется и не печатается; в params.json и вывод попадают только числа и ключи ролей.
Коды: 0 — пересчитано (записано или --dry-run), 1 — ошибка чтения/записи.
"""
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
H_DEFAULT, T_DEFAULT = 0.04, 0.10
WEFF_FALLBACK = 213 / 250           # сжатие при окне 250K — от 213K (30.10)
DEFAULT_WINDOW = 200_000            # без autoCompactWindow — как раньше
H_RANGE, T_RANGE, CAL_RANGE = (0.02, 0.12), (0.01, 0.50), (1.0, 2.0)
MIN_N = 5                           # выборка меньше — запасное значение
WEFF_BAND = (0.75, 1.0)
SEGMENT_MIN = 0.005
ROLE_MAX_DELAY_S = 120
GIT_COMMIT_RE = re.compile(r"\bgit\b(?:\s+-[Cc]\s+\S+)*\s+commit\b")
GH_PR_RE = re.compile(r"\bgh\s+pr\s+create\b")
CLI_RE = re.compile(r"ctx_budget\.py\S*\s+(?:next|done)\b")
SPAWN_RE = re.compile(r"spawn_session\.sh\b.*--handoff")
CARD_TOOLS = ("update_task_status", "move_task")
WORK_STATE_TOOLS = ("work_state_write", "forest_set_work_state")


# ---------------------------------------------------------------- места и параметры

def budget_dir():
    return Path(os.environ.get("CTX_BUDGET_DIR") or Path.home() / ".claude" / "ctx-budget")


def params_path():
    return budget_dir() / "params.json"


def projects_dir():
    return Path(os.environ.get("CTX_BUDGET_PROJECTS") or Path.home() / ".claude" / "projects")


def lineage_dir():
    return Path(os.environ.get("TAIBE_LINEAGE_DIR") or Path.home() / ".claude" / "lineage")


def load_params():
    try:
        data = json.loads(params_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def clamp(value, bounds):
    return min(max(value, bounds[0]), bounds[1])


def _n(entry):
    try:
        return int((entry or {}).get("n") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0


def settings_window(project_dir):
    """autoCompactWindow (или env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) из settings.local → settings → пользовательских."""
    project = Path(project_dir or REPO_ROOT)
    for path in (project / ".claude/settings.local.json", project / ".claude/settings.json",
                 Path.home() / ".claude/settings.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        env = data.get("env") if isinstance(data.get("env"), dict) else {}
        for value in (data.get("autoCompactWindow"), env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")):
            try:
                value = int(value)
            except (TypeError, ValueError):
                continue
            if value > 0:
                return value
    return DEFAULT_WINDOW


def window_tokens(project_dir=None):
    """Номинальное окно живой сессии: SUCCESSOR_WINDOW_TOKENS → CLAUDE_CODE_AUTO_COMPACT_WINDOW → настройки."""
    for knob in ("SUCCESSOR_WINDOW_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"):
        value = os.environ.get(knob, "").strip()
        if value.isdigit() and int(value) > 0:
            return int(value)
    return settings_window(project_dir or os.environ.get("CLAUDE_PROJECT_DIR") or REPO_ROOT)


def w_eff(window, params):
    """(токены точки сжатия, источник): история этого окна → окно − запас по истории → 213/250 окна."""
    entry = (params.get("w_eff") or {}).get(str(window)) or {}
    tokens = entry.get("tokens") if isinstance(entry, dict) else None
    if _n(entry) >= MIN_N and isinstance(tokens, int) and 0 < tokens <= window:
        return tokens, "история окна"
    reserve = params.get("reserve") or {}
    tokens = reserve.get("tokens") if isinstance(reserve, dict) else None
    if _n(reserve) >= MIN_N and isinstance(tokens, int) and 0 < tokens < window / 2:
        return window - tokens, "окно − запас по истории"
    return int(window * WEFF_FALLBACK), "213/250 окна"


def _q(entry, key, bounds):
    try:
        return clamp(float(entry[key]), bounds)
    except (KeyError, TypeError, ValueError):
        return None


def handoff_cost(params):
    entry = params.get("handoff") or {}
    value = _q(entry, "p80", H_RANGE) if _n(entry) >= 3 else None
    return (value, "история") if value else (H_DEFAULT, "по умолчанию")


def task_estimate(role, params):
    """(доля W_eff, источник) для незаявленной задачи: медиана роли → медиана всех ролей → 10 %.

    Медиана, а не p80: по истории 06.11 p80 = 43 % — с ним любая незаявленная задача давала бы передачу ровно
    на 85 % (фиксированный порог), а хвост закрывает страховка s ≥ 0,985 − H."""
    tasks = params.get("tasks") or {}
    for key, src in (((role, "история роли " + role),) if role and role != "-" else ()) + (("*", "история"),):
        entry = tasks.get(key) or {}
        value = _q(entry, "median", T_RANGE) if _n(entry) >= MIN_N else None
        if value:
            return value, src
    return T_DEFAULT, "по умолчанию"


def calibration(params):
    """Множитель к заявленной оценке: медиана факт/оценка, только вверх (1–2), от 5 замеров."""
    entry = (params.get("calibration") or {}).get("declared") or {}
    try:
        return clamp(float(entry["median"]), CAL_RANGE) if _n(entry) >= MIN_N else 1.0
    except (KeyError, TypeError, ValueError):
        return 1.0


def pct(x):
    """Доля → «87», «98,5», «0,6» (проценты по-русски)."""
    v = round(x * 100, 1)
    return str(int(v)) if v == int(v) else ("%.1f" % v).replace(".", ",")


# ---------------------------------------------------------------- learn

def _epoch(stamp):
    try:
        return datetime.strptime(str(stamp)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def _tool_events(content):
    for block in content if isinstance(content, list) else ():
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = str(block.get("name") or "")
        if name.endswith(CARD_TOOLS) and "boards" in name:
            yield ("b", None)
        elif name.endswith(WORK_STATE_TOOLS):
            yield ("ws", None)
        elif name == "Bash":
            cmd = str((block.get("input") or {}).get("command") or "")
            if SPAWN_RE.search(cmd):
                yield ("spawn", None)
            elif CLI_RE.search(cmd) or GH_PR_RE.search(cmd) or GIT_COMMIT_RE.search(cmd):
                yield ("b", None)


def scan_transcript(path):
    """{"cwd", "start", "events": [(тип, число)]} основной цепочки. Типы: u (usage ответа), compact (preTokens,
    auto?), b (граница задачи), inject (текст порога/бюджета), ws (work_state), spawn."""
    events, cwd, start = [], None, None
    with open(path, "rb") as fh:
        for raw in fh:
            if b'"compact_boundary"' in raw:
                kind = "compact"
            elif b'"hook_additional_context"' in raw and b"<successor-threshold>" in raw:
                events.append(("inject", None))
                continue
            elif b'"type":"assistant"' in raw:
                kind = "assistant"
            else:
                continue  # реплики пользователя и выводы инструментов не разбираются
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(d, dict) or d.get("isSidechain"):
                continue
            if kind == "compact":
                if d.get("subtype") == "compact_boundary":
                    meta = d.get("compactMetadata") or {}
                    pre = meta.get("preTokens") if isinstance(meta.get("preTokens"), int) else 0
                    events.append(("compact", (pre, meta.get("trigger") == "auto")))
                continue
            if d.get("type") != "assistant":
                continue
            if start is None:
                start = _epoch(d.get("timestamp"))
            if cwd is None and isinstance(d.get("cwd"), str):
                cwd = d["cwd"]
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}
            usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
            try:
                u = sum(int(usage.get(k) or 0) for k in (
                    "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
            except (TypeError, ValueError):
                u = 0
            if u > 0:
                events.append(("u", u))
            events.extend(_tool_events(msg.get("content")))
    return {"cwd": cwd, "start": start, "events": events}


def analyze(events):
    """Токены: сжатия [(preTokens, U перед ним)], куски задач между границами, передачи."""
    compactions, segments, handoffs = [], [], []
    last_u = seg_u = hand_u = None
    ws_seen = spawned = False
    peak = 0

    def close_handoff():
        if hand_u is not None and spawned and peak > hand_u:
            handoffs.append(peak - hand_u)

    for kind, val in events:
        if kind == "u":
            last_u = val
            seg_u = val if seg_u is None else seg_u
            peak = max(peak, val) if hand_u is not None else peak
        elif kind == "compact":
            if val[1] and last_u:
                compactions.append((val[0], last_u))
            close_handoff()
            last_u = seg_u = hand_u = None
            ws_seen = spawned = False
            peak = 0
        elif kind == "b" and hand_u is None and seg_u is not None and last_u is not None:
            if last_u > seg_u:
                segments.append(last_u - seg_u)
            seg_u = last_u
        elif kind == "inject" and hand_u is None and last_u is not None:
            hand_u = peak = last_u
        elif kind == "ws" and hand_u is not None and not ws_seen and last_u is not None:
            ws_seen, hand_u, peak = True, last_u, max(peak, last_u)  # передача — с первого savepoint
        elif kind == "spawn" and hand_u is not None:
            spawned = True
    close_handoff()
    return compactions, segments, handoffs


def quantile(values, q):
    xs = sorted(values)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def stats(values, digits=4):
    return {"median": round(quantile(values, 0.5), digits), "p80": round(quantile(values, 0.8), digits),
            "n": len(values)}


def lineage_starts():
    out = []
    try:
        paths = list(lineage_dir().glob("*.json"))
    except OSError:
        return out
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            at = datetime.strptime(str(data.get("at")), "%Y-%m-%dT%H:%M:%S%z").timestamp()
        except (OSError, ValueError, AttributeError):
            continue
        role = re.sub(r"[^A-Za-z0-9_-]", "", str(data.get("role") or ""))[:40]
        if role:
            out.append((at, role))
    return sorted(out)


def role_by_start(starts, start):
    """Роль сессии по времени: ближайший предшествующий запуск линии не дальше ROLE_MAX_DELAY_S."""
    best = None
    for at, role in starts:
        if at > start:
            break
        best = (at, role)
    return best[1] if best and start - best[0] <= ROLE_MAX_DELAY_S else None


def journal_rows():
    rows = []
    for name in ("journal.1.jsonl", "journal.jsonl"):
        try:
            with open(budget_dir() / name, encoding="utf-8") as fh:
                for ln in fh:
                    try:
                        row = json.loads(ln)
                    except ValueError:
                        continue
                    if isinstance(row, dict):
                        rows.append(row)
        except OSError:
            continue
    return rows


def learn_calibration(rows):
    starts, out = {}, {"declared": [], "history": []}
    for row in rows:
        key = (row.get("sid"), row.get("seq"))
        if row.get("ev") == "start":
            starts[key] = row
        elif row.get("ev") == "end" and key in starts:
            st = starts.pop(key)
            try:
                actual = (float(row["u"]) - float(st["u"])) / float(st["weff"])
                est = float(st["t"])
            except (KeyError, TypeError, ValueError, ZeroDivisionError):
                continue
            if est > 0 and actual >= SEGMENT_MIN:
                out["declared" if st.get("explicit") else "history"].append(actual / est)
    return {k: stats(v, 3) for k, v in out.items() if v}


def learn(days=30, projects=None, now=None):
    """(params, сводка одной строкой) по транскриптам за `days` дней."""
    now = now or time.time()
    root = Path(projects or projects_dir())
    rows = journal_rows()
    roles = {r.get("sid"): r.get("role") for r in rows if r.get("role") not in (None, "", "-")}
    starts = lineage_starts()
    per_file, nfiles = [], 0
    for path in sorted(root.glob("*/*.jsonl")):
        try:
            if now - path.stat().st_mtime > days * 86400:
                continue
            scan = scan_transcript(path)
        except OSError:
            continue
        nfiles += 1
        found = analyze(scan["events"])
        if not any(found):
            continue
        role = roles.get(path.stem) or (role_by_start(starts, scan["start"]) if scan["start"] else None) or "-"
        window = settings_window(scan["cwd"]) if scan["cwd"] else DEFAULT_WINDOW
        per_file.append((window, role) + found)
    params = {"version": 1, "learned_at": datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "days": days, "files": nfiles, "w_eff": {}, "tasks": {}}
    by_window, reserves = {}, []
    for window, _role, comp, _segs, _hands in per_file:
        for _pre, before in comp:
            if WEFF_BAND[0] <= before / window <= WEFF_BAND[1]:
                by_window.setdefault(window, []).append(before)
                reserves.append(window - before)
    for window, xs in sorted(by_window.items()):
        tokens = int(quantile(xs, 0.5))
        params["w_eff"][str(window)] = {"tokens": tokens, "ratio": round(tokens / window, 4), "n": len(xs),
                                        "p10": int(quantile(xs, 0.1)), "p90": int(quantile(xs, 0.9))}
    if reserves:
        params["reserve"] = {"tokens": int(quantile(reserves, 0.5)), "n": len(reserves)}
    tasks, hands = {}, []
    for window, role, _comp, segs, hs in per_file:
        weff = w_eff(window, params)[0]
        fr = [x / weff for x in segs if x / weff >= SEGMENT_MIN]
        tasks.setdefault("*", []).extend(fr)
        if role != "-":
            tasks.setdefault(role, []).extend(fr)
        hands.extend(x / weff for x in hs)
    params["tasks"] = {k: stats(v) for k, v in sorted(tasks.items()) if v}
    if hands:
        params["handoff"] = stats(hands)
    cal = learn_calibration(rows)
    if cal:
        params["calibration"] = cal
    return params, summary(params)


def summary(params):
    p = pct
    parts = ["learn: %d транскриптов за %d дн" % (params.get("files", 0), params.get("days", 0))]
    for window, e in sorted((params.get("w_eff") or {}).items(), key=lambda kv: int(kv[0])):
        parts.append("W_eff %dK→%dK (%s %% окна, n %d)" % (int(window) // 1000, e["tokens"] // 1000, p(e["ratio"]),
                                                          e["n"]))
    if params.get("reserve"):
        parts.append("запас %dK" % (params["reserve"]["tokens"] // 1000))
    h = params.get("handoff")
    parts.append("H p50 %s %% p80 %s %% (n %d)" % (p(h["median"]), p(h["p80"]), h["n"]) if h else "H — нет данных")
    for role, e in (params.get("tasks") or {}).items():
        parts.append("задачи %s: p50 %s %% p80 %s %% (n %d)" % (role, p(e["median"]), p(e["p80"]), e["n"]))
    cal = (params.get("calibration") or {}).get("declared")
    parts.append("калибровка ×%s (n %d)" % (("%.2f" % cal["median"]).replace(".", ","), cal["n"]) if cal
                 else "калибровка — заявленных задач ещё нет")
    return " · ".join(parts)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, path)


def run(args):
    try:
        params, text = learn(days=args.days, projects=args.projects)
    except OSError as exc:
        print("ctx_budget learn: ошибка чтения — %s" % type(exc).__name__, file=sys.stderr)
        return 1
    if not args.dry_run:
        out = Path(args.out) if args.out else params_path()
        try:
            write_json(out, params)
        except OSError as exc:
            print("ctx_budget learn: не записать %s — %s" % (out, type(exc).__name__), file=sys.stderr)
            return 1
        text += " → " + str(out)
    print(text)
    return 0
