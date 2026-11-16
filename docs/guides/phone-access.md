# Роли и сервисы с iPhone — SSH через WireGuard t-boards

> **Статус (2026-11-16):** сверено с `boards/deploy/vps/wg-setup.sh` (`WG_MAC_SSH_FROM`, `--rules`),
> `wg-issue.sh`, `eval/tools/tmux_host.py`, tmux 3.8. Решение владельца 16.11: доступ — через наш WireGuard, без
> Tailscale (iOS держит включённым один VPN, а WireGuard t-boards на телефоне уже есть). Разбор — OPS-82,
> [`docs/integrations/agent-bridge/README.md`](../integrations/agent-bridge/README.md).

Схема: iPhone (WireGuard, `10.77.0.N`) → VPS `10.77.0.1` → Mac `10.77.0.2:22` (SSH) → `tmux -L agents attach`. VPS
пропускает между устройствами туннеля только SSH к Mac и только с адресов из `WG_MAC_SSH_FROM`. Порт 22 в интернет не
открывается.

## 1. VPS — профиль телефона и правило (с Mac, одна строка)

Нужен влитый PR с `wg-setup.sh --rules`. Строка копирует новый `wg-setup.sh`, выдаёт телефону профиль (QR — в
терминале, сам файл — в `~/Downloads`), вписывает адрес телефона в `WG_MAC_SSH_FROM` и применяет правила:

```bash
cd ~/Desktop/Development/tAIBE && scp boards/deploy/vps/wg-setup.sh root@hrhrm-v2.com:/tmp/wg-setup.sh && ssh root@hrhrm-v2.com 'install -m 0700 /tmp/wg-setup.sh /opt/t-boards/wg-setup.sh && rm /tmp/wg-setup.sh' && ssh root@hrhrm-v2.com 'bash /opt/t-boards/wg-issue.sh iphone split' > ~/Downloads/t-boards-iphone.conf && ip=$(sed -n 's|^Address = \(.*\)/32$|\1|p' ~/Downloads/t-boards-iphone.conf) && ssh root@hrhrm-v2.com "cd /opt/t-boards && cp -a .env .env.before-ssh-1611 && sed -i '/^WG_MAC_SSH_FROM=/d' .env && echo WG_MAC_SSH_FROM=$ip >> .env && bash wg-setup.sh --rules" && echo "телефон: $ip"
```

- Имя `iphone` уже занято — сначала отзыв старого профиля: `ssh root@hrhrm-v2.com 'bash /opt/t-boards/wg-issue.sh --revoke iphone'`
  (список имён — `ssh root@hrhrm-v2.com 'grep "^# " /etc/wireguard/wg0.conf'`).
- `split` — через VPS идёт только `10.77.0.0/24`, остальной интернет телефона — как раньше. `full` — весь трафик через
  VPS (как обычный VPN).
- Откат правила: `ssh root@hrhrm-v2.com "cd /opt/t-boards && sed -i '/^WG_MAC_SSH_FROM=/d' .env && bash wg-setup.sh --rules"`.

## 2. iPhone — WireGuard

1. WireGuard → старый туннель t-boards → удалить (он не подключался; новый профиль — с PresharedKey).
2. «+» → «Создать из QR-кода» → QR из терминала Mac → имя `t-boards` → разрешить конфигурацию VPN.
3. Туннель → «Изменить» → «Подключать по требованию»: сотовая сеть и Wi-Fi — VPN держится сам.
4. На Mac удалить файл профиля (в нём закрытый ключ телефона): `rm ~/Downloads/t-boards-iphone.conf`.
5. Tailscale на iPhone не нужен — можно удалить.

## 3. iPhone — Termius и ключ

1. App Store → Termius (бесплатного тарифа хватает).
2. Keychain → «+» → Generate Key → тип ED25519, имя `iphone`.
3. Ключ → Export / Share → скопировать **публичный** ключ (`ssh-ed25519 AAAA… iphone`). С тем же Apple ID и
   включённым Handoff он сразу в буфере Mac (универсальный буфер обмена).

## 4. Mac — вход по SSH только по ключу и только из туннеля

1. Ключ телефона — с ограничением «только из туннеля» (`from=`), из буфера, адрес телефона — из шага 1:

   ```bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf 'from="10.77.0.N" %s\n' "$(pbpaste)" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && tail -1 ~/.ssh/authorized_keys
   ```

2. Вход только по ключам (файл читается раньше `100-macos.conf`, первое значение побеждает):

   ```bash
   printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers %s\n' "$USER" | sudo tee /etc/ssh/sshd_config.d/000-taibe.conf && sudo sshd -t && echo "sshd: конфиг ок"
   ```

3. Системные настройки → Основные → Общий доступ → **Удалённый вход**: вкл., «Разрешить доступ» — только ваш
   пользователь.
4. Mac не должен засыпать: Системные настройки → Аккумулятор → Параметры → «Не переходить в режим сна автоматически
   при питании от сети, когда дисплей выключен» — вкл.; «Выводить из сна для доступа к сети» — «При питании от сети».
   С закрытой крышкой без внешнего монитора Mac спит — тогда он недоступен.
5. WireGuard на Mac (10.77.0.2) должен быть включён — он уже держит доску и память; Tailscale на Mac не запускать.

## 5. iPhone — подключение

Termius → Hosts → «+»:

| Поле | Значение |
|---|---|
| Label | `Mac агенты` |
| Address | `10.77.0.2` |
| Port | `22` |
| Username | ваш пользователь Mac (`whoami`) |
| Key | `iphone` |
| Startup snippet | `/opt/homebrew/bin/tmux -L agents attach` |

Проверка: выключить Wi-Fi, WireGuard вкл., подключиться — откроются роли и сервисы. Экран лучше горизонтально.

## Клавиши tmux на телефоне

Строка над клавиатурой Termius даёт Ctrl, Esc, Tab и стрелки. Префикс — `Ctrl-b`, затем:

| Клавиша | Что |
|---|---|
| `j` | к следующему окну, которое ждёт («!» — ждёт разрешения, «·» — задачи) |
| `s` | продукты и `ops` (журналы сервисов) |
| `w` | все окна списком |
| `[` | прокрутка истории (`q` — выйти) |
| `d` | отключиться — роли работают дальше |

- Ввод с телефона уходит в активное окно роли — как с клавиатуры Mac.
- tmux подгоняет окна под размер последнего активного экрана: на Mac после телефона окна вернут размер при первом
  нажатии клавиши.
- Только смотреть: `tmux -L agents attach -r`. В этом режиме работают лишь переключение сессий (`Ctrl-b (` и
  `Ctrl-b )`) и отключение; окна внутри сессии не листаются, размер — как на Mac.

## Если не подключается

| Симптом | Проверка |
|---|---|
| WireGuard на iPhone без «рукопожатия» | VPS: `ssh root@hrhrm-v2.com 'wg show wg0 latest-handshakes'`; профиль выдан заново (шаг 1) |
| Termius: timeout | Mac спит или WireGuard на Mac выключен; на VPS нет правила — `ssh root@hrhrm-v2.com 'iptables -S TB-WG \| grep dport.22'` |
| Termius: connection refused | «Удалённый вход» на Mac выключен |
| Permission denied (publickey) | в `~/.ssh/authorized_keys` нет ключа телефона или в `from=` другой адрес |
| `no server running on …/agents` | на Mac: `python3 -I eval/tools/agents_up.py` |
