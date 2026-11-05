# tAIBE — tasks, AI Boards & Eval pipelines

A product layer for teams where long-lived AI coding sessions and people work side by side. Its goal is one:
the team spends fewer tokens and less context **without losing speed or quality**, and never stands idle on a
usage limit. It is laid over a host project and changes nothing visible there: pull requests, cards, the owner
queue, the bot and "merge = deploy" look as before.

| Part | Path | What it is |
|---|---|---|
| **tAI-Boards** | [`boards/`](boards/) | Where the work lives: kanban for agents first and people second. Task forest (trees, branches, sectors, felling, seeds), leases with fencing tokens, work state written after every step, agent fields on cards (`branch`, `pullRequests`, `contextPack`, `tokens`, `costUsd`), an approval matrix (agents bring a card to "review" at most), per-product data segmentation, history with rollback, Notion import, claude-mem binding, a token-cheap MCP. Spec — [`boards/docs/`](boards/docs/README.md). |
| **eval** | [`eval/`](eval/) | How the team works cheaply: the economy model (calls × context × price + cold rewrites + output) and mechanisms P1–P11 — role genomes (`claude --settings`), handoff capsules (`contextPack`), the Nerve watchdog (wakes a session only when it must act), the swarm (routine on cheap models behind an egress filter), wake/cost anatomy and measurements. The layer evolves itself ([`eval/evolve/`](eval/evolve/README.md)): versions every skill/rule/prompt on change, prices the always-loaded context per role, finds repeated facts, picks between versions by a blind judge (quality first, then tokens), never re-asks a decided question, and keeps descendants on a short focus list with their own lineage id. |
| **Control & AI tooling** | [`infra/`](infra/CLAUDE.md) | Services the process runs on: AI council (model lenses for adversarial review, daily plan, review of "on review" cards), owner queue (MCP `oq_*`, Telegram bot, ops console), shared MCP hub, LLM gateway with key/model rotation, context compression, and model-free repository gates (`infra/checks/`: secrets, hygiene, data integrity, syntax, dependency advisories as a ratchet). |
| **Process layer** | [`process/`](process/README.md), `.claude/`, `.continue/`, `.agents/`, `.windsurf/`, `.ai/`, [`docs/`](docs/README.md) | The team operating layer: role launch prompts, operating model, Never/Always rules, specialist subagents, hooks, skills, knowledge chunks, task-case templates, worktree workflow, closed-items log. |

Target metrics: ≤ $20 per PR, mean context ≤ 120K, first call ≤ 55K tokens, "read the task and start" 55–75 %
cheaper than a Notion-based process, RPO ≤ 2 h, zero team stops the owner does not know about.

## Quick start

```bash
make help            # all layer commands
make check           # eval + layer hooks/skills + infra services (stdlib python, node built-ins)
make check-boards    # boards gates (pnpm)
make wt-fix NAME=x   # isolated git worktree with its own dependencies
```

### tAI-Boards (`boards/`)

```bash
cd boards
cp .env.sample .env.local          # fill in the values
docker compose -f compose.local.yml up
# or from source (Node 24, pnpm 10):
pnpm install --frozen-lockfile && pnpm dev
```

### eval (`eval/`)

Pure Python 3 standard library — nothing to install:

```bash
python3 -I -m unittest discover -s eval/nerve    -p 'test_*.py'
python3 -I -m unittest discover -s eval/pipeline -p 'test_*.py'
python3 -I -m unittest discover -s eval/swarm    -p 'test_*.py'
```

### Control & AI tooling (`infra/`)

```bash
npm run mcp-hub:status        # shared MCP hub
npm run llm-gateway:status    # model gateway
npm run ai-council:status     # AI council
npm run done:check            # closed-items index
```

### Team T3 — one command per product (`eval/tools/spawn_session.sh`)

Run it from the product's folder (its main checkout; worktrees count as the same product). It checks and raises
the Nerve first: not loaded → `launchctl bootstrap`, silent pulse → `kickstart -k`. Then it opens the roles in the
canonical order 1→5→4→3→2→6, waiting until each new session shows up before the next one, up to `SPAWN_WAIT`
seconds (default 90). At the end it prints who came up and who did not. A role that is already alive in this
product is skipped, so running the command again opens only the missing roles.

```bash
T=~/Desktop/Development/tAIBE/eval/tools
cd ~/Desktop/Development/HR_Helper-v2              # HR Helper; tAIBE — cd ~/Desktop/Development/tAIBE
bash $T/spawn_session.sh --launch --roles all      # whole team; one role: --launch --role release
bash $T/spawn_session.sh --status                  # roles → session (pid, name, status, generation, idle) + Nerve pulse
bash $T/spawn_session.sh --stop                    # prints `kill <pid>` per live role for the owner; kills nothing
```

`--force` opens a role even when it is alive, and `--terminal print` prints the commands for a VS Code tab instead of
opening windows. A live role is the youngest live Claude Code session with that role's genome inside the product
that has no successor yet (neither an acceptance receipt nor a live descendant of the same role). Until OPS-25 there
is one Nerve per Mac (`space.hrhelper.nerve`) and one set of role launch files (`eval/prompts/launch-3010/roles/`)
for every product.

Laying the layer over another project — [`process/README.md`](process/README.md).

## Repository layout

```
boards/        tAI-Boards — pnpm workspace (apps/api, apps/web, packages/*); docs/ spec, architecture, implementation log; tools/ stand probes
eval/          python-stdlib pipeline: nerve/, swarm/, pipeline/ (capsules, genome, reflex), evolve/ (versions, budgets, A/B), tools/, data/, reports/
infra/         ai-council/, owner-queue-mcp/, owner-queue-bot/, ops-console/, mcp-hub/, llm-gateway/, headroom/, scripts/
process/       role prompts, operating model, overlay guide, TRANSFER.md (where things came from)
docs/          specs/, plans/ (closed-items log), guides/ (how-tos), integrations/ (external solutions analysis), ai/, ops/
.claude/ .continue/ .agents/ .windsurf/ .ai/   functional layer: rules, subagents, hooks, skills, knowledge, task cases
.github/workflows   boards-ci · eval-ci · infra-ci · layer-ci
```

## Origins, forks & licenses

The product was incubated inside another repository where the team worked (`agolubenk/HR_Helper-v2`):
it was assembled from that repository's
subprojects `supertick-eval/` (→ `eval/`) and `t-boards/` (→ `boards/`), its AI-tooling services (→ `infra/`) and
its functional layer (→ `.claude/` & co.). Path mapping and what was not carried over — [`process/TRANSFER.md`](process/TRANSFER.md).

Third-party foundations:

- **tAI-Boards** is a fork of [Kaneo](https://github.com/usekaneo/kaneo) — MIT; the root [LICENSE](LICENSE) is Kaneo's
  licence and covers the fork in `boards/`. The internal `@kaneo/*` package scope and `KANEO_*` env names are kept
  until the split.
- **eval** started as an evaluation of [denizen24/supertick](https://github.com/denizen24/supertick) (MIT): two of its
  mechanisms were adopted in shadow mode (a model-free watchdog → the Nerve; an external engine for one-off
  read-only roles). Excerpts — [`eval/context/supertick-src/`](eval/context/supertick-src/) with its LICENSE; verdict —
  [`eval/EVALUATION.md`](eval/EVALUATION.md).
- `claude-plugins-official/` — vendored official Claude Code plugins (licenses inside each plugin).
- UI and motion skills in `.claude/skills/` — vendored from [emilkowalski/skills](https://github.com/emilkowalski/skills)
  (MIT), provenance in [`.claude/skills/VENDORED.md`](.claude/skills/VENDORED.md).
- **Borrowed solutions.** When the core, base capabilities, design or principles of an external solution are taken
  into the product, it is named here («what was taken → where»), in the docs of the part it went into and in its
  review under [`docs/integrations/`](docs/integrations/README.md). A solution is taken only if it strengthens and
  complements tAIBE — measured before and after — never to replace a part or leave it at the same level. Under
  review: oh-my-openagent, cognee, agno, warp, ai-memory, i-have-adhd, codebase-memory-mcp, openproject. Taken so far:
  **[OpenProject](https://github.com/opf/openproject)** (GPLv3) — the idea of validating the relation graph on write
  (no subtask cycles) → `boards/apps/api/src/task-relation/` (idea only, no code);
  **[i-have-adhd](https://github.com/ayghri/i-have-adhd)** (MIT) — blind pairwise A/B judging of skill versions →
  `eval/evolve/ab.py` (idea, own code); **[agno](https://github.com/agno-agi/agno)** (Apache-2.0) — untrusted text
  between fences with a per-call random nonce → the same judge, the AI council's review prompts and the board
  notebook (idea, own code).
- The MCP hub runs [1mcp](https://github.com/1mcp-app/agent); the AI council and the gateway use local
  [Ollama](https://ollama.com) models and hosted providers (GLM Z.AI, OpenRouter) through their public APIs.

## По-русски

**tAIBE** — продукт-слой для команды долгоживущих ИИ-сессий и людей: меньше токенов и контекста без потери скорости
и качества, без простоев на лимите. **tAI-Boards** — где живёт работа: доски в первую очередь для агентов (лес задач,
аренды с fencing, состояние после каждого шага, капсулы на карточке, матрица прав, импорт Notion). **eval** — как
команда работает дёшево: геномы ролей, капсулы, Нерв, рой, замеры. **infra** — сервисы контроля: ИИ-консилиум,
очередь владельца, MCP-хаб, шлюз моделей. **Слой процесса** — промпты ролей, законы, скиллы, хуки, знания,
worktrees и журнал закрытого. Продукт собран из подпроектов `supertick-eval/` и `t-boards/` репозитория-инкубатора
и его ИИ-инструментов; карта переноса — [`process/TRANSFER.md`](process/TRANSFER.md).
