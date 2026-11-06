# eval/evolve — the layer evolves by itself, without paying twice

> **Status (2026-11-06):** working toolkit plus the daily run, stdlib Python, tests `python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'`.
> Source of truth: the code in this folder. The cycle is **variation → measurement → selection → pin**.

The process layer (skills, rules, subagents, commands, role cards, launch prompts, hooks, genome source) changes
every day. This folder keeps three promises:

1. **Every change is versioned without a manual step.** Git counts the versions; nobody bumps a number by hand.
2. **A new version wins on quality first, then on tokens.** A cheaper version that is worse is not selected.
3. **Nothing is paid for twice.** That covers a fact repeated in the context every session loads, a question the
   owner already answered, and a queue re-read in full by every descendant.

## The cycle

| Step | Tool | What it does |
|---|---|---|
| Variation | any edit of a layer file, or a session that proposes one | — |
| Version | git, read by `catalog.py` | The version of an artifact is the number of commits that changed it; `rev` is the last of them, `dirty` marks uncommitted edits. Every merged change is a new version with no extra step, no hook and no file to conflict on. One artifact's history: `git log --oneline -- <path>`. |
| Measure: cost | `catalog.py` | Always-loaded tokens (L1) per role genome. This is the root card, rules without `paths:`, and the skill, agent and command listings, where a skill switched off costs 0 and a name-only one costs its name. `budget.json` is a ratchet: L1 of a role may not grow past it, and CI checks that (`catalog.py --check`, layer CI). Headroom is 5 %, about 250–400 tokens per role, so it trips on purpose: cut a duplicate, or raise the cap with `--ratchet` as a visible edit in the PR. |
| Measure: waste | `dupes.py` | Clusters of the same sentence across artifacts, priced in tokens. `--l1` keeps only copies inside every session's start. `--against-l1 FILE` lists the lines of a handoff that repeat L1. `spawn_session.sh` runs it before a successor starts. |
| Measure: quality | `ab.py` + `cases/*.jsonl` | Blind A/B of two versions (git revisions or the working tree) by a judge through the local llm-gateway. Each case is judged twice with the sides swapped, so position bias cancels. Two modes: `instructions` (2 calls per case) and `outputs` (4 calls per case). |
| Select | `ab.py` | B is taken when it wins (≥ 60 % of decisive cases, at least 2), or when it is not worse and cheaper. Otherwise A is kept. |
| Pin | `ab.py --record` | The verdict goes into `verdicts.jsonl` with both versions as commit ids. A fake judge, a working-tree version, fewer than 2 decisive cases or even one judge answer out of format is never evidence. |

## No repeats, no getting lost

| Problem | Tool |
|---|---|
| Asking the owner what is already decided, or what is already asked and waiting | `eval/tools/ask_once.py check "<question>" [--oq <oq_list export>]`. Owner answers come from the ledger `eval/data/decisions.jsonl` (the last line of an id wins), `docs/plans/done/` and spec rows citing `Q-0xx`/`D-0xx`. Open questions come from the owner queue, spec `Q-1xx` and roadmap «В:» rows. Exit 3: a candidate answer, so read it and cite it if it really answers (measured 01.11: 7 of 8 answers found, 1 false candidate in 8). Exit 4: already open, do not ask again. After the answer: `record`. Wired into the skills `grill-task` and `successor-handoff`. |
| A descendant re-reading the whole queue | `eval/tools/queue_focus.py <plan or export> [--session <lineage>]`. It returns a few lines in the board's order: bugs by severity, finish before starting (a WIP limit), priority, then how much a card unblocks. Final statuses, raw ideas and goals with open leaves are left out; blocked cards are listed with their blockers. With `--session` (default `$TAIBE_LINEAGE`), cards held by other sessions leave the focus and the WIP count. |
| Sessions that look alike but must not be confused | `spawn_session.sh` gives every descendant a lineage id under its parent's (`TAIBE_LINEAGE`, e.g. `r.x1y2.k3z4`, generation = dots). The first message names it, and the session uses it as its `session` label on cards and in the queue. Launch template, genome and handoff structure stay the same for all. |
| Handoff ids lost between generations | `eval/tools/handoff_ids.py collect/diff` (existing). |

## Switches per product

A product's settings in tAI-Boards (**Pipeline & evolution**) can switch off the parts here that spend model calls
or run without a person: the A/B judge (`abJudge`), the ask-once lookup (`askOnce`) and the handoff duplicate
check (`handoffDupes`). The same page covers the pipeline's automation: prompt brief, successor, grill hint, Nerve,
swarm, council review, card auto-fill. Tools read the switches through `.claude/scripts/pipeline_settings.py`. The list
and where each switch is enforced: [`boards/docs/pipeline-settings.md`](../../boards/docs/pipeline-settings.md).

## Commands

```bash
python3 -I eval/evolve/catalog.py              # versions from git, L1 per role vs budget (also: make evolve)
python3 -I eval/evolve/catalog.py --ratchet    # set budgets to today's L1 + 5 % (commit budget.json on purpose)
python3 -I eval/evolve/dupes.py --l1           # duplicates every session pays for
python3 -I eval/evolve/dupes.py --against-l1 handoff.md --max-waste 300
python3 -I eval/evolve/ab.py --artifact .claude/skills/grill-task/SKILL.md --a HEAD~1 --b work \
    --cases eval/evolve/cases/grill-task.jsonl                # needs the llm-gateway; --record only for commits
python3 -I eval/tools/ask_once.py check "can a subtask have two parents?"
python3 -I eval/tools/queue_focus.py eval/board/plan-*.json  # also: make focus
python3 -I eval/evolve/daily.py run --target taibe --since <rev>  # the daily run's judging part, now
python3 -I eval/evolve/daily.py cases eval/evolve/cases/*.jsonl   # cases fit for the daily run?
```

## Daily run — selection without a person (owner, 06.11)

> «А/В сравнения должна запускать отдельная автоматическая сессия 1 раз в сутки и вносить корректировки также
> автоматически. Ложноположительные результаты должны помечаться как брак и не приниматься.»

`daily.sh run` (launchd, 05:00 local, after the notebook sync of 04:17) runs `daily.py nightly`: it takes the run's one lock (`flock`, shared with `daily.py cycle --force`), refreshes the run's own worktree `worktrees/evolve/daily` (detached on a fresh
`origin/board-agents`; no person's checkout is touched) and starts its fresh `daily.py cycle`:

| Step | Who | What |
|---|---|---|
| measure | `daily.py run` | `catalog.py`, `dupes.py --l1`, `eval/tools/ctx_budget.py learn` when it exists; layer files changed since the last run (`~/.claude/evolve/state.json`) |
| calibrate | `judges.py` | Judges are Claude models only (owner decision 06.11); no local model, gateway or Ollama is started. Candidates in order: `claude:claude-sonnet-5-5`, `claude:claude-haiku-5-5`, then `claude:claude-opus-5-5` as a fallback — at night only if `abJudgeClaude` is on (the board, closed on doubt, or the owner's file `~/.claude/evolve/abJudgeClaude.on`), or given by the owner with `--judges`. Each is calibrated on the reference skill (`grill-task`): identical texts TIE in both orders, the text beats its first 30 % and its copy with a harmful paragraph in both orders, 6 asks, all right. The first two that pass judge. Fewer than two → nothing is judged, the artifacts stay pending, one line «нет годного судьи» goes to SE-49 |
| judge | `daily.py run` + `quality.py` | The version before the last edit against the current one, for every changed file with cases. Item by item: both judges finish an artifact before the next one starts, at most 2 artifacts a night, and an artifact starts only if the night's budget (160 calls, 1.2 M tokens) covers it for both judges; the rest stay pending. The state moves to head only when nothing is pending. Files without cases go to `~/.claude/evolve/queue.json` |
| act | `daily.py run` | Accepted loss of the merged version → revert PR; accepted win → pinned in `verdicts.jsonl`; brak and insufficient → recorded, never applied |
| session | `daily_session.cmd_session` | `claude -p` with `daily-prompt.md` and one input file the code prepares (verdicts as labels and reasons, queued artifacts with their diffs, the day's incidents as scrubbed command templates): cases for the queue, a review of accepted verdicts (it can only append a `supersedes … brak` line), antigens as data (rows plus fire/quiet cases in `antigen_cases.json`), and a last line for SE-49 that the code posts after the personal-data scan. Exact rights: read the worktree, write four data paths, two exact check commands; no git, gh, hub, MCP, agents or code. 60 turns, $4, 45 min; quota spent — quiet exit |
| publish | `daily_session.cmd_publish` | Runs nothing the model wrote. Data (cases, verdicts) passes `check_cases`, the past-lines rule and `guard.scan` (names, e-mails, phones, `/Users/`, UUIDs, tokens → refused) → one PR that may merge by itself; antigens pass `guard.check_antigens` (lesson ≤ 400, no «ignore/bypass» wording; pattern < 50 ms on 100 KB in a child process; own fire/quiet cases) → one PR for a person |
| merge | `daily.py merge` | Only PRs this run opened (`prs.json` record + `Evolve-Run:` trailer, head unchanged), no `D`/`R` (`git diff --name-status -M`), safe class only — data, or a skill / prompt (not `lens-*`) restored to the exact blob of a version already in the base; every check green; the base branch has required checks (none → closed); `evolveAutoMerge` on and read from the board (defaults or a failed read → off) → `gh pr merge --auto --squash --match-head-commit`. Rules, cards, agents, commands, the genome, `*.py`, `*.sh`, lenses: PRs marked «[manual merge]». HR: PRs only |

The merge is done by the owner's scheduled job, not by a Claude session: the sessions' merge-guard
(`.claude/hooks/pre-tool-use-merge-guard.py`) is not bypassed and not changed, and the headless session itself has
no `gh`, `git push` or `git commit`. A scheduled run outside 03:00–08:00 (a Mac asleep at 05:00 starts the job on
wake) logs and waits for the next night, so it never spends daytime quota; `--force` runs it now.

### Statuses and thresholds (`quality.py`)

Every verdict is `accepted`, `brak` or `insufficient`, with its reasons. Only `accepted` acts.

| Check | Threshold | Why there |
|---|---|---|
| Canaries, on every run, from the current text | the same text twice → TIE in both orders (`X` twice is a position reader); the first 30 % of it → loses; it with a harmful paragraph in the middle → loses | A judge that cannot see a cut or a harmful order cannot see a real difference either. A failed canary makes the judge's **whole run** brak, not only that file |
| Swap agreement | at most 1/3 of cases change pick when the sides swap | A coin flips half the cases, a position reader all of them; 1/3 leaves room for real near-ties |
| Format | 0 answers out of format | A broken answer is never read as a tie (ab.py's rule) |
| Repeat | 1/3 of decisive cases asked again; a flip to the other side → brak, a fall to a tie counts as a tie | Temperature 0 should answer the same; +30 % calls |
| Length | the same meaning at two lengths (the text, and it restated); a judge whose probes mostly go to one length is biased, and its picks of that length are brak | The judge prompt here says length is not a criterion (tokens are priced apart) |
| Calibration | every candidate, every night, 6 asks on the reference skill, all right | 06.11: local qwen2.5:7b and glm4 (9.4B) passed the identity canary and failed truncate and harm; a judge that cannot see half a skill missing cannot see a real edit. Local models are no longer candidates (owner rule) |
| Two judges | two different models must both pass and agree; one judge, a disagreement or an unreachable judge → insufficient | One model's taste is not evidence |
| Evidence | ≥ 6 cases, ≥ 4 decisive, the winner ≥ 80 % of decisive | ab.py takes 2 and 60 %; a fair coin gives 4 of 4 one time in 16, 5 of 6 — 7 in 64 |

A judge that is not reached (a limit message, a wrong answering model, an error, an empty answer, the budget, out
of time) is «unavailable», never brak: the file stays pending and is judged again the next night against the same
baseline. The headless session may append a `supersedes` line that marks an accepted
verdict brak; a revert PR whose verdict was superseded is closed, not merged. Nobody turns brak into accepted.

### Claude judges (`abJudgeClaude`, off by default)

Every `claude:<model>` id goes to `judges.claude_call`: `claude -p --model <model> --output-format json`, the same
prompt and last-line format as `ab.py`, no tools, no MCP, no hooks (`disableAllHooks`), no session file, an empty
folder. The answering model is checked in `modelUsage` (a dated build or a `[1m]` variant is the same model), and the
real tokens are charged to the night's budget; the worst ratio of real to estimated tokens scales the next estimates.
A full first night with two artifacts is about 137 calls. Nightly judges are off until the owner turns them on: the
switch on the board (Pipeline & evolution; the deployed board has no such switch yet), or the local file
`touch ~/.claude/evolve/abJudgeClaude.on` (remove it to turn them off). `TAIBE_PIPELINE=abJudgeClaude=off` turns them
off over both. The owner's first run by hand:

```bash
python3 -I eval/evolve/daily.py run --target taibe --judges claude:claude-sonnet-5-5,claude:claude-haiku-5-5
```

### Limits (`resources.py`)

The run waits up to 30 min while another heavy launchd job runs (notebook sync at 04:17, backup). The headless
session keeps its own limits (60 turns, $4, 45 min). A revert puts back only the version before the losing edit (A is
the parent of the last commit that changed the file), and only if the file has not changed since the verdict. «Not
worse and cheaper» keeps B; an old version that is cheaper at the same quality is only flagged, never reverted.

### Turning auto-merge on (owner)

`evolveAutoMerge` is **off** by default and off whenever the settings cannot be read. Leave it off for a week and
read the journal (`~/.claude/evolve/runs/*.json`, the `[manual merge]` and data PRs it opened); then turn on
«Allow auto-merge» and required checks for `board-agents` in GitHub, and the switch in the board's settings.

### Install (owner, after the merge)

```bash
bash eval/evolve/daily.sh install     # renders space.hrhelper.evolve-daily.plist into ~/Library/LaunchAgents, loads it
bash eval/evolve/daily.sh status      # launchd state, last run's summary
bash eval/evolve/daily.sh run --force # a run now (it takes the lock; one run at a time)
bash eval/evolve/daily.sh uninstall
```

Optional: `sudo pmset repeat wakeorpoweron MTWRFSU 04:55:00` wakes the Mac for it. GitHub auto-merge is off in
tAIBE and `board-agents` has no required checks today: the run checks every check of the PR itself before
`gh pr merge --auto`; turning on «Allow auto-merge» and required checks in the repository makes GitHub hold the line
too. Switches: `abJudge` off — no judge calls; `abJudgeClaude` off — no nightly judges; `evolveAutoMerge` off — PRs
wait for a person; the master switch off — no run steps that spend model time.

## Limits — measured, not assumed

- Token counts are the eval estimate (`tokens.py`: Latin ~3.5 chars per token, Cyrillic ~2.2), the same one
  `context_audit.py` uses. They are good for comparing versions, not for billing.
- L1 counts only what the layer adds. The harness's own system prompt and MCP tool descriptions are measured by
  `eval/tools/context_audit.py` on real transcripts.
- `ab.py` with a real judge has not run in this repository's CI: CI has no gateway. The harness, the swap rule and
  the selection rule are covered by tests with a scripted judge. Before relying on the judge, measure how often it
  agrees with the owner on 10–20 labelled cases (proposal 5 in `docs/integrations/README.md`).
- `ask_once.py` uses TF-IDF with crude stemming and no embeddings. Every ledger entry carries `kw`, keywords in
  the other language, so a question in English finds an answer written in Russian. Expect false negatives on
  heavy rewording: the agent reads the hits, the exit code is a hint.

## Origins

- Blind A/B judging of skill versions comes from [i-have-adhd](https://github.com/ayghri/i-have-adhd) (MIT), as an
  idea; no code was taken. Review: [`docs/integrations/i-have-adhd/`](../../docs/integrations/i-have-adhd/README.md).
- Untrusted text goes between fences with a random nonce per call. The idea comes from
  [agno](https://github.com/agno-agi/agno); review: [`docs/integrations/agno/`](../../docs/integrations/agno/README.md).
