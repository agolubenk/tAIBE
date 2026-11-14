# mitmproxy — локальный прокси для ручной проверки досок

> **Статус (2026-11-14):** ✅ скрипт `infra/scripts/security/mitmproxy-local.sh`, mitmproxy 12.3.1. Карточка TB-164
> (TB-24 S24-1, R-075, N-006), спека — [`../specs/phase-c-stage2.md`](../specs/phase-c-stage2.md) §4. Почему не hetty —
> [`../integrations/hetty/README.md`](../integrations/hetty/README.md), разбор инструмента —
> [`../integrations/mitmproxy/README.md`](../integrations/mitmproxy/README.md).

Для владельца и роли release: как посмотреть и повторить запросы локального стенда досок через mitmproxy. Всё идёт
только на этом Mac: прокси и веб-интерфейс слушают `127.0.0.1`, данные лежат вне git, системное хранилище сертификатов
не меняется. Прод и стенд d4dev этим не проверяются.

## 1. Установить mitmproxy (один раз)

```bash
brew install --cask mitmproxy
mitmdump --version            # Mitmproxy: 12.3.1
```

mitmproxy в Homebrew — cask, а `brew pin` действует только на формулы. Поэтому скрипт сам сверяет версию с `VERSION`
в файле и не запускается на другой. После `brew upgrade` скрипт остановится; новая версия — PR, который меняет
`VERSION`.

## 2. Поднять локальный стенд досок

Стенд — `boards/compose.local.yml` (web на 5173, API на 1337), нужен `boards/.env.local`:

```bash
cd boards && docker compose -f compose.local.yml up
```

Стенд тяжёлый для памяти. Если `~/.claude/memguard/state.json` не `ok`, стенд не поднимайте.

## 3. Запустить прокси и браузер

```bash
infra/scripts/security/mitmproxy-local.sh             # mitmweb и отдельный профиль Chrome
infra/scripts/security/mitmproxy-local.sh start --no-browser   # только mitmweb
```

- Прокси — `http://127.0.0.1:8180`, веб-интерфейс — `http://127.0.0.1:8181`. mitmweb печатает адрес интерфейса с
  `?token=…`: открывайте его по этой ссылке.
- Chrome запускается с собственным профилем (`--user-data-dir`) и открывает `http://localhost:5173` через прокси.
  `--proxy-bypass-list=<-loopback>` нужен, потому что иначе Chrome не шлёт `localhost` в прокси. Основной профиль
  Chrome не меняется.
- CA mitmproxy создаётся при первом запуске в каталоге данных. В системный keychain он не попадает: Chrome доверяет ему
  только в своём профиле, по хэшу SPKI (`--ignore-certificate-errors-spki-list`).
- Остановка — Ctrl-C в терминале скрипта. Окно Chrome закройте отдельно.

Переменные: `MITM_LOCAL_HOME` (каталог данных), `MITM_PROXY_PORT`, `MITM_WEB_PORT`, `MITM_TARGET_URL`, `MITM_CHROME`
(путь к Chrome).

## 4. Где данные и как их удалить

```bash
infra/scripts/security/mitmproxy-local.sh paths         # каталог, CA, профиль Chrome
infra/scripts/security/mitmproxy-local.sh remove-data   # удалить всё после вопроса y/N
```

По умолчанию данные в `~/.local/state/taibe-mitmproxy` (права `700`). Перехваченные запросы mitmweb держит в памяти и
сам на диск не пишет; сохранённый из интерфейса файл кладите в тот же каталог, не в репозиторий.

## 5. Проверка

```bash
lsof -nP -iTCP:8180 -iTCP:8181 -sTCP:LISTEN     # mitmweb только на 127.0.0.1
security find-certificate -a -c mitmproxy       # пусто: CA не в keychain
git status                                       # в репозитории нет данных прокси
```

Проверено 14.11.2026 на Mac (macOS 27.2, arm64): оба порта — `127.0.0.1`, `security find-certificate` пуст, запрос
через прокси проходит (`curl -x http://127.0.0.1:8180 …`).

Запуск «по кнопке» с доски — не здесь, это S23-6 (метка `review-requested` на PR).
