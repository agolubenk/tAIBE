# infra/scripts/

Скрипты ИИ-контура и процесса. Команды — корневой `package.json` (`npm run …`) и `Makefile`.

```
infra/scripts/
  dev/       wt-deps.sh (свои зависимости git worktree), dev-common.sh (помощники Ollama и локального env)
  dev-ai/    MCP-хаб, секреты (mcp-secret.sh: env → Keychain), MCP досок (mcp-t-boards.sh), конвейер ИИ-инструментов,
             локальные модели (Tiel-Coder, доп. модели, прогрев), прокси claude-mem только для чтения
  misc/      done-index.py — таблица и формат журнала закрытого (docs/plans/DONE.md)
  prod/      ops-deploy-event.py — событие деплоя в ops-консоль (подпись агента хоста)
  security/  .env.strix.example — профиль Strix (ИИ-пентест по запросу); mitmproxy-local.sh — mitmweb только на
             127.0.0.1 перед локальным стендом досок (docs/ops/mitmproxy-local.md)
```

| Задача | Команда |
|--------|---------|
| Состояние всего ИИ-контура | `npm run ai-pipeline:status` (`doctor`, `dashboard`, `logs`) |
| MCP-хаб | `npm run mcp-hub:status` · `start` / `restart` — только из основного checkout |
| Шлюз моделей | `npm run llm-gateway:status` · `llm-gateway:sync` (пересобрать конфиг Continue) |
| Консилиум | `npm run ai-council:status` · `ai-council:selftest` |
| Локальные модели консилиума | `npm run ollama:tiel-coder` · `ollama:extra-models` · `ollama:warmup` |
| Worktree с зависимостями | `make wt-fix NAME=…` (`infra/scripts/dev/wt-deps.sh install|check`) |
| Журнал закрытого | `npm run done:index` · `npm run docs:check` |

## Strix (ИИ-пентест)

On-demand: self-hosted CLI в Docker или облако app.strix.ai; профиль —
`cp infra/scripts/security/.env.strix.example infra/scripts/security/.env.strix` (файл в `.gitignore`).
Скиллы — `penetration-testing-with-strix`, `fix-security-vulnerabilities-with-strix`.

Ollama-роли предметной области host-проекта, его dev-стек (compose, миграции) и Open WebUI остаются в host-проекте.
