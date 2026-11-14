# docs/guides/ — описания и инструкции

Как устроено и как сделать: пошаговые инструкции и описания для людей и агентов. Одна тема — один файл;
у инструкции — баннер `> **Статус (YYYY-MM-DD):**` с датой сверки. Инструкции, которые живут рядом с кодом, здесь
не копируются — только ссылка.

| Тема | Где |
|---|---|
| Развернуть слой над host-проектом | [`process/README.md`](../../process/README.md) |
| Откуда что перенесено, что инстанс-зависимо | [`process/TRANSFER.md`](../../process/TRANSFER.md) |
| Параллельная работа в git worktrees | [`worktrees/README.md`](../../worktrees/README.md) |
| Команды ИИ-контура (хаб, шлюз, консилиум, модели) | [`infra/scripts/README.md`](../../infra/scripts/README.md) |
| Запуск досок локально и на VPS | [`boards/README.md`](../../boards/README.md), [`boards/deploy/vps/README.md`](../../boards/deploy/vps/README.md) |
| Нерв: установка, команды, откат | [`eval/nerve/README.md`](../../eval/nerve/README.md) |
| Переезд очереди владельца | [`docs/ops/owner-queue-cutover.md`](../ops/owner-queue-cutover.md) |
| Запуск команды ролей Т3 | `eval/tools/spawn_session.sh` выбирает промпты по продукту (`:115-119`, OPS-25 Ф3): продукт по умолчанию (HR) — [`eval/prompts/launch-3010/README.md`](../../eval/prompts/launch-3010/README.md), tAIBE — `eval/prompts/taibe/` ([`COMMON.md`](../../eval/prompts/taibe/COMMON.md), `roles/`) |
