# M1 — продукт как сущность инстанса: `instances/<slug>.json` и команда `taibe products`

> **Статус (2026-11-03):** 🔲 спека v1 на утверждение. Развилки Р1, Р2 — владельцу через Координатора. Фаза M1
> дорожной карты [`multi-product.md`](../plans/roadmap/multi-product.md). Сверено с кодом `board-agents@25d73636`
> и Mac владельца 03.11 (роль 2, линия r.85l7.auq8.b9g3).

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
   — создаёт `instances/<slug>.json` (по образцу `--from`: роли и раскладка), прогоняет `check`, `render`.
4. `taibe products render [--check]` — собирает `eval/nerve/config.json`; `--check` только сравнивает.

## Модель

| Файл | Что в нём | Кто пишет |
|---|---|---|
| `instances/<slug>.json` | поля продукта (список выше) + `slug`, `title` | человек или `products add` |
| `instances/_shared.json` | поля Mac и аккаунта + `default_product` | человек |
| `instances/schema.json` | JSON Schema обоих видов файлов | PR |
| `eval/nerve/config.json` | **генерируется**: `_shared` ⊕ продукт по умолчанию, json-равен нынешнему | только `render` |

- **slug** — `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`, неизменяем после `add`; HR → `hr-helper` (развилка Р2).
- Поле продукта не может стоять в `_shared`, и наоборот — это проверяет схема (`additionalProperties: false`).
- `config.json` в M1 не удаляется. Причина: копия `pipeline_settings.py` в папках продуктов и пути через ссылки
  HR (`supertick-eval`, `eval`) читают именно его; перевод читателей на загрузчик — M3, удаление `config.json` — M3.

## Правила

- **R-1.** `render` детерминирован: ключи в порядке нынешнего `config.json`, отступ 2, `ensure_ascii=False`,
  перевод строки в конце. Вывод для `hr-helper` json-равен `config.json` на `25d73636`.
- **R-2.** Секретов в файлах нет — только `secret_cmd` (как сейчас в `queue`). `check` падает, если значение похоже
  на ключ: префиксы `sk-`, `ghp_`, `github_pat_`, `xox`, длинный base64.
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
    цепочке `pipeline_settings._key`);
  - `build.py --check` для этого продукта зелёный.
- **R-7.** `render --check` — шаг в `eval-ci.yml` перед `build.py --check`.
- **Сквозные инварианты:** снаружи ничего не меняется (PR, карточки, очередь, бот, Нерв, геномы); мёрж в
  `board-agents` прод не деплоит; основной checkout tAIBE получает изменения только по `git pull` владельца.
- **Стоимость:** ноль в рантайме (файлы читает только `render`), CI +1 шаг < 1 с, сеть только в `check` без
  `--offline`.

## Приёмка

- **AC-1.** `./taibe products render --check` → exit 0; `git diff --exit-code eval/nerve/config.json` после
  `render` пуст. Json-равенство с `25d73636`:
  `python3 -I -c 'import json,subprocess as s;a=json.loads(s.check_output(["git","show","25d73636:eval/nerve/config.json"]));b=json.load(open("eval/nerve/config.json"));exit(a!=b)'`.
- **AC-2.** `python3 -I eval/pipeline/genome/build.py --check` → exit 0.
- **AC-3.** `./taibe products check hr-helper` на Mac владельца — без fail; warn только с объяснением.
- **AC-4.** Негативы → exit 1 и строка с причиной:
  - чужая роль в `path_roles`;
  - slug `HR_Helper`;
  - ручная правка `config.json` (`render --check`);
  - поле Mac в файле продукта;
  - строка `ghp_…` в файле.
- **AC-5.** `add demo --dir <временная папка-git> --from hr-helper` → `list` показывает 2 продукта,
  `config.json` байт-в-байт прежний, `default_product` не изменился.
- **AC-6.** `python3 -I eval/nerve/test_nerve.py` и тесты геномов зелёные; новые тесты `test_taibe.py`
  покрывают AC-4 и AC-5 без сети.
- **Откат:** revert PR; `config.json` байт-в-байт прежний (AC-1), данных M1 не переносит.

## Не входит

- Перевод читателей с `config.json` на загрузчик продуктов и удаление `config.json` — M3.
- Состояние по продуктам — M2 ([`multi-product-m2-state.md`](multi-product-m2-state.md)).
- `build.py --product` и запуск сессий по продукту — M3; синк слоя — M4.
- Продукт у пунктов очереди — M6.

## Открытые вопросы (развилки владельцу — через Координатора r.qaly)

- **Р1. Где хранить файлы продуктов.** tAIBE — **публичный** репозиторий (HR — приватный); `config.json` и геномы
  уже в git и уже содержат пути Mac владельца, имя приватного репо HR, адреса ops-консоли и d4dev.
  - **А, рекомендую** — в git tAIBE, как сейчас. M1 не публикует ничего сверх уже опубликованного, есть история и
    CI видит настоящий конфиг. Решение о приватности второго продукта — до M7: при А его файл тоже будет публичным.
  - **Б** — локально: gitignore и пример в git. При `git pull` основного checkout снятые с учёта `config.json` и
    геномы **удалятся**, и Нерв останется без конфига до ручного `render`. CI видит только пример.
  - **В** — нейтральные поля в git, машинные и приватные — в `<slug>.local.json`. Риски Б плюс два файла на продукт.
- **Р2. slug.** **Рекомендую** собственный (формат выше), неизменяемый; HR → `hr-helper`. Отклонено: slug доски
  (меняется при переименовании и ломает `state/<slug>` из M2) и имя репо (`HR_Helper-v2`: регистр и `_`; у продукта
  может не быть своего репо).

## Связи

- Дорожная карта: [`docs/plans/roadmap/multi-product.md`](../plans/roadmap/multi-product.md), решение
  `d-0211-multi-product` (`eval/data/decisions.jsonl`).
- Следующая фаза: [`multi-product-m2-state.md`](multi-product-m2-state.md).
- Попутная находка 03.11: карточка ОШИБКИ #634 — переключатели пайплайна с доски не действуют на Mac (python3 3.14
  без CA-файла, fetch настроек падает на SSL). M1 её не чинит, но `check` (R-6, доска) покажет тот же сбой.
