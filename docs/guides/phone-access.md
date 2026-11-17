# Роли и сервисы с iPhone — SSH через WireGuard t-boards

> **Статус (2026-11-16):** сверено с `boards/deploy/vps/wg-setup.sh` (`WG_MAC_SSH_FROM`, `--rules`),
> `wg-issue.sh`, `eval/tools/tmux_host.py`, tmux 3.8, OpenSSH на macOS (`Include sshd_config.d/*` первым). Решение
> владельца 16.11: доступ — через наш WireGuard, без Tailscale (iOS держит включённым один VPN). Разбор — OPS-82,
> [`docs/integrations/agent-bridge/README.md`](../integrations/agent-bridge/README.md).

Схема: iPhone (WireGuard, `10.77.0.X`) → VPS `10.77.0.1` → Mac `10.77.0.2:22` → `tmux -L agents attach`. VPS
пропускает между устройствами туннеля только SSH к Mac и только с адресов `WG_MAC_SSH_FROM`; сам VPS к SSH Mac не
пускается. Mac пускает по SSH только из туннеля, только по ключу, а ключ телефона умеет только открыть tmux (без
проброса портов и агента). Порт 22 в интернет не открывается.

**Что даёт доступ с телефона.** Полное управление ролями: ответы на «!» (разрешения), ввод в любое окно, новое окно
tmux — это оболочка Mac с его ключами GitHub и SSH. Граница доверия — iPhone: код-пароль и Face ID на телефоне и в
Termius обязательны (§3). Только смотреть — второй ключ (§6).

Порядок: §1 VPS → §2 WireGuard на iPhone → §3 Termius → §4 Mac → §5 проверка → §6 закрыть вход по паролю.

## 1. VPS — профиль телефона и правило (с Mac)

Нужен влитый PR с `wg-setup.sh --rules`.

**1а. Отозвать старый профиль телефона** (он не подключался). Список устройств — строки `# <имя> (<режим>)`:

```bash
ssh root@hrhrm-v2.com 'grep "^# " /etc/wireguard/wg0.conf'
ssh root@hrhrm-v2.com 'bash /opt/t-boards/wg-issue.sh --revoke <имя старого профиля телефона>'
```

**1б. Новый профиль и правило — одна строка.** Копирует новый `wg-setup.sh`, выдаёт профиль `iphone` (QR — в
терминале; файл с ключом — во временный файл 0600 и сразу удаляется), вписывает адрес телефона в `WG_MAC_SSH_FROM`
(заменяет прежний список) и применяет правила:

```bash
cd ~/Desktop/Development/tAIBE && scp boards/deploy/vps/wg-setup.sh root@hrhrm-v2.com:/tmp/wg-setup.sh && ssh root@hrhrm-v2.com 'install -m 0700 /tmp/wg-setup.sh /opt/t-boards/wg-setup.sh && rm /tmp/wg-setup.sh' && f=$(mktemp) && ssh root@hrhrm-v2.com 'bash /opt/t-boards/wg-issue.sh iphone split' > "$f" && ip=$(sed -n 's|^Address = \(10\.77\.0\.[0-9]*\)/32$|\1|p' "$f") && rm -f "$f" && [ -n "$ip" ] && ssh root@hrhrm-v2.com "cd /opt/t-boards && cp -a .env .env.before-ssh-1611 && sed -i '/^WG_MAC_SSH_FROM=/d' .env && printf '\nWG_MAC_SSH_FROM=%s\n' $ip >> .env && bash wg-setup.sh --rules" && echo "АДРЕС ТЕЛЕФОНА: $ip — он нужен в §4"
```

- Последняя строка — `АДРЕС ТЕЛЕФОНА: 10.77.0.X`. Забыли — `ssh root@hrhrm-v2.com "grep -A4 '^# iphone' /etc/wireguard/wg0.conf | grep AllowedIPs"`.
- Строка оборвалась на последнем `ssh` — повторить только его (профиль уже выдан).
- `split` (рекомендуется): через VPS идёт только трафик к Mac, интернет телефона — напрямую; мало данных и батареи.
  `full` — весь трафик телефона через VPS, нужен, только если нужно скрыть IP.
- Второе устройство (iPad) — вписать оба адреса через пробел: `WG_MAC_SSH_FROM=10.77.0.X 10.77.0.Y`, затем
  `bash /opt/t-boards/wg-setup.sh --rules`.
- Откат правила: `ssh root@hrhrm-v2.com "cd /opt/t-boards && sed -i '/^WG_MAC_SSH_FROM=/d' .env && bash wg-setup.sh --rules"`.

## 2. iPhone — WireGuard

1. WireGuard → старый туннель t-boards → удалить.
2. «+» → «Создать из QR-кода» → QR из терминала Mac → имя `t-boards` → разрешить конфигурацию VPN.
3. На Mac очистить терминал от QR: `Cmd-K`.
4. Включить туннель. Работает, если в нём появилось «Последнее рукопожатие» со временем.
5. «Подключать по требованию» (сотовая и Wi-Fi) держит туннель всегда — единицы процентов батареи в сутки. Если
   мешает — включайте туннель вручную перед работой.
6. Tailscale на iPhone не нужен — удалить.

## 3. iPhone — Termius

1. App Store → Termius. В аккаунт Termius не входить и синхронизацию не включать: ключ не должен уходить в облако.
2. На iPhone включён код-пароль. Termius → Settings → Security → блокировка приложения кодом и Face ID.
3. Keychain → «+» → Generate Key → ED25519, имя `iphone`.
4. Ключ → Export / Share → скопировать **публичный** ключ (`ssh-ed25519 AAAA…`). С тем же Apple ID и включённым
   Handoff он сразу в буфере Mac.

## 4. Mac — вход для телефона

1. Системные настройки → Основные → Общий доступ → **Удалённый вход**: вкл., доступ — только ваш пользователь.
2. Ключ телефона из буфера: проверяется, что в буфере ровно один публичный ключ; ключ работает только с адреса
   телефона и только открывает tmux. **Замените `X`** на адрес из §1:

   ```bash
   ip=10.77.0.X; k="$(pbpaste)"; [ "$(printf '%s\n' "$k" | wc -l | tr -d ' ')" = 1 ] && printf '%s\n' "$k" | ssh-keygen -l -f - >/dev/null && mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf 'from="%s",restrict,pty,command="/opt/homebrew/bin/tmux -L agents attach" %s\n' "$ip" "$k" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo "ключ телефона добавлен" || echo "в буфере не один публичный ключ — скопируйте его из Termius ещё раз"
   ```

3. Mac не должен засыпать: работает только от сети, крышка открыта (или в отдельном окне терминала `caffeinate -s`).
   Системные настройки → Аккумулятор → Параметры: «Не переходить в режим сна автоматически при питании от сети, когда
   дисплей выключен» — вкл. Цена — 5–10 Вт, пока Mac не спит. От батареи и с закрытой крышкой Mac спит — с телефона он
   недоступен.
4. WireGuard на Mac включён (он уже держит доску и память; Mac в туннеле — `10.77.0.2`). Tailscale на Mac не
   запускать.

## 5. Проверка с телефона

Termius → Hosts → «+»: Label `Mac агенты`, Address `10.77.0.2`, Port `22`, Username — ваш пользователь Mac (`whoami`),
Key `iphone`. Startup snippet не нужен: ключ сам открывает tmux.

Выключить Wi-Fi, туннель t-boards включён, открыть хост. Видно: окна tmux с ролями и строка статуса внизу («!» — ждёт
разрешения, «·» — ждёт задачи). Пустой экран — `Ctrl-b`, затем `s`. Сервер tmux не запущен — соединение сразу
закрывается: на Mac `python3 -I eval/tools/agents_up.py`.

## 6. Закрыть вход по паролю (после проверки §5)

Только по ключам и только из туннеля (файл читается раньше `100-macos.conf`, первое значение побеждает; sshd на Mac
читает конфиг при каждом входе — перезапуск не нужен):

```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nPermitRootLogin no\nAllowUsers %s@10.77.0.0/24\n' "$USER" | sudo tee /etc/ssh/sshd_config.d/000-taibe.conf >/dev/null && sudo sshd -t && echo "sshd: конфиг ок"
```

Ключи без `from=` в `~/.ssh/authorized_keys` (старые, чужие) — проверить: `grep -vc '^from=' ~/.ssh/authorized_keys`
(0 — хорошо).

Только смотреть — второй ключ в Termius (`iphone-view`), та же строка из §4.2 с
`command="/opt/homebrew/bin/tmux -L agents attach -r"`. В этом режиме работают лишь переключение сессий (`Ctrl-b (`,
`Ctrl-b )`) и отключение; окна внутри сессии не листаются, размер — как на Mac.

## Клавиши tmux на телефоне

Строка над клавиатурой Termius даёт Ctrl, Esc, Tab и стрелки. Префикс — `Ctrl-b`, затем:

| Клавиша | Что |
|---|---|
| `j` | к следующему окну, которое ждёт («!» — разрешения, «·» — задачи) |
| `s` | продукты и `ops` (журналы сервисов) |
| `w` | все окна списком |
| `[` | прокрутка истории (`q` — выйти) |
| `d` | отключиться — роли работают дальше |

- Пока телефон подключён, окна на Mac узкие (tmux подгоняет их под последний активный экран); после `Ctrl-b d` и
  нажатия клавиши на Mac размер вернётся.
- Сотовая сеть сменилась — SSH может оборваться; роли в tmux живут дальше, просто откройте хост снова.

## Телефон потерян

1. VPS — отозвать профиль и закрыть SSH к Mac:
   `ssh root@hrhrm-v2.com "bash /opt/t-boards/wg-issue.sh --revoke iphone && cd /opt/t-boards && sed -i '/^WG_MAC_SSH_FROM=/d' .env && bash wg-setup.sh --rules"`
2. Mac — удалить ключи телефона: `sed -i '' '/^from="10\.77\.0\./d' ~/.ssh/authorized_keys`
3. Адрес отозванного телефона VPS может выдать следующему устройству — новый телефон добавлять заново по §1–§4.

## Если не подключается

| Симптом | Проверка |
|---|---|
| WireGuard на iPhone без рукопожатия | VPS: `ssh root@hrhrm-v2.com 'wg show wg0 latest-handshakes'`; профиль выдан заново (§1) |
| Termius: timeout | Mac спит или WireGuard на Mac выключен; правило на VPS: `ssh root@hrhrm-v2.com 'iptables -S TB-WG \| grep dport.22'` |
| Termius: connection refused | «Удалённый вход» на Mac выключен |
| Permission denied (publickey) | нет ключа телефона в `~/.ssh/authorized_keys`, в `from=` другой адрес или `AllowUsers` в `000-taibe.conf` не тот пользователь |
| Соединение сразу закрывается | на Mac нет сервера tmux: `python3 -I eval/tools/agents_up.py` |
