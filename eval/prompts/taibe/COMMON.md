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
   Review of a new PR (coordinator 13.11, canon `.claude/memory/chunks/process/adversarial-review.md`): the author runs
   the chain first from the main checkout and puts the report in the PR body:
   `TAIBE_HOST_ROOT=<repo_root> infra/ai-council/review_chain.sh <PR> /tmp/rc-<PR>.json`. `<repo_root>` is the field of
   `instances/hr-helper.json`: the council base is in the HR host. Without `TAIBE_HOST_ROOT` the chain exits 1
   (`.claude/scripts/host_root.py:17`). If the coordinator reports the opencode limit, add
   `REVIEW_CHAIN_FORCE=glm`. Exit 0 — the author writes `Линза «цепочка»: approve на <sha>` in the PR with a link to the
   report: the quorum needs 3 lenses (`min_lenses`, `instances/taibe.json`), and a signature with «GLM» counts as
   Control. Exit 2 — the chain findings are `changes`: fix them and run the chain again on the new head (each run starts
   a new report). Exit 1 or 3 (chain not available, quota) — do not repeat, tell the coordinator; the PR waits for the
   chain, no third role lens is assigned, and you take the next card. An urgent PR goes to the owner only through the
   coordinator. Then at most 2 Claude role lenses: the path owner and the one that the coordinator assigns. If a new
   head carries only the accepted finding of lens X, write «дельта = принятая находка <X>» in the assign: only X
   confirms, every other lens writes one line `<Линза> (роль N): approve переношу на <sha>`. New logic or a file outside
   the finding gets a full round.
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
  After a merge, request the card's close in the same step.
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
