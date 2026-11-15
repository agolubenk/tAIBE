# Локальные модели Ollama

> **В доме слоя (2026-11-01):** здесь — модели ИИ-контура разработки (Tiel-Coder для deep-роли консилиума, доп.
> модели Continue, прогрев: `npm run ollama:tiel-coder`, `ollama:extra-models`, `ollama:warmup`). Роли `hr-helper-*`,
> agent pipeline FlowsAssistant, `dev-start-with-ai.sh` и Open WebUI — модели и dev-стек первого host-проекта: их
> скрипты и Modelfile остались там, разделы ниже про них — справка инстанса.

> **Статус (2026-10-23):** владелец удалил с Mac `qwen3-coder:30b`, `qwen3.6:27b` (и алиасы `hr-helper-text`,
> `hr-helper-resume`), `mistral-small3.2` (и `hr-helper-analytics`, `hr-helper-json`) — решение d-mac-models = drop-4.
> Локально остались `glm4:latest`, `qwen2.5:7b`, `nomic-embed-text`. Таблицы ниже описывают прежний набор и ждут
> переработки. Значения по умолчанию в коде (`ollama-models.config.ts`, `resume-parse-*`) и `apps/backend/.env.example`
> всё ещё называют удалённые алиасы — дев-`.env` переопределяет их на `glm4:latest` и `qwen2.5:7b`. Роли консилиума —
> `infra/ai-council/config.toml`.
>
> **2026-10-28:** возвращена одна L-модель — `tiel-coder:35b-a3b-iq3s` (Ornith-1.5-35B-A3B, unsloth-dynamic IQ3_S + MTP
> + mmproj BF16, файл 14.07 ГБ в `infra/local/ollama/gguf/`, gitignored): deep-роль `proposer.code` консилиума,
> Executor в Continue, код-чат через HR Gateway. Установка: `npm run ollama:tiel-coder` (см. §Дополнительные
> chat-модели). `hf` CLI на этой машине не работает (системному Python 3.14 не хватает `yaml`) — скрипт качает `curl -C -`.
>
> **2026-10-29:** тот же скрипт создаёт второй тег `tiel-coder-fim:latest` — FIM-вариант для автокомплита
> Continue (шаблон infill-копия qwen2.5-coder, `num_ctx` 8192, t° 0.1, стоп-токены `<|fim_suffix|>`).
> Облачный GLM-автокомплит невозможен в принципе: у Z.AI нет `/completions` (FIM) эндпоинта —
> Continue получал HTTP 404. Тёплая латентность FIM ≈ 0.8 с.
>
> **Управление шлюзом HR Gateway (:8789):** код — `infra/llm-gateway/` (перенос `e5289f88c`, 01.11), npm-скрипты —
> в корневом `package.json:29-36` (`npm run llm-gateway:restart|status|sync`; сверка 14.11). Данные (`.env` с ключами
> OpenRouter, `.state`) — всегда в основном дереве, `infra/llm-gateway/`; при запуске из worktree лаунчер резолвит
> их туда сам (`infra/llm-gateway/bin/llm-gateway.sh:3,8`).

Четыре **независимые роли** моделей для разных задач. Один процесс `ollama serve` на `http://127.0.0.1:11434` — в каждом запросе указывается своё имя модели. Ollama сам выгружает/подгружает веса (`OLLAMA_KEEP_ALIVE`, `OLLAMA_MAX_LOADED_MODELS`).

## Роли и алиасы

| Роль | Алиас в проекте | Базовая модель | RAM (ориентир) | Задачи |
|------|-----------------|----------------|----------------|--------|
| Vision | `hr-helper-vision` | MiniCPM-o 2.6 Q4_K_M | ~5.5 ГБ | Фото кандидатов, OCR, скриншоты |
| Text Gen | `hr-helper-text` | Qwen 3.6 27B Q4_K_M | ~17 ГБ | Ответы на вопросы, тексты из БД |
| Resume parse | `hr-helper-resume` | Qwen 3.6 27B Q4_K_M (T=0.15) | ~17 ГБ | Phase 2 LLM обогащение резюме |
| Analytics | `hr-helper-analytics` | Mistral Small 3.2 24B (`mistral-small3.2`) | ~15 ГБ | Scoring, отчёты, JSON |
| Embedding | `hr-helper-embed` | nomic-embed-text | ~0.3 ГБ | RAG, семантический поиск |

Все LLM-алиасы используют `num_ctx 64000` в Modelfile. На хосте: `export OLLAMA_CONTEXT_LENGTH=64000` перед `ollama serve`.

Modelfile: `infra/local/ollama/models/hr-helper-*.Modelfile`

## Установка моделей

```bash
# Из корня репозитория (первый раз — долго, качает GGUF с Hugging Face)
bash infra/scripts/dev-ai/ollama-setup-models.sh

# Только пересоздать алиасы без pull
SKIP_PULL=1 bash infra/scripts/dev-ai/ollama-setup-models.sh
```

Требуется [Ollama](https://ollama.com/download) в PATH.

## Запуск всего стека

```bash
# Infra (Postgres, Redis, …) + Ollama + миграции + Nest :3001 + Vite :3000
bash infra/scripts/dev-ai/dev-start-with-ai.sh

# Без повторного pull GGUF (алиасы + dev уже поднятые модели)
SKIP_OLLAMA_PULL=1 bash infra/scripts/dev-ai/dev-start-with-ai.sh
```

Короткие npm-скрипты в корне:

```bash
npm run ollama:setup
npm run dev:ai
```

## Agent pipeline (3 модели)

Трёхшаговый pipeline для workflow / агентных задач (FlowsAssistant: agent → analytics → опциональный agent-refinement). Ставится **отдельно** от базовых ролей: `npm run ollama:pipeline` (`infra/scripts/dev-ai/ollama-setup-agent-pipeline.sh`), тогда как `npm run ollama:setup` ставит только роли из таблицы выше. Флаги: `SKIP_PULL=1` — только пересоздать алиасы; `CONFIGURE_SHELL=0` — не дописывать `OLLAMA_CONTEXT_LENGTH` в `~/.zshrc`.

| Шаг | Базовая модель | Алиас | RAM | Роль |
|-----|----------------|-------|-----|------|
| 1 | `deepseek-r1:32b` | `hr-helper-reasoning` | ~19 ГБ | Reasoning — **исключён**, см. ниже |
| 2 | `glm4:latest` | `hr-helper-agent` | ~16 ГБ | Агентные цепочки |
| 3 | `mistral-small3.2` | `hr-helper-analytics`, `hr-helper-json` | ~15 ГБ | JSON / analytics / function calling |

**DeepSeek R1 32B/671B исключены из установки:** пайплайн-скрипт качает только GLM-4 и Mistral Small; тяжёлые `deepseek-r1:32b` / `deepseek-r1` (671B) — в блоклисте `apps/backend/src/modules/ai/local/config/ollama-model-blocklist.ts` (OOM на 24 ГБ). Reasoning-модель выбирается через ai-integrations / конфиг агента в UI — env-переменной `OLLAMA_MODEL_REASONING` в коде нет.

Лёгкие **DeepSeek-R1 Qwen-distill 7B/14B** оставались разблокированными и ставились отдельно, но с 2026-08-13 из dev-стека выведены (см. §Дополнительные chat-модели ниже). В блоклисте продукта они по-прежнему НЕ значатся: если образ скачан, он доступен в AI-чате по тегу — это решение продуктовое, отдельное от раскладки dev-консилиума.

На 24 ГБ RAM для pipeline держать `OLLAMA_MAX_LOADED_MODELS=1` (glm4 ~16 ГБ + mistral ~15 ГБ одновременно не помещаются) — скрипт выставляет это по умолчанию.

Env backend (`apps/backend/.env`, см. `.env.example`):

```bash
OLLAMA_MODEL_AGENT=hr-helper-agent          # шаг agent (glm4); совпадает с дефолтом в коде
OLLAMA_MODEL_ANALYTICS=hr-helper-analytics  # шаг analytics/json (mistral)
# OLLAMA_CHAIN_KEEP_ALIVE=0 — keep_alive между шагами цепочки FlowsAssistant ('0' = выгружать сразу)
```

### Open WebUI

```bash
npm run open-webui:prepare   # только pull образа + volume, контейнер не стартует
npm run open-webui:up        # → http://localhost:8080
```

| Параметр | Где | Значение |
|----------|-----|----------|
| `num_ctx` | Admin → Settings → Models (глобально) и Admin → Models → Advanced (per-model) | **64000** — иначе UI останется на дефолтных 2048–4096 |
| Temperature | Chat ⚙️ | reasoning 0.6 · agent 0.4 · json 0.1 (как в Modelfile) |
| Model unload | Admin → Settings | по желанию (экономия RAM) |

## Переменные окружения (backend)

См. `apps/backend/.env.example`:

- `OLLAMA_BASE_URL` — URL Ollama (по умолчанию `http://127.0.0.1:11434`)
- `OLLAMA_MODEL_VISION`, `OLLAMA_MODEL_TEXT_GEN`, `OLLAMA_MODEL_ANALYTICS`, `OLLAMA_MODEL_EMBEDDING` — алиасы
- `OLLAMA_RESUME_MODEL=hr-helper-resume` — phase 2 парсера резюме (fallback: `OLLAMA_MODEL_TEXT_GEN`)
- `OLLAMA_KEEP_ALIVE=30m` — не выгружать модель сразу после запроса
- `AI_LOCAL_ENABLED` / `OLLAMA_ENABLED` — `false` отключает локальный AI

Рекомендуется на хосте с Ollama:

```bash
export OLLAMA_CONTEXT_LENGTH=64000
export OLLAMA_KEEP_ALIVE=30m
export OLLAMA_NUM_PARALLEL=2
export OLLAMA_MAX_LOADED_MODELS=2
```

## NestJS: модуль `ai-local`

Путь: `apps/backend/src/modules/ai/local/`

| HTTP | Назначение |
|------|------------|
| `GET /api/v1/ai-local/status` | конфигурация (без auth) |
| `GET /api/v1/ai-local/health` | Ollama + список алиасов (без auth) |
| `POST /api/v1/ai-local/vision/analyze` | изображение base64 + prompt |
| `POST /api/v1/ai-local/text/generate` | chat messages |
| `POST /api/v1/ai-local/analytics/run` | JSON / json_schema |
| `POST /api/v1/ai-local/embeddings` | один текст → vector |
| `POST /api/v1/ai-local/embeddings/batch` | пакет текстов |

Защищённые эндпоинты — JWT + company user (как `ai-integrations`).

### Связь с другими частями приложения

```
React (features/pages)
    → shared/api/aiLocal.ts
        → Nest ai-local.controller
            → VisionAiService | TextGenAiService | AnalyticsAiService | EmbeddingAiService
                → OllamaHttpClient → Ollama :11434
```

- **AI-чат** (`ai-integrations`, `OllamaProvider`) — общий список моделей `/api/tags`, произвольная модель в UI.
- **Парсинг резюме** (`resume-parser/stage3-llm`) — отдельный вызов `/api/chat` + `OLLAMA_MODEL` (можно указать `hr-helper-text`).
- **RAG (будущее)** — `EmbeddingAiService` + pgvector / ClickHouse.

## Frontend

```typescript
import { fetchAiLocalHealth, visionAnalyze } from '@/shared/api/aiLocal'
```

## Проверка

```bash
curl -s http://127.0.0.1:11434/api/tags | head
curl -s http://localhost:3001/api/v1/ai-local/health | jq
```

## Память на MacBook 24 ГБ

Одновременно комфортно: **Vision + Embed** или **Text + Embed**. Analytics запускать отдельно, когда не грузятся тяжёлые LLM.

**Правило для ИИ-агента/консилиума (2026-09-21):** любой вызов локальной Ollama-модели —
строго последовательно, никогда параллельно/батчем, даже если шаги независимы и в другом
контексте их можно было бы распараллелить (см. `.claude/rules/13-agents-mcp.md` §Workflow Engine —
там это касается backend-агентов, здесь — консилиума/dev-tooling). Несколько одновременных
инференсов кладут ноутбук — это не гипотетический риск, а прямое следствие приведённого выше
расчёта памяти. Облачные провайдеры (GLM/Anthropic и т.п.) и MCP-инструменты (serena, консилиум)
этим ограничением не связаны — с ними можно работать с любыми актуальными настройками/степенью
конкурентности.

## Альтернативные модели

Измените `FROM` в Modelfile и пересоздайте алиас:

- Vision: `Qwen2.5-VL-7B` (см. комментарии в Modelfile vision)
- Text: `Meta-Llama-3.1-8B` при нехватке RAM
- Embedding: multilingual-e5 через отдельный сервис (не Ollama)

## Дополнительные chat-модели (без hr-helper-* алиаса)

Ставятся отдельно от базовых ролей — видны в AI-чате напрямую по тегу через `/api/tags` (как `glm4`/`mistral-small3.2`), без Modelfile/алиаса.

| Модель | Тег Ollama | Размер | Задачи |
|--------|-----------|--------|--------|
| Tiel-Coder 35B-A3B (UD-IQ3_S+MTP+mmproj) | `tiel-coder:35b-a3b-iq3s` | ~13.1 ГБ + 0.9 ГБ mmproj (MoE, активно 3B; vision) | Код-ассистент, агентные code-задачи; deep-роль `proposer.code` консилиума |

```bash
npm run ollama:tiel-coder
# только пересоздать тег без загрузки (файлы уже в infra/local/ollama/gguf/):
SKIP_DOWNLOAD=1 SKIP_SHA=1 npm run ollama:tiel-coder
# без vision-проектора: VISION=0 …; тестовая генерация: RUN_SMOKE=1 …
```

Скрипт: `infra/scripts/dev-ai/ollama-setup-tiel-coder.sh` — качает GGUF с HF (curl, докачка),
проверяет sha256, генерирует Modelfile (`num_ctx 16384` — 13.1 ГБ весов + ~1.6 ГБ KV укладываются
в ~16 ГБ GPU-бюджета 24-ГБ машины; 32k уходит в CPU, 64k — своп) и делает `ollama create`.
Если `ollama create` упадёт на MTP-тензорах (llama.cpp в сборке Ollama старее модели), fallback —
не-MTP квант из репозитория `peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF` (правка `MAIN_FILE`/`MAIN_SHA` в скрипте).

`qwen3-coder:30b-a3b-q4_K_M` удалён 2026-10-23 (d-mac-models = drop-4). Скрипт
`npm run ollama:extra-models` всё ещё прописывает его в `EXTRA_MODELS` — **не запускать** без
решения владельца: скачает обратно 19 ГБ удалённой модели.

**DeepSeek-R1 7B/14B выведены из dev-стека 2026-08-13.** Роль независимого аналитика в консилиуме (Continue и AI Council) забрал `glm4:latest`: другая модельная линейка — другие систематические ошибки, при этом 5.5 ГБ против 9 ГБ. Скрипт их больше не ставит и прогрев (`npm run ollama:warmup` → `infra/scripts/dev-ai/ollama-warmup.sh`) их не трогает; уже скачанные образы остаются на диске, удаление — на усмотрение владельца (`ollama rm deepseek-r1:14b-qwen-distill-q4_K_M`). Актуальная раскладка ролей — `.continue/rules/02-context-routing.md`, `docs/specs/ai-council.md` §4.

## Ревью-консилиум AI Council (2026-10-04)

Вкладка «Ревью» (`infra/ai-council`, `docs/specs/ai-council.md §17`) гоняет карточки Notion
в статусе `на ревью` на локальных моделях — тех же, что у консилиума проработки, новых тегов
не требует. Дефолты: агенты без своей модели → `qwen2.5:7b`, оппонент → `glm4:latest`,
судья → `glm4:latest` (профиль «Быстрое ревью»). Тяжёлые привязки ревью с 2026-10-28 можно
назначать на `tiel-coder:35b-a3b-iq3s` (L-tier: одна резидентно, memory-guard); прежние привязки
на `qwen3-coder:30b-a3b-q4_K_M`/`mistral-small3.2:latest` недействительны — модели удалены
2026-10-23 (d-mac-models = drop-4). Все вызовы — строго последовательно, в процессе
council_worker (ревью берётся раньше проработок). Окно ревью по умолчанию ≈ 13.9k (10k входа +
2.5k выхода): одна перезагрузка модели при переключении с проработки (общий `num_ctx` 8192);
потолок «до максимума модели» — `max_num_ctx` в настройках ревью (32768).

