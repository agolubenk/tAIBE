# M1 — продукт как сущность инстанса: `instances/<slug>.json` и команда `taibe products`

> **Статус (2026-11-04):** 🔲 спека v1.3 на утверждение. Развилки Р1, Р2 решены владельцем 04.11 18:55
> (`d-taibe-m1m2-0411`, «всё по рекомендации»): `instances/` — в git tAIBE, slug HR — `hr-helper`. Код M1
> разблокирован. Фаза M1 дорожной карты
> [`multi-product.md`](../plans/roadmap/multi-product.md). Сверено с кодом `board-agents@25d73636` и Mac владельца
> 03.11 (роль 2). v1.1 — 6 находок линзы корректности (GLM, 04.11) и линза M0/M1 к tAIBE #39, сверено с
> `board-agents@3f77c84c`. v1.2 — линзы ресурсов, продукта и краёв (GLM, 04.11 17:10).
>
> **OPS-25 (07.11, `d-ops25-plan-0711`):** для двух команд действует сужение — [`nerve-per-product.md`](../plans/roadmap/nerve-per-product.md):
> `instances/` и `eval/nerve/products.py render` есть (Ф1), команды `taibe products add/check` нет до третьего продукта; Нерв читает `instances/` сам (Ф2a).

## Проблема

tAIBE знает ровно один продукт. Всё, что относится к продукту, лежит в `eval/nerve/config.json` вперемешку с
настройками Mac и аккаунта Claude:

- **продукт** — `repo_root`, `product_tree`, `team.{project_dir, roles, active_hours}`,
  `github.{repo, min_lenses, quorum_to, path_roles (16), lens_roles (22)}`,
  `queue.{source_roles (6), owner_items, secret_cmd}`, `boards.{product, workspace, note}`;
- **Mac и аккаунт** — `interval_seconds`, `sources`, `system`, `budget`, `circadian`, `tap`,
  `team.projects_root`, `queue.url`, `boards.url`.

Читатели `config.json`: Нерв (`eval/nerve/nerve.py:236` — все источники), сборщик геномов
(`eval/pipeline/genome/build.py:38` — `repo_root`, `product_tree` для путей хуков), настройки пайплайна
(`.claude/scripts/pipeline_settings.py:110` — блок `boards`), `infra/scripts/split/1-preflight.sh:41`,
`eval/nerve/test_nerve.py:21`. `eval-ci.yml` гоняет `build.py --check` для инстанса из `config.json`.
Команды `taibe` нет.

Второй продукт (M7) сейчас подключить нечем: пришлось бы руками держать второй `config.json`, а читатели видят
только один. M1 вводит продукт как отдельную сущность и **ничего не меняет в поведении**: `config.json` остаётся и
собирается из файлов продуктов.

## Пользователи и сценарии

- **Владелец** подключает продукт одной командой и сразу видит, чего не хватает (папки, ролей, доски), — а не
  узнаёт об этом по молчащему Нерву.
- **Координатор и роли** работают как раньше: Нерв, геномы, `tap` берут тот же `config.json`.
- **Сессия, которая меняет раскладку ролей или путей**, правит файл продукта, а не `config.json`. CI ловит
  ручную правку сгенерированного файла.

Сценарии:

1. `taibe products list` — slug, название на доске, папка, репо, отметка продукта по умолчанию.
2. `taibe products check hr-helper` — проверка без записи (R-6), отчёт строками «ок / warn / fail», exit 1 при fail.
3. `taibe products add <slug> --dir <папка> --repo <owner/name> --board "<название>" [--from <slug>] [--default]`
   — создаёт `instances/<slug>.json` (по образцу `--from`: роли и раскладка), показывает отчёт `check` и делает
   `render`. Fail в отчёте не отменяет создание: файл доправляют и прогоняют `check` снова. Но при fail команда
   возвращает exit 1, а последняя строка вывода — «продукт <slug> создан, но не готов: поправьте файл и прогоните
   `check`». С `--default` при fail `default_product` не меняется. `--offline` передаётся в `check`.
4. `taibe products render [--check]` — собирает `eval/nerve/config.json`; `--check` только сравнивает.

## Модель

| Файл | Что в нём | Кто пишет |
|---|---|---|
| `instances/<slug>.json` | поля продукта (список выше) + `slug`, `title` | человек или `products add` |
| `instances/_shared.json` | поля Mac и аккаунта + `default_product` | человек |
| `instances/schema.json` | JSON Schema обоих видов файлов | PR |
| `eval/nerve/config.json` | **генерируется**: `_shared` ⊕ продукт по умолчанию, байт-в-байт равен нынешнему | только `render` |

- **slug** — `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`, неизменяем после `add`; HR → `hr-helper` (Р2, решено 04.11).
- Поле продукта не может стоять в `_shared`, и наоборот — это проверяет схема (`additionalProperties: false`).
  Строка fail называет поле и файл, в котором ему место.
- **`⊕` — рекурсивное слияние объектов.** Блоки `team`, `queue`, `boards` разрезаны между файлами:
  `team.projects_root` в `_shared`, `team.project_dir` в продукте. При слиянии верхнего уровня `team` продукта
  затёр бы `projects_root`, и бюджет по всему аккаунту (`budget.py:147`) перестал бы считаться. Один и тот же лист в
  обоих файлах — fail `render` и `check`, а не переопределение.
- `config.json` в M1 не удаляется. Причина: копия `pipeline_settings.py` в папках продуктов и пути через ссылки
  HR (`supertick-eval`, `eval`) читают именно его; перевод читателей на загрузчик — M3, удаление `config.json` — M3.

## Правила

- **R-1.** `render` детерминирован: ключи и вложенные ключи — в порядке нынешнего `config.json` (порядок задаёт
  шаблон в коде `render`, а не файлы-источники), отступ 2, `ensure_ascii=False`, перевод строки в конце. Вывод для
  `hr-helper` **байт-в-байт** равен `config.json` на `25d73636`. Сверено 04.11: файл — это ровно
  `json.dumps(d, ensure_ascii=False, indent=2) + "\n"`, 4821 байт, `\u`-эскейпов нет; с `25d73636` до `3f77c84c`
  не менялся.
  - Запись атомарна: временный файл в той же папке + `os.replace`. При любой ошибке `render` прежний
    `config.json` не трогается: его читает Нерв на каждом проходе (`nerve.py:236`).
- **R-2.** Секретов в файлах нет — только `secret_cmd` (как сейчас в `queue`). `check` падает, если значение похоже
  на ключ: префиксы `sk-`, `ghp_`, `github_pat_`, `xox`, `AKIA`, JWT (`eyJ…` из трёх частей через точку), заголовок
  `-----BEGIN` (PEM), длинный base64.
- **R-3.** `add` не трогает `default_product` без `--default`; не перезаписывает существующий slug.
- **R-4.** Команды — только stdlib Python, `python3 -I eval/tools/taibe.py …`, плюс sh-обёртка `./taibe` в корне
  tAIBE. Обёртка ищет интерпретатор так же, как плист Нерва.
- **R-5.** Роли продукта ⊂ `eval/pipeline/roles.json`; `path_roles`, `lens_roles`, `source_roles` ссылаются только
  на роли продукта.
- **R-6.** `check` ничего не пишет и проверяет:
  - папка — git-checkout, `remote.origin.url` указывает на `github.repo`;
  - `product_tree` существует;
  - `team.project_dir` существует (warn — сессий ещё не было);
  - R-5;
  - доска находится по названию (`boards.product` в `boards.workspace`; сеть, `--offline` пропускает; ключ — по
    цепочке `pipeline_settings._key`). Сеть, SSL, таймаут или нет ключа — **warn** с причиной, не fail: на Mac
    владельца сейчас SSL (ОШИБКИ #634, фикс — tAIBE #38). Fail — только когда сервер ответил, а доски нет;
  - `build.py --check` зелёный — только для продукта по умолчанию. Для остальных warn «`build.py --product` — M3»:
    в M1 сборщик видит один инстанс из `config.json`.
- **R-7.** `render --check` — шаг в `eval-ci.yml` перед `build.py --check`.
- **Сквозные инварианты:** снаружи ничего не меняется (PR, карточки, очередь, бот, Нерв, геномы); мёрж в
  `board-agents` прод не деплоит; основной checkout tAIBE получает изменения только по `git pull` владельца.
- **Стоимость:**
  - в рантайме ноль: файлы читает только `render`, число процессов и частота опросов Нерва не меняются;
  - CI: +1 шаг. «< 1 с» — оценка, замер идёт в отчёт PR M1;
  - сеть только в `check` без `--offline`. Это ручная команда, в цикле она не запускается.

## Приёмка

- **AC-1.** `./taibe products render --check` → exit 0; `git diff --exit-code eval/nerve/config.json` после
  `render` пуст. Байт-в-байт с `25d73636` — разовая проверка в отчёт PR M1, в checkout с полной историей:
  `git show 25d73636:eval/nerve/config.json | cmp - eval/nerve/config.json`. В CI её нет: checkout там мелкий
  (depth 1), `git show` по старому коммиту не работает. Постоянная проверка в CI — R-7.
- **AC-2.** `python3 -I eval/pipeline/genome/build.py --check` → exit 0.
- **AC-3.** `./taibe products check hr-helper` на Mac владельца — без fail; warn только с объяснением (до tAIBE #38
  это warn шага «доска» по SSL).
- **AC-4.** Негативы → exit 1 и строка с причиной:
  - чужая роль в `path_roles`;
  - slug `HR_Helper`;
  - ручная правка `config.json` (`render --check`);
  - поле Mac в файле продукта;
  - строка `ghp_…` в файле;
  - один и тот же лист (`team.projects_root`) в `_shared` и в продукте.
- **AC-5.** `add demo --dir <временная папка> --repo o/demo --from hr-helper --offline`, где папка — `git init`,
  `remote.origin.url` → `o/demo` и пустой `product_tree`. Итог: `list` показывает 2 продукта, отчёт `check` без
  fail (`build.py` — warn «M3»), `config.json` байт-в-байт прежний, `default_product` не изменился. `test_taibe.py`
  работает во временной копии `instances/`. На Mac после проверки `instances/demo.json` удаляется, и
  `git status --porcelain instances/` пуст: тестовые продукты в git не попадают.
- **AC-6.** `python3 -I eval/nerve/test_nerve.py` и тесты геномов зелёные; новые тесты `test_taibe.py`
  покрывают AC-4 и AC-5 без сети.
- **Откат:** revert PR; `config.json` байт-в-байт прежний (AC-1), данных M1 не переносит.

## Не входит

- Перевод читателей с `config.json` на загрузчик продуктов и удаление `config.json` — M3.
- Состояние по продуктам — M2 ([`multi-product-m2-state.md`](multi-product-m2-state.md)).
- `build.py --product` и запуск сессий по продукту — M3; синк слоя — M4.
- **`TAIBE_HOST_ROOT`** (tAIBE #39) — это `repo_root` продукта-хоста, задаётся в env сервисов. До M3 источников
  два: env и `instances/<slug>.json`. В M3 загрузчик продуктов сам выставляет env из файла продукта при запуске
  сервисов, и ручная запись env уходит.
- Продукт у пунктов очереди — M6.

## Решения владельца (04.11 18:55, `d-taibe-m1m2-0411` — «всё по рекомендации»)

- **Р1 = А:** `instances/` — в git tAIBE. Перед `add` каждого нового продукта владелец подтверждает, что его поля
  можно публиковать; нельзя — этот продукт идёт по варианту В (отдельная задача).
- **Р2:** slug собственный и неизменяемый, HR → `hr-helper`.

Варианты, из которых выбирали, — ниже, без изменений.

- **Р1. Где хранить файлы продуктов.** tAIBE — **публичный** репозиторий (HR — приватный); `config.json` и геномы
  уже в git и уже содержат пути Mac владельца, имя приватного репо HR, адреса ops-консоли и d4dev.
  - **А, выбрано** — в git tAIBE, как сейчас. M1 не публикует ничего сверх уже опубликованного, есть история и
    CI видит настоящий конфиг. Решение о приватности второго продукта — до M7: при А его файл тоже будет публичным.
    Публикацию не отозвать: файл остаётся в истории git. Поэтому перед `add` нового продукта владелец подтверждает,
    что его поля можно публиковать; если нельзя, этот продукт идёт по варианту В.
  - **Б** — локально: gitignore и пример в git. При `git pull` основного checkout снятые с учёта `config.json` и
    геномы **удалятся**, и Нерв останется без конфига до ручного `render`. CI видит только пример.
  - **В** — нейтральные поля в git, машинные и приватные — в `<slug>.local.json`. Риски Б плюс два файла на продукт.
- **Р2. slug.** **Выбрано:** собственный (формат выше), неизменяемый; HR → `hr-helper`. Отклонено: slug доски
  (меняется при переименовании и ломает `state/<slug>` из M2) и имя репо (`HR_Helper-v2`: регистр и `_`; у продукта
  может не быть своего репо).

## Связи

- Дорожная карта: [`docs/plans/roadmap/multi-product.md`](../plans/roadmap/multi-product.md), решение
  `d-0211-multi-product` (`eval/data/decisions.jsonl`).
- Следующая фаза: [`multi-product-m2-state.md`](multi-product-m2-state.md).
- Попутная находка 03.11: карточка ОШИБКИ #634 — переключатели пайплайна с доски не действуют на Mac (python3 3.14
  без CA-файла, fetch настроек падает на SSL). M1 её не чинит, но `check` (R-6, доска) покажет тот же сбой.
