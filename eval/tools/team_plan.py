#!/usr/bin/env python3
"""Команда ролей по продуктам: сколько ролей какого продукта держать открытыми и открыть недостающие (OPS-82,
решение владельца 17.11).

Всего ролей — system.team.total (12), по умолчанию поровну (system.team.split, 6+6). Доли продуктов владелец меняет
в очереди: ответ на пункт system.team.split_item (d-team-split, вариант «8-4» — по порядку продуктов в instances/;
другая доля — «7-5» в заметке к ответу), не меньше system.team.min_per_product (2) на продукт. Свободно памяти
< system.mem_warn — потолок system.team.floor (10); обратно к total — только от mem_warn + RAISE_GAP (запас, чтобы
потолок не скакал). Свободно < mem_critical — новые роли не открываются. Потолок не даёт открыть роль — уведомление
на Mac и пункт в очереди; вернулся — тоже.
Роли продукта по приоритету: coord, release, backend, frontend, plan, boards, backend-2, frontend-2; продукты —
вперемешку по рангу роли, чтобы при потолке у каждого остались главные роли. Открывает spawn_session.sh --launch,
по одной, с паузой; роль, чья сессия не поднялась, — снова через 10, 20, 40 мин… (не чаще раза в 6 ч), после
трёх неудач — пункт владельцу. Не открывает: пока Нерв стоит на лимите аккаунта, пока молчит хаб MCP (:3050),
пока владелец поставил паузу — на Mac (team_plan.py pause) или в очереди (ответ «pause» на тот же пункт: кнопка «Роли»
в шапке /queue). Уменьшение доли не закрывает работающие роли, и они считаются в потолок. Каждый запуск отмечает
состояние команды в консоли очереди (PUT /team: доли, раскладка, пауза, открыто из нужного, память) — его показывает
кнопка «Роли» в шапке /queue. Не документом очереди: отметка раз в 10 мин меняла бы ETag списка задач у всех открытых
страниц; и не в checks: статус агента в пункте будит владельца ботом.

  python3 -I eval/tools/team_plan.py plan      что должно быть открыто и что открыто (ничего не запускает)
  python3 -I eval/tools/team_plan.py up [N]    открыть недостающие роли (не больше N за запуск; «ВКЛ», вход, сторож)
  python3 -I eval/tools/team_plan.py pause     сторож и «ВКЛ» не открывают роли (resume — снова открывают)
"""
import fcntl
import http.client
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(TOOLS.parent / "nerve"))
import products as P  # noqa: E402
import queue_focus as Q  # noqa: E402
import team_status as TS  # noqa: E402
import tmux_host as T  # noqa: E402

ORDER = ("coord", "release", "backend", "frontend", "plan", "boards", "backend-2", "frontend-2")
DEFAULTS = {"total": 12, "floor": 10, "min_per_product": 2, "split_item": "d-team-split"}
SOURCE = "team_plan (сторож команды ролей на Mac, OPS-82)"
PAUSE_CHOICE = "pause"  # ответ на пункт долей: кнопка «Пауза» в шапке /queue
STATE_API = "/team"     # PUT /api/oq/v1/team: настройка консоли, не документ очереди (infra/ops-console/server/queue/team.ts)
RAISE_GAP = 8        # п.п. памяти сверх mem_warn, чтобы вернуть полный состав
PAUSE_AFTER = 15     # с между ролями: MCP и первый ход предыдущей успевают взять память
RETRY = 600          # с до повтора роли, чья сессия не поднялась; дальше — вдвое, до RETRY_MAX
RETRY_MAX = 6 * 3600
FAILS_NOTICE = 3
ERRORS = (OSError, ValueError, TypeError, KeyError, SystemExit, subprocess.SubprocessError, http.client.HTTPException)


def config():
    """(team, mem_warn, mem_critical, max_sessions, {slug: [роли по приоритету]}, {slug: repo_root})."""
    shared, prods = P.load()
    system = shared.get("system") or {}
    team = {**DEFAULTS, **(system.get("team") or {})}
    active = {s: p for s, p in prods.items() if p.get("active") and p.get("repo_root")}
    roles = {s: [r for r in ORDER if r in ((p.get("team") or {}).get("roles") or ())] for s, p in active.items()}
    return (team, int(system.get("mem_warn", 20)), int(system.get("mem_critical", 10)),
            int(system.get("max_sessions", 14)), roles, {s: p["repo_root"] for s, p in active.items()})


def parse_split(choice, slugs, total, least):
    """«8-4» или [8, 4] → {slug: 8, ...} по порядку slugs; сумма total, каждый не меньше least; иначе None."""
    try:
        nums = [int(x) for x in (choice if isinstance(choice, list) else str(choice).split("-"))]
    except (TypeError, ValueError):
        return None
    if len(nums) != len(slugs) or sum(nums) != total or min(nums) < least:
        return None
    return dict(zip(slugs, nums))


def cache_path():
    return T.conf_dir() / "team-split.json"


def read_answer(team, log=lambda m: None):
    """Ответ владельца на пункт долей; пауза в нём — файл queue_pause_path(). Ответа не видно (404: пункт перенесли в
    продукт, которого токен не видит, или удалили) — пауза как была: иначе она снялась бы сама."""
    doc = Q.oq_request(f"checks/{team['split_item']}")
    if doc is None:
        log(f"  ответ на {team['split_item']} не виден (404) — доли и пауза из последнего ответа")
        return {}
    data = doc.get("data") or {}
    # Пауза — тот же ответ: доли при ней — последний принятый ответ (кэш), снять — выбрать долю.
    if data.get("choice") == PAUSE_CHOICE:
        T.write_private(queue_pause_path(), str(data.get("at") or ""))
    else:
        queue_pause_path().unlink(missing_ok=True)
    return data


def paused_now(team, log):
    """Пауза перед каждой ролью: проход при входе открывает 12 ролей до получаса, пауза владельца — сразу, не в конце."""
    if pause_path().exists():
        return True
    try:
        read_answer(team, log)
    except ERRORS:
        pass  # очередь молчит — пауза как в последнем ответе
    return queue_pause_path().exists()


def owner_split(team, slugs, log=lambda m: None):
    """Доли из ответа владельца в очереди; очередь недоступна — последний принятый ответ; его нет — конфиг."""
    total, least = int(team["total"]), int(team["min_per_product"])
    base = parse_split([int((team.get("split") or {}).get(s, 0)) for s in slugs], slugs, total, least) or dict(
        zip(slugs, [total // len(slugs) + (i < total % len(slugs)) for i in range(len(slugs))]))
    try:
        data = read_answer(team, log)
        # В пункте до 5 вариантов; другая доля («7-5») — в заметке к ответу, она важнее выбранного варианта.
        noted = re.search(r"\b(\d{1,2}(?:-\d{1,2})+)\b", str(data.get("note") or ""))
        got = (noted and parse_split(noted.group(1), slugs, total, least)) or parse_split(data.get("choice"), slugs,
                                                                                         total, least)
        if got:
            T.write_private(cache_path(), json.dumps([got[s] for s in slugs]))
            return got, "очередь"
    except ERRORS as exc:
        log(f"  очередь не ответила ({exc.__class__.__name__}) — доли из последнего ответа")
    try:
        got = parse_split(json.loads(cache_path().read_text(encoding="utf-8")), slugs, total, least)
        if got:
            return got, "последний ответ"
    except ERRORS:
        pass
    return base, "конфиг"


def allocate(split, roles):
    """Доля продукта не больше числа его ролей; остаток — продуктам, у которых роли ещё есть."""
    alloc = {s: min(n, len(roles[s])) for s, n in split.items()}
    left = sum(split.values()) - sum(alloc.values())
    for s in split:
        add = min(left, len(roles[s]) - alloc[s])
        alloc[s] += add
        left -= add
    return alloc


def plan(alloc, roles):
    """[(продукт, роль)] вперемешку по рангу: при потолке у каждого продукта остаются главные роли."""
    out = []
    for i in range(max(alloc.values() or [0])):
        out += [(s, roles[s][i]) for s in alloc if i < alloc[s]]
    return out


def live_set(roots, log=lambda m: None):
    """{(продукт, роль)} живых ролей — один проход по сессиям на продукт; сбой — продукт в ответе None (не открывать)."""
    sx, out, bad = TS.Sys(), set(), set()
    for s, root in roots.items():
        try:
            out |= {(s, r) for r in TS.live_roles(TS.role_rows(sx, root, s))}
        except ERRORS as exc:
            bad.add(s)
            log(f"  {s}: живые роли не прочитаны ({exc.__class__.__name__}) — роли продукта не открываю")
    return out, bad


def nerve_limit(slugs):
    """Действующий лимит аккаунта из состояния Нерва (общее и каждого продукта); прошедший resume не в счёт."""
    base = Path(os.environ.get("NERVE_STATE_DIR") or TOOLS.parent / "nerve" / "state")
    now = datetime.now().astimezone()
    for f in [base / "state.json", *(base / "products" / s / "state.json" for s in slugs)]:
        try:
            lim = (json.loads(f.read_text(encoding="utf-8")).get("budget") or {}).get("limit")
            when = datetime.fromisoformat(str(lim.get("resume") or lim.get("reset")))
        except (OSError, ValueError, AttributeError, TypeError):
            continue
        if when.tzinfo is None:
            when = when.astimezone()
        if when > now:
            return lim
    return None


def hub_up():
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", 3050)) == 0


def spawn(slug, role, log):
    """Открыть роль; True — сессия поднялась (только это считается)."""
    try:
        r = subprocess.run(["bash", str(TOOLS / "spawn_session.sh"), "--launch", "--product", slug, "--role", role],
                           capture_output=True, text=True, env={**os.environ, "SPAWN_GATE": "off"}, timeout=600)
    except subprocess.SubprocessError as exc:
        log(f"  {slug}/{role}: запуск не ответил ({exc.__class__.__name__})")
        return False
    line = next((ln.strip() for ln in r.stdout.splitlines() if ln.strip().startswith(f"{role} —")),
                r.stderr.strip()[-200:])
    log(f"  {slug}/{role}: {line}")
    return "поднята" in line


def owner_note(kind, title, body, log):
    """Уведомление на Mac и пункт в очереди (id со случайным хвостом: заранее занять его нельзя)."""
    try:
        subprocess.run(["osascript", "-e", "on run argv", "-e",
                        "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
                        "Команда ролей", title], capture_output=True, timeout=15)
    except ERRORS:
        pass
    try:
        Q.oq_request(f"items/c-team-{kind}-{time.strftime('%Y%m%d')}-{secrets.token_hex(2)}", method="PUT",
                     data={"data": {"kind": "check", "title": title[:200], "added": time.strftime("%Y-%m-%d"),
                                    "source": SOURCE, "body": body + "\n\nЭто уведомление — отметьте прочитанным."}})
    except ERRORS as exc:
        log(f"  пункт в очередь не записан ({exc.__class__.__name__})")
    log(f"  уведомление: {title}")


def state_path():
    return T.conf_dir() / "team-state.json"


def pause_path():
    return T.conf_dir() / "team-pause"


def queue_pause_path():
    """Последний прочитанный ответ владельца — пауза (очередь недоступна — действует он)."""
    return T.conf_dir() / "team-pause-queue"


def hhmm(when):
    try:
        return datetime.fromisoformat(str(when)).astimezone().strftime("%H:%M")
    except ValueError:
        return str(when)


def holdup(slugs):
    """Почему роли сейчас не открывать: (пауза mac|queue|'', текст владельцу, текст журнала); всё пусто — можно."""
    if pause_path().exists():
        return "mac", "пауза включена на самом Mac — снять можно только там", \
            "пауза владельца на Mac (team_plan.py resume — снять)"
    if queue_pause_path().exists():
        return "queue", "включена пауза — чтобы снять, выберите долю в «Роли»", \
            "пауза владельца в очереди (снять — доля в шапке /queue)"
    lim = nerve_limit(slugs)
    if lim:
        when = lim.get("resume") or lim.get("reset")
        return "", f"лимит Claude исчерпан до {hhmm(when)}", f"Нерв стоит на лимите аккаунта до {when}"
    if not hub_up():
        return "", "не работает служба инструментов агентов (хаб MCP)", \
            "хаб MCP (:3050) молчит — роли без него работают вслепую"
    return "", "", ""


def publish(st, team, log):
    """Состояние команды для кнопки «Роли» в шапке /queue — каждый запуск; время отметки ставит консоль."""
    doc = {"item": team["split_item"], "total": int(team["total"]),
           **{k: st.get(k) for k in ("split", "alloc", "max", "src", "want", "live", "extra", "cap", "pause", "hold")}}
    mem = st.get("mem")
    doc["mem"] = round(mem, 1) if isinstance(mem, (int, float)) else None
    doc = {k: v for k, v in doc.items() if v is not None or k in ("want", "live", "extra", "cap", "mem")}
    try:
        Q.oq_request(STATE_API, method="PUT", data=doc)
    except ERRORS as exc:
        log(f"  состояние для /queue не записано ({exc.__class__.__name__})")


def load_state():
    try:
        st = json.loads(state_path().read_text(encoding="utf-8"))
        return st if isinstance(st, dict) else {}
    except ERRORS:
        return {}


def ceiling(free, prev, warn, team):
    """Потолок с запасом: вниз — ниже mem_warn, вверх — только от mem_warn + RAISE_GAP. Памяти не знаем — floor."""
    total, floor = int(team["total"]), int(team["floor"])
    if free is None or free < warn:
        return floor
    return total if prev == total or free >= warn + RAISE_GAP else floor


def up(limit=None, log=print):
    T.conf_dir().mkdir(parents=True, exist_ok=True)
    os.chmod(T.conf_dir(), 0o700)
    with open(T.conf_dir() / "team.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("команда: роли уже открывает другой запуск (сторож или «ВКЛ») — они появятся в окне tmux")
            return 0
        st = load_state()
        try:
            return _up(st, limit, log)
        finally:
            T.write_private(state_path(), json.dumps(st, ensure_ascii=False))


def _up(st, limit, log):
    team, warn, crit, _, roles, roots = config()
    try:
        return _run(st, limit, log, team, warn, crit, roles, roots)
    except ERRORS:
        # Без этого в очередь ушло бы прошлое состояние с новым временем — «на Mac всё хорошо».
        st.update(want=None, live=None, extra=None, pause="", hold="сбой сторожа Mac — подробности в taibe-team.log")
        raise
    finally:
        publish(st, team, log)


def _run(st, limit, log, team, warn, crit, roles, roots):
    split, src = owner_split(team, list(roles), log)
    alloc = allocate(split, roles)
    steps = plan(alloc, roles)
    live, bad = live_set(roots, log)
    total = int(team["total"])
    pause, hold, why = holdup(list(roles))
    # alloc — что Mac держит на деле: доля больше числа ролей продукта отдаёт остаток другому (10-2 при 8 ролях — 8-4).
    st.update(split=[[s, n] for s, n in split.items()], alloc=[[s, n] for s, n in alloc.items()],
              max=[[s, len(r)] for s, r in roles.items()], src=src, want=len(steps), pause=pause, hold=hold,
              live=len([x for x in steps if x in live]), extra=len(live - set(steps)), mem=TS.Sys().mem_free())
    publish(st, team, log)  # до открытия ролей: проход при входе идёт до получаса — страница видит его сразу
    if why:
        log(f"команда: {why} — роли не открываю")
        return 0
    cap = ceiling(st["mem"], st.get("cap", total), warn, team)
    log("команда: " + " · ".join(f"{s} {n}" for s, n in split.items()) + f" ({src}), открыто "
        f"{len([x for x in steps if x in live])}, потолок {cap}")
    tries, now, blocked = st.setdefault("roles", {}), time.time(), []
    opened = 0
    for s, r in steps:
        key = f"{s}/{r}"
        if (s, r) in live or s in bad:
            tries.pop(key, None) if (s, r) in live else None
            continue
        free = TS.Sys().mem_free()
        cap = min(cap, ceiling(free, cap, warn, team))  # за запуск потолок только опускается
        if len(live) >= cap:  # и роли сверх доли: после смены доли они работают, всего — не больше потолка
            blocked.append(key)
            continue
        # Свои границы команды — потолок ролей и память; max_sessions — пропуск ручных запусков: в нём и сессии
        # владельца, и фоновые claude (17.11 четыре такие сессии оборвали команду на 9 ролях из 12).
        if (free is not None and free < crit) or (limit and opened >= limit):
            break
        t = tries.get(key) or {}
        if t.get("next", 0) > now:
            continue
        if opened and paused_now(team, log):
            st.update(pause="mac" if pause_path().exists() else "queue", hold=holdup(list(roles))[1])
            log("команда: пауза владельца — остальные роли не открываю")
            break
        if spawn(s, r, log):
            live.add((s, r))
            tries.pop(key, None)
        else:
            fails = int(t.get("fails", 0)) + 1
            tries[key] = {"fails": fails, "next": now + min(RETRY * 2 ** (fails - 1), RETRY_MAX)}
            if fails == FAILS_NOTICE:
                owner_note("role", f"Роль {key} не поднимается: {fails} попытки подряд",
                           f"Сторож команды открывал роль {key} {fails} раза, сессия не поднялась. Дальше пробует "
                           "не чаще раза в 6 ч. Посмотрите её окно в tmux (tmux -L agents attach, Ctrl-b w) или "
                           "журнал ~/Library/Logs/taibe-team.log.", log)
        opened += 1
        st.update(live=len([x for x in steps if x in live]), extra=len(live - set(steps)))
        publish(st, team, log)
        time.sleep(PAUSE_AFTER)
    have = len([x for x in steps if x in live])
    if blocked and cap < total and not st.get("low"):
        owner_note("cap", f"Команда: {cap} ролей вместо {total} — мало памяти",
                   f"Свободной памяти меньше {warn}%: открыто {have} ролей, ещё не открыты: {', '.join(blocked)}. "
                   "Работающие роли не закрываются. Освободить память: закрыть Docker, Ollama или лишние окна "
                   f"Claude. Когда свободно станет {warn + RAISE_GAP}% и больше, сторож сам откроет остальные (раз в 10 "
                   "мин) и сообщит.", log)
        st["low"] = True
    elif st.get("low") and cap == total:
        owner_note("cap", f"Команда снова {total} ролей — память освободилась",
                   f"Свободной памяти снова больше {warn + RAISE_GAP}%: сторож открывает недостающие роли до {total}.",
                   log)
        st["low"] = False
    st.update(cap=cap, live=have, extra=len(live - set(steps)), at=time.strftime("%Y-%m-%d %H:%M"))
    log(f"команда: открыто ролей {have} из {len(steps)}, потолок {cap}")
    return 0


def show():
    team, warn, _, _, roles, roots = config()
    split, src = owner_split(team, list(roles))
    live, _ = live_set(roots)
    paused = " · ПАУЗА владельца на Mac" if pause_path().exists() else \
        " · ПАУЗА владельца в очереди" if queue_pause_path().exists() else ""
    print("доли: " + " · ".join(f"{s} {n}" for s, n in split.items()) + f" ({src}); всего {team['total']}, при "
          f"свободной памяти < {warn}% — {team['floor']}, обратно от {warn + RAISE_GAP}%{paused}")
    tries = load_state().get("roles") or {}
    for s, r in plan(allocate(split, roles), roles):
        t = tries.get(f"{s}/{r}")
        retry = f"  (не поднялась {t['fails']} раз, повтор после {time.strftime('%H:%M', time.localtime(t['next']))})" \
            if t and (s, r) not in live else ""
        print(f"  {'✓' if (s, r) in live else '·'} {s}/{r}{retry}")
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "up" and len(argv) <= 3:
        return up(int(argv[2]) if len(argv) == 3 and argv[2].isdigit() else None)
    if cmd == "plan" and len(argv) == 2:
        return show()
    if cmd in ("pause", "resume") and len(argv) == 2:
        T.conf_dir().mkdir(parents=True, exist_ok=True)
        if cmd == "pause":
            pause_path().write_text(time.strftime("%Y-%m-%d %H:%M"), encoding="utf-8")
            print("пауза: роли не открываются, пока не resume (работающие не закрыты)")
        else:
            pause_path().unlink(missing_ok=True)
            if queue_pause_path().exists():
                print("пауза на Mac снята, но в очереди стоит пауза владельца: роли не откроются, пока в шапке /queue "
                      "(кнопка «Роли») не выбрана доля")
            else:
                print("пауза снята: сторож откроет недостающие роли в течение 10 мин")
        return 0
    print((__doc__ or "").split("\n\n")[-1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
