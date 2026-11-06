# Start of a T3 role of the tAIBE team (OPS-25)

Product: tAIBE (`aiBoards&eval`), checkout `~/Desktop/Development/tAIBE`, branch `board-agents`, repo
`agolubenk/tAIBE`. Product slug: `taibe`. Owner decision: `d-ops25-plan-0711` (all by recommendation). Plan and
the table «Кто чем владеет»: `docs/plans/roadmap/nerve-per-product.md`.

## Read, in this order

1. Your role file `roles/<N>-<key>.md`.
2. This file.
3. Laws: `.claude/rules/90-team-t3.md`, TEAM-0 §1–2 and §10
   (`~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2/handoff/2026-10-25/team/TEAM-0-COMMON.md`).
4. Your work state: `work_state_read <key>-taibe`.

## First steps

1. **Nerve.** One Monitor (persistent): `python3 -I eval/nerve/nerve.py tap <key> --product taibe`. Always write
   the flag: a session after `--resume` can lose the genome and its `TAIBE_PRODUCT`.
2. **Board.** `forest_set_work_state` with `session: "taibe <key>"`, `harness: "claude-code"` and `step`. Take a
   lease on a card only when you start work on it.
3. **Done.** `forest_set_work_state` with `step: "started; next — <first task>"`.

## On every step

- After each step: `work_state_write <key>-taibe` and `forest_set_work_state`.
- Work in `worktrees/<track>/<topic>`. Do not commit in the main checkout.
- Every owner-queue item of the tAIBE team has `-taibe-` in its id (`m-taibe-91`, `d-taibe-…`). Without it, the
  owner's answer goes to the HR team.
- Every decision gets 3 or more independent lenses (`.claude/memory/chunks/process/adversarial-review.md`).

## Do not

- Merge PRs. Only tAIBE Control (role 5) merges: one at a time, `--match-head-commit`. A merge into `board-agents`
  does not deploy production.
- Take HR work (`HR_Helper-v2`). Give it to the HR team as a t-boards card.
- Call local models outside the machine lock (`infra/ai-council/ollama.py`, `local_inference_slot`).
