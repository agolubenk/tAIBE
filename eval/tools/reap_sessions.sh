#!/bin/bash
# Уборка закончившихся сессий Claude Code (relaunch-terminal, карточка 2). Без флагов — список (и чистка записей линий старше 30 дн.):
# pid, возраст, простой, роль, поколение, есть ли квитанция наследника, вердикт, cwd.
#   bash eval/tools/reap_sessions.sh [--idle-hours 24] [--include-waiting] [--root DIR]
#   bash eval/tools/reap_sessions.sh --kill     владелец, в своём терминале, не позже 10 мин после показа списка
#   bash eval/tools/reap_sessions.sh --auto            безопасная автоуборка, сухо: что снял бы и почему
#   bash eval/tools/reap_sessions.sh --auto --summary  сводка журнала за сутки (--since-hours N), без сырого JSONL
# Снимает (--auto --apply) только launchd владельца space.hrhelper.reaper (reaper_launchd.sh install --apply): вне
# него --apply отказывает. Подробности — eval/tools/lineage_reap.py, lineage_auto.py. Агентам --kill не запускать:
# это действие владельца; решение 06.11 — автоуборка по безопасным правилам.
set -euo pipefail
exec python3 -I "$(cd "$(dirname "$0")" && pwd)/lineage.py" reap "$@"
