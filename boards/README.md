# aiBoards

Task boards for mixed human / AI-agent teams — a focused fork of [Kaneo](https://github.com/usekaneo/kaneo) (MIT).

On top of upstream it adds:

- **Agent identity on the board** — each card shows which agent/session works it (migration `0076`).
- **SSR board snapshots** — server-rendered read-only boards with a nightly push job (migration `0077`), plus `ssr-tools` MCP tools.
- **Forest pulse** — an agents' feed / pulse panel over board activity.
- **Notebook card sources** and the `notebook_search`, `notebook_ask`, `notebook_brief` and `notebook_add_source` MCP tools.
- **Workspace-scoped API keys** — one key is limited to one workspace; workspaces are presented as «Продукты» in RU.
- RU as a first-class product language.

Product docs: [docs/t-boards-spec.md](docs/t-boards-spec.md) (spec, RU) · [docs/architecture-overview2.0.md](docs/architecture-overview2.0.md) (ContextFlow architecture).

## Run

```bash
cp .env.sample .env.local          # fill in the values
docker compose -f compose.local.yml up     # postgres + api (:1337) + web
```

From source (Node 24, pnpm 10):

```bash
pnpm install --frozen-lockfile
pnpm dev
```

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm i18n:check && pnpm openapi:check
```

All of the above run in CI (`.github/workflows/boards-ci.yml`).

## Attribution

Based on [Kaneo](https://github.com/usekaneo/kaneo) by its authors, MIT — see the repository [LICENSE](../LICENSE). Upstream community, marketing and publishing workflows were trimmed for this fork; `CHANGELOG.md` and `AI_POLICY.md` come from upstream.
