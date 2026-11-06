#!/bin/bash
# Уборка закончившихся сессий Claude Code (relaunch-terminal, карточка 2). Без флагов — список (и чистка записей линий старше 30 дн.):
# pid, возраст, простой, роль, поколение, есть ли квитанция наследника, вердикт, cwd.
#   bash eval/tools/reap_sessions.sh [--idle-hours 24] [--include-waiting] [--root DIR]
#   bash eval/tools/reap_sessions.sh --kill     владелец, в своём терминале, не позже 10 мин после показа списка
#   bash eval/tools/reap_sessions.sh --auto     безопасная автоуборка, сухо: что снял бы и почему (+ reap-auto.jsonl)
#   bash eval/tools/reap_sessions.sh --auto --apply   то же с действием: launchd владельца (reaper_launchd.sh) или он сам
# Подробности — eval/tools/lineage_reap.py, lineage_auto.py. Агентам --kill и --apply не запускать (из сессии claude
# --apply отказывает сам): это действия владельца, решение 06.11 — автоуборка по безопасным правилам.
set -euo pipefail
exec python3 -I "$(cd "$(dirname "$0")" && pwd)/lineage.py" reap "$@"
