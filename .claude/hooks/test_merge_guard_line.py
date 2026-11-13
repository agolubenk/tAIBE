#!/usr/bin/env python3
"""
TB-81: Контроль по линии (`line:<L>` в списке merge-guard) — держатель линии проходит, предшественник после приёма
и чужая линия — нет. Линия и квитанции — настоящий eval/tools/lineage.py над временным каталогом линий.

Запуск: python3 -I .claude/hooks/test_merge_guard_line.py  (exit 1 при расхождении)
"""
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ["TAIBE_LINEAGE_DIR"] = tempfile.mkdtemp(prefix="mg-line-")
import merge_guard_identity as mi  # noqa: E402

LIN = mi.load_lineage(HERE.parents[1])
LDIR = Path(os.environ["TAIBE_LINEAGE_DIR"])
ST = "Fri Nov 13 21:30:00 2026"
failures, checked = [], [0]


class Sx:
    """Процессы и окружение без ps: pid → (линия, старт)."""

    def __init__(self, procs):
        self.p = {pid: LIN.Proc(pid, 1, pid, "ttys001", start, "claude") for pid, (_, start) in procs.items()}
        self.env = {pid: line for pid, (line, _) in procs.items()}

    def procs(self):
        return dict(self.p)

    def alive(self, p):
        q = self.p.get(p.pid)
        return q is not None and LIN.norm(q.start) == LIN.norm(p.start)

    def env_line(self, pid):
        return self.env.get(pid)


def ack(line, pid, start=ST):
    LIN.lfile(line, ".ack").write_text(json.dumps({"line": line, "pid": pid, "start": start}), encoding="utf-8")


def reset():
    for f in LDIR.iterdir():
        f.unlink()


def check(label, got, want_pass):
    checked[0] += 1
    if (got is None) != want_pass:
        failures.append(f"{label}: ждали {'проход' if want_pass else 'отказ'}, получили {got!r}")


def verdict(pid, procs, lines=("r.ddgg",)):
    return mi.line_verdict(pid, list(lines), lin=LIN, sx=Sx(procs))


if LIN is None:
    print("lineage.py не найден")
    sys.exit(1)

# корень линии — первое поколение, квитанция не нужна
reset()
check("корень линии", verdict(10, {10: ("r.ddgg", ST)}), True)
check("чужая линия", verdict(11, {11: ("r.gtew", ST)}), False)
check("линия-соседка с общим началом", verdict(12, {12: ("r.ddggx", ST)}), False)
check("сессия без линии", verdict(13, {13: (None, ST)}), False)
check("процесса нет", verdict(99, {10: ("r.ddgg", ST)}), False)

# наследник без квитанции не Контроль; с квитанцией — Контроль, предшественник — уже нет
reset()
both = {10: ("r.ddgg", ST), 20: ("r.ddgg.ab12", ST)}
check("наследник до ack", verdict(20, both), False)
check("предшественник до ack наследника", verdict(10, both), True)
ack("r.ddgg.ab12", 20)
check("наследник после ack", verdict(20, both), True)
check("предшественник после ack наследника", verdict(10, both), False)
check("чужая квитанция (pid другой)", verdict(21, {21: ("r.ddgg.ab12", ST)}), False)
check("квитанция старого процесса с тем же pid", verdict(20, {20: ("r.ddgg.ab12", "Sat Nov 14 01:00:00 2026")}), False)

# через закончившееся поколение: внук принял, сын умер — корень не Контроль
reset()
ack("r.ddgg.ab12", 20)
ack("r.ddgg.ab12.cd34", 30)
chain = {10: ("r.ddgg", ST), 30: ("r.ddgg.ab12.cd34", ST)}
check("внук после ack", verdict(30, chain), True)
check("корень при живом внуке", verdict(10, chain), False)

# наследник умер без смены — корень снова держатель
reset()
ack("r.ddgg.ab12", 20)
check("корень, наследник с ack умер", verdict(10, {10: ("r.ddgg", ST)}), True)

# control_verdict: запись line: проходит только через проверку линии; sessionId и имя работают как раньше
me = {"sessionId": "6fbb5c84-0000-0000-0000-000000000000", "name": "taibe-4b", "pid": 40}
ok, no = (lambda pid, lines: None), (lambda pid, lines: "нет")
check("список из одной линии, линия держится", mi.control_verdict(me["sessionId"], [me], ["line:r.ddgg"], ok), True)
check("список из одной линии, линия не держится", mi.control_verdict(me["sessionId"], [me], ["line:r.ddgg"], no), False)
check("sessionId рядом с линией", mi.control_verdict(me["sessionId"], [me], ["line:r.x", "6fbb5c84"], no), True)
check("«line:» не принимается за имя", mi.control_verdict(
    me["sessionId"], [dict(me, name="line:r.ddgg")], ["line:r.ddgg"], no), False)
got = []
mi.control_verdict(me["sessionId"], [me], ["line:r.ddgg", "line:r.f93t"], lambda pid, lines: got.append((pid, lines)))
if got != [(40, ["r.ddgg", "r.f93t"])]:
    failures.append(f"проверка линии получила {got}, ждали pid 40 и обе линии")
checked[0] += 1
none_called = []
mi.control_verdict(me["sessionId"], [me], ["6fbb5c84"], lambda pid, lines: none_called.append(1))
if none_called:
    failures.append("без записей line: проверка линии не должна вызываться (лишний ps)")
checked[0] += 1

if failures:
    print("\n".join(failures))
    sys.exit(1)
print(f"merge-guard по линии: все проверки прошли ({checked[0]})")
