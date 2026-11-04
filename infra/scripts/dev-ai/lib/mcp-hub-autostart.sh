# shellcheck shell=bash
# Автозапуск хаба и serena при входе в систему. Подключается из mcp-hub.sh (source): нужны SERVE_ROOT,
# HOST_ROOT, CONFIG_DIR, LOG_DIR.
#
#   LaunchAgent (RunAtLoad) → open «HR Helper MCP Hub.app» → mcp-hub.sh start
#
# Почему через приложение: репо лежит в ~/Desktop, а macOS (TCC) не пускает туда процессы, запущенные launchd
# напрямую (`/bin/bash: …/mcp-hub.sh: Operation not permitted`, код 126). Доступ к папке «Рабочий стол» выдаётся
# одному этому приложению — macOS спросит один раз — а не /bin/bash целиком.
# Команда запуска (PATH, папка репо, журнал) зашита в само подписанное приложение, а не лежит рядом отдельным
# скриптом: скрипт в ~/.config любой процесс пользователя мог бы переписать без доступа к «Рабочему столу» и
# выполниться с доступом приложения. Скрипты репо так не подменить — они сами на «Рабочем столе». Открытым
# остаётся другое: node, python3 и uvx из Homebrew подменяются без всякого доступа и запускаются с доступом приложения.
# Цена — сменился PATH или папка репо, значит новое приложение, новая подпись, и macOS спросит доступ снова.
# Пересборку решает sha256 команды в Info.plist при целой подписи: совпал — приложение не трогаем. Там же лежит PATH,
# с которым приложение собрано: status сверяет по нему, а не по PATH своего терминала.
# launchd держит только короткий запуск. Сервисы стартуют в своей сессии (lib/proc-lifecycle.sh), поэтому
# KeepAlive нет: упавший сервис поднимает следующий start или задача VS Code при открытии папки (init).
# PATH записывается при установке. У launchd он голый (/usr/bin:/bin…): node и uvx не нашлись бы, а python3 был
# бы системным, без пакета mcp, и ai-council в хабе не стартовал бы.

AUTOSTART_LABEL="space.hrhelper.mcp-hub"
AUTOSTART_BUNDLE_ID="space.hrhelper.mcp-hub-launcher"
AUTOSTART_SHA_KEY="HRHelperAutostartSHA256"
AUTOSTART_PATH_KEY="HRHelperAutostartPATH"
AUTOSTART_LOG_MAX=1048576 # байт; больше — оставляем последние 256 КБ

autostart_plist() { echo "${MCP_HUB_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$AUTOSTART_LABEL.plist"; }
autostart_app() { echo "${MCP_HUB_AUTOSTART_APP:-$HOME/Applications/HR Helper MCP Hub.app}"; }
autostart_log() { echo "$LOG_DIR/autostart.log"; }
# До 2026-10-30 команда лежала отдельным скриптом; on и off его убирают.
autostart_legacy_runner() { echo "$CONFIG_DIR/autostart.sh"; }

# Пути попадают в XML plist и в строку AppleScript; экранировать оба формата ради редкого имени папки не стоит.
autostart_check_paths() {
  local p
  for p in "$(autostart_app)" "$(autostart_log)" "$(autostart_plist)" "$SERVE_ROOT"; do
    case "$p" in
      *[\<\>\&\"\\]*)
        echo "✗ автозапуск: в пути есть один из символов <>&\"\\ — не поддерживается: $p" >&2
        return 1
        ;;
    esac
  done
}

autostart_path() {
  local dirs="" bin dir missing=0
  for bin in python3 node uvx gh; do
    if ! dir="$(command -v "$bin" 2>/dev/null)"; then
      # Без gh хаб работает (токен GitHub тогда из Keychain); без остальных — нет.
      if [ "$bin" = gh ]; then echo "⚠ автозапуск: gh не найден в PATH" >&2; else
        echo "✗ автозапуск: $bin не найден в PATH — запустите on из терминала, где он есть" >&2
        missing=1
      fi
      continue
    fi
    dir="$(dirname "$dir")"
    case ":$dirs:" in *":$dir:"*) ;; *) dirs="${dirs:+$dirs:}$dir" ;; esac
  done
  # Системный python3 найдётся и без пакета mcp — тогда ai-council в хабе не стартует при каждом входе.
  if [ "$missing" = 0 ] && ! python3 -c 'import mcp' 2>/dev/null; then
    echo "✗ автозапуск: у $(command -v python3) нет пакета mcp — запустите on из терминала, где python3 с mcp" >&2
    missing=1
  fi
  [ "$missing" = 0 ] || return 1
  printf '%s:/usr/bin:/bin:/usr/sbin:/sbin' "$dirs"
}

# Одна строка bash: журнал обрезается на месте (тот же inode — launchd пишет в него же) и открывается до cd —
# пропавшая папка репо тоже оставит в нём строку с кодом. Затем start и его код.
autostart_command() { # <PATH>
  local log
  log="$(autostart_log)"
  printf 'export PATH=%q; ' "$1"
  # Хост продукта (TAIBE_HOST_ROOT) — в саму команду: без него вход в систему поднял бы serena на коде слоя.
  if [ "$HOST_ROOT" != "$SERVE_ROOT" ]; then printf 'export TAIBE_HOST_ROOT=%q; ' "$HOST_ROOT"; fi
  printf 'l=%q; if [ "$(stat -f%%z "$l" 2>/dev/null || echo 0)" -gt %d ]; then ' "$log" "$AUTOSTART_LOG_MAX"
  printf 'tail -c 262144 "$l" >"$l.1" && cat "$l.1" >"$l"; rm -f "$l.1"; fi; exec >>"$l" 2>&1; '
  printf 'echo "== $(date "+%%F %%T") автозапуск"; '
  printf 'cd %q || { echo "== код 1: нет папки репо — перенесли? повторите npm run mcp-hub:autostart -- on"; exit 1; }; ' \
    "$SERVE_ROOT"
  printf '/bin/bash %q start; echo "== код $?"' "$SERVE_ROOT/infra/scripts/dev-ai/mcp-hub.sh"
}

# Приложение — одна строка AppleScript: выполнить команду через /bin/bash.
autostart_source() { # <PATH>
  local src
  src="$(autostart_command "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf 'do shell script "/bin/bash -c " & quoted form of "%s"' "$src"
}

# Совпадает ли собранное приложение с командой: sha в Info.plist и целая подпись (её ломает правка любого файла внутри).
autostart_app_current() { # <sum>
  local app
  app="$(autostart_app)"
  [ -d "$app" ] &&
    [ "$(plutil -extract "$AUTOSTART_SHA_KEY" raw "$app/Contents/Info.plist" 2>/dev/null)" = "$1" ] &&
    codesign --verify --strict "$app" 2>/dev/null
}

autostart_build_app() { # <PATH>
  local app src sum tmpdir rc
  app="$(autostart_app)"
  src="$(autostart_source "$1")"
  sum="$(printf '%s' "$src" | shasum -a 256 | cut -d' ' -f1)"
  autostart_app_current "$sum" && return 0
  tmpdir="$(mktemp -d)"
  autostart_compile_app "$app" "$tmpdir" "$src" "$sum" "$1"
  rc=$?
  rm -rf "$tmpdir"
  return "$rc"
}

autostart_compile_app() { # <app> <tmpdir> <src> <sum> <PATH>
  local app="$1" tmp out
  # Имя каталога при сборке — имя приложения (CFBundleName): его macOS показывает в запросе доступа.
  tmp="$2/$(basename "$app")"
  # osacompile сам подписывает и сообщает об этом; печатаем его вывод, только если сборка упала.
  out="$(osacompile -o "$tmp" -e "$3" 2>&1)" || { echo "$out" >&2; return 1; }
  # Без значка в Dock; свой bundle id — чтобы в «Конфиденциальность → Файлы и папки» было видно, чьё это.
  plutil -replace LSUIElement -bool true "$tmp/Contents/Info.plist" || return 1
  plutil -replace CFBundleIdentifier -string "$AUTOSTART_BUNDLE_ID" "$tmp/Contents/Info.plist" || return 1
  plutil -replace "$AUTOSTART_SHA_KEY" -string "$4" "$tmp/Contents/Info.plist" || return 1
  plutil -replace "$AUTOSTART_PATH_KEY" -string "$5" "$tmp/Contents/Info.plist" || return 1
  out="$(codesign -f -s - "$tmp" 2>&1)" || { echo "✗ codesign: $out" >&2; return 1; }
  mkdir -p "$(dirname "$app")"
  if [ -d "$app" ]; then autostart_remove_app || return 1; fi
  mv "$tmp" "$app" || return 1
  echo "→ приложение запуска: $app (новое — macOS спросит доступ к «Рабочему столу», нужно разрешить)"
}

autostart_remove_app() {
  local app
  app="$(autostart_app)"
  [ -d "$app" ] || return 0
  # Удаляем только своё приложение: путь можно переопределить, и чужой каталог мы не трогаем.
  if [ "$(plutil -extract CFBundleIdentifier raw "$app/Contents/Info.plist" 2>/dev/null)" != "$AUTOSTART_BUNDLE_ID" ]; then
    echo "✗ $app — не приложение автозапуска хаба, не удаляю" >&2
    return 1
  fi
  rm -r "$app"
}

autostart_on() {
  local domain plist path
  domain="gui/$(id -u)"
  plist="$(autostart_plist)"
  autostart_check_paths || return 1
  path="$(autostart_path)" || return 1
  mkdir -p "$(dirname "$plist")" "$LOG_DIR"
  autostart_build_app "$path" || return 1
  rm -f "$(autostart_legacy_runner)"
  # open повторяется: при входе в систему LaunchServices может быть ещё не готов. Путь приложения — в $0.
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AUTOSTART_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>for i in 1 2 3 4 5 6 7 8 9 10; do /usr/bin/open -g -j "\$0" &amp;&amp; exit 0; sleep 3; done; exit 1</string>
    <string>$(autostart_app)</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$(autostart_log)</string>
  <key>StandardErrorPath</key><string>$(autostart_log)</string>
</dict>
</plist>
EOF
  plutil -lint -s "$plist" || return 1
  # Повторное включение (сменился PATH или папка репо) — выгрузить прежнюю версию.
  launchctl bootout "$domain/$AUTOSTART_LABEL" 2>/dev/null || true
  # RunAtLoad запускает start сразу: живые сервисы он не трогает, только проверяет.
  launchctl bootstrap "$domain" "$plist" || return 1
  echo "✓ автозапуск включён: $plist (журнал — $(autostart_log))"
}

autostart_off() {
  launchctl bootout "gui/$(id -u)/$AUTOSTART_LABEL" 2>/dev/null || true
  rm -f "$(autostart_plist)" "$(autostart_legacy_runner)"
  autostart_remove_app || return 1
  echo "✓ автозапуск выключен; запущенные хаб и serena продолжают работать (остановить — npm run mcp-hub:stop)"
}

autostart_status() {
  local info plist path sum
  plist="$(autostart_plist)"
  if [ ! -f "$plist" ]; then
    echo "автозапуск выключен (включить — npm run mcp-hub:autostart -- on)"
    return 0
  fi
  echo "автозапуск: $plist → $(autostart_app)"
  if info="$(launchctl print "gui/$(id -u)/$AUTOSTART_LABEL" 2>/dev/null)"; then
    printf '%s\n' "$info" | grep -E '^[[:space:]]+(runs|last exit code) = ' | sed 's/^[[:space:]]*/  /'
  else
    echo "  ✗ plist есть, но launchd его не загрузил — npm run mcp-hub:autostart -- on"
  fi
  # Сверка — по PATH, с которым приложение собрано: так видны смена папки репо, формата команды и сломанная подпись,
  # а терминал с другим PATH (без gh, например) ложной тревоги не даёт.
  path="$(plutil -extract "$AUTOSTART_PATH_KEY" raw "$(autostart_app)/Contents/Info.plist" 2>/dev/null)"
  if [ -z "$path" ]; then
    echo "  ⚠ приложения нет или его собрала старая версия скрипта — повторите on"
  else
    sum="$(autostart_source "$path" | shasum -a 256 | cut -d' ' -f1)"
    autostart_app_current "$sum" ||
      echo "  ⚠ приложение не совпадает с командой (папка репо, формат команды или подпись) — повторите on"
    (PATH="$path" && command -v node && command -v uvx && python3 -c 'import mcp') >/dev/null 2>&1 ||
      echo "  ⚠ по PATH приложения нет node, uvx или python3 с пакетом mcp — повторите on из терминала, где они есть"
  fi
  # Код самого start — в журнале («== код N»): launchd видит только open, а он завершается раньше start.
  # Показываем весь последний запуск (до 20 строк): причина падения печатается раньше кода.
  if [ -f "$(autostart_log)" ]; then
    echo "  последний запуск:"
    awk '/^== .* автозапуск$/ { b = "" } { b = b $0 "\n" } END { printf "%s", b }' "$(autostart_log)" |
      tail -n 20 | sed 's/^/    /'
  fi
}

cmd_autostart() { # <on|off|status>
  case "$1" in
    on) autostart_on ;;
    off) autostart_off ;;
    status) autostart_status ;;
    *)
      echo "usage: $0 autostart {on|off|status}" >&2
      return 2
      ;;
  esac
}
