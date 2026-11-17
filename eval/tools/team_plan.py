#!/usr/bin/env python3
"""Команда ролей по продуктам: сколько ролей какого продукта держать открытыми и открыть недостающие (OPS-82,
решение владельца 17.11).

Всего ролей — system.team.total (12), по умолчанию поровну (system.team.split, 6+6). Доли продуктов владелец меняет
в очереди: ответ на пункт system.team.split_item (d-team-split, вариант «8-4» — по порядку продуктов в instances/;
другая доля — «7-5» в заметке к ответу),
не меньше system.team.min_per_product (2) на продукт. Мало памяти (свободно < system.mem_warn) — потолок
system.team.floor (10); память вернулась — снова total. Смена потолка — уведомление на Mac и пункт в очереди.
Свободно < mem_critical — новые роли не открываются вовсе (дальше — memguard).
Роли продукта по приоритету: coord, release, backend, frontend, plan, boards, backend-2, frontend-2; продукты —
вперемешку по рангу роли, чтобы при потолке у каждого остались главные роли. Открывает spawn_session.sh --launch
(живую роль пропускает, ждёт новую сессию), по одной. Уменьшение доли не закрывает работающие роли.
Не открывает, пока Нерв стоит на лимите аккаунта (eval/nerve/state/state.json budget.limit).

  python3 -I eval/tools/team_plan.py plan    что должно быть открыто и что открыто (ничего не запускает)
  python3 -I eval/tools/team_plan.py up      открыть недостающие роли («ВКЛ», вход в систему, сторож раз в 10 мин)
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import time
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


def config():
    """(team, mem_warn, mem_critical, max_sessions, {slug: [роли по приоритету]}, {slug: repo_root})."""
    shared, prods = P.load()
    system = shared.get("system") or {}
    team = {**DEFAULTS, **(system.get("team") or {})}
    active = {s: p for s, p in prods.items() if p.get("active")}
    roles = {s: [r for r in ORDER if r in ((p.get("team") or {}).get("roles") or ())] for s, p in active.items()}
    return (team, int(system.get("mem_warn", 20)), int(system.get("mem_critical", 10)),
            int(system.get("max_sessions", 14)), roles, {s: p.get("repo_root") for s, p in active.items()})


def parse_split(choice, slugs, total, least):
    """«8-4» → {slug: 8, ...} по порядку slugs; сумма total, каждый не меньше least; иначе None."""
    try:
        nums = [int(x) for x in str(choice).split("-")]
    except ValueError:
        return None
    if len(nums) != len(slugs) or sum(nums) != total or min(nums) < least:
        return None
    return dict(zip(slugs, nums))


def cache_path():
    return T.conf_dir() / "team-split.json"


def owner_split(team, slugs):
    """Доли из ответа владельца в очереди; очередь недоступна — последний принятый ответ; его нет — конфиг."""
    total, least = int(team["total"]), int(team["min_per_product"])
    base = {s: int((team.get("split") or {}).get(s, 0)) for s in slugs}
    if sum(base.values()) != total or min(base.values() or [0]) < least:
        base = dict(zip(slugs, [total // len(slugs) + (i < total % len(slugs)) for i in range(len(slugs))]))
    try:
        data = (Q.oq_request(f"checks/{team['split_item']}") or {}).get("data") or {}
        # В пункте до 5 вариантов; другая доля («7-5») — в заметке к ответу, она важнее выбранного варианта.
        noted = re.search(r"\b(\d{1,2}(?:-\d{1,2})+)\b", str(data.get("note") or ""))
        got = (noted and parse_split(noted.group(1), slugs, total, least)) or parse_split(data.get("choice"), slugs,
                                                                                         total, least)
        if got:
            cache_path().parent.mkdir(parents=True, exist_ok=True)
            cache_path().write_text(json.dumps(got), encoding="utf-8")
            return got, "очередь"
    except (OSError, ValueError, SystemExit):
        pass
    try:
        got = json.loads(cache_path().read_text(encoding="utf-8"))
        if set(got) == set(slugs) and sum(got.values()) == total:
            return got, "последний ответ"
    except (OSError, ValueError):
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


def is_live(slug, role, root):
    r = subprocess.run([sys.executable, "-I", str(TOOLS / "team_status.py"), "live", "--role", role, "--product", slug,
                        "--cwd", root], capture_output=True, text=True, timeout=60)
    return r.returncode == 0


def nerve_limit():
    try:
        st = json.loads((TOOLS.parent / "nerve" / "state" / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return (st.get("budget") or {}).get("limit")


def spawn(slug, role, log):
    """Открыть роль; True — окно открыто (сессия поднялась или ещё поднимается)."""
    r = subprocess.run(["bash", str(TOOLS / "spawn_session.sh"), "--launch", "--product", slug, "--role", role],
                       capture_output=True, text=True, env={**os.environ, "SPAWN_GATE": "off"}, timeout=600)
    line = next((ln.strip() for ln in r.stdout.splitlines() if ln.strip().startswith(f"{role} —")), r.stderr.strip()[-200:])
    log(f"  {slug}/{role}: {line}")
    return "поднята" in line or "открыта, сессия НЕ появилась" in line


def notify(cap, total, free, live, log):
    """Потолок сменился: уведомление на Mac и пункт владельцу в очереди."""
    low = cap < total
    title = (f"Команда: {cap} ролей вместо {total} — мало памяти (свободно {free}%)" if low
             else f"Команда снова {total} ролей — память освободилась (свободно {free}%)")
    body = (f"Открыто ролей: {live}. " + ("Новые роли сверх {0} не открываются, пока свободно меньше mem_warn; работающие "
            "не закрываются. Когда память освободится, сторож (раз в 10 мин) сам доведёт команду до {1}.".format(cap, total)
            if low else "Сторож открывает недостающие роли до полного состава.") + "\n\nНичего делать не нужно — это уведомление.")
    subprocess.run(["osascript", "-e", "on run argv", "-e", 'display notification (item 2 of argv) with title (item 1 of argv)',
                    "-e", "end run", "Команда ролей", title], capture_output=True, timeout=15)
    try:
        Q.oq_request(f"items/c-team-cap-{time.strftime('%Y%m%d-%H%M')}", method="PUT", data={"data": {
            "kind": "check", "title": title, "body": body, "added": time.strftime("%Y-%m-%d"), "source": SOURCE}})
    except (OSError, ValueError, SystemExit) as exc:
        log(f"  пункт в очередь не записан: {exc}")
    log(f"  уведомление: {title}")


def state_path():
    return T.conf_dir() / "team-state.json"


def up(log=print):
    T.conf_dir().mkdir(parents=True, exist_ok=True)
    with open(T.conf_dir() / "team.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("команда: другой запуск уже открывает роли")
            return 0
        lim = nerve_limit()
        if lim:
            log(f"команда: Нерв стоит на лимите аккаунта до {lim.get('resume') or lim.get('reset')} — роли не открываю")
            return 0
        team, warn, crit, max_s, roles, roots = config()
        split, src = owner_split(team, list(roles))
        steps = plan(allocate(split, roles), roles)
        live = {(s, r) for s, r in steps if is_live(s, r, roots[s])}
        log("команда: " + " · ".join(f"{s} {n}" for s, n in split.items()) + f" ({src}), открыто {len(live)}")
        total, floor = int(team["total"]), int(team["floor"])
        n, cap, free = len(live), total, None
        for s, r in steps:
            if (s, r) in live:
                continue
            free = TS.Sys().mem_free()
            cap = floor if free is not None and free < warn else total
            if n >= cap or TS.live_sessions(TS.Sys()) >= max_s:
                break
            if free is not None and free < crit:
                log(f"  свободно памяти {free}% < mem_critical {crit}% — новые роли не открываю")
                break
            n += spawn(s, r, log)
        free = TS.Sys().mem_free() if free is None else free
        cap = floor if free is not None and free < warn else total
        try:
            old = json.loads(state_path().read_text(encoding="utf-8")).get("cap", total)
        except (OSError, ValueError):
            old = total
        if cap != old:
            notify(cap, total, "—" if free is None else free, n, log)
        state_path().write_text(json.dumps({"cap": cap, "at": time.strftime("%Y-%m-%d %H:%M")}), encoding="utf-8")
        log(f"команда: открыто ролей {n} из {cap}" + (f" (потолок снижен: свободно {free}%)" if cap < total else ""))
        return 0


def show():
    team, warn, _, _, roles, roots = config()
    split, src = owner_split(team, list(roles))
    print("доли: " + " · ".join(f"{s} {n}" for s, n in split.items()) + f" ({src}); всего {team['total']}, "
          f"при нехватке памяти (< {warn}%) — {team['floor']}")
    for s, r in plan(allocate(split, roles), roles):
        print(f"  {'✓' if is_live(s, r, roots[s]) else '·'} {s}/{r}")
    return 0


def main(argv):
    if len(argv) != 2 or argv[1] not in ("plan", "up"):
        print((__doc__ or "").split("\n\n")[-1], file=sys.stderr)
        return 2
    return up() if argv[1] == "up" else show()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
