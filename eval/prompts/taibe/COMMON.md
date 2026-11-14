# Start of a T3 role of the tAIBE team (OPS-25)

Product: tAIBE (`aiBoards&eval`), checkout `~/Desktop/Development/tAIBE`, branch `board-agents`, repo
`agolubenk/tAIBE`. Product slug: `taibe`. Owner decision: `d-ops25-plan-0711` (all by recommendation). Plan and
the table «Кто чем владеет»: `docs/plans/roadmap/nerve-per-product.md`.

## Read, in this order

1. Your role file `roles/<N>-<key>.md`.
2. This file.
3. Laws: `.claude/rules/90-team-t3.md` and only §10 of TEAM-0: Read
   `~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2/handoff/2026-10-25/team/TEAM-0-COMMON.md`
   with `offset=200`. §1–9 describe the HR team; skip them. In §10, the HR files `state/<key>.md` and the
   `TEAM-<n>` card are `state/<key>-taibe.md` and this folder for you.
4. Board rules: `eval/prompts/launch-3010/T-BOARDS.md`, only the sections «Цикл работы с карточкой», «Что сервер
   требует при смене статуса» and «PR и линзы». A lens verdict: the first non-empty line has the lens name, the word
   `approve` or `changes`, and the head SHA after it (`Бэкенд: approve на 46b9f87e1`) — the Nerve quorum
   (`eval/nerve/quorum.py`) reads only this line.
5. Your work state: `work_state_read <key>-taibe` (not `<key>-t3`: that list belongs to the HR role).

## Board

Workspace aiBoards&eval `lth89qy6f8j1greiy4c5cn23`. Projects: OPS «Инфраструктура» `mjwiozcdb50f7imppo1n2emv`,
TB «t-boards» `mf6jpr5wftbgr3z93lvw807v`, SE «supertick-eval» `tl3j7yc2mc7lyro1on059dmh`, IDEA «Банк идей»
`gfr6adn3iw3y4dxzbsuotrhv` (half-baked ideas: do not take), GL «Цели и планы» `czjtga2z1wdvfv3di7dxhm1x`.
`forest_set_work_state` replaces the whole state: send `branch`, `taskId` and `waiting` every time.

## First steps

1. **Nerve.** One Monitor (persistent): `python3 -I eval/nerve/nerve.py tap <key> --product taibe`. Always write
   the flag: a session after `--resume` can lose the genome and its `TAIBE_PRODUCT`.
2. **Board.** `forest_set_work_state` with `workspaceId: "lth89qy6f8j1greiy4c5cn23"`, `session: "taibe <key>"`,
   `harness: "claude-code"` and `step`. Take a lease on a card only when you start work on it.
3. **First card.** Roles 2–6: if your work state is empty, wait. The coordinator sends your first card through the
   Nerve, and your tap prints it. Do not message the coordinator for it.
4. **Done.** `forest_set_work_state` with `step: "started; next — <first task>"`.

## On every step

- After each step: `work_state_write <key>-taibe` and `forest_set_work_state`.
- Work in `worktrees/<track>/<topic>`. Do not commit in the main checkout.
- Next card: when your card goes to review or merges, run `python3 -I eval/tools/queue_focus.py --plan --product
  taibe`. Take the first item and its lease (`forest_acquire_lease`). If the lease is taken, take the next item.
  After a merge, send the done line to role 2 in the same step:
  `python3 -I eval/nerve/nerve.py emit plan --product taibe "done #<n> <KEY> — <what is done, max 200 chars>"`. This
  message type is allowed in addition to TEAM-0 §10.3. Do not open a done PR and do not request the close: role 2
  does both, once a day (SE-61, `docs/plans/DONE.md`).
- Switch your lane only for an owner inbox item with `urgency: now`, an inbox alert (always), a production failure
  or an owner stop. Put any other signal (a Nerve digest, a finding, an idea, an inbox item with `urgency: queue`) as
  a card in the plan's backlog row and continue your card.
- Every owner-queue item of the tAIBE team has `-taibe-` in its id (`m-taibe-91`, `d-taibe-…`). Without it, the
  owner's answer goes to the HR team.
- Every decision gets 3 or more independent lenses (`.claude/memory/chunks/process/adversarial-review.md`).

## Do not

- Merge PRs. Only tAIBE Control (role 5) merges: one at a time, `--match-head-commit`. A merge into `board-agents`
  does not deploy production.
- Take HR work (`HR_Helper-v2`). Give it to the HR team as a t-boards card.
- Call local models outside the machine lock (`infra/ai-council/ollama.py`, `local_inference_slot`).
