# process — командный слой aiBoards & eval

Процессы и надстройки команды ИИ-сессий (Т-сборка): роли, протоколы, законы, скиллы, хуки и знания — всё, что сегодня работает поверх host-проекта-инкубатора. Здесь это самостоятельный продукт: слой накладывается на host-проект и настраивается под него. Откуда что перенесено и что осталось инстанс-зависимым — [`TRANSFER.md`](TRANSFER.md).

## Состав слоя

| Где | Что |
|---|---|
| `prompts/` | Пусковые промпты команды: `SUCCESSOR-PROMPT.md` (мастер-промпт), `1-QUEUE` (Координатор), `2-CONTROL` (Контроль), `3-F5`, `3-OWNER-QUEUE` |
| `model/` | Операционная модель живого инстанса (первый хост): `CLAUDE.md` (DAMS L1), `AGENTS.md`, `ACTION-PLAN.md` — эталон настройки |
| `TRANSFER.md` | Манифест переноса из инкубатора: соответствие путей, исправленные дефекты, инстанс-зависимое |
| `../.claude/` | Рабочий слой: `rules/` (законы Never/Always, грузятся по `paths:`), `agents/` (субагенты-специалисты), `hooks/` (+ их тесты), `scripts/` (`glm_client.py`, `rag_query.py`, `sync-agent-skills.sh`), `skills/` (канонические скиллы, `VENDORED.md` для вендорных), `memory/` (чанки знаний + `capital.json`), `settings.json` (хуки слоя) |
| `../.continue/`, `../.agents/`, `../.windsurf/skills/` | Зеркала скиллов для других харнессов (Continue, Codex/Copilot, Cursor, Windsurf, …); регенерируются `sync-agent-skills.sh` |
| `../.ai/` | Процесс папок задач: `templates/` (brief → recon → hypotheses → plan → evidence → cloud-question); живые дела `task/` — рантайм, не коммитятся |
| `../infra/` | Сервисы процесса: ИИ-консилиум (линзы адверсариальной проверки), очередь владельца (`oq_*`, бот, ops-консоль), MCP-хаб, llm-gateway, headroom, `scripts/dev-ai/`, `scripts/dev/wt-deps.sh` — роль `infra/CLAUDE.md` |
| `../docs/` | Сквозные спеки (очередь, консилиум), журнал закрытого `plans/DONE.md` + `plans/done/`, стандарт документа |
| `../Makefile`, `../package.json`, `../worktrees/` | Команды слоя: `make wt-*` (worktrees), `make check`, `npm run mcp-hub:* / llm-gateway:* / ai-council:*` |
| `../claude-plugins-official/` | Vendored официальные плагины (лицензии внутри) |
| `../eval/` | Демоны и измерения слоя: Нерв (github/queue/budget источники, кворум, циркадные режимы), swarm, капсулы, геномы ролей, `tools/spawn_session.sh` |

## Как развернуть слой над host-проектом

1. Скопировать в корень host-проекта: `.claude/`, `.agents/`, `.continue/`, `.windsurf/`, `.ai/`, `claude-plugins-official/`, `process/`, `eval/` (можно под другим именем папки — например, `supertick-eval/`), нужные сервисы `infra/` и `docs/plans/DONE.md` с `done/` — или только нужные части. Код, которому важно место дерева (`spawn_session.sh`, хук `context-threshold`, `mcp-t-boards.sh`, `wt-deps.sh`), находит его сам.
2. Поправить пути инстанса: в `.claude/rules/*` секции `paths:` сейчас указывают на дерево первого хоста (`apps/backend/`, …) — заменить на пути host-проекта; правила предметной области (02–16) и доменные скиллы заменить своими.
3. Настроить инстанс: `.claude/settings.json` (хуки), `eval/nerve/config.json` (`repo_root`, `product_tree` — имя папки eval в хосте, репозиторий GitHub, роли, `project_dir`, очередь владельца, бюджеты), затем пересобрать геномы ролей: `python3 -I eval/pipeline/genome/build.py`. Консилиум — `infra/ai-council/config.toml`; секреты — `infra/scripts/dev-ai/mcp-secret.sh` (env → Keychain).
4. Прогнать проверки слоя — все должны быть зелёными:
   ```bash
   for t in .claude/hooks/test_*.py .claude/scripts/test_*.py; do python3 "$t"; done
   python3 -I eval/pipeline/genome/build.py --check
   ```
5. Скиллы править только в `.claude/skills/` (канон); зеркала пересобирает `.claude/scripts/sync-agent-skills.sh` (`--check` ловит расхождение).
6. Межагентный текст (ASD-STE100, `.claude/rules/00-agent-comms.md`) — один канон на все продукты машины:
   `bash .claude/scripts/agent-comms-link.sh` ставит ссылку `~/.claude/rules/00-agent-comms.md` на файл основного
   checkout (не worktree), `--check` её проверяет. Claude Code грузит ссылку в каждом проекте и в субагентах; в tAIBE,
   где тот же файл лежит в `.claude/rules/`, — один раз (проверено 06.11). В сессии внутри worktree копию worktree
   исключает `claudeMdExcludes` в `.claude/settings.json`: иначе вторая копия рядом со ссылкой (замер 06.11 — 2).
   Копию в host-проект не класть. Ссылки нет у облачных сессий (claude.ai/code, облачные агенты): в клоне tAIBE
   правило грузится из `.claude/rules/`, в клоне другого продукта — нет. Cowork пропускает ссылки из
   `~/.claude/rules/` на файлы вне рабочей папки.

## Что в слой НЕ входит (рантайм инстанса, не продукт)

`.claude/memory/session/`, `.claude/council/`, `.ai/task/`, `settings.local.json`, `CLAUDE.local.md`, `.serena/`, `.cmem-projects/`, `graphify-out/`, `.playwright-mcp/`, `agent-transcripts/`, `eval/nerve/state/`, `eval/swarm/state/` — живое состояние сессий, кэши и памяти машин; создаются при работе и не переносятся.
