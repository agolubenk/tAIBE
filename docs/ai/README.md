# docs/ai/ — локальные модели и ИИ-консилиум

| Файл | Содержание |
|------|------------|
| [`LOCAL_OLLAMA_MODELS.md`](./LOCAL_OLLAMA_MODELS.md) | Роли локальных моделей, установка (`infra/scripts/dev-ai/ollama-setup-*.sh`), agent pipeline |
| [`TOON_PROMPT_FORMAT.md`](./TOON_PROMPT_FORMAT.md) | TOON-формат промптов и ответов MCP (дешевле JSON) |
| [`COUNCIL-DRIFT-DESIGN.md`](./COUNCIL-DRIFT-DESIGN.md) | ИИ-консилиум: разбор дрейфа рубрики 14.10 и механизмы M1–M11 |
| [`DRIFT-47.md`](./DRIFT-47.md) | ИИ-консилиум: 47 предложений дрейфа — каким механизмом закрыто каждое |
| [`own-ai-principles.md`](./own-ai-principles.md) | «Свой ИИ» по слоям: гейт на самоправки агентов, закрывает человек, `author` в ответах MCP, журнал «почему и сколько» |

Спека консилиума — [`../specs/ai-council.md`](../specs/ai-council.md), код — `infra/ai-council/`, шлюз моделей —
`infra/llm-gateway/`. Облачный контур GLM (Z.AI Coding) — ключи в `infra/llm-gateway/.env` и Keychain (`mcp-secret.sh`).
