# Git worktrees — tAIBE

Отдельные checkout'ы для параллельных сессий Claude Code без конфликтов в одной рабочей копии. Канон —
`.claude/rules/07-worktrees.md`; команды — `make wt-help`.

## Схема

```
worktrees/<track>/<topic>/        ветка <track>/<topic>, база — board-agents (WT_BASE)
```

| Track | Когда |
|-------|-------|
| `feature` | новая функциональность досок, пайплайна или слоя |
| `fix` | баг-фиксы (карточка в «Ошибках») |
| `refactor` | декомпозиция, перенос слоёв |
| `spike` | исследование, замер, пилот (капсула/геном/Нерв в теневом режиме) |
| `review` | правки по ревью PR |

## Быстрый старт

```bash
make wt-fix NAME=notion-5xx-retry            # worktree + pnpm install --frozen-lockfile в boards/
make wt-spike NAME=genome-r4 WT_DEPS=0       # без зависимостей: eval, слой, документы (stdlib python)
make wt-deps TRACK=fix NAME=notion-5xx-retry # поставить позже
make wt-check TRACK=fix NAME=notion-5xx-retry
make wt-list
make wt-rm TRACK=fix NAME=notion-5xx-retry
```

В Claude Code: slash-команды `/init-worktree`, `/init-parallel-worktrees`.

Агентская сессия (не Контроль): `make` с этим Makefile останавливает merge-guard (SE-105), поэтому агент
запускает команды рецептов напрямую. Отказ на `make <цель>` их печатает, полный список —
`.claude/rules/07-worktrees.md`, «Агентская сессия — прямые формы»:

```bash
mkdir -p worktrees/fix && git worktree add "worktrees/fix/notion-5xx-retry" -b "fix/notion-5xx-retry" board-agents
infra/scripts/dev/wt-deps.sh install "worktrees/fix/notion-5xx-retry"   # без зависимостей — пропустить
git worktree list
```

## Зависимости — свои у каждого worktree

Worktree лежит внутри основного checkout: без своего `boards/node_modules` Node молча поднимается к установке
основного checkout — чужой WIP пакетов, другая версия TypeScript, ложные ошибки typecheck и тестов. Хук
`PreToolUse` (`.claude/hooks/pre-tool-use-wt-deps.sh` → `infra/scripts/dev/wt-deps.sh check`) останавливает гейт
(`pnpm …`, `vp …`, `npm run …`, `npx …`) в `boards/` linked worktree без своей свежей установки; обход для команды,
не связанной с зависимостями, — `WT_DEPS_CHECK=0` в её начале. eval и слой — stdlib python, зависимостей нет.

Интеграционные тесты API досок из любого worktree — `zsh boards/tools/run-int.sh` (одна тестовая БД на все
checkout'ы, прогоны идут по очереди под локом).

## Локальные файлы

`.worktreeinclude` в корне — список env/settings, которые Claude Code копирует в новый worktree.

## Примечание

Содержимое `worktrees/*/` (кроме этого README) в git не коммитится — это живые checkout'ы. После merge PR —
`git branch -d <track>/<topic>`.
