#!/usr/bin/env python3
"""peer_turns.py (SE-59): причины ходов, вставки, ответы владельца к сроку; только чтение; в выводе нет текста и id.

Run: python3 -I eval/tools/test_peer_turns.py
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import peer_turns as PT  # noqa: E402

UNTIL = datetime(2026, 11, 14, 0, 0, tzinfo=timezone.utc)
SINCE = UNTIL - timedelta(hours=60)
T0 = UNTIL - timedelta(hours=2)
SECRET = "СЕКРЕТ-ТЕКСТА"


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def turn(t, how, text, **extra):
    o = {"type": "user", "timestamp": iso(t), "turnOrigin": how, "turnPosition": {"promptIndex": 1, "turnIndex": 1},
         "message": {"role": "user", "content": text}}
    o.update(extra)
    return o


def note(text):
    return f"<task-notification>\n<task-id>b1</task-id>\n<event>{text}</event>\n</task-notification>"


def session():
    """Сессия Т3: каждая запись — с ожидаемой причиной хода (None — хода не начинает)."""
    return [
        turn(T0 - timedelta(minutes=30), "human", "Сборка Т3, ключ реестра boards, роль 6."),
        turn(T0 + timedelta(minutes=1), "peer", f"<cross-session-message from=\"x\">{SECRET}</cross-session-message>",
             isMeta=True, origin={"kind": "peer"}),
        turn(T0 + timedelta(minutes=5), "task_notification",
             note(f"НЕРВ 01:00 owner.answer: ответ владельца d-taibe-x1: да {SECRET}")),
        turn(T0 + timedelta(minutes=6), "task_notification", note("[Monitor expired after 1800s]")),
        turn(T0 + timedelta(minutes=7), "task_notification", note("Background command done")),
        {"type": "assistant", "timestamp": iso(T0 + timedelta(minutes=8)), "message": {"content": [
            {"type": "tool_use", "name": "Bash", "input": {"command": "echo d-taibe-x3"}}]}},  # выход, не вход
        {"type": "user", "timestamp": iso(T0 + timedelta(minutes=30)), "message": {"content": [
            {"type": "tool_result", "content": f"d-taibe-x2 answered {SECRET} d-taibe-x30"}]}},
        {"type": "attachment", "timestamp": iso(T0 + timedelta(minutes=31)), "attachment": {
            "type": "queued_command", "commandMode": "prompt",
            "prompt": "<cross-session-message>hi</cross-session-message>"}},
        {"type": "attachment", "timestamp": iso(T0 + timedelta(minutes=32)), "attachment": {
            "type": "queued_command", "commandMode": "task-notification", "prompt": note("НЕРВ 01:02 assign: x")}},
        {"type": "user", "timestamp": iso(T0 + timedelta(minutes=33)), "isMeta": True,
         "message": {"content": [{"type": "text", "text": "Base directory for this skill: …"}]}},
        {"type": "user", "timestamp": iso(T0 + timedelta(minutes=40)), "isCompactSummary": True,
         "message": {"content": "This session is being continued from a previous conversation."}},
        {"type": "user", "timestamp": iso(T0 + timedelta(minutes=41)), "origin": {"kind": "task-notification"},
         "message": {"content": note("НЕРВ 01:05 review: старый журнал без turnOrigin")}},
        turn(SINCE - timedelta(hours=1), "peer", "<cross-session-message>до окна</cross-session-message>"),
    ]


def journal_line(key, kind="owner.answer"):
    return json.dumps({"seq": "1", "ts": iso(T0), "key": key, "kind": kind, "to": ["boards"], "text": SECRET})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.projects, self.nerve = os.path.join(root, "projects"), os.path.join(root, "nerve")
        for d in ("p-tAIBE", "-Users-x--claude-mem-observer-sessions", "p-other"):
            os.makedirs(os.path.join(self.projects, d))
        os.makedirs(os.path.join(self.nerve, "products", "taibe"))
        self.write("p-tAIBE/s1.jsonl", session())
        self.write("-Users-x--claude-mem-observer-sessions/o.jsonl",
                   [turn(T0, "peer", "<cross-session-message>наблюдатель</cross-session-message>")])
        self.write("p-other/s2.jsonl", [turn(T0, "human", "просто вопрос"),
                                        turn(T0 + timedelta(minutes=2), "peer", "<cross-session-message>x")])
        with open(os.path.join(self.nerve, "journal.jsonl"), "w") as f:
            f.write("\n".join([journal_line(f"oq:answer:d-taibe-x1:{iso(T0)}"),
                               journal_line(f"oq:answer:d-taibe-x2:{iso(T0)}"),
                               journal_line(f"oq:answer:d-taibe-x3:{iso(T0)}"),
                               journal_line(f"oq:answer:d-taibe-x3:{iso(T0)}"),  # тот же ответ дважды — один
                               journal_line(f"oq:answer:d-taibe-x9:{iso(SINCE - timedelta(hours=1))}"),  # до окна
                               journal_line("manual:2026-11-13T20:00:00+00:00:coord:1"),
                               journal_line(f"oq:answer:d-taibe-x5:{iso(T0)}", kind="owner.inbox"), "не json"]) + "\n")
        with open(os.path.join(self.nerve, "products", "taibe", "journal.jsonl"), "w") as f:
            f.write(journal_line(f"oq:answer:d-taibe-x4:{iso(UNTIL - timedelta(minutes=5))}") + "\n")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, entries):
        with open(os.path.join(self.projects, rel), "w") as f:
            f.write("\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n")
        os.utime(os.path.join(self.projects, rel), (UNTIL.timestamp(), UNTIL.timestamp()))

    def run_pt(self):
        return PT.run(self.projects, self.nerve, SINCE, UNTIL)


class Turns(Base):
    def test_kinds_of_turns(self):
        t3 = self.run_pt()["команды"]["Т3"]
        self.assertEqual({k: t3[k] for k in PT.KINDS},
                         {"пир": 1, "нерв": 2, "монитор истёк": 1, "монитор": 1, "человек": 1, "сжатие": 1,
                          "прочее": 0})
        self.assertEqual(t3["ходов"], 7, "результат инструмента, вставки, тело навыка и ход до окна — не ходы")
        self.assertEqual((t3["доля_пир"], t3["доля_пир_и_нерв"]), (round(1 / 7, 3), round(3 / 7, 3)))
        self.assertEqual((t3["вставок_пир"], t3["вставок_нерв"]), (1, 1))

    def test_teams_and_observer_skipped(self):
        teams = self.run_pt()["команды"]
        self.assertEqual(sorted(teams), ["Т3", "прочие"], "папка наблюдателя claude-mem не читается")
        self.assertEqual((teams["прочие"]["ходов"], teams["прочие"]["пир"]), (2, 1))

    def test_old_file_skipped(self):
        os.utime(os.path.join(self.projects, "p-other", "s2.jsonl"), (0, 0))
        self.assertNotIn("прочие", self.run_pt()["команды"])


class OwnerAnswers(Base):
    def test_late_and_unread(self):
        a = self.run_pt()["ответы_владельца"]
        self.assertEqual((a["в_окне"], a["к_сроку"]), (4, 3), "x4 моложе 15 мин, x9 до окна, inbox, manual — нет")
        self.assertEqual(a["без_прочтения_дольше_15_мин"], 2, "x2 прочитан через 30 мин, x3 — никогда")
        self.assertEqual(a["не_прочитано"], 1, "выход сессии и d-taibe-x30 — не прочтение x3")
        self.assertEqual((a["медиана_мин"], a["p90_мин"]), (30.0, 30.0))

    def test_no_answers(self):
        for p in ("journal.jsonl", os.path.join("products", "taibe", "journal.jsonl")):
            os.remove(os.path.join(self.nerve, p))
        a = self.run_pt()["ответы_владельца"]
        self.assertEqual((a["в_окне"], a["медиана_мин"]), (0, None))


def tap(t, command):
    return {"type": "assistant", "timestamp": iso(t), "message": {"content": [
        {"type": "tool_use", "name": "Monitor", "input": {"command": command}}]}}


def limit(kind, t):
    return json.dumps({"seq": "1", "ts": iso(t), "key": f"{kind}:{iso(t)}", "kind": kind, "to": ["coord"],
                       "text": SECRET})


class Routing(Base):
    """x1–x3 — главному журналу, адресат boards; s1 — сессия boards (тап без продукта)."""

    def setUp(self):
        super().setUp()
        self.write("p-tAIBE/s1.jsonl", [tap(T0 - timedelta(minutes=29), "python3 -I eval/nerve/nerve.py tap boards")]
                   + session())

    def add(self, rel, command, *reads):
        """Сессия с тапом `command`, которая читает id в заданные минуты после T0."""
        self.write(rel, [tap(T0 - timedelta(minutes=20), command)] + [
            turn(T0 + timedelta(minutes=m), "task_notification", note(f"НЕРВ owner.answer: {i}")) for i, m in reads])

    def test_reader_role_and_product(self):
        self.add("p-other/s3.jsonl", "TAIBE_PRODUCT=hr-helper python3 nerve.py tap coord", ("d-taibe-x1", 2))
        self.add("p-other/s4.jsonl", "python3 nerve.py tap boards --product taibe", ("d-taibe-x3", 25))
        a = PT.run(self.projects, self.nerve, SINCE, UNTIL, default="hr-helper")["ответы_владельца"]
        self.assertEqual(a["прочитано_адресатом"], 2, "x3 прочла boards другого продукта — не адресат")
        self.assertEqual(a["первым_прочёл_адресат"], 1, "x1 первой прочла coord")
        self.assertEqual(a["без_прочтения_дольше_15_мин"], 2, "x2 через 30 мин, x3 через 25 мин")
        self.assertEqual(a["опоздали_в_паузе_лимита"], 0)

    def test_limit_pause_counts_from_its_end(self):
        with open(os.path.join(self.nerve, "journal.jsonl"), "a") as f:
            f.write(limit("limit.hit", T0 - timedelta(minutes=1)) + "\n" +
                    limit("limit.resume", T0 + timedelta(minutes=20)) + "\n")
        a = self.run_pt()["ответы_владельца"]
        self.assertEqual(a["без_прочтения_дольше_15_мин"], 2, "счёт приёмки паузу не вычитает")
        self.assertEqual(a["опоздали_в_паузе_лимита"], 2)
        self.assertEqual(a["дольше_15_мин_без_паузы"], 1, "x2 — 10 мин без паузы; x3 не прочитан — 100 мин")

    def test_open_pause_runs_to_window_end(self):
        with open(os.path.join(self.nerve, "journal.jsonl"), "a") as f:
            f.write(limit("limit.hit", T0 - timedelta(minutes=1)) + "\n")
        a = self.run_pt()["ответы_владельца"]
        self.assertEqual((a["опоздали_в_паузе_лимита"], a["дольше_15_мин_без_паузы"]), (2, 0),
                         "пауза ещё идёт — время без паузы 0")

    def test_tap_of(self):
        self.assertEqual(PT.tap_of('"command":"nerve.py tap boards --product taibe"', "hr-helper"),
                         ("boards", "taibe"))
        self.assertEqual(PT.tap_of("nerve.py tap coord --product hr-helper", "hr-helper"), ("coord", ""))
        self.assertIsNone(PT.tap_of("nerve.py tap --product taibe boards", ""), "флаг — не роль")


class Privacy(Base):
    def digest(self):
        h = hashlib.sha256()
        for d, _, files in sorted(os.walk(self.tmp.name)):
            for f in sorted(files):
                p = os.path.join(d, f)
                h.update(p.encode() + open(p, "rb").read() + str(os.stat(p).st_mtime_ns).encode())
        return h.hexdigest()

    def test_output_has_counts_only_and_reads_only(self):
        before = self.digest()
        until = UNTIL.astimezone().strftime("%Y-%m-%d %H:%M")
        for extra in ([], ["--json"]):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                PT.main(["--projects", self.projects, "--nerve", self.nerve, "--until", until] + extra)
            text = out.getvalue()
            self.assertIn("пир", text)
            for leak in (SECRET, "d-taibe-x", "Сборка", "cross-session", "boards"):
                self.assertNotIn(leak, text, f"вывод {extra or 'текст'} не несёт текста сообщений, промптов и id")
        self.assertEqual(self.digest(), before, "журналы только читаются")


if __name__ == "__main__":
    unittest.main(verbosity=1)
