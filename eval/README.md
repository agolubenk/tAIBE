# eval — measurement & ops pipeline for an AI session team

Evaluates how a long-lived team of AI coding sessions spends money and attention, and runs its day-to-day ops. Pure Python 3 standard library — no external dependencies.

| Dir | What |
|---|---|
| `nerve/` | Watchdog daemon: GitHub / owner-queue / system / budget sources, quorum between roles, circadian modes (day/evening/night). |
| `swarm/` | Egress orchestration for the session swarm. |
| `pipeline/` | Capsule handoffs (author → review lenses), `genome/` configs (roles, boards, plan). |
| `tools/` | `spend.py` (team spend at API prices: session × day, role, product, context window bands — see «Spend» below), `prices.py` (the one API price table for `eval/`), `transcript.py` (where transcripts live, how to read them), `wake_anatomy.py` (what wakes a session, what it costs), `context_audit.py`, `call_purpose.py`, `spawn_session.sh` + `lineage.py` (predecessor retires itself after the successor's ack), `reap_sessions.sh` (list finished sessions; `--kill` is the owner's; `--auto` — safe auto-cleanup, dry by default, acts only under the owner's launchd agent `reaper_launchd.sh`, `--auto --summary` — a readable day summary), Terminal windows of `spawn_session.sh` close themselves after `claude` exits 0 and a 10 s countdown (Enter keeps)., `ctx_budget.py` (live window budget of a session: `next`/`done`/`status`, daily `learn` → `~/.claude/ctx-budget/params.json`; hook `context-threshold.py`). |
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

CI runs the same commands (`.github/workflows/eval-ci.yml`). Tool tests `eval/tools/test_*.py` run as scripts in `.github/workflows/layer-ci.yml`.

## Spend (GL-1)

`python3 -I eval/tools/spend.py --hours 24 [--json out.json] [--attribution [--prs file]]` — read-only, no LLM. It
reports $ at API prices per session × local day × product, with role, lineage and registry key from the first message of the session, product of each call
by `budget.Products` (the same function as the Nerve window share, SE-66: cwd under a `repo_root` of
`instances/*.json`, else the session folder), context median / p90, context window bands (≤ 250K, 250–500K, 500K–1M, > 1M) as shares of calls
and $, cold calls, compactions and the first call. Subagent calls count in the parent session; a request copied into
a resumed session counts once. Sessions without a role go to «прочее». Metric definitions are in the docstring of
`spend.py`. `--attribution` (PR 2, `attribution.py`) adds the target of each call — a PR (lens window `gh pr view N` …
`gh pr comment N`, then the `forest_set_work_state` branch or card), a card, or «unattributed»; the PR list comes from
`gh pr list --state all --limit 1000` per `github.repo` of `instances/*.json` (`--prs` — a file, for tests). Rules
are in the docstring of `attribution.py`. The nightly run and the weekly table are the next steps of the GL-1 plan.

## Runtime state

`nerve/state/` and `swarm/state/` hold live daemon state (journals, locks, logs) and are gitignored — they are created on first run and never committed.
