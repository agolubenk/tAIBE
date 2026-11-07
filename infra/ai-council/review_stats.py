#!/usr/bin/env python3
"""AI Council — вклад ролей ревью и пересчёт вердиктов по сохранённым прогонам. Без моделей.

Канон: docs/specs/ai-council.md §17.5.

    python3 infra/ai-council/review_stats.py agents [--json]
    python3 infra/ai-council/review_stats.py replay [--limit N] [--json]

Консилиум оценивается не объёмом обсуждения, а тем, что роль даёт решению: находки, которые
не снял оппонент; находки, которых больше никто не нашёл; решающие (с опорой в диффе);
согласие владельца с вердиктом прогона (переход применён / отклонён — review_runs).

Пересчёт (`replay`) — та же политика, что в прогоне (review_policy.decide), над сохранёнными
выводами и досье из транскрипта. Встречную проверку он не воспроизводит (моделей не зовёт):
решающий critical без подтверждения остаётся NEEDS_HUMAN — это нижняя граница FAIL.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import review_catalog as cat          # noqa: E402
import review_evidence as EV          # noqa: E402
from review_policy import _defect_claim, decide  # noqa: E402
from review_state import _RunState, tracked_files  # noqa: E402

DOSSIER_STAGES = ("independent", "pair_check", "chain", "rubric", "challenge")


def _done_runs(store, limit: int = 0) -> list[dict]:
    sql = ("SELECT id, card_id, board, verdict, result, snapshot, transition_state, profile_name "
           "FROM review_runs WHERE status = 'done' AND result IS NOT NULL ORDER BY finished_at DESC")
    rows = store.q(sql + (f" LIMIT {int(limit)}" if limit else ""))
    out = []
    for r in rows:
        try:
            out.append({**r, "result": json.loads(r["result"] or "{}"),
                        "snapshot": json.loads(r["snapshot"] or "{}")})
        except ValueError:
            continue
    return out


def owner_label(run: dict) -> str:
    """Согласие владельца: applied — согласен с переходом, rejected — нет, иначе неизвестно."""
    return {"applied": "agree", "approved": "agree", "rejected": "disagree"}.get(run.get("transition_state") or "", "")


def agent_stats(store, limit: int = 0) -> dict:
    runs = _done_runs(store, limit)
    stats: dict[str, dict] = defaultdict(lambda: Counter())
    for run in runs:
        res = run["result"]
        findings = res.get("findings") or []
        titles = Counter(EV.norm(f.get("title"))[:120] for f in findings)
        for key, v in (res.get("votes") or {}).items():
            s = stats[key]
            s["runs"] += 1
            s[f"vote_{v.get('vote') or 'none'}"] += 1
            label = owner_label(run)
            if label:
                agreed = (label == "agree") == (run["verdict"] == "ACCEPT" and v.get("vote") == "accept"
                                                or run["verdict"] == "FAIL" and v.get("vote") == "fail")
                s["owner_labeled"] += 1
                s["vote_matches_owner"] += int(agreed if run["verdict"] in ("ACCEPT", "FAIL") else 0)
        for f in findings:
            s = stats[f.get("by") or "?"]
            s["findings"] += 1
            s[f"sev_{f.get('severity') or '?'}"] += 1
            if f.get("refuted"):
                s["refuted"] += 1
            elif titles[EV.norm(f.get("title"))[:120]] == 1:
                s["unique"] += 1
            if f.get("decisive"):
                s["decisive"] += 1
            if f.get("confirmed_by"):
                s["confirmed"] += 1
        for c in res.get("consults") or []:
            stats[c.get("from") or "?"]["asked"] += 1
            if not c.get("skipped"):
                stats[c.get("to") or "?"]["answered"] += 1
    steps = store.q("SELECT agent_key, COUNT(*) calls, SUM(ok) ok, AVG(ms) ms, AVG(tokens_in) tin, "
                    "AVG(tokens_out) tout FROM review_steps GROUP BY agent_key")
    for row in steps:
        s = stats[row["agent_key"]]
        s["calls"] = int(row["calls"] or 0)
        s["calls_ok"] = int(row["ok"] or 0)
        s["avg_s"] = round((row["ms"] or 0) / 1000, 1)
        s["avg_tokens_in"] = int(row["tin"] or 0)
        s["avg_tokens_out"] = int(row["tout"] or 0)
    labels = {a["key"]: a["label"] for a in cat.BUILTIN_AGENTS}
    table = []
    for key, s in sorted(stats.items(), key=lambda kv: -kv[1]["runs"]):
        f = s["findings"] or 0
        table.append({"key": key, "label": labels.get(key, key), **dict(s),
                      "refuted_share": round(s["refuted"] / f, 2) if f else None,
                      "unique_share": round(s["unique"] / f, 2) if f else None})
    verdicts = Counter(r["verdict"] for r in runs)
    owner = Counter((r["verdict"], owner_label(r)) for r in runs if owner_label(r))
    return {"runs": len(runs), "verdicts": dict(verdicts),
            "owner": {f"{v}:{lab}": n for (v, lab), n in owner.items()}, "agents": table}


def _dossier(store, run_id: str) -> str:
    marks = ",".join("?" for _ in DOSSIER_STAGES)
    row = store.q1(f"SELECT prompt FROM review_steps WHERE run_id = ? AND stage_type IN ({marks}) "
                   "ORDER BY id LIMIT 1", (run_id, *DOSSIER_STAGES))
    if not row:
        return ""
    text = row["prompt"] or ""
    at = text.find("# Досье карточки")
    return text[at:] if at >= 0 else text


def replay_run(store, run: dict, tracked: set[str]) -> dict:
    """Новая политика над сохранённым прогоном. Потолки важности и правило «critical
    проверяющего без опоры → major» применяются, как в живом прогоне."""
    snap, res = run["snapshot"], run["result"]
    agents = snap.get("agents") or {}
    catalog = {a["key"]: a for a in cat.BUILTIN_AGENTS}
    plan = {"spec": {"verdict": {**cat.DEFAULT_VERDICT, **((snap.get("spec") or {}).get("verdict") or {}),
                                 "evidence_gate": True}},
            "blocking": bool(snap.get("blocking")), "stages": snap.get("stages") or [],
            "participants": snap.get("participants") or [], "adversary": snap.get("adversary") or "",
            "judge": snap.get("judge") or "", "consult": {"ask": 0, "cross_check": 0}, "addressable": [],
            "agents": {k: {**a, "max_severity": catalog.get(k, {}).get("max_severity", ""),
                           "audits_evidence": bool(catalog.get(k, {}).get("audits_evidence"))}
                       for k, a in agents.items()}}
    st = _RunState.bare(plan, _dossier(store, run["id"]))
    st.tracked = tracked
    voters = res.get("voters") or list((res.get("votes") or {}).keys())
    primary = voters[0] if voters else ""
    checkers = {snap.get("adversary")} | ({voters[1]} if len(voters) > 1 and any(
        s.get("type") == "pair_check" for s in plan["stages"]) else set())
    own: dict[str, list] = defaultdict(list)
    extra: list[tuple[str, dict]] = []
    for f in res.get("findings") or []:
        body = {k: v for k, v in f.items() if k not in ("id", "refuted", "refuted_reason", "by",
                                                          "grounding", "grounding_why", "decisive")}
        by = f.get("by") or ""
        (extra.append((by, body)) if by in checkers and by != primary else own[by].append(body))
    for key in voters:
        v = (res.get("votes") or {}).get(key)
        if not v or v.get("vote") not in cat.VOTES:
            st.vote(key, None)
            continue
        out = _RunState.normalize({**v, "findings": own.get(key, [])}, plan["agents"].get(key, {}))
        st.vote(key, out)
    for by, body in extra:
        st.add_findings(by, [body], author_agent=plan["agents"].get(by, {}))
    for f in res.get("findings") or []:
        if f.get("refuted"):
            st.refuted[(f.get("by"), EV.norm(f.get("title"))[:160])] = f.get("refuted_reason") or "снято"
        for who in f.get("confirmed_by") or []:
            fid = st.fid(f.get("by") or "", f.get("title") or "")
            st.confirmed.setdefault(fid, set()).add(who)
    st.judge_out = res.get("judge")
    verdict, conf, _summary = decide(st)
    # Неподтверждённый critical даст FAIL при подтверждении коллегой, только если он заявление о дефекте
    # (review_policy._defect_claim): автор голосует fail или не голосует вовсе.
    valid = {k: o for k, o in st.latest.items() if o.get("vote") in cat.VOTES}
    decisive_open = [f["id"] for f in st.findings() if f.get("severity") == "critical" and f.get("decisive")
                     and not f.get("confirmed_by") and _defect_claim(f, valid, st.voters)]
    return {"id": run["id"], "old": run["verdict"], "new": verdict, "reason": st.policy.get("verdict_reason"),
            "owner": owner_label(run), "would_fail_if_confirmed": bool(decisive_open)}


def replay(store, limit: int = 0) -> dict:
    tracked = tracked_files()
    rows = [replay_run(store, r, tracked) for r in _done_runs(store, limit)]
    matrix = Counter((r["old"], r["new"]) for r in rows)
    by_owner = Counter((r["old"], r["new"], r["owner"]) for r in rows if r["owner"])
    return {"runs": len(rows),
            "matrix": {f"{a}→{b}": n for (a, b), n in sorted(matrix.items())},
            "reasons": dict(Counter(r["reason"] for r in rows)),
            "owner": {f"{a}→{b}:{o}": n for (a, b, o), n in sorted(by_owner.items())},
            "new_accept_not_old": sum(1 for r in rows if r["new"] == "ACCEPT" and r["old"] != "ACCEPT"),
            "fail_if_crosscheck_confirms": sum(1 for r in rows if r["would_fail_if_confirmed"]
                                               and r["new"] != "FAIL"),
            "rows": rows}


def main() -> int:
    from store import Store
    parser = argparse.ArgumentParser(description="Вклад ролей ревью и пересчёт вердиктов")
    parser.add_argument("cmd", choices=["agents", "replay"])
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--db", default="")
    args = parser.parse_args()
    store = Store(Path(args.db)) if args.db else Store()
    try:
        data = agent_stats(store, args.limit) if args.cmd == "agents" else replay(store, args.limit)
    finally:
        store.close()
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=1))
        return 0
    if args.cmd == "replay":
        print(f"прогонов: {data['runs']}; новый ACCEPT сверх прежнего: {data['new_accept_not_old']}; "
              f"станут FAIL при подтверждении коллегой: {data['fail_if_crosscheck_confirms']}")
        for k, n in data["matrix"].items():
            print(f"  {k:28} {n}")
        print("причины:", data["reasons"])
        print("с решением владельца:", data["owner"])
        return 0
    print(f"прогонов: {data['runs']} · вердикты {data['verdicts']} · владелец {data['owner']}")
    for a in data["agents"]:
        print(f"  {a['label'][:26]:26} прогонов {a.get('runs', 0):3}  вызовов {a.get('calls', 0):3}  "
              f"находок {a.get('findings', 0):3}  снято {a.get('refuted_share')}  уник. {a.get('unique_share')}  "
              f"решающих {a.get('decisive', 0)}  ⌀ {a.get('avg_s', 0)} с")
    return 0


if __name__ == "__main__":
    sys.exit(main())
