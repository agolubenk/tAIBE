# checkov — разбор встраивания

> **Статус (2026-11-14):** ❌ не берём сейчас — замер release на `board-agents` (прогон
> [43601268170](https://github.com/agolubenk/tAIBE/actions/runs/43601268170)): в варианте A 4 находки, настоящих 0
> (порог ≥ 5), §«Замер». Источник — [bridgecrewio/checkov](https://github.com/bridgecrewio/checkov),
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
- [ ] Замер: 0 настоящих находок — ценности сверх существующих проверок нет.
- [x] Инвариант «снаружи ничего не меняется»: отчётом первую неделю (S23-2).
- [x] Лицензия Apache-2.0 — запуск как инструмента совместим.
- [x] Ресурсы: раннер GitHub, только на PR с правкой инфраструктуры.
- [x] Данные: без ключа Prisma Cloud отчёт никуда не уходит.

## Замер (release, раннер GitHub)

Прогон release 14.11 — [43601268170](https://github.com/agolubenk/tAIBE/actions/runs/43601268170), отчёт —
комментарий 6878251322 в tAIBE #312 (PR закрыт без мёржа). checkov 3.4.5.

1. **Находки и время:** A (`dockerfile`, `openapi`) — 4 находки, 14 с; B (все фреймворки) — 19 находок, 105 с.
2. **Разметка A** (все 4 — меньше 20; plan, по коду `board-agents`, 14.11):

   | Проверка | Где | Итог | Почему |
   |---|---|---|---|
   | `CKV_DOCKER_2` нет `HEALTHCHECK` | `boards/apps/web/Dockerfile` | шум | не образ прода: прод VPS берёт один образ `TB_IMAGE` (`boards/deploy/vps/compose.yml:27`) |
   | `CKV_DOCKER_2` нет `HEALTHCHECK` | `infra/owner-queue-bot/Dockerfile` | шум | `restart` Docker по статусу `unhealthy` не перезапускает; без оркестратора проверка ничего не меняет |
   | `CKV_OPENAPI_21` массив без `maxItems` | `boards/apps/docs/openapi.json:79-99` | ложная | это схема ответа (`issues` ошибки валидации), не входа: предел размера ответа не защищает API |
   | `CKV_OPENAPI_5` пустой `security` | `boards/apps/docs/openapi.json` | ложная | глобально задан `bearerAuth`; `security: []` стоит явно у 13 публичных операций (`/instance/status`, `/public-project/{id}`, ленты календаря по токену и др.) — это намеренно |

3. **B сверх A:** secrets — 15 находок, все ложные или тестовые (переводы `boards/i18n/{de-DE,nl-NL}.json`, тестовые
   пароли CI и e2e, имена ключей в чарте); github_actions — 380 проверок прошли, 0 находок; actionlint на том же
   дереве — тоже 0, пересечения нет.
4. Helm-чарт `boards/charts/kaneo` checkov не отрисовал (нужен `kaneo.env.authSecret`) — Kubernetes не проверялся;
   в проде чарт не используется.

## Риски и открытые вопросы

- Часть проверок Dockerfile (например, `HEALTHCHECK`) может спорить с принятыми решениями выкладки — разметка в п. 3,
  выключение — в конфиге с причиной.

## Вердикт и рекомендация

**Не берём сейчас (вариант C).** Порог «настоящих ≥ 5» не пройден: в варианте A настоящих 0 из 4, в B прибавляются
только ложные secrets. Задача CI стоила бы 14 с на каждом PR с инфраструктурой и не дала бы ни одной правки —
«на прежнем уровне — тоже отказ». Буква R-070 называет checkov: отступ, как у abide, — решение координатора с
владельцем.

**Вернуться**, если: появятся новые Dockerfile или образы прода, в прод пойдёт чарт Kubernetes, или OpenAPI начнёт
описывать вход с массивами без предела. Повторный замер — тот же вариант A.

**Адверсариальная проверка (возражения по линзам и ответы автора; независимые линзы — в PR):**

| Участник (линза) | Возражение | Ответ |
|---|---|---|
| корректность | compose не проверяется — главный файл выкладки `boards/deploy/vps/compose.yml` | верно; это предел инструмента, в разборе названо |
| ресурсы | Python-зависимости в CI | закреплённый образ, только на PR с инфраструктурой |
| продукт | дубль actionlint | A берёт только dockerfile и openapi |
