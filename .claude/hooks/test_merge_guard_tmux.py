#!/usr/bin/env python3
"""
Проверка merge-guard: окна сессий в tmux (OPS-82) — агенту только чтение списков. Ввод (`send-keys`), экран
(`capture-pane`), закрытие (`kill-*`, `respawn-*`), подключение, команды в сервере (`run-shell`, `#(…)` в формате,
`-c`, `-C`, хуки, `source-file`) и новые окна мимо spawn_session.sh — отказ всем, и Контролю тоже. Сокращения и
цепочки `\\;` разбираются; чтение (`ls`, `list-windows`, `display -p '#{…}'`, `has-session`, `-V`) проходит.

Запуск: python3 -I .claude/hooks/test_merge_guard_tmux.py  (только эти проверки; все — test_merge_guard.py)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import D9, bash, finish  # noqa: E402

DENY = [
    ("ввод в окно", "tmux send-keys -t coord 'x' Enter"),
    ("ввод с сокетом", "tmux -L agents send-keys -t '=taibe:1' 'y' Enter"),
    ("сокет в связке и сокращение", "tmux -Lagents send -t x y"),
    ("путь к tmux", "/opt/homebrew/bin/tmux -L agents send-keys -t %1 y"),
    ("экран окна", "tmux -L agents capture-pane -p -t %1"),
    ("закрыть панель", "tmux -L agents kill-pane -t %3"),
    ("закрыть сервер", "tmux -L agents kill-server"),
    ("перезапуск панели", "tmux -L agents respawn-pane -k -t %1 'bash'"),
    ("подключение", "tmux -L agents attach -t '=taibe'"),
    ("tmux без команды", "tmux"),
    ("режим управления", "tmux -C -L agents"),
    ("команда оболочки", "tmux -c 'echo x'"),
    ("run-shell", "tmux -L agents run-shell 'echo x'"),
    ("хук сервера", "env TMUX= tmux -L agents set-hook -g pane-focus-in 'send-keys x'"),
    ("конфиг", "tmux -L agents source-file /tmp/x.conf"),
    ("новое окно мимо spawn_session", "tmux -L agents new-window -t '=taibe:' 'claude'"),
    ("цепочка: чтение, затем ввод", "tmux -L agents list-windows \\; send-keys -t x y"),
    ("цепочка: `;` в конце слова", "tmux -L agents list-windows\\; send-keys -t x y"),
    ("формат с командой", "tmux -L agents list-windows -F '#(echo x)'"),
    ("буфер — чужой экран", "tmux -L agents show-buffer"),
    ("вторая команда строки", "tmux -L agents ls; tmux -L agents kill-session -t taibe"),
]
ALLOW = [
    ("список окон", "tmux -L agents list-windows -a"),
    ("сокращение ls", "tmux -L agents ls"),
    ("версия", "tmux -V"),
    ("формат без команды", "tmux -L agents display-message -p '#{pid}:#{start_time}'"),
    ("панели", "tmux -L agents list-panes -a -F '#{pane_id} #{pane_tty}'"),
    ("есть ли сессия", "tmux -L agents has-session -t '=taibe'"),
    ("цепочка чтений", "tmux -L agents lsw \\; lsp"),
    ("слово tmux в тексте", "echo tmux send-keys"),
    ("grep по журналу", "grep -c send-keys /tmp/log.txt"),
]
for label, cmd in DENY:
    bash(label, cmd, True)
    bash(label + " — Контроль", cmd, True, who=D9)
for label, cmd in ALLOW:
    bash(label, cmd, False)

if __name__ == "__main__":
    finish(" — окна сессий в tmux")
