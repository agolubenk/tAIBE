#!/usr/bin/env python3
"""
TB-81 часть 2 и OPS-55: линия в oq_agent_status. session — своя линия или линия предка, которую сессия держит;
takeover (перехват входящего у держателя, OPS-35) — линия предка, которую сессия держит. «Держит» — как запись
line: списка Контроля (#176). Линия и квитанции — настоящий eval/tools/lineage.py над временным каталогом линий.

Запуск: python3 -I .claude/hooks/test_merge_guard_oq.py  (exit 1 при расхождении)
"""
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ["TAIBE_LINEAGE_DIR"] = tempfile.mkdtemp(prefix="mg-oq-")
import merge_guard_identity as mi  # noqa: E402
import merge_guard_mcp as mm  # noqa: E402
import merge_guard_testkit as tk  # noqa: E402

LIN = mi.load_lineage(HERE.parents[1])
LDIR = Path(os.environ["TAIBE_LINEAGE_DIR"])
ST = "Fri Nov 13 21:30:00 2026"
failures, checked = [], [0]


class Sx:
    """Процессы и окружение без ps: pid → (линия, старт[, ppid, команда]). ps_calls — сколько раз взят полный
    список."""

    def __init__(self, procs):
        procs = {pid: (v + (1, "claude"))[:4] for pid, v in procs.items()}
        self.p = {pid: LIN.Proc(pid, ppid, pid, "ttys001", start, cmd) for pid, (_, start, ppid, cmd) in procs.items()}
        self.env = {pid: line for pid, (line, *_) in procs.items()}
        self.ps_calls = 0

    def procs(self):
        self.ps_calls += 1
        return dict(self.p)

    def alive(self, p):
        q = self.p.get(p.pid)
        return q is not None and LIN.norm(q.start) == LIN.norm(p.start)

    def env_line(self, pid):
        return self.env.get(pid)


def rec(line, role="plan"):
    LIN.lfile(line, ".json").write_text(json.dumps({"line": line, "role": role}), encoding="utf-8")


def ack(line, pid, start=ST, at="2026-11-13T21:40:00+0300", role="plan"):
    """Наследник: запись линии с ролью и квитанция приёма."""
    rec(line, role)
    LIN.lfile(line, ".ack").write_text(json.dumps({"line": line, "pid": pid, "start": start, "at": at}),
                                       encoding="utf-8")


def reset():
    for f in LDIR.iterdir():
        f.unlink()
    rec("r.y80w")


def check(label, got, want_pass):
    checked[0] += 1
    if (got is None) != want_pass:
        failures.append(f"{label}: ждали {'проход' if want_pass else 'отказ'}, получили {got!r}")


def oq(pid, procs, value, takeover=None):
    return mi.oq_line_verdict(pid, value, takeover, lin=LIN, sx=Sx(procs))


if LIN is None:
    print("lineage.py не найден")
    sys.exit(1)

# --- session: своя линия ---
reset()
root = {10: ("r.y80w", ST)}
check("своя линия (корень)", oq(10, root, "r.y80w"), True)
check("чужая линия", oq(10, root, "r.gtew"), False)
check("линия-соседка с общим началом", oq(10, root, "r.y80wx"), False)
check("линия потомка", oq(10, root, "r.y80w.plit"), False)
check("сессия без линии", oq(13, {13: (None, ST)}, "r.y80w"), False)
check("процесса нет", oq(99, root, "r.y80w"), False)
check("pid не число (сессии нет в реестре)", oq(None, root, "r.y80w"), False)
rec("r.y80w.plit")
check("своя линия наследника до ack — свой захват", oq(20, {20: ("r.y80w.plit", ST)}, "r.y80w.plit"), True)
# claude из Bash другой сессии: окружение (линия) — от родителя
nested = {10: ("r.y80w", ST, 5, "/opt/bin/claude --resume"), 11: (None, ST, 10, "-zsh"), 12: ("r.y80w", ST, 11, "claude")}
check("вложенный claude с линией родителя", oq(12, nested, "r.y80w"), False)
check("сессия верхнего уровня (родитель — оболочка)", oq(10, {**nested, 5: (None, ST, 1, "login")}, "r.y80w"), True)

# --- takeover: наследник берёт пункт у держателя-предка ---
reset()
both = {10: ("r.y80w", ST), 20: ("r.y80w.plit", ST)}
rec("r.y80w.plit")
check("наследник до ack: takeover", oq(20, both, "r.y80w.plit", "r.y80w"), False)
ack("r.y80w.plit", 20)
check("наследник после ack: takeover", oq(20, both, "r.y80w.plit", "r.y80w"), True)
check("takeover = своя линия", oq(20, both, "r.y80w.plit", "r.y80w.plit"), False)
check("takeover — чужая линия", oq(20, both, "r.y80w.plit", "r.gtew"), False)
check("takeover — соседка корня", oq(20, both, "r.y80w.plit", "r.y80"), False)
check("takeover — не линия", oq(20, both, "r.y80w.plit", "hr-helper-v2-4e"), False)
check("предшественник после ack наследника: takeover потомка", oq(10, both, "r.y80w", "r.y80w.plit"), False)
check("предшественник после ack наследника: своя линия", oq(10, both, "r.y80w"), False)
check("наследник после ack: своя линия", oq(20, both, "r.y80w.plit"), True)
check("наследник умер после ack: корень снова держит свою линию", oq(10, {10: ("r.y80w", ST)}, "r.y80w"), True)
check("чужая квитанция (pid другой)", oq(21, {21: ("r.y80w.plit", ST)}, "r.y80w.plit", "r.y80w"), False)
check("квитанция старого процесса с тем же pid",
      oq(20, {20: ("r.y80w.plit", "Sat Nov 14 01:00:00 2026")}, "r.y80w.plit", "r.y80w"), False)

# старое поколение при живом наследнике новее; внук через поколение без квитанции
reset()
ack("r.y80w.aa11", 20)
ack("r.y80w.aa11.bb22", 30, at="2026-11-13T22:00:00+0300")
chain = {20: ("r.y80w.aa11", ST), 30: ("r.y80w.aa11.bb22", ST)}
check("старое поколение при живом внуке: takeover корня", oq(20, chain, "r.y80w.aa11", "r.y80w"), False)
check("внук после ack: takeover корня через поколение", oq(30, chain, "r.y80w.aa11.bb22", "r.y80w"), True)
check("внук после ack: takeover сына", oq(30, chain, "r.y80w.aa11.bb22", "r.y80w.aa11"), True)

# потомок другой роли (наследник Контроля в линии плана и подобное) — не держатель
reset()
ack("r.y80w.xx99", 20, role="release")
check("наследник другой роли: takeover", oq(20, {20: ("r.y80w.xx99", ST)}, "r.y80w.xx99", "r.y80w"), False)

# --- OPS-55: session = линия предка, которую сессия держит (отпустить или вести захват предка) ---
reset()
ack("r.y80w.plit", 20)
heir = {10: ("r.y80w", ST), 20: ("r.y80w.plit", ST)}
check("session = линия предка, наследник с ack", oq(20, heir, "r.y80w"), True)
check("session = линия предка, другой процесс той же линии", oq(21, {21: ("r.y80w.plit", ST)}, "r.y80w"), False)
reset()
rec("r.y80w.plit")
check("session = линия предка без ack", oq(20, heir, "r.y80w"), False)
reset()
ack("r.y80w.plit", 20, role="release")
check("session = линия предка, другая роль", oq(20, heir, "r.y80w"), False)
reset()
ack("r.y80w.aa11", 20)
ack("r.y80w.aa11.bb22", 30, at="2026-11-13T22:00:00+0300")
check("session = линия предка у старого поколения", oq(20, chain, "r.y80w"), False)
check("session = сын, takeover = корень (внук с ack)", oq(30, chain, "r.y80w.aa11", "r.y80w"), True)
check("session = корень, takeover = корень", oq(30, chain, "r.y80w", "r.y80w"), False)
check("session = корень, takeover = сын (не предок session)", oq(30, chain, "r.y80w", "r.y80w.aa11"), False)
check("session = линия r.y80wx (не предок)", oq(30, chain, "r.y80wx"), False)

# held_verdict без ps -A (так зовёт хук HR: линия — своя, pid и старт — из реестра сессий)
reset()
ack("r.y80w.plit", 20)
check("held: наследник с ack", mi.held_verdict(LIN, Sx(heir), "r.y80w.plit", 20, ST, "r.y80w"), True)
check("held: старт из реестра другой", mi.held_verdict(LIN, Sx(heir), "r.y80w.plit", 20, "Sat Nov 14 01:00:00 2026",
                                                       "r.y80w"), False)
check("held: не наследник", mi.held_verdict(LIN, Sx(heir), "r.gtew.plit", 20, ST, "r.y80w"), False)
check("held: корень после ack наследника", mi.held_verdict(LIN, Sx(heir), "r.y80w", 10, ST, "r.y80w"), False)
check("held: Sx без procs — достаточно alive", mi.held_verdict(LIN, type("A", (), {"alive": Sx(heir).alive})(),
                                                               "r.y80w.plit", 20, ST, "r.y80w"), True)

# oq_lines_verdict — чистое правило полей (его зовёт и хук HR): held спрашивается только о предках
asked = []
held_yes = lambda line: asked.append(line)  # noqa: E731
check("правило: своя линия — тоже через held", mi.oq_lines_verdict("r.a.b", "r.a.b", None, held_yes), True)
check("правило: предок и takeover-предок", mi.oq_lines_verdict("r.a.b.c", "r.a.b", "r.a", held_yes), True)
checked[0] += 1
if asked != ["r.a.b", "r.a.b", "r.a"]:
    failures.append(f"held спрошен о {asked}, ждали r.a.b (своя), затем r.a.b и r.a")
check("правило: своя линия, held отказал", mi.oq_lines_verdict("r.a.b", "r.a.b", None, lambda line: "нет"), False)
check("правило: held отказал", mi.oq_lines_verdict("r.a.b", "r.a", None, lambda line: "нет"), False)
check("правило: линии сессии нет", mi.oq_lines_verdict(None, "r.a", None, held_yes), False)
check("правило: линия «r» без сегмента", mi.oq_lines_verdict("r", "r", None, held_yes), False)

# полный список процессов — один раз на вызов, даже с проверкой держателя
reset()
ack("r.y80w.plit", 20)
sx = Sx(heir)
mi.oq_line_verdict(20, "r.y80w.plit", "r.y80w", lin=LIN, sx=sx)
checked[0] += 1
if sx.ps_calls != 1:
    failures.append(f"ps -A на перехват: {sx.ps_calls} раз, ждали 1")

# нет lineage.py — линия не проходит
real_load = mi.load_lineage
mi.load_lineage = lambda *a: None
check("нет lineage.py", mi.oq_line_verdict(20, "r.y80w.plit", None, sx=Sx(heir)), False)
mi.load_lineage = real_load

# --- oq_identity: разбор полей; линию решает line_check ---
OQ = "mcp__owner-queue__oq_agent_status"
me = {"sessionId": "aaaaaaaa-0000-0000-0000-000000000000", "name": "hr-helper-v2-aa", "pid": 40}
reg = lambda: [me]  # noqa: E731
ok, no = (lambda pid, v, t: None), (lambda pid, v, t: "нет")
got = []
check("своё имя", mm.oq_identity(OQ, {"session": "hr-helper-v2-aa"}, me["sessionId"], reg, no), True)
check("короткое своё имя", mm.oq_identity(OQ, {"session": "aa"}, me["sessionId"], reg, no), True)
check("чужое имя", mm.oq_identity(OQ, {"session": "hr-helper-v2-4e"}, me["sessionId"], reg, ok), False)
check("без session и takeover", mm.oq_identity(OQ, {"status": "doing"}, me["sessionId"], reg, no), True)
check("линия, проверка прошла", mm.oq_identity(OQ, {"session": "r.y80w.plit"}, me["sessionId"], reg, ok), True)
check("линия, проверка не прошла", mm.oq_identity(OQ, {"session": "r.y80w.plit"}, me["sessionId"], reg, no), False)
check("линия без проверки линии", mm.oq_identity(OQ, {"session": "r.y80w.plit"}, me["sessionId"], reg), False)
check("takeover без session", mm.oq_identity(OQ, {"takeover": "r.y80w"}, me["sessionId"], reg, ok), False)
check("takeover с именем в session", mm.oq_identity(
    OQ, {"session": "hr-helper-v2-aa", "takeover": "r.y80w"}, me["sessionId"], reg, ok), False)
mm.oq_identity(OQ, {"session": " r.y80w.plit ", "takeover": "r.y80w"}, me["sessionId"], reg,
               lambda pid, v, t: got.append((pid, v, t)))
mm.oq_identity(OQ, {"session": "r.y80w", "takeover": ""}, "нет-в-реестре", reg, lambda pid, v, t: got.append((pid, v, t)))
checked[0] += 1
if got != [(40, "r.y80w.plit", "r.y80w"), (None, "r.y80w", None)]:
    failures.append(f"line_check получил {got}, ждали (40, r.y80w.plit, r.y80w) и (None, r.y80w, None)")
check("сервер под другим именем: чужое имя", mm.oq_identity(
    "mcp__q__oq_agent_status", {"session": "hr-helper-v2-4e"}, me["sessionId"], reg, ok), False)
check("через хаб: линия идёт в проверку", mm.oq_identity(
    "mcp__hub__owner-queue_1mcp_oq_agent_status", {"session": "r.y80w.plit"}, me["sessionId"], reg, no), False)
check("сервер под другим именем: вердикт мёржа пойман", mm.oq_merge_write(
    "mcp__q__oq_put", {"collection": "items", "id": "m-1", "data": {"sha": "abc"}}), False)
check("другая операция с session не проверяется", mm.oq_identity(
    "mcp__owner-queue__oq_put", {"session": "r.gtew"}, me["sessionId"], reg, no), True)

# --- хук: decide передаёт merge_guard_identity.oq_line_verdict ---
calls = []
real_oq = tk.mg.oq_line_verdict
tk.mg.oq_line_verdict = lambda pid, v, t: calls.append((pid, v, t))
check("хук: линия проходит по проверке", tk.run(OQ, {"session": "r.y80w.plit", "takeover": "r.y80w"}), True)
tk.mg.oq_line_verdict = lambda pid, v, t: "нет"
check("хук: линия не проходит по проверке", tk.run(OQ, {"session": "r.y80w.plit"}), False)
tk.mg.oq_line_verdict = real_oq
checked[0] += 1
if calls != [(tk.C4["pid"], "r.y80w.plit", "r.y80w")]:
    failures.append(f"хук передал в проверку линии {calls}, ждали pid сессии из реестра и обе линии")

if failures:
    print("\n".join(failures))
    sys.exit(1)
print(f"merge-guard, линия в очереди владельца: все проверки прошли ({checked[0]})")
