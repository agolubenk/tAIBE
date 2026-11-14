# План действий — 13.10.2026: волны и бэклог (почищен 20.10)

> Для кого: владелец продукта и агенты, работающие по плану. Временный инструмент отслеживания: лежит в корне,
> в git не коммитится, удаляется после закрытия волн 0–3 (история — Notion и `docs/plans/done/`). Источники:
> `docs/plans/2026-10-12-product-backlog.md` (45 пунктов), Notion «Ошибки» и «Задачи» (выгрузка 13.10 08:43 МСК),
> ops-отчёт 12–13.10. Ход работ — ops-консоль https://ops.admin.hrhelper.space/queue → «Ход работ».
> Доска `ACTION-BOARD.md` (заморожена 15.10) убрана из корня 20.10 — копия в
> `~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2/handoff/archive/2026-10-20-root/`.

## Где живое состояние — начните отсюда (20.10)

> Этот файл — только список волн 2–3 и бэклога 12.10. Текущее состояние здесь больше не ведётся.

- **Что ждёт вас** — решения, мёржи, серверные команды, ручные проверки: очередь
  https://ops.admin.hrhelper.space/queue или бот @hrhelper_owner_queue_bot.
- **Ход работ** по трекам (кто, что, до какого числа) — там же, вкладка «Ход работ».
- **Открытые задачи и ошибки** — Notion «Задачи» и «Ошибки». Закрытое — `docs/plans/done/`.
- **Что делает каждая сессия** — промпты-наследники в корне (таблица ниже), раздел 0 каждого.
- Сводка на 18.10, история оценок 15–17.10 и журнал убраны 20.10 в архив:
  `~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2/handoff/archive/2026-10-20-root/ACTION-PLAN.before-cleanup-2026-10-20.md`.

### Notion → «Ход работ» (20.10, сессия 5e)

- **Сделано.** Все 469 открытых карточек Notion сверены, 469 из 470 разложены по 68 строкам «Хода работ»:
  - 168 карточек — к пунктам этого плана: волны 2–3, PS-01/03/05, Telegram и другие;
  - 301 — дополнительные, по блокам.
  Направления: 5 прежних и 8 продуктовых — ATS, Telegram, встречи, интеграции, Wiki, HR-процессы, UX, расширение и мобильное. В Notion у каждой карточки поле **«Очередь»** = id строки; фильтр «Очередь не пусто» — всё, что в плане.
- **Порядок.** Ошибки раньше задач, critical → low. Пробелы волны 1 получили свои строки: распознавание `w-n-stt` (полоса ops) и профиль `w-n-profile` (полоса консилиума). Все high вне волн — строка `w-n-high`.
- **Сроки.** Продуктовая полоса после волны 3 закрывает ошибки блоков с 23.11 до ~21.01. Задачи бэклога 12.10 («Бэклог 12.10 · A–Г») идут кварталами до июня 2027. Задачи P0–P1 блоков и устаревшие «в работе» — без срока до сверки. Пересчёт по факту волны 2 — 06.11 (`w-n-replan`).
- **Ждут вас:**
  - `d-plan-capacity` — кто берёт продуктовые блоки;
  - `d-board-cleanup` — сверка «в работе», «на ревью» и дублей;
  - `d-triage-hb` — 51 карточка half-baked и без статуса;
  - мёржи `m-239` (страница очереди, деплой) и `m-240` (документы, без деплоя).

### Файлы в корне — что это (20.10)

| Файл | Что это | Кто ведёт |
|---|---|---|
| `ACTION-PLAN.md` | этот план: волны 2–3, бэклог 12.10 | агенты по плану |
| `SUCCESSOR-PROMPT.md` | общий вход для новой сессии: роли и их промпты | любая новая сессия |
| `SUCCESSOR-PROMPT-1-QUEUE.md` | роль «Исполнитель»: код и PR | сессия 21 |
| `SUCCESSOR-PROMPT-2-CONTROL.md` | роль «Контроль»: ревью до мёржа, проверка прода, сверка очереди и Notion | сессия dd |
| `SUCCESSOR-PROMPT-3-F5.md` | роль «Мёржи, деплои, ИИ-провайдеры» | сессия 46 |
| `SUCCESSOR-PROMPT-3-OWNER-QUEUE.md` | очередь владельца: ops-консоль, бот, MCP | сессия 09 |
| `AGENTS.md`, `TARGET_REPO_STRUCTURE.md` | каноны репозитория, в git | правки — docs-PR в `main` |

Убрано 20.10:
- `ACTION-BOARD.md` — в архиве (там же, где копия плана);
- «Очередь владельца HR Helper.html» — удалён;
- `COUNCIL-DRIFT-DESIGN.md` и `DRIFT-47.md` — переносятся в `docs/ai/` (docs-PR). Ваше действие с 18 предложениями
  дрейфа — пункт `c-drift18` в очереди.

## Как ведём

> **Сверка 14.11:** с 30.10 канон открытого — t-boards, Notion заморожен и только для чтения (R-084,
> `eval/data/decisions.jsonl:8` `d-3010-canon`; `.claude/rules/17-notion-board.md`). Пункт про Notion ниже — история.

- **Notion — канон открытого.** Статусы карточек двигаются по факту: открыто/задача → в работе → на ревью. Финальный
  статус («закрыто»/«завершённые») — только после «да» владельца, вместе с записью в `docs/plans/done/<модуль>.md`.
- **Ход работ** — в очереди https://ops.admin.hrhelper.space/queue → «Ход работ» (документы `work/*`; локальная доска
  `ACTION-BOARD.md` заморожена 15.10 и убрана 20.10). «Выполнено» по карточке — только после «да» владельца.
- **Порядок:** «Ошибки» раньше «Задач», severity critical → low, внутри уровня — от простого к сложному. Строго по одной
  задаче: взял → сделал → проверил → «на ревью» → следующая. Half-baked без ОК владельца не берём.
- **Ревью:** каждая готовая задача — консилиум. С 14.10 — облако GLM (Coding Plan, потолки 500 вызовов за 10 ч и 1200
  в сутки); локальные модели — профиль «Локально без лимитов (по очереди)» (`rp_eecd8482e790`), строго по одному прогону.
  Вердикт и разбор возражений — в PR и комментарием на карточке.

## Сводка на 13.10

| | Открыто | В работе | На ревью | Прочее |
|---|---|---|---|---|
| Ошибки | 147 (4 critical, 41 high; 5 half-baked) | 15 | 44 | — |
| Задачи | 72 «от пользователя» + 70 прожаренных (25 half-baked) + 3 | 42 | 22 | 8 «выполненные» |

Сегодня заведено 25 карточек: 13 ошибок (11 из бэклога 12.10, OPS-KAFKA-HC, OPS-DEPLOY-COLD-BUILD) и 12 задач.
Остальные 20 пунктов бэклога уже были в Notion — сопоставление ниже. Ops за сутки: 28 ложных «unhealthy» Kafka
и 1 падение витрины (деплой), доступность ≥ 99,86 %.

## Волна 0 — прод сейчас

1. [OPS-KAFKA-HC](https://app.notion.com/p/3f8dd207a82581f18966e758fecdd75c) — Healthcheck Kafka без JVM + `init: true`: 28 ложных «unhealthy» в сутки, 1449 зомби. ✅ #144 выкачен 13.10 18:09 UTC, на проде проверено 14.10 — ждёт «да» · _high · P0 · S_
2. [OPS-DEPLOY-COLD-BUILD](https://app.notion.com/p/3f8dd207a825818f8f45fe6c45dbc527) — Деплой обрывался по 75 мин: полная сборка, `chown -R` по node_modules до 26 мин. ✅ #145 (без `chown`, потолок 120 мин) — деплой 91 мин прошёл; кэш сборки — отдельная OPS-BUILD-CACHE · _high · P0 · S_

## Волна 1 — critical: безопасность и прод-инциденты (от простого к сложному)

3. [98481c5c](https://app.notion.com/p/3e8dd207a82581f7b631db1298481c5c) + [e1fdaaa7](https://app.notion.com/p/3e8dd207a82581c5b9b7f3aee1fdaaa7) — Кросс-тенантный запуск процесса Workflow: REST закрыт, Connect RPC `runWorkflowProcess` — нет. ✅ #146 выкачен 13.10 — ждёт «да» · _critical · security · S_
4. [PS-02](https://app.notion.com/p/3f8dd207a8258178b7a9d51d0f47535e) + [8331133a](https://app.notion.com/p/3e5dd207a8258190a428d9758331133a) + [b7d13105](https://app.notion.com/p/3e5dd207a82581c6b7edf614b7d13105) + [52faed4a](https://app.notion.com/p/3e8dd207a8258103b9cec81152faed4a) — Whisper STT обрывался на 5-й минуте (таймауты undici 300 с) и повторял загрузку целого файла. ✅ #147 выкачен 13.10 — нужна ручная проверка записью > 5 мин · _critical · M_
5. [070b945e](https://app.notion.com/p/3e2dd207a82581139f8dcd47070b945e) + [9868502a](https://app.notion.com/p/3e7dd207a82581cb9693dd2f9868502a) + [2a478b8b](https://app.notion.com/p/3e2dd207a825812db90be1d72a478b8b) + [7c0411ab](https://app.notion.com/p/3e7dd207a825810e9c47c2297c0411ab) + [8d353b76](https://app.notion.com/p/3e7dd207a8258162b52dc6908d353b76) — Профиль весит ~140 КБ и тянется 9–16 раз/мин; источник веса — снимки каталога переводов, сохранённые как переопределения (3263 строки / 1,4 МБ). Один кластер: лимиты на сервере, ETag, чистка снимков · _critical · M_
6. [e4b2ed46](https://app.notion.com/p/3eddd207a82580df8564f57ae4b2ed46) — Huntflow: токены обновляются сами — PS-04. ✅ часть 1 #154 (14.10) и часть 2 #157 (15.10 13:52 UTC, прод 200) выкачены: single-flight обмена, 401 → refresh + повтор, фоновое обновление раз в час; в воркфлоу-чате — понятная ошибка Huntflow и кнопки на настройки. Карточка «на ревью» — ждёт «да» · _critical · M_
7. [PS-01](https://app.notion.com/p/3f8dd207a82581609df5c8f5c3556815) — Meeting Intelligence не блокирует приложение: фоновые стадии, state machine, идемпотентность · _critical · L_
   - 18.10: фоновые стадии на проде (#169); ваша проверка `c-ps01-prod`; метка загрузки в футере — 23–24.10.
8. [PS-03](https://app.notion.com/p/3f8dd207a82581509fb6df4108813430) — Медиа до 1,5 ГБ: multipart в MinIO с докачкой (связано с MI-UPLOAD-413) · _задача · P0 · L_
   - 18.10: шаги 1–2 на проде — API частями (#193), маршрут nginx и потолки загрузок (#196, #202, #212); шаг 3 — интерфейс с докачкой, до 26.10.
9. [PS-05](https://app.notion.com/p/3f8dd207a825816591c0f72e4c7fd40c) + [cab22c30](https://app.notion.com/p/3e9dd207a8258148b34fea9acab22c30) + [TG-SM-9](https://app.notion.com/p/3e6dd207a82581e48912ea0d0f0253d8) — Telegram desktop теряет сессию и перерисовывается; «Слишком много запросов» (PS-06); вотчдог SM эвиктит здоровую сессию на FLOOD_WAIT · _critical · L_
   - 18.10: шаги A–E на проде (#171, #172, #174, #176, #177, #179, #180, #201); ваши проверки `c-ps05-ab` и `c-180`; карточка «на ревью».

## Волна 2 — high: безопасность и доступ

10. [SEC-01](https://app.notion.com/p/3f8dd207a82581a59edef4777bd00ddd) — Вся OpenAPI-спека (1242 пути) отдаётся анонимно — закрыть guard'ом и в nginx · _high · P1 · S_
11. [B-115](https://app.notion.com/p/3ecdd207a82581c2896ac9abaeb79209) — Кэш AI-задач без companyId/userId — черновик одного пользователя мог уйти другому · _high · P1 · S_
12. [B-116](https://app.notion.com/p/3ecdd207a82581ab8364d8b31a73027a) — env AI_POLICY_*/AI_ROUTING_RUNTIME_TASKS не доходит до backend-контейнера · _high · P1 · S_
13. [18c7c0ba](https://app.notion.com/p/3f4dd207a82581ed80f8e97718c7c0ba) — Любой оператор платформы создаёт компанию и её админа со своим паролем · _high · P1_
14. [265855a6](https://app.notion.com/p/3f6dd207a825816a8f51c4bc265855a6) — chatStream/generateImage игнорируют baseUrl подключения · _high · P1_
15. [8612262c](https://app.notion.com/p/3e5dd207a82581c183dbe7598612262c) + [9ad661a3](https://app.notion.com/p/3e8dd207a82581e6b7d0c95d9ad661a3) — IDOR: заявка кандидата чужой компании по UUID (REST, Connect, skills-match) · _high_
16. [B-102](https://app.notion.com/p/3d6dd207a8258136af7be8d721362a02) + [cd0bd448](https://app.notion.com/p/3e8dd207a8258172bf21ee0ccd0bd448) — ATS: смена этапа, комментарии и bulk-пути без проверки прав · _high_
17. [eeb99c48](https://app.notion.com/p/3e8dd207a8258152a344f237eeb99c48) — Вакансии: создание и удаление без RBAC и без записи в историю · _high_
18. [ea62bc0f](https://app.notion.com/p/3eedd207a825812e9574e3d2ea62bc0f) — Lockdown-экран показывает содержимое тостов (UX-07) · _high · M_
19. [B-108](https://app.notion.com/p/3d8dd207a82581f48880db2d87f6e114) — Нет Content-Security-Policy ни на одном слое · _high_
20. [2ff63c8c](https://app.notion.com/p/3f3dd207a8258195b294c1342ff63c8c) — npm audit: 58 уязвимостей (5 critical) — без мажорных скачков, по группам · _high · M_

## Волна 3 — high: штормы запросов, данные, ATS

21. [55e5e44b](https://app.notion.com/p/3e7dd207a8258199bc8deaab55e5e44b) + [7b7bcf0d](https://app.notion.com/p/3e2dd207a82581a4845cc1b07b7bcf0d) — Главная и календарь: бесконечный цикл запросов (queryKey с миллисекундами) и шторм calendar/events · _high · P1 · S_
22. [T-277](https://app.notion.com/p/3cadd207a8258197a0a2c46eb83d2178) — Telegram: аватары не показываются, нестабильно в списках · _P0_
23. [1da2e404](https://app.notion.com/p/3e5dd207a8258170b139cfe91da2e404) — Воркфлоу-процессы и сообщения ИИ-панели Telegram «пропадают» — нет привязки к чату · _high_
24. [PS-07](https://app.notion.com/p/3f8dd207a825814faa56d7640d5a60e5) — Анализ чата > 100 сообщений: окно контекста + summary вместо роста массива · _high · P1 · M_
25. [ATS-09](https://app.notion.com/p/3f8dd207a82581198bd9f21ff32f6713) — 404 по ссылке на кандидата 1653: route-not-found ≠ candidate-not-found · _high · P1 · S_
26. [ATS-05](https://app.notion.com/p/3f8dd207a82581038128f88d1c319587) — Deep-link открывает карточку кандидата; URL — источник истины · _high · P1 · M_
27. [ATS-10](https://app.notion.com/p/3f8dd207a825812b8a48c7c0fbbc8406) + [T-266](https://app.notion.com/p/3c6dd207a825815291ceef6269ad9817) — Попап смены этапа: только этапы своей вакансии, имя этапа вместо lc-c-… (вместе с T-266) · _high · P1 · M_
28. [ATS-07](https://app.notion.com/p/3f8dd207a825810fb87ce40361cf5de7) — Диагностика дублей: оба ID в ссылке, разложение score · _high · P1 · M_
29. [1b3024fc](https://app.notion.com/p/3e2dd207a825814eadb0c1fa1b3024fc) + [70c85bb9](https://app.notion.com/p/3e9dd207a82581ac8e97c4cb70c85bb9) + [947cb616](https://app.notion.com/p/3e2dd207a825816d926ed214947cb616) — Модалка вакансии: падение на «Статусах», нетипизированная VM, PUT отбивает сохранение · _high_
30. [07ff3554](https://app.notion.com/p/3e2dd207a8258103ae95e5fb07ff3554) — Статистика ATS 500: потеряна materialized view (миграция — план и ревью) · _high_
31. [60f0f7ff](https://app.notion.com/p/3e5dd207a82581a6be98fdec60f0f7ff) — Отчётность рекрутинга: 400 на детализации и сохранении · _high_
32. [B-90](https://app.notion.com/p/3d1dd207a82581029db0fe62c4466fec) — PUT /system/menu-modules-global привязан к чужому DTO · _high_
33. [RAG-01](https://app.notion.com/p/3f8dd207a8258113adadd2bf622acf98) — ИИ-навигатор Wiki: различать пустую выдачу и сбой роутера · _high · P1 · M_
34. [AI-06](https://app.notion.com/p/3f8dd207a82581179bd2fd1e4be27121) + [B-99](https://app.notion.com/p/3d5dd207a82581a785ecf6cb9208bbdf) + [8559a01e](https://app.notion.com/p/3e8dd207a82581e490fbd8aa8559a01e) — Автоматизации через общий роутинг; fallback не только hardcoded-пара · _high · P1 · M_
35. [27438721](https://app.notion.com/p/3e5dd207a82581179a50e68b27438721) + [a78cc6fe](https://app.notion.com/p/3e8dd207a825814d829fe8b1a78cc6fe) — NPS онбординга и ответы Survey Engine не собираются · _high_
36. [B-111](https://app.notion.com/p/3dfdd207a82581748e52ea5b88d3be37) — Referral: scope/audience заявлены в схеме, но молча не работают · _high_
37. [edf93498](https://app.notion.com/p/3eedd207a82581adaba0d0ceedf93498) + [B-119](https://app.notion.com/p/3eddd207a82581c293fbf5c972bb7a5a) — iOS: уведомления не приходят; нижний бар нечитаем (B-119 «в работе») · _high · MOB-01/02_
38. [B-92](https://app.notion.com/p/3d1dd207a825812099f9ff36be8f8359) — B-92 Kafka self-fencing — после пересоздания kafka сверить и предложить закрытие вместе с OPS-KAFKA-HC · _high · S_
39. [B-94](https://app.notion.com/p/3d1dd207a8258155862bd0db5487c5ef) — Бэкап dev-Postgres отстаёт от миграций · _high_

## Задачи из бэклога 12.10 — после ошибок, в порядке волн документа

40. [ATS-04](https://app.notion.com/p/3f8dd207a825818e9f84e14a0f4d7c23) — Поиск по ID карточки (1653, #1653, ссылка) · _P1 · S_
41. [ATS-11](https://app.notion.com/p/3f8dd207a825811db6f8de1534a78c47) — «Запустить сейчас» для автоматизаций вакансии · _P1 · M_
42. [ATS-06](https://app.notion.com/p/3f8dd207a82581df9ef2d7bd9e15976f) — Телефоны E.164 + дедупликация (миграция — план и ревью владельца) · _P1 · M_
43. [AI-05](https://app.notion.com/p/3f8dd207a82581698e73c6bcfd49160e) — AI Tools: вкладки маршрутов/моделей/провайдеров/ключей и реальный статус · _P1 · L_
44. [RAG-02](https://app.notion.com/p/3f8dd207a82581f3b273db74bbd3fda0) — Содержательные чанки вакансий в Wiki RAG · _P1 · M_
45. [ATS-02](https://app.notion.com/p/3f8dd207a8258120b8d8c802b97f2ee3) — Сопроводительные письма hh.ru вместе с откликом · _P1 · M_
46. [WF-01](https://app.notion.com/p/3f8dd207a825815397cec2f8995551e5) — /t и /е — HR Screening в календарь + Meet · _P1 · L_
47. [57c76920](https://app.notion.com/p/3eedd207a82581759b56de3557c76920) — /hr — заполнение Huntflow по ссылке и ответам (WF-02) · _P1 · XL_
48. [ATS-03](https://app.notion.com/p/3f8dd207a82581de81a6d9c602d2c730) — Telegram ↔ кандидат: связь сообщений (после решения по хранению переписки) · _P1 · L_
49. [46736119](https://app.notion.com/p/3eedd207a825811fbbcdf44246736119) + [265ee973](https://app.notion.com/p/3eedd207a82581bc8b60f911265ee973) — Хранение переписки Telegram: настройка, удаление, без тостов (TG-01/02) · _P2_
50. [ATS-01](https://app.notion.com/p/3f8dd207a8258169b67dd2928149571f) — «По состоянию на <дата>» для незакрытых периодов · _P2 · S_
51. [UX-02](https://app.notion.com/p/3f8dd207a825814cb72ad88cf28d6421) — Загрузка аватарки · _P2 · M_
52. [da8a92b5](https://app.notion.com/p/3eedd207a825813aa10bdb57da8a92b5) + [5cb8da08](https://app.notion.com/p/3eedd207a825812d928edd885cb8da08) — Календарь и модель Workflow — настройки на сервере (UX-03/04) · _P2_
53. [61fe43d2](https://app.notion.com/p/3eedd207a82581cba397fffa61fe43d2) — Персональный дашборд (UX-01) · _P2_
54. [ec4403f7](https://app.notion.com/p/3eedd207a82581809c62ea81ec4403f7) — /settings/hitl/:id (HITL-01) · _P2 · M_
55. [BM-01](https://app.notion.com/p/3f8dd207a82581788197cebec80955c8) — Benchmark вакансий: ADR, ERD, лицензирование · _spike · XL_

## Ошибки medium из бэклога 12.10

56. [df5cb9e2](https://app.notion.com/p/3eedd207a82581beb09ce7b3df5cb9e2) — Telegram: даты парсятся как MM/DD (TG-03) · _medium · M_
57. [bd7aab49](https://app.notion.com/p/3eedd207a8258141a803ec90bd7aab49) — Быстрые кнопки: снятая активность возвращается (TG-05) · _medium · S_
58. [75237d5a](https://app.notion.com/p/3eedd207a8258154b1aee85575237d5a) + [65c10de6](https://app.notion.com/p/3e8dd207a825811a809bde8f65c10de6) — Плавающие окна выходят за экран (UX-05) · _medium_
59. [3f8f33d7](https://app.notion.com/p/3eedd207a82581f9b0a7e5f93f8f33d7) — Учёт рабочего времени: правка текущего дня (UX-08) · _medium · M_
60. [1df7bf63](https://app.notion.com/p/3eedd207a82581358ca3f5fc1df7bf63) — Закрытый тост открывается повторно (UX-06) · _low · S_
61. [58fe81f9](https://app.notion.com/p/3eedd207a82581ea8668c2b458fe81f9) — Мобильный Telegram: «Отправить» — только иконка (TG-04) · _P3 · S_
62. [048fad6c](https://app.notion.com/p/3eedd207a8258130ae12ec16048fad6c) — iOS: акцентные цвета из профиля (MOB-01) · _medium · M_

Остальные открытые ошибки medium/low (≈ 90) и прожаренные задачи берутся после списка выше, тем же порядком;
актуальная очередь — представления Notion «Ошибки»/«Задачи» с сортировкой по Severity/Priority.

## Сопоставление бэклога 12.10 с Notion

| Пункт | Карточки | Где сейчас |
|---|---|---|
| PS-01 | [PS-01](https://app.notion.com/p/3f8dd207a82581609df5c8f5c3556815) | открыто, волна 1 |
| PS-02 | [PS-02](https://app.notion.com/p/3f8dd207a8258178b7a9d51d0f47535e) + [8331133a](https://app.notion.com/p/3e5dd207a8258190a428d9758331133a) + [b7d13105](https://app.notion.com/p/3e5dd207a82581c6b7edf614b7d13105) + [52faed4a](https://app.notion.com/p/3e8dd207a8258103b9cec81152faed4a) | волна 1 |
| PS-03 | [PS-03](https://app.notion.com/p/3f8dd207a82581509fb6df4108813430) + [3bf4ca23](https://app.notion.com/p/3e5dd207a825817f995be7733bf4ca23) | волна 1 |
| PS-04 | [e4b2ed46](https://app.notion.com/p/3eddd207a82580df8564f57ae4b2ed46) | «в работе», волна 1 |
| PS-05 | [PS-05](https://app.notion.com/p/3f8dd207a825816591c0f72e4c7fd40c) | волна 1 |
| PS-06 | [cab22c30](https://app.notion.com/p/3e9dd207a8258148b34fea9acab22c30) + [fc101b10](https://app.notion.com/p/3e6dd207a8258186967fccddfc101b10) | волна 1 / fc101b10 на ревью |
| PS-07 | [PS-07](https://app.notion.com/p/3f8dd207a825814faa56d7640d5a60e5) | волна 3 |
| AI-01…03 | [796c106e](https://app.notion.com/p/3f6dd207a82581a7a36ce935796c106e) + [T-289](https://app.notion.com/p/3e2dd207a825814badadd2c6a94c8101) | «в работе» (каталог провайдеров, T-289) |
| AI-04 | [T-290](https://app.notion.com/p/3eadd207a825815688b0c9b1b447849d) | «на ревью» (T-290) |
| AI-05 | [AI-05](https://app.notion.com/p/3f8dd207a82581698e73c6bcfd49160e) | задача, после волны 3 |
| AI-06 | [AI-06](https://app.notion.com/p/3f8dd207a82581179bd2fd1e4be27121) | волна 3 |
| ATS-01 | [ATS-01](https://app.notion.com/p/3f8dd207a8258169b67dd2928149571f) | задача P2 |
| ATS-02 | [ATS-02](https://app.notion.com/p/3f8dd207a8258120b8d8c802b97f2ee3) | задача |
| ATS-03 | [ATS-03](https://app.notion.com/p/3f8dd207a82581de81a6d9c602d2c730) | задача |
| ATS-04 | [ATS-04](https://app.notion.com/p/3f8dd207a825818e9f84e14a0f4d7c23) | задача S |
| ATS-05 | [ATS-05](https://app.notion.com/p/3f8dd207a82581038128f88d1c319587) | волна 3 |
| ATS-06 | [ATS-06](https://app.notion.com/p/3f8dd207a82581df9ef2d7bd9e15976f) | задача, миграция — план |
| ATS-07 | [ATS-07](https://app.notion.com/p/3f8dd207a825810fb87ce40361cf5de7) | волна 3 |
| ATS-08 | [T-270](https://app.notion.com/p/3c6dd207a82581cdb92fc60e7f5eb1c5) | прожарена (T-270 ATS-MERGE-1, XL) |
| ATS-09 | [ATS-09](https://app.notion.com/p/3f8dd207a82581198bd9f21ff32f6713) | волна 3 |
| ATS-10 | [ATS-10](https://app.notion.com/p/3f8dd207a825812b8a48c7c0fbbc8406) | волна 3 |
| ATS-11 | [ATS-11](https://app.notion.com/p/3f8dd207a825811db6f8de1534a78c47) | задача |
| TG-01 | [46736119](https://app.notion.com/p/3eedd207a825811fbbcdf44246736119) | задача P2 L |
| TG-02 | [265ee973](https://app.notion.com/p/3eedd207a82581bc8b60f911265ee973) | задача P3 S |
| TG-03 | [df5cb9e2](https://app.notion.com/p/3eedd207a82581beb09ce7b3df5cb9e2) | ошибка medium M |
| TG-04 | [58fe81f9](https://app.notion.com/p/3eedd207a82581ea8668c2b458fe81f9) | задача P3 S |
| TG-05 | [bd7aab49](https://app.notion.com/p/3eedd207a8258141a803ec90bd7aab49) | ошибка medium S |
| RAG-01 | [RAG-01](https://app.notion.com/p/3f8dd207a8258113adadd2bf622acf98) | волна 3 |
| RAG-02 | [RAG-02](https://app.notion.com/p/3f8dd207a82581f3b273db74bbd3fda0) | задача |
| UX-01 | [61fe43d2](https://app.notion.com/p/3eedd207a82581cba397fffa61fe43d2) | задача P2 |
| UX-02 | [UX-02](https://app.notion.com/p/3f8dd207a825814cb72ad88cf28d6421) | задача P2 |
| UX-03 | [da8a92b5](https://app.notion.com/p/3eedd207a825813aa10bdb57da8a92b5) | задача P2 M |
| UX-04 | [5cb8da08](https://app.notion.com/p/3eedd207a825812d928edd885cb8da08) | задача P2 S |
| UX-05 | [75237d5a](https://app.notion.com/p/3eedd207a8258154b1aee85575237d5a) + [65c10de6](https://app.notion.com/p/3e8dd207a825811a809bde8f65c10de6) | ошибки medium |
| UX-06 | [1df7bf63](https://app.notion.com/p/3eedd207a82581358ca3f5fc1df7bf63) | ошибка low S |
| UX-07 | [ea62bc0f](https://app.notion.com/p/3eedd207a825812e9574e3d2ea62bc0f) | волна 2 |
| UX-08 | [3f8f33d7](https://app.notion.com/p/3eedd207a82581f9b0a7e5f93f8f33d7) | ошибка medium M |
| BM-01 | [BM-01](https://app.notion.com/p/3f8dd207a82581788197cebec80955c8) | spike XL — после решения по лицензиям данных |
| MOB-01 | [B-119](https://app.notion.com/p/3eddd207a82581c293fbf5c972bb7a5a) + [048fad6c](https://app.notion.com/p/3eedd207a8258130ae12ec16048fad6c) | B-119 «в работе» + акцент |
| MOB-02 | [edf93498](https://app.notion.com/p/3eedd207a82581adaba0d0ceedf93498) | волна 3 |
| SEC-01 | [SEC-01](https://app.notion.com/p/3f8dd207a82581a59edef4777bd00ddd) | волна 2 |
| HITL-01 | [ec4403f7](https://app.notion.com/p/3eedd207a82581809c62ea81ec4403f7) | задача P2 M |
| WF-01 | [WF-01](https://app.notion.com/p/3f8dd207a825815397cec2f8995551e5) | задача |
| WF-02 | [57c76920](https://app.notion.com/p/3eedd207a82581759b56de3557c76920) | задача P1 XL |

## Связанность — кластеры

- **Kafka и деплой:** [B-92](https://app.notion.com/p/3d1dd207a825812099f9ff36be8f8359) + [OPS-KAFKA-HC](https://app.notion.com/p/3f8dd207a82581f18966e758fecdd75c) + [OPS-DEPLOY-COLD-BUILD](https://app.notion.com/p/3f8dd207a825818f8f45fe6c45dbc527) + [5f18449c](https://app.notion.com/p/3f6dd207a82581b1a64ef14a5f18449c) — B-92 — родитель OPS-KAFKA-HC; медленный деплой — OPS-BUILD-CACHE (кэш сборки не переиспользуется); связь с потолком кэша 20 ГБ из задачи 5f18449c (#141) — гипотеза, не проверена.
- **Workflow: кросс-тенантный запуск:** [e1fdaaa7](https://app.notion.com/p/3e8dd207a82581c5b9b7f3aee1fdaaa7) + [98481c5c](https://app.notion.com/p/3e8dd207a82581f7b631db1298481c5c) — REST закрыт, Connect RPC — нет.
- **Профиль, переводы, вес ответа:** [070b945e](https://app.notion.com/p/3e2dd207a82581139f8dcd47070b945e) + [9868502a](https://app.notion.com/p/3e7dd207a82581cb9693dd2f9868502a) + [2a478b8b](https://app.notion.com/p/3e2dd207a825812db90be1d72a478b8b) + [7c0411ab](https://app.notion.com/p/3e7dd207a825810e9c47c2297c0411ab) + [8d353b76](https://app.notion.com/p/3e7dd207a8258162b52dc6908d353b76) + [B-104](https://app.notion.com/p/3d8dd207a82581bc9f5ae49cc12eeeef) + [feb8e4c4](https://app.notion.com/p/3e7dd207a825813a9434ed7dfeb8e4c4) — вес профиля = снимки каталога в translation_overrides; ETag снимет повторные загрузки; на ревью — гонка темы и 400 ui-preferences.
- **Штормы запросов:** [55e5e44b](https://app.notion.com/p/3e7dd207a8258199bc8deaab55e5e44b) + [7b7bcf0d](https://app.notion.com/p/3e2dd207a82581a4845cc1b07b7bcf0d) + [cab22c30](https://app.notion.com/p/3e9dd207a8258148b34fea9acab22c30) + [fc101b10](https://app.notion.com/p/3e6dd207a8258186967fccddfc101b10) + [070b945e](https://app.notion.com/p/3e2dd207a82581139f8dcd47070b945e) + [T-277](https://app.notion.com/p/3cadd207a8258197a0a2c46eb83d2178) + [PS-05](https://app.notion.com/p/3f8dd207a825816591c0f72e4c7fd40c) — один класс причин — нестабильные queryKey, повторный bootstrap, отсутствие ETag; nginx limit_req ловит последствия.
- **STT и Meeting Intelligence:** [PS-01](https://app.notion.com/p/3f8dd207a82581609df5c8f5c3556815) + [PS-02](https://app.notion.com/p/3f8dd207a8258178b7a9d51d0f47535e) + [PS-03](https://app.notion.com/p/3f8dd207a82581509fb6df4108813430) + [8331133a](https://app.notion.com/p/3e5dd207a8258190a428d9758331133a) + [b7d13105](https://app.notion.com/p/3e5dd207a82581c6b7edf614b7d13105) + [52faed4a](https://app.notion.com/p/3e8dd207a8258103b9cec81152faed4a) + [3bf4ca23](https://app.notion.com/p/3e5dd207a825817f995be7733bf4ca23) + [229012c4](https://app.notion.com/p/3f0dd207a82580fc9953c292229012c4) + [MI-18](https://app.notion.com/p/3e6dd207a82581f28944fdc50c429961) — модель Whisper, OOM, застревание записи и лимит 50 МБ — проверять вместе.
- **ИИ-маршрутизация:** [T-289](https://app.notion.com/p/3e2dd207a825814badadd2c6a94c8101) + [T-290](https://app.notion.com/p/3eadd207a825815688b0c9b1b447849d) + [T-291](https://app.notion.com/p/3eadd207a82581baafc1c5ab17df37d3) + [796c106e](https://app.notion.com/p/3f6dd207a82581a7a36ce935796c106e) + [B-116](https://app.notion.com/p/3ecdd207a82581ab8364d8b31a73027a) + [B-115](https://app.notion.com/p/3ecdd207a82581c2896ac9abaeb79209) + [265855a6](https://app.notion.com/p/3f6dd207a825816a8f51c4bc265855a6) + [ce7ed28f](https://app.notion.com/p/3f6dd207a82581b89ff2dd2cce7ed28f) + [82f23ee3](https://app.notion.com/p/3f6dd207a82581c88340efa382f23ee3) + [915a1f8b](https://app.notion.com/p/3f6dd207a825812b8e1bc265915a1f8b) + [3cb1c666](https://app.notion.com/p/3f3dd207a825815388bcfe0e3cb1c666) + [B-112](https://app.notion.com/p/3ebdd207a825814aa6bafd16c553535a) + [B-99](https://app.notion.com/p/3d5dd207a82581a785ecf6cb9208bbdf) + [8559a01e](https://app.notion.com/p/3e8dd207a82581e490fbd8aa8559a01e) + [AI-05](https://app.notion.com/p/3f8dd207a82581698e73c6bcfd49160e) + [AI-06](https://app.notion.com/p/3f8dd207a82581179bd2fd1e4be27121) — T-289/T-290 — основа; B-115/B-116 и baseUrl — дыры в уже смёрженном.
- **ATS: права доступа:** [B-102](https://app.notion.com/p/3d6dd207a8258136af7be8d721362a02) + [cd0bd448](https://app.notion.com/p/3e8dd207a8258172bf21ee0ccd0bd448) + [8612262c](https://app.notion.com/p/3e5dd207a82581c183dbe7598612262c) + [9ad661a3](https://app.notion.com/p/3e8dd207a82581e6b7d0c95d9ad661a3) + [32c42e33](https://app.notion.com/p/3e8dd207a82581b38708d4bd32c42e33) + [eeb99c48](https://app.notion.com/p/3e8dd207a8258152a344f237eeb99c48) + [T-266](https://app.notion.com/p/3c6dd207a825815291ceef6269ad9817) + [ATS-10](https://app.notion.com/p/3f8dd207a825812b8a48c7c0fbbc8406) — один guard-паттерн на все мутирующие пути и чтение по UUID.
- **Секреты и шифрование:** [B-85](https://app.notion.com/p/3cbdd207a8258141aba0c4ced0f234e7) + [5b141844](https://app.notion.com/p/3e8dd207a8258147803adb5f5b141844) + [13a8e420](https://app.notion.com/p/3e5dd207a82581e69723d3cd13a8e420) + [B-91](https://app.notion.com/p/3d1dd207a82581158e86e793c8dcbedf) — решение по ENCRYPTION_SECRET на проде — за владельцем.
- **OnlyOffice:** [B-15](https://app.notion.com/p/3b8dd207a82581c2ad1ce65300a7a651) + [58ac848c](https://app.notion.com/p/3e8dd207a8258186b09fd7f958ac848c) + [fbceeff2](https://app.notion.com/p/3e7dd207a82581928879ed6afbceeff2) + [727f61f0](https://app.notion.com/p/3e8dd207a825812dadbbc02f727f61f0) — DS на проде не развёрнут — решение «развернуть или убрать» за владельцем.
- **Telegram:** [PS-05](https://app.notion.com/p/3f8dd207a825816591c0f72e4c7fd40c) + [cab22c30](https://app.notion.com/p/3e9dd207a8258148b34fea9acab22c30) + [PS-07](https://app.notion.com/p/3f8dd207a825814faa56d7640d5a60e5) + [TG-SM-9](https://app.notion.com/p/3e6dd207a82581e48912ea0d0f0253d8) + [1da2e404](https://app.notion.com/p/3e5dd207a8258170b139cfe91da2e404) + [T-277](https://app.notion.com/p/3cadd207a8258197a0a2c46eb83d2178) + [46736119](https://app.notion.com/p/3eedd207a825811fbbcdf44246736119) + [265ee973](https://app.notion.com/p/3eedd207a82581bc8b60f911265ee973) + [df5cb9e2](https://app.notion.com/p/3eedd207a82581beb09ce7b3df5cb9e2) + [58fe81f9](https://app.notion.com/p/3eedd207a82581ea8668c2b458fe81f9) + [bd7aab49](https://app.notion.com/p/3eedd207a8258141a803ec90bd7aab49) + [ATS-03](https://app.notion.com/p/3f8dd207a82581de81a6d9c602d2c730) + [56ef685a](https://app.notion.com/p/3e2dd207a8258162b3cfdc7856ef685a) + [T-99](https://app.notion.com/p/3b9dd207a82581db8ba7e0ffc4796303) — TG-STATE (c4796303) — half-baked, но «в работе»: нарушение хард-стопа, нужен ОК владельца.
- **iOS:** [B-119](https://app.notion.com/p/3eddd207a82581c293fbf5c972bb7a5a) + [048fad6c](https://app.notion.com/p/3eedd207a8258130ae12ec16048fad6c) + [edf93498](https://app.notion.com/p/3eedd207a82581adaba0d0ceedf93498) + [T-305](https://app.notion.com/p/3ecdd207a82581adbcd1f42e6aede858) — B-119 + T-305; уведомления и акцент — отдельные ошибки.
- **Вакансия: модалка:** [1b3024fc](https://app.notion.com/p/3e2dd207a825814eadb0c1fa1b3024fc) + [70c85bb9](https://app.notion.com/p/3e9dd207a82581ac8e97c4cb70c85bb9) + [947cb616](https://app.notion.com/p/3e2dd207a825816d926ed214947cb616) — падение «Статусов» — следствие нетипизированной VM.
- **Опросы:** [27438721](https://app.notion.com/p/3e5dd207a82581179a50e68b27438721) + [a78cc6fe](https://app.notion.com/p/3e8dd207a825814d829fe8b1a78cc6fe) — ответы не пишутся — отчёты пустые.

## Ревизия «в работе»

42 задачи и 15 ошибок в статусе «в работе», большинство без движения с 24.09–05.10. Серия MI-1…MI-18: коммиты
24–27.09, модуль на проде; MI-3/MI-6/MI-21 уже «выполненные», MI-8/MI-15 «на ревью» с коммитами. Кандидаты на
«на ревью» после сверки с кодом. Карточки без ветки и коммитов дольше двух недель — вернуть в очередь (решение
владельца списком). Полный перечень — в доске, раздел «В работе — унаследовано».

## История

Оценки 15–17.10, итоги 15.10, новые ошибки 16.10 и журнал до 20.10 — в архиве: `~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2/handoff/archive/2026-10-20-root/ACTION-PLAN.before-cleanup-2026-10-20.md`.
Новое сюда не пишем: состояние ведут очередь и Notion.
