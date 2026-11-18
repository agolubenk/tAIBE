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
MENU_MAX = 12        # строк в блоке меню после заголовка — больше не бывает
INPUT_ZONE = 6       # строка ввода — среди последних непустых строк
PREFILL = "continue"
TEXT = "лимит снят: продолжай с work_state"
SETTLE = 1.5         # с: экран после клавиши


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
    block = [x for x in (tidy(ln) for ln in lines[heads[-1] + 1:]) if x]  # рамка окна меню — пустая после tidy
    if not block or len(block) > MENU_MAX:
        return None
    if not all(OPTION_RE.fullmatch(x) or GUIDE_RE.fullmatch(x) for x in block):
        return None
    if not any(STOP_RE.fullmatch(x) for x in block) or not any(WAIT_RE.fullmatch(x) for x in block):
        return None
    return lines[heads[-1]:]


def rule(line):
    s = line.strip()
    return len(s) >= 8 and set(s) <= RULE


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
    """[(линия, роль, панель, tty)] панелей ролей этого сервера: запись линии и живая панель совпали (S5)."""
    r = T.tmux("list-panes", "-a", "-F", "#{pane_id} #{pane_tty} #{pane_pid}")
    rows = {p[0]: p[1:] for p in (ln.split() for ln in r.stdout.splitlines()) if len(p) == 3}
    server = T.server_info()
    out = []
    for path in sorted(L.ldir().glob("*.json")):
        rec = L.read_json(path)
        if not isinstance(rec, dict) or rec.get("terminal") != "tmux" or not L.valid_line(rec.get("line")):
            continue
        pane = str(rec.get("pane") or "")
        want = [str(rec.get("tty") or ""), str(rec.get("pane_pid") or "")]
        if server and pane in rows and rows[pane] == want and rec.get("server") == server:
            out.append((rec["line"], rec.get("role") or "", pane, want[0]))
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


def screen(pane):
    r = T.tmux("capture-pane", "-p", "-t", pane)
    return r.stdout if r.returncode == 0 else None


def keys(pane, *args):
    return T.tmux("send-keys", "-t", pane, *args).returncode == 0


def digest(lines):
    return hashlib.sha256(json.dumps(lines, ensure_ascii=False).encode("utf-8")).hexdigest()


def unstick_pane(sx, pane, tty, sleep):
    """Одна панель: (действие, sha256 строк меню) или None — меню нет, клавиш не было."""
    before = screen(pane)
    menu = menu_lines(before) if before is not None else None
    if menu is None or not in_menu(sessions_on(sx, tty)):
        return None
    sha = digest(menu)
    if not keys(pane, "Escape"):
        return "esc failed", sha
    sleep(SETTLE)
    after = screen(pane)
    if after is None or menu_lines(after) is not None:
        return "esc; menu stayed", sha
    if any(s.get("status") == "waiting" for s in sessions_on(sx, tty)):
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


def unstick(fresh, sx=None, sleep=time.sleep):
    """Все панели ролей с меню лимита. fresh(линия) — Esc этой линии за сброс ещё не было (S4).
    [{line, role, pane, action, sha256}] — только панели, где была клавиша."""
    sx = sx or L.Sys()
    done = []
    for line, role, pane, tty in role_panes():
        if not fresh(line):
            continue
        got = unstick_pane(sx, pane, tty, sleep)
        if got:
            done.append({"line": line, "role": role, "pane": pane, "action": got[0], "sha256": got[1]})
    return done
