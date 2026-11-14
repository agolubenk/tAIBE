# checkov — разбор встраивания

> **Статус (2026-11-14):** 🔍 разбирается: документация и код источника прочитаны, прогон на `board-agents` — у
> release (раннер GitHub, §«Замер»). Источник — [bridgecrewio/checkov](https://github.com/bridgecrewio/checkov),
> 3.4.5 (2026-11-12). Карточка — TB-167 (S23-1), спека [`phase-c-stage2.md`](../../specs/phase-c-stage2.md) §3.
> Индекс и правила — [`../README.md`](../README.md).

## Что это

- Статический анализ инфраструктуры как кода, Python. Фреймворки — каталоги `checkov/*` источника: terraform,
  kubernetes, helm, dockerfile, github_actions, openapi, secrets, sca и другие.
- **Лицензия — Apache-2.0** (`t-boards-spec.md:420`, сверено 14.11). Зрелость: 9,2 тыс. звёзд, релизы еженедельно.
- Вывод — CLI, JSON, SARIF, JUnit. Часть возможностей (SCA пакетов, платформа) требует ключа Prisma Cloud — не берём.

## На что ложится в tAIBE

Что в репозитории есть из его фреймворков (`git ls-tree`, `origin/board-agents`, 14.11):

| Фреймворк checkov | У нас | Уже проверяет |
|---|---|---|
| dockerfile (13 проверок) | 5 Dockerfile: `boards/Dockerfile.kaneo`, `boards/apps/api`, `boards/apps/web`, `infra/ops-console`, `infra/owner-queue-bot` | ничего |
| github_actions | 5 workflow в `.github/workflows/` (+ 9 в `claude-plugins-official/`, не наши) | actionlint 1.7.7 (`checks-ci.yml:52-53`), включая инъекцию выражений |
| openapi | `boards/apps/docs/openapi.json` | `pnpm openapi:check` — только совпадение со схемой |
| secrets | весь репозиторий | `infra/checks` (secrets) |
| docker compose (8 файлов) | — | checkov compose не разбирает |

Новая ценность — **Dockerfile** и правила безопасности **OpenAPI**; github_actions и secrets в основном дублируют
actionlint и `infra/checks`.

## Варианты встраивания

| Вариант | Что берём | Куда | Цена | Эффект |
|---|---|---|---|---|
| A — узкий прогон | `--framework dockerfile openapi`, закреплённый образ или версия, `--skip-path claude-plugins-official` | задача CI при правках `infra/**`, `boards/deploy/**`, `Dockerfile*`, `compose*.yml`, `.github/**` (S23-2) | 1 задача CI, только на таких PR (время — замер) | находки в Dockerfile и OpenAPI, которых сейчас не видит ничто |
| B — все фреймворки | без `--framework` | то же | больше времени и дублей с actionlint и secrets | мало сверх A |
| C — не брать | — | — | 0 | Dockerfile и OpenAPI без проверки |

## Проверка «усиливает, а не заменяет»

- [x] A дополняет: actionlint и `infra/checks` не заменяются.
- [ ] Замер «до/после» — после прогона.
- [x] Инвариант «снаружи ничего не меняется»: отчётом первую неделю (S23-2).
- [x] Лицензия Apache-2.0 — запуск как инструмента совместим.
- [x] Ресурсы: раннер GitHub, только на PR с правкой инфраструктуры.
- [x] Данные: без ключа Prisma Cloud отчёт никуда не уходит.

## Замер (release, раннер GitHub)

Прогон 3.4.5 на `board-agents`: варианты A и B, вывод JSON артефактом. Записать:

1. число находок по фреймворкам и проверкам;
2. время задачи для A и B;
3. выборку 20 находок A — plan размечает «настоящая / ложная»;
4. сколько находок github_actions из B уже ловит actionlint.

## Риски и открытые вопросы

- Часть проверок Dockerfile (например, `HEALTHCHECK`) может спорить с принятыми решениями выкладки — разметка в п. 3,
  выключение — в конфиге с причиной.

## Вердикт и рекомендация

**Предлагаю:** вариант A после замера. Если в выборке 20 настоящих находок меньше 5 или доля ложных больше 30 % —
не берём (C). Порог — допущение для линз.

**Адверсариальная проверка (возражения по линзам и ответы автора; независимые линзы — в PR):**

| Участник (линза) | Возражение | Ответ |
|---|---|---|
| корректность | compose не проверяется — главный файл выкладки `boards/deploy/vps/compose.yml` | верно; это предел инструмента, в разборе названо |
| ресурсы | Python-зависимости в CI | закреплённый образ, только на PR с инфраструктурой |
| продукт | дубль actionlint | A берёт только dockerfile и openapi |
