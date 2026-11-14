# Вывод tAIBE из HR_Helper-v2 — пошаговая инструкция

> **05.11 13:49 МСК — шаги 3, 5, 6, 7 (Л1–Л3) выполнены: ссылок в HR нет, роли запущены с геномами tAIBE (#59),
> HR #461/#462 влиты, откат — `~/Backups/hr-links-20261105-134927/ROLLBACK.sh`.** Остаток — M1, M3 (своя команда
> `taibe launch`), Т4/Х5, Х6, M5.
> **Сверка 14.11** (`board-agents@8f24e9082`): M1 частично — `instances/` и `eval/nerve/products.py` (`list`, `render`,
> `get`, `:213-216`; `add`/`check` нет; OPS-25 Ф1 `1a8b412ee`); из M3 — геномы и запуск Т3 по продукту (Ф3 `1f4cecc10`),
> команды `taibe launch` нет; команда шага 4 даёт 64 файла, а не 51. Остальные строки не пересверялись.
> Сверено с живой системой 2026-11-04 23:15 МСК (сессия development-3a).
> - Состояние: tAIBE `board-agents` `e80082f9`, HR `main` `9eb45246c`, d4dev `f216280-b15`.
> - Канон статусов по каждой строке — [`standalone-checklist.md`](../plans/roadmap/standalone-checklist.md). Здесь только порядок,
>   команды, бэкап, откат и проверки.
> - Фазы — [`multi-product.md`](../plans/roadmap/multi-product.md).
> - Как устроено разделение 02.11 (M0) — [`split-hr-taibe.md`](split-hr-taibe.md).

**Цель (владелец, 03.11).** HR не зависит от `t-boards/`, `supertick-eval/`, `eval/` и ссылок. tAIBE собирается,
тестируется и разворачивается сам. Данные не теряются.

**Главное ограничение.** Ссылки в checkout HR (`supertick-eval`, `eval`, `boards`, `t-boards/app` → tAIBE) снимаются
**последними**. Каждая живая сессия Т3 запущена с геномом `HR_Helper-v2/supertick-eval/pipeline/genome/<роль>.json`, а пути
хуков в геноме идут через ссылку. Снять ссылку раньше перезапуска ролей новой командой (M3) — значит сломать хуки
всем живым сессиям.

## Что уже сделано (на 04.11 23:15)

| Шаг | Что | Когда · чем |
|---|---|---|
| M0 | tAIBE — отдельная папка и репозиторий; в HR — ссылки | 02.11, HR #453 |
| Д1–Д4, Д6–Д8 | Бэкап досок раз в 2 ч (восстановление проверено: 82 миграции, 1299 карточек), `.secrets` досок, синк блокнота и SSR на tAIBE | 03–04.11, OPS-16 |
| Д2 | База консилиума остаётся в HR, код идёт из tAIBE (`TAIBE_HOST_ROOT`) | tAIBE #39 влит 04.11; бэкап и `integrity_check` — шаг 2 команды (b) |
| С1 | Нерв запускается из `tAIBE/eval/nerve`, а не через ссылку | 04.11 23:07, plist; бэкап `~/Backups/nerve-plist-0411/` |
| С2, С3 | Хаб 1mcp :3050 работает на коде tAIBE, данные хоста — HR | 04.11 22:47, `s-hub-switch-b-0411`, 0 провалов |
| С7 | TLS-фикс переключателей пайплайна | tAIBE #38 влит |
| Т1–Т3, Т5, Т6 | CI tAIBE зелёный; d4dev собирается из tAIBE; спеки M1/M2; E7 | b15 на d4dev 04.11; #33, #34 влиты |

## Порядок оставшегося

Даты — оценка, не обещание. Каждый шаг — отдельный PR или команда с откатом. Следующий шаг начинается только после
проверки предыдущего.

### Шаг 1. С4 — сессионные MCP на код tAIBE (05.11, 10 мин)

- **Что.** HR #461: в `.mcp.json` серверы `ai-council` и `owner-queue` указывают на
  `${TAIBE_ROOT:-…/tAIBE}`, у `ai-council` задан `TAIBE_HOST_ROOT` = HR. `.mcp.json` добавлен в `paths-ignore` деплоя,
  поэтому мёрж прод не пересобирает.
- **Когда.** Не во время другого деплоя HR: `gh run list --workflow deploy-contabo.yml -L 2` — все `completed`.
- **Проверка.**
  - После мёржа: `gh run list --workflow deploy-contabo.yml -L 1` — новой записи нет.
  - Новая сессия в HR: `ps -axo command | grep -E 'tAIBE/infra/(ai-council/mcp_server|owner-queue-mcp/server)'` — процессы есть.
- **Откат.** Revert PR; сессии берут старые пути при следующем старте.

### Шаг 2. M1 — продукт как сущность инстанса (05–06.11, 1–2 дня)

- **Что.** По спеке [`multi-product-m1-instances.md`](../specs/multi-product-m1-instances.md). Решения владельца уже приняты
  (`d-taibe-m1m2-0411`):
  - `instances/hr-helper.json` в git tAIBE;
  - `eval/nerve/config.json` генерируется из него;
  - `build.py` различает корень слоя (tAIBE) и корень продукта (HR);
  - `boards.product` задан — после этого переключатели пайплайна работают (С7).
- **Кто.** Роли 2 и 6, PR в tAIBE, вливает Контроль.
- **Проверка.**
  - Приёмка спеки.
  - `build.py --check` в CI.
  - `pipeline_settings.py status` — без «several products».
- **Откат.** Revert; `config.json` возвращается из git.

### Шаг 3. M3 — сессии по продукту без ссылок (С6, Х1–Х3; 06–09.11, спека + 2–3 дня)

- **Что.**
  - Спека M3, утверждает владелец.
  - `build.py --product hr-helper` собирает геномы с абсолютными путями в tAIBE.
  - `taibe launch hr-helper --role <роль>` заменяет `spawn_session.sh` с путём через ссылку.
  - Хук порога наследника (`.claude/hooks/context-threshold.py:7,50,56`), скилл `successor-handoff` (`SKILL.md:68,71`) и
    `paths:` правила 17 берут пути из конфига продукта.
  - В HR это PR только из `.claude/**` — без деплоя.
- **Переход.** Каждая роль уходит к наследнику обычным порядком, а наследник стартует новой командой. Старые сессии с
  геномом через ссылку закрываются после приёма (`close-windows.sh` из снимка флота).
- **Проверка.** `ps -axo command | grep -c 'HR_Helper-v2/supertick-eval'` = 0, все роли живы, Нерв будит тапы.
- **Откат.** Старая команда запуска и старые геномы остаются в git до шага 6.

### Шаг 4. Т4 и Х5 — пути HR внутри tAIBE и тексты (параллельно шагам 2–3)

- 51 файл tAIBE называет `HR_Helper-v2` (`git grep -l HR_Helper-v2 -- . ':!docs/plans/done'`):
  `eval/pipeline` 14, `eval/prompts` 6, `infra` 11, остальное — документы.
- Пути продукта (worktrees HR, данные хоста) законны и уходят в `instances/hr-helper.json` (M1). Пути слоя через
  `HR_Helper-v2/supertick-eval` — правятся.
- Тексты о путях — `CLAUDE.md:7` в HR, `infra/mcp-hub/README.md:203`, `docs/ops/deploy-contabo.md:15`.

### Шаг 5. Л1 — проверка готовности (после шага 3 и суток без сбоев)

Все команды только читают. Каждая строка должна дать 0 или «ok»:

```bash
H=~/Desktop/Development/HR_Helper-v2
grep -l -E 'HR_Helper-v2/(supertick-eval|eval|boards|t-boards)' ~/Library/LaunchAgents/*.plist ~/.config/hr-helper-mcp-hub/mcp.json $H/.mcp.json 2>/dev/null | wc -l
grep -o 'HR_Helper-v2/supertick-eval' ~/Desktop/Development/tAIBE/eval/pipeline/genome/*.json | wc -l      # сейчас 24
ps -axo command | grep -E 'HR_Helper-v2/(supertick-eval|eval|boards|t-boards)' | grep -vc grep             # сейчас 7 сессий
docker ps -q | xargs -n1 docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}{{.Config.WorkingDir}}' | grep -c -E 'HR_Helper-v2/(t-boards|boards|eval|supertick-eval)'
(cd $H && git grep -n -E 'supertick-eval/|t-boards/' -- .claude/hooks .claude/skills .claude/rules | wc -l)
```

Сейчас не 0 вторая и третья строка, а пятая — до PR M3. Это и есть шаги 2–3.

### Шаг 6. Л2 — снять ссылки (команда на Mac, решение владельца; 10–11.11)

Ссылки переносятся в бэкап, а не удаляются. **Имя ссылки — без завершающего `/`**: `mv eval/ …` перенёс бы
содержимое `tAIBE/eval`.

```bash
set -eu
H=~/Desktop/Development/HR_Helper-v2; T=~/Desktop/Development/tAIBE; B=~/Backups/hr-links-$(date +%Y%m%d-%H%M)
mkdir -p "$B/t-boards"
cnt() { find "$T/eval" "$T/boards" -type f -not -path '*/node_modules/*' | wc -l | tr -d ' '; }
before=$(cnt); cd "$H"
for l in supertick-eval eval boards; do test -L "$l" || { echo "СТОП: $l не ссылка"; exit 1; }; mv "$l" "$B/$l"; done
test -L t-boards/app || { echo "СТОП: t-boards/app не ссылка"; exit 1; }; mv t-boards/app "$B/t-boards/app"; rmdir t-boards
cp .git/info/exclude "$B/exclude"
sed -i '' -e '/^\/supertick-eval$/d' -e '/^\/eval$/d' -e '/^\/boards$/d' -e '/^\/t-boards\/$/d' .git/info/exclude
[ "$(cnt)" = "$before" ] && echo "файлы tAIBE целы: $before" || echo "СТОП: число файлов tAIBE изменилось"
echo "откат: см. $B"
```

- Строку `/.claude/pipeline-settings.json` в `exclude` оставить: это кэш продукта HR.
- **Откат:**

  ```bash
  cd $H && mkdir -p t-boards && mv "$B/t-boards/app" t-boards/app && for l in supertick-eval eval boards; do mv "$B/$l" "$l"; done && cp "$B/exclude" .git/info/exclude
  ```

### Шаг 7. Л3 и после

- **Л3.**
  - Роль стартует новой командой.
  - Нерв будит.
  - Хаб отдаёт tools.
  - `glm_pr_review` идёт из tAIBE.
  - CI tAIBE зелёный.
  - Сутки без сбоев.
- **После Л3:**
  - **Х6** — убрать `supertick-eval/**`, `t-boards/**` из `paths-ignore` HR. Только когда окно отката разделения закрыто:
    на них держится revert HR #453.
  - **M5** — удалить копии слоя в HR (`infra/ai-council`, `infra/owner-queue-mcp`, `infra/mcp-hub`) по частям, решением
    владельца. До этого HR-копия консилиума заморожена (HR #459).
  - **M4** — синк слоя в HR PR-ом (`taibe sync-layer`). Сюда же — версия merge-guard: tAIBE #40 → HR #433.
  - **M6** — очередь владельца по продуктам и отделение ops-консоли.

## Решения владельца, которые ещё нужны

1. `d-433-now-or-after-40-0411` — когда вливать HR #433 (merge-guard). Рекомендовано: после tAIBE #40 и линзы.
2. Спека M3 — утвердить, когда роль 2 её выпустит (шаг 3).
3. Л2 — «да» на команду шага 6, после зелёного Л1.
4. Х6 и M5 — после Л3, отдельными пунктами.
