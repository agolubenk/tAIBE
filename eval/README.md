# eval — measurement & ops pipeline for an AI session team

Evaluates how a long-lived team of AI coding sessions spends money and attention, and runs its day-to-day ops. Pure Python 3 standard library — no external dependencies.

| Dir | What |
|---|---|
| `nerve/` | Watchdog daemon: GitHub / owner-queue / system / budget sources, quorum between roles, circadian modes (day/evening/night). |
| `swarm/` | Egress orchestration for the session swarm. |
| `pipeline/` | Capsule handoffs (author → review lenses), `genome/` configs (roles, boards, plan). |
| `tools/` | `wake_anatomy.py` (what wakes a session, what it costs), `context_audit.py` (`--product <slug>` — the team of one product from `instances/`), `call_purpose.py`, `spawn_session.sh` + `lineage.py` (predecessor retires itself after the successor's ack), `reap_sessions.sh` (list finished sessions; `--kill` is the owner's; `--auto` — safe auto-cleanup, dry by default, acts only under the owner's launchd agent `reaper_launchd.sh`, `--auto --summary` — a readable day summary), Terminal windows of `spawn_session.sh` close themselves after `claude` exits 0 and a 10 s countdown (Enter keeps)., `ctx_budget.py` (live window budget of a session: `next`/`done`/`status`, daily `learn` → `~/.claude/ctx-budget/params.json`; hook `context-threshold.py`). |
| `data/` | Measurements: wake anatomy runs, cost audits per team wave. |
| `reports/`, `shadow/` | Lens reports; shadow-mode watchdog probe. |
| `context/` | Background: the evaluated [supertick](https://github.com/denizen24/supertick) approach (excerpt in `context/supertick-src/`, MIT) and team notes. |
| `board/`, `prompts/`, `boards/` | Plan cards, prompts, board-side architecture notes. |

Deep docs (RU): [EVALUATION.md](EVALUATION.md) — supertick applicability verdict · [ADVANTAGES.md](ADVANTAGES.md) · [HANDOFF-2026-10-28.md](HANDOFF-2026-10-28.md) — current team handoff · [Dev4dev — инженерный контур](Dev4dev%20%20итоговая%20архитектура%20и%20оптимизация%20инженерного%20контура.md).

## Tests

From the repo root, Python ≥ 3.10:

```bash
python3 -I -m unittest discover -s eval/nerve    -p 'test_*.py'
python3 -I -m unittest discover -s eval/pipeline -p 'test_*.py'
python3 -I -m unittest discover -s eval/swarm    -p 'test_*.py'
```

CI runs the same commands (`.github/workflows/eval-ci.yml`).

## Runtime state

`nerve/state/` and `swarm/state/` hold live daemon state (journals, locks, logs) and are gitignored — they are created on first run and never committed.
