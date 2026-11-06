# Pipeline & evolution settings per product

> **Status (2026-11-01):** implemented. Spec rows: R-110, AC-028 (`t-boards-spec.md`). Owner's request of 01.11:
> each product's settings must be able to manage the evolution process and the pipeline, and switch the automated
> part on and off. Source of truth for the list: `packages/permissions/src/pipeline-toggles.ts`.

A product is a workspace (R-002). Its settings page **Pipeline & evolution**
(`/dashboard/settings/workspace/pipeline`) has three parts:

- a master switch, *Automated process*: off stops everything at once and keeps each switch's value;
- *Evolution of the process*;
- *Automatic parts of the pipeline*.

People with the workspace's `manage_settings` permission (owner, admin) change the switches. Members, agents and
API keys of the workspace can read them but never change them, so automation cannot widen its own rights.

## Switches and where each is enforced

A switch is listed only if something actually obeys it. Every enforcement point treats a missing or failed read
of the settings as **on**, except `abJudgeClaude`, which spends the owner's tokens and stays **off**. The exception is the layer: there, the last known values stay in effect.

| Switch | Group | Off means | Enforced in |
|---|---|---|---|
| `abJudge` | evolution | `ab.py` makes no model calls for A/B comparisons (exit 3) | `eval/evolve/ab.py` |
| `abJudgeClaude` | evolution | **Off by default** (the owner's tokens). On: the nightly run may calibrate and use Claude (`claude -p --model claude-sonnet-5-5`) as a judge when fewer than two free judges pass | `eval/evolve/judges.py` (`daily.py run`) |
| `askOnce` | evolution | `ask_once.py check` returns "ask as usual" without looking up | `eval/tools/ask_once.py` |
| `handoffDupes` | evolution | no duplicate-context check before a successor starts | `eval/tools/spawn_session.sh` |
| `evolveAutoMerge` | evolution | the nightly evolution run merges none of its own PRs (reverts after a lost A/B, verdicts, cases, antigens); they wait for a person. On by default (owner, 06.11) | `eval/evolve/daily.py merge` (`daily_git.merge_ready`) |
| `promptBrief` | pipeline | no GLM brief of long prompts (one model call per prompt saved) | `.claude/hooks/user-prompt-submit.py` |
| `successorAuto` | pipeline | no automatic successor at 80 % of the window | `.claude/hooks/context-threshold.py` |
| `grillHint` | pipeline | no `<grill-task-auto>` reminder on new tasks (the rule to roast large tasks stays) | `.claude/hooks/user-prompt-submit.py` |
| `nerveWakes` | pipeline | Nerve still journals events but wakes nobody | `eval/nerve/nerve.py` |
| `swarm` | pipeline | `swarm.py ask` refuses to call a model (exit 3); the session does the job itself | `eval/swarm/swarm.py` |
| `councilReview` | pipeline | the council worker takes no review of cards on review (its own `worker_enabled` still applies too) | `infra/ai-council/council_worker.py` |
| `cardAutofill` | pipeline | an agent's move no longer fills assignee and start date; the move's comment and link still go out | `apps/api/src/forest/card-fill/fill-card.ts` (server) |

Repository gates (`infra/checks`, CI) are not switches. A red check is a defect, not a preference.

## How the layer reads them

The API has two routes:
- `GET /api/pipeline-settings/workspace/{workspaceId}`: members and the workspace's API keys;
- `PUT /api/pipeline-settings/workspace/{workspaceId}`: a user session with `manage_settings`. The body is a
  partial `{automation?, toggles?}`, and an unknown switch is a 400.

Storage is the table `workspace_pipeline_setting`: one JSON row per workspace, migration `0080`. No row means
every default (all on).

Hooks and tools call `.claude/scripts/pipeline_settings.py` (stdlib).

- **Source.** It reads the board, at most once every 10 minutes, using three things:
  - the board's address: `T_BOARDS_URL` from your environment, or `boards.url` in `eval/nerve/config.json`; https,
    with plain http only to localhost. An address from the repository is used only for a trusted host: the known
    board host, localhost, or `T_BOARDS_ALLOWED_HOSTS` from your own environment. A pull request that changes the
    address cannot redirect the key;
  - the key: this install's own `T_BOARDS_PIPELINE_KEY`, from your environment or else Keychain through
    `infra/scripts/dev-ai/mcp-secret.sh` (service `hr-helper-mcp`, account `T_BOARDS_PIPELINE_KEY`). Every product
    and every install gets its own key (owner's decision `d-tb-product-key-0411`). There is no fallback to the boards
    MCP's `T_BOARDS_API_KEY`: that key reaches every product;
  - the product: the key names it. The key must reach exactly one product, and that product is read. A key that
    reaches several is refused. `boards.product` / `T_BOARDS_PRODUCT` (the name or slug people see) and
    `boards.workspace` / `T_BOARDS_WORKSPACE` (an id) are only a check. If the key is for another product, it is
    refused, so a key put into the wrong install cannot turn on another product's switches. The check works only
    when the install names its product: tAIBE's `eval/nerve/config.json` names «aiBoards&eval» (`aiboards-eval`)
    and its workspace id, and a test keeps it so. With no product and no workspace set, any one product's key is
    read. The product is asked
    again on every refresh (two calls per 10 minutes), so a key swapped for a wider one is refused within one
    refresh.
- **Cache.** The answer is kept in `.claude/pipeline-settings.json` (gitignored, mode 600). A cache from another
  workspace is ignored.
- **Strict answers.** Only a complete answer is accepted. Redirects are refused, so the key never goes to another
  host. A switch newer than the deployed board (`LATE_TOGGLES` in the script, today `abJudgeClaude` and `evolveAutoMerge`) may be
  missing from the answer: it then takes its default, and the rest of the answer is still read.
- **Failures.** A failed read keeps the last known values and is retried only after 10 minutes. So the board
  being down costs one timeout per 10 minutes, and an outage never turns back on what the owner switched off.
- **Hot paths.** The successor hook runs on every tool call. It reads the cache only, after its own cheap exits.
- **Environment.** `TAIBE_PIPELINE` can only switch parts off on top of the board: `off`, or `swarm=off,…`.
  A session cannot overrule the owner.
- **Not connected.** With no board address, no `T_BOARDS_PIPELINE_KEY`, a key that reaches several products, or a
  key for another product than the config names, the layer keeps the last known switches of its product (defaults
  if it never read the board). The status command below says what is missing.

Limits: one product per install (the key reaches one workspace). Another install (HR Helper, when the layer comes
there) needs its own key, and its product check must come from its own config, not from a copy of tAIBE's. On one
Mac the Keychain account name is fixed today, so a second install needs its own account name first. The page keeps only the last change (who and when), with no per-switch history. An open page does not update live when someone else changes a switch.

```bash
python3 -I .claude/scripts/pipeline_settings.py          # effective switches and their source
python3 -I .claude/scripts/pipeline_settings.py fetch    # refresh now
```

### Connect an install (owner)

1. On the board: Settings → API keys → choose the product → Create. For tAIBE the product is «aiBoards&eval»: a key
   for any other product is refused by the config's check. The key is shown once; the board keeps only its hash.
   Another install first names its own product in its own config (`boards.product`, `boards.workspace`) or in
   `T_BOARDS_PRODUCT` / `T_BOARDS_WORKSPACE`.
2. On the Mac: `security add-generic-password -U -s hr-helper-mcp -a T_BOARDS_PIPELINE_KEY -w`. Paste the key at the
   prompt: it never reaches the shell history.
3. Check: `python3 -I .claude/scripts/pipeline_settings.py fetch`, then the status command. The source is `board`, and
   the product is the one you chose.
4. Undo: `security delete-generic-password -s hr-helper-mcp -a T_BOARDS_PIPELINE_KEY`. The hooks go back to the
   last known switches, and to the defaults once the cache is removed.

## Tests

- `packages/permissions/src/pipeline-toggles.test.ts`: defaults, normalisation, the master switch.
- `tests/api-integration/pipeline-settings.test.ts`:
  - defaults and partial updates;
  - agents, keys and members get 403 on update;
  - an unknown switch gets 400;
  - with `cardAutofill` off, no fields are filled and the comment is still posted.
- `tests/api-integration/api-key-workspace-scope.test.ts`: a key limited to product A reads A's switches (200), gets
  404 on B and 403 on an update.
- `.claude/scripts/test_pipeline_settings.py`:
  - the keys match the TypeScript list;
  - environment override, cache, fetch from a fake board;
  - an outage keeps the last known values; a broken cache falls back to defaults;
  - a key for one product reads it; a key for several, a key for another product than the config names, or only
    `T_BOARDS_API_KEY` is refused; the product is asked on every refresh;
  - the shipped `eval/nerve/config.json` names its product, and a key for another product keeps this product's
    «off»; a URL the key is never sent to costs no Keychain call.
