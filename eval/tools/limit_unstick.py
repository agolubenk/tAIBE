"""SE-174: роль в меню лимита Claude Code после сброса — закрыть меню и продолжить работу без владельца.

После повторных отказов по лимиту Claude Code открывает меню «What do you want to do?» (`/rate-limit-options`). Пока
оно открыто, сессия не читает ни Monitor, ни тап Нерва: `limit.resume` до неё не доходит. В момент сброса демон Нерва
(`actions.poll_budget`) зовёт `unstick`. Он проходит по панелям ролей сервера `tmux -L agents` и закрывает меню.

Что в коде Claude Code (2.1.326 и 2.1.327, проверено по исходнику в бинарнике):
- порядок пунктов меню не постоянный (пункты «extra usage», «upgrade» бывают первыми) — цифру не нажимаем;
- Esc — `onCancel` меню: меню закрывается; если автопродолжение взведено и ввод пуст, в ввод кладётся `continue`;
- Esc в диалоге разрешения — отказ, не одобрение: ложное совпадение не открывает обход одобрения владельца;
- файл сессии `~/.claude/sessions/<pid>.json`: открыто меню — `status: waiting`, `waitingFor: "dialog open"`;
  диалог разрешения — `waitingFor: "permission prompt"` (так же — любой диалог без своей записи).

Условия линзы Контроля (комментарий `qn4fghzaj96l19z0woc27s92` на SE-174):
- S1: меню — нижний блок видимого экрана (`capture-pane -p` без истории): заголовок, после него только пункты и
  подсказка клавиш; плюс у единственной интерактивной сессии claude на tty панели `waitingFor` = «dialog open».
- S2: одна клавиша (Esc) по совпадению. Потом снова экран и статус: меню нет, сессия не ждёт диалога, внизу строка
  ввода. В ней `continue` — Enter; пусто — текст TEXT и Enter; что-то другое — больше ничего.
- S3: вводится только константа (PREFILL от самого Claude Code или TEXT), `send-keys -l`; с экрана — ничего.
- S4: триггер — сброс в самом демоне (ключ `limit:resume:<сброс>`), не событие журнала; не больше одного Esc на
  панель за сброс — `fresh(line)` у вызывающего (ключ журнала `limit:unstick:<сброс>:<линия>`).
- S5: только панели из записей линий `~/.claude/lineage/*.json` (`terminal: tmux`), у которых панель, tty, pid
  пусковой оболочки и сервер те же, что при открытии (как `tmux_host.close_pane`). Окна владельца записей не имеют.
- S6: CLI нет; зовёт только демон Нерва. Журнал — sha256 совпавших строк, не текст экрана (N1).

SE-187 (дизайн — комментарий на карточке 19.11 15:12): ответ — каждая панель ролей с путём (`pane_current_path`, по
нему Нерв выбирает журнал продукта) и исходом; у панели без меню — почему клавиш нет (итог на подъём). D: сессия
`idle` после отказа по лимиту (меню закрыл владелец, ввод пуст) — TEXT и Enter, без Esc. Признак «стоит из-за лимита»
даёт код Нерва (`stuck`, транскрипт читает он); здесь — только статус, экран и клавиши.
"""
import hashlib
import json
import re
import time

import lineage as L
import tmux_host as T

TITLE = "What do you want to do?"
STOP_RE = re.compile(r"\d+\.\s+Stop(?: and wait for limit to reset)?")
WAIT_RE = re.compile(r"\d+\.\s+(?:Wait here, then continue automatically\b.*|Don.t continue automatically)")
OPTION_RE = re.compile(r"\d+\.\s+\S.*")
GUIDE_RE = re.compile(r".*\b(?:Esc|Enter)\b.*\b(?:cancel|confirm|select)\b.*", re.I)
PROMPT_RE = re.compile(r"[>❯](?:\s(?P<draft>.*))?")
FRAME = "│┃╭╮╰╯─━┌┐└┘❯› \t"
RULE = set("─━-╭╮╰╯┌┐└┘")
NAMED_RULE_RE = re.compile(r"[─━]{8,}\s+[^─━│┃\s][^─━│┃]{0,63}?\s+[─━]{1,8}")  # «──── taibe-plan-czc6 ─» (живой снимок)
MENU_MAX = 12        # строк в блоке меню после заголовка — больше не бывает
INPUT_ZONE = 8       # строка ввода — среди последних непустых строк (под ней линия и 1–3 строки статуса)
PREFILL = "continue"
TEXT = "лимит снят: продолжай с work_state"
SETTLE = 1.5         # с: экран после клавиши
NO_MATCH = "no keys: status menu, screen differs"
NO_SCREEN = "no keys: status menu, no screen"
IDLE = "idle after limit: "  # D (SE-187): начало действия у сессии idle после отказа по лимиту


def tidy(line):
    return line.strip(FRAME)


def bottom(screen):
    return [ln.rstrip() for ln in screen.splitlines() if ln.strip()]


def menu_lines(screen):
    """Строки меню, если оно — нижний блок экрана (S1), иначе None."""
    lines = bottom(screen)
    heads = [i for i, ln in enumerate(lines) if tidy(ln) == TITLE]
    if not heads:
        return None
    # Линии (и с именем сессии внизу) и пустые строки рамки — не строки меню. Строка ввода «❯» остаётся и не проходит.
    block = [tidy(ln) for ln in lines[heads[-1] + 1:] if not rule(ln) and ln.strip("│┃ \t")]
    if not block or len(block) > MENU_MAX:
        return None
    if not all(OPTION_RE.fullmatch(x) or GUIDE_RE.fullmatch(x) for x in block):
        return None
    if not any(STOP_RE.fullmatch(x) for x in block) or not any(WAIT_RE.fullmatch(x) for x in block):
        return None
    return lines[heads[-1]:]


def rule(line):
    """Линия рамки: только знаки линии или линия с именем сессии внутри (живой снимок 18.11)."""
    s = line.strip()
    return len(s) >= 8 and set(s) <= RULE or bool(NAMED_RULE_RE.fullmatch(s))


def draft(screen):
    """Текст строки ввода Claude Code внизу экрана: '' — пусто, None — строки ввода не видно. Строка ввода —
    «> текст» или «❯ текст» сразу под линией или верхом рамки."""
    lines = bottom(screen)[-INPUT_ZONE:]
    for i in range(len(lines) - 1, 0, -1):
        m = PROMPT_RE.fullmatch(lines[i].strip("│┃ \t"))
        if m and rule(lines[i - 1]):
            return (m.group("draft") or "").strip()
    return None


def role_panes():
    """[(линия, роль, панель, tty, путь)] панелей ролей этого сервера: запись линии и живая панель совпали (S5). Путь —
    `pane_current_path` (метаданные `list-panes`, не экран; в пути бывают пробелы — он последний)."""
    r = T.tmux("list-panes", "-a", "-F", "#{pane_id} #{pane_tty} #{pane_pid} #{pane_current_path}")
    rows = {p[0]: p[1:] for p in (ln.split(None, 3) for ln in r.stdout.splitlines()) if len(p) >= 3}
    server = T.server_info()
    out = []
    for path in sorted(L.ldir().glob("*.json")):
        rec = L.read_json(path)
        if not isinstance(rec, dict) or rec.get("terminal") != "tmux" or not L.valid_line(rec.get("line")):
            continue
        pane = str(rec.get("pane") or "")
        want = [str(rec.get("tty") or ""), str(rec.get("pane_pid") or "")]
        if server and pane in rows and rows[pane][:2] == want and rec.get("server") == server:
            out.append((rec["line"], rec.get("role") or "", pane, want[0], (rows[pane][2:] or [""])[0]))
    return out


def sessions_on(sx, tty, procs=None):
    """Файлы сессий интерактивных claude на tty (дочерние `claude -p` той же панели не в счёт)."""
    out = []
    for p in (procs or sx.procs()).values():
        if L.argv0(p) == "claude" and "/dev/" + p.tty == tty:
            d = L.read_json(L.sessions_dir() / f"{p.pid}.json")
            if isinstance(d, dict) and d.get("kind", "interactive") == "interactive":
                out.append(d)
    return out


def in_menu(sessions):
    return len(sessions) == 1 and sessions[0].get("status") == "waiting" and \
        sessions[0].get("waitingFor") == "dialog open"


def idle_cli(sessions):
    """D1: на tty одна сессия claude из терминала (`entrypoint` cli, не SDK), и она ждёт ввода."""
    return len(sessions) == 1 and sessions[0].get("status") == "idle" and \
        sessions[0].get("entrypoint", "cli") == "cli"


def status_of(sessions):
    """Почему у панели нет меню — для итога подъёма (SE-187 C)."""
    if len(sessions) != 1:
        return f"{len(sessions)} claude sessions" if sessions else "no claude session"
    s = sessions[0]
    return f"status {s.get('status') or '?'}" + (f" ({s['waitingFor']})" if s.get("waitingFor") else "")


def screen(pane):
    r = T.tmux("capture-pane", "-p", "-t", pane)
    return r.stdout if r.returncode == 0 else None


def keys(pane, *args):
    return T.tmux("send-keys", "-t", pane, *args).returncode == 0


def digest(lines):
    return hashlib.sha256(json.dumps(lines, ensure_ascii=False).encode("utf-8")).hexdigest()


def unstick_pane(sx, pane, tty, sleep, procs=None, stuck=None):
    """Одна панель: (действие, sha256) или None — по статусу меню нет, клавиш не было. sha256 — строк меню; если
    статус — меню, а экран не совпал или не снят, — нижнего блока экрана (или ''), и клавиш нет. stuck(сессия) — D:
    сессия idle стоит из-за лимита этого подъёма (код Нерва); тогда — wake_idle."""
    sessions = sessions_on(sx, tty, procs)
    if not in_menu(sessions):
        return wake_idle(pane, sleep) if stuck and idle_cli(sessions) and stuck(sessions[0]) else None
    before = screen(pane)
    if before is None:
        return NO_SCREEN, ""
    menu = menu_lines(before)
    if menu is None:  # живая раскладка не та, что в тестах: приёмка отличит это от «меню не было»
        return NO_MATCH, digest(bottom(before)[-MENU_MAX:])
    sha = digest(menu)
    if not keys(pane, "Escape"):
        return "esc failed", sha
    sleep(SETTLE)
    after = screen(pane)
    if after is None or menu_lines(after) is not None:
        return "esc; menu stayed", sha
    if any(s.get("status") == "waiting" for s in sessions_on(sx, tty, procs)):
        return "esc; another dialog", sha
    text = draft(after)
    if text == PREFILL:
        return ("esc, enter" if keys(pane, "Enter") else "esc; enter failed"), sha
    if text == "":
        if not keys(pane, "-l", TEXT):
            return "esc; text failed", sha
        sleep(SETTLE / 3)
        return ("esc, text, enter" if keys(pane, "Enter") else "esc, text; enter failed"), sha
    return "esc; input not empty" if text else "esc; no input line", sha


def wake_idle(pane, sleep):
    """D (SE-187): меню закрыто, сессия ждёт ввода. Клавиши — только TEXT и Enter, если на экране нет меню лимита и
    строка ввода пуста (D3). Esc нет: вне меню он ничего не закрывает, а в чужом диалоге — отказ."""
    shown = screen(pane)
    if shown is None:
        return IDLE + "no keys, no screen", ""
    if menu_lines(shown) is not None:  # статус не меню, а меню на экране — не наш случай
        return IDLE + "no keys, menu on screen", digest(menu_lines(shown))
    text = draft(shown)
    if text != "":
        return IDLE + ("no keys, input not empty" if text else "no keys, no input line"), ""
    if not keys(pane, "-l", TEXT):
        return IDLE + "text failed", ""
    sleep(SETTLE / 3)
    return IDLE + ("text, enter" if keys(pane, "Enter") else "text; enter failed"), ""


def unstick(fresh, sx=None, sleep=time.sleep, stuck=None):
    """Все панели ролей этого сервера. fresh(линия) — ключа этой линии за подъём ещё нет (S4); stuck — для D.
    [{line, role, pane, path, kind, action, sha256}] — каждая свежая панель. kind: "menu" — статус меню (клавиши или
    строка без клавиш), "idle" — D, None — клавиш нет, action — почему (только в итог подъёма, ключ линии не тратит)."""
    sx = sx or L.Sys()
    out = []
    panes = [p for p in role_panes() if fresh(p[0])]
    procs = sx.procs() if panes else None  # один `ps -A` на подъём
    for line, role, pane, tty, path in panes:
        kind = "menu"
        try:
            got = unstick_pane(sx, pane, tty, sleep, procs, stuck)
            if got is None:
                kind, got = None, ("no keys: " + status_of(sessions_on(sx, tty, procs)), "")
            elif got[0].startswith(IDLE):
                kind = "idle"
        except Exception as e:  # noqa: BLE001 — клавиши прошлых панелей уже нажаты: их строки и ключи не теряются
            got = (f"error: {type(e).__name__}", "")
        out.append({"line": line, "role": role, "pane": pane, "path": path, "kind": kind, "action": got[0],
                    "sha256": got[1]})
    return out
