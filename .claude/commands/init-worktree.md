---
description: Создать git worktree для изолированной Claude-сессии (track + topic)
argument-hint: [track] [topic] — например refactor vacancy-save-split
---

Создай изолированное git worktree по схеме репозитория (`worktrees/<track>/<topic>`).

## Вход

1. Если аргументы не переданы — спроси:
   - **track**: `feature` | `fix` | `refactor` | `spike` | `review`
   - **topic**: kebab-case, например `vacancy-save-split`
2. **base branch** по умолчанию: `WT_BASE` из `Makefile` (дом слоя — `board-agents`, host-проект — `main`); нет — уточни у пользователя

## Выполнить

Из **корня основного репозитория** (не из существующего worktree). Переменную пути не называть `PATH`: это затрёт
поиск команд, и `mkdir`/`git` перестанут находиться.

```bash
TRACK="<track>"
TOPIC="<topic>"
BRANCH="${TRACK}/${TOPIC}"
WT_PATH="worktrees/${TRACK}/${TOPIC}"
BASE="$(sed -n 's/^WT_BASE ?= //p' Makefile 2>/dev/null)"; BASE="${BASE:-main}"

mkdir -p "worktrees/${TRACK}"
git worktree add "${WT_PATH}" -b "${BRANCH}" "${BASE}"
git worktree list
```

Если ветка `${BRANCH}` уже существует локально:

```bash
git worktree add "${WT_PATH}" "${BRANCH}"
```

## После создания

1. Напомни: Claude Code скопирует файлы из `.worktreeinclude` (локальные `.env`).
2. Зависимости — свои: `infra/scripts/dev/wt-deps.sh install "${WT_PATH}"`. В доме слоя — `pnpm install --frozen-lockfile` в `boards/`; в npm-монорепо хоста скрипт делает `npm ci` с заглушкой
   `DATABASE_URL` для postinstall бэкенда, смотрит код возврата самого `npm ci`, собирает `packages/*` и проверяет,
   что `@hr-helper/*` ведут внутрь worktree. `make wt-add` зовёт его сам, но агентской сессии `make` с этим Makefile
   останавливает merge-guard (SE-105) — ей эта команда напрямую. Пропустить можно только без гейтов (документы,
   чтение): первый гейт без установки остановит хук `pre-tool-use-wt-deps.sh` с командой починки. Ссылка
   `node_modules` на основной checkout — не установка: `@hr-helper/*` молча берутся из его сборки.
3. До первой правки — базовая линия гейтов: прогнать typecheck, lint и test нужных пакетов и записать число ошибок.
   Гейт дальше — «нет новых ошибок против базовой линии», а не «ноль ошибок».
4. Одна задача на worktree — не смешивать refactor и fix в одной сессии.
5. Из сессии worktree не делать `cd` в другие checkout'ы: вызывать их инструменты по абсолютному пути. Если `cd`
   случился — вернуться и проверить `pwd` и `git rev-parse --abbrev-ref HEAD`.
6. Правила worktree: `.claude/rules/07-worktrees.md`, `worktrees/README.md`.

## Завершение ветки

- Схлопывать свои коммиты через `git reset --soft $(git merge-base HEAD origin/main)`, а не `origin/main`. Иначе в
  коммит молча попадает откат чужих изменений, влитых в main после ответвления.
- После любого `reset` — `git diff --stat origin/main`: в списке только свои файлы.

## Проверка

- `git worktree list` показывает новый путь
- Ветка соответствует `track/topic`
