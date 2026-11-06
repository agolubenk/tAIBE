#!/usr/bin/env python3
"""Бюджет окна (ctx_budget.py, ctx_budget_params.py, хук context-threshold.py) на синтетике: примеры владельца
06.11, сброс после сжатия, запасные значения, битый транскрипт, CLI next/done/status, learn без утечки текста.
Без сети и окон; состояние — во временном CTX_BUDGET_DIR. Run: python3 -I <this file>"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
import ctx_budget as cb  # noqa: E402
import ctx_budget_params as cp  # noqa: E402

HOOK = REPO / ".claude/hooks/context-threshold.py"
WEFF = int(250_000 * 213 / 250)  # запасная точка сжатия для окна 250K
SECRET = "Иванов Иван Петрович +7 999 123-45-67"
KNOBS = ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "SUCCESSOR_WINDOW_TOKENS", "SUCCESSOR_AUTO", "T3_ROLE_KEY",
         "TAIBE_LINEAGE", "TAIBE_PIPELINE", "CLAUDE_CODE_SESSION_ID", "CTX_BUDGET_DIR", "CTX_BUDGET_PROJECTS",
         "TAIBE_LINEAGE_DIR", "ANTHROPIC_MODEL", "CLAUDE_PROJECT_DIR")


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"


def answer(tokens, tools=(), sidechain=False, cwd="/nonexistent", ts="2026-11-06T10:00:00.000Z", model=None):
    usage = {"input_tokens": 2, "cache_read_input_tokens": tokens - 102, "cache_creation_input_tokens": 50,
             "output_tokens": 50}
    content = [{"type": "tool_use", "id": "toolu_1", "name": n, "input": i} for n, i in tools] or [
        {"type": "text", "text": "ответ: " + SECRET}]
    msg = {"role": "assistant", "usage": usage, "content": content}
    if model:
        msg["model"] = model
    return dumps({"parentUuid": "p", "isSidechain": sidechain, "message": msg, "type": "assistant", "cwd": cwd,
                  "timestamp": ts})


def user(text=SECRET):
    return dumps({"parentUuid": "p", "isSidechain": False, "type": "user",
                  "message": {"role": "user", "content": text}})


def compact(pre):
    return dumps({"type": "system", "subtype": "compact_boundary", "isSidechain": False,
                  "compactMetadata": {"trigger": "auto", "preTokens": pre}})


def inject():
    return dumps({"type": "attachment", "isSidechain": False, "attachment": {
        "type": "hook_additional_context", "hookEvent": "PostToolUse", "content": ["<successor-threshold>…"]}})


def bash(cmd):
    return ("Bash", {"command": cmd})


class DecideTest(unittest.TestCase):
    """Правило владельца 06.11: тишина до 85 %, дальше — влезает ли остаток + передача в 98,5 %."""

    def test_owner_examples(self):
        self.assertEqual(cb.decide(0.80, 0.15, 0.04), "quiet")      # 80 % и задачи на 15 % + 4 % — до 85 % без передачи
        self.assertEqual(cb.decide(0.86, 0.10, 0.04), "handoff")    # 0,86 + 0,10 + 0,04 = 1,00 > 0,985
        self.assertEqual(cb.decide(0.86, 0.05, 0.04), "ok")         # 0,95 — продолжать
        self.assertEqual(cb.decide(0.70, 0.50, 0.04), "quiet")      # огромная задача на 70 % — тишина
        self.assertEqual(cb.decide(0.85, 0.50 - 0.15, 0.04), "handoff")  # на 85 % сработал остаток

    def test_safety_and_floor(self):
        self.assertEqual(cb.decide(0.945, 0.0, 0.04), "safety")     # s ≥ 0,985 − H при любых оценках
        self.assertEqual(cb.decide(0.849, 0.0, 0.20), "quiet")      # передачи до 85 % нет даже при большой H
        self.assertEqual(cb.decide(0.90, 0.045, 0.04), "ok")        # ровно 0,985 — ещё влезает

    def test_remaining(self):
        self.assertEqual(cb.remaining({"t": 0.15, "u0": 100, "explicit": True}, 100 + 0.20 * 1000, 1000)[0],
                         cb.REM_MIN)  # потрачено больше оценки — остаток 2 %
        rem, _, boundary = cb.remaining({"t": 0.10, "u0": 500, "explicit": False}, 503, 1000)
        self.assertEqual((rem, boundary), (0.10, True))  # только что граница — оценка следующей целиком

    def test_size_and_pct(self):
        self.assertEqual([cb.parse_size(x) for x in ("S", "m", "L", "6", "6%", "6,5 %")],
                         [0.03, 0.07, 0.15, 0.06, 0.06, 0.065])
        for bad in ("XL", "0", "150%", ""):
            self.assertRaises(ValueError, cb.parse_size, bad)
        self.assertEqual([cb.pct(x) for x in (0.985, 0.87, 0.046, 0.006)], ["98,5", "87", "4,6", "0,6"])


class ParamsTest(unittest.TestCase):
    def test_fallbacks_without_params(self):
        self.assertEqual(cp.w_eff(250_000, {}), (WEFF, "213/250 окна"))
        self.assertEqual(cp.handoff_cost({}), (0.04, "по умолчанию"))
        self.assertEqual(cp.task_estimate("release", {}), (0.10, "по умолчанию"))
        self.assertEqual(cp.calibration({}), 1.0)

    def test_learned_values(self):
        params = {"w_eff": {"250000": {"tokens": 216_000, "n": 595}}, "reserve": {"tokens": 33_000, "n": 595},
                  "handoff": {"p80": 0.046, "n": 101}, "calibration": {"declared": {"median": 1.3, "n": 6}},
                  "tasks": {"*": {"median": 0.15, "n": 900}, "plan": {"median": 0.035, "n": 30},
                            "boards": {"median": 0.2, "n": 2}}}
        self.assertEqual(cp.w_eff(250_000, params)[0], 216_000)
        self.assertEqual(cp.w_eff(400_000, params), (345_600, "доля 250K по истории"))  # окно без истории — доля
        self.assertEqual(cp.w_eff(1_000_000, params)[0], 864_000)
        own = dict(params, w_eff=dict(params["w_eff"], **{"1000000": {"tokens": 900_000, "n": 5}}))
        self.assertEqual(cp.w_eff(1_000_000, own), (900_000, "история окна"))
        few = dict(params, w_eff=dict(params["w_eff"], **{"1000000": {"tokens": 600_000, "n": 4}}))
        self.assertEqual(cp.w_eff(1_000_000, few)[0], 864_000)  # меньше 5 событий — доля
        self.assertEqual(cp.handoff_cost(params)[0], 0.046)
        self.assertEqual(cp.task_estimate("plan", params)[0], 0.035)
        self.assertEqual(cp.task_estimate("boards", params)[0], 0.15)  # мало замеров роли — все роли
        self.assertEqual(cp.calibration(params), 1.3)
        self.assertEqual(cp.calibration({"calibration": {"declared": {"median": 0.5, "n": 9}}}), 1.0)  # только вверх
        self.assertEqual(cp.handoff_cost({"handoff": {"p80": 0.5, "n": 9}})[0], cp.H_RANGE[1])


class WindowTest(unittest.TestCase):
    """U больше настроенного окна — окно определено неверно (сессия 1M), а не сигнал передачи."""

    def test_resolve(self):
        self.assertEqual(cp.resolve_window(200_000, True, 494_000), (1_000_000, "модель 1M"))
        self.assertEqual(cp.resolve_window(200_000, False, 494_000), (1_000_000, "U больше окна"))
        self.assertEqual(cp.resolve_window(None, False, 494_000), (1_000_000, "U больше окна"))
        self.assertEqual(cp.resolve_window(250_000, True, 216_000), (250_000, "настройки"))  # влезает — настройки
        self.assertEqual(cp.resolve_window(250_000, False, 254_000), (250_000, "настройки"))  # ≤ окна × 1,02
        self.assertEqual(cp.resolve_window(None, True, 150_000), (1_000_000, "модель 1M"))
        self.assertEqual(cp.resolve_window(None, False, 150_000), (200_000, "по умолчанию"))
        self.assertEqual(cp.resolve_window(None, False, None), (200_000, "по умолчанию"))

    def test_model_mark(self):
        for name in ("opus[1m]", "claude-opus-5-5[1m]", "claude-sonnet-4-5-1m", "Opus [1M]"):
            self.assertTrue(cp.is_1m(name), name)
        for name in ("claude-opus-5-5", "claude-haiku-4-5-20251001", "opus", "x-11m", None, ""):
            self.assertFalse(cp.is_1m(name), name)


class Sandbox(unittest.TestCase):
    """Хук и CLI на временном каталоге: окно 250K из env, без params.json → W_eff 213K, H 4 %, T 10 %."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.budget, self.projects = root / "budget", root / "projects"
        (self.projects / "p").mkdir(parents=True)
        self.sid = "sess-%d" % os.getpid()
        self.tr = self.projects / "p" / (self.sid + ".jsonl")
        self.tr.write_text("", encoding="utf-8")
        self.env = {k: v for k, v in os.environ.items() if k not in KNOBS}
        self.env.update(CTX_BUDGET_DIR=str(self.budget), CTX_BUDGET_PROJECTS=str(self.projects),
                        SUCCESSOR_WINDOW_TOKENS="250000", CLAUDE_CODE_SESSION_ID=self.sid,
                        TAIBE_LINEAGE_DIR=str(root / "lineage"), HOME=str(root / "home"),
                        CLAUDE_PROJECT_DIR=str(root / "home"))  # без настроек и модели владельца

    def tearDown(self):
        self.tmp.cleanup()

    def grow(self, share, *extra):
        """Дописать в транскрипт ≥ 24 KB и ответ с контекстом share·W_eff."""
        with open(self.tr, "a", encoding="utf-8") as fh:
            fh.write(user("x" * 25_000) + "".join(extra) + answer(int(share * WEFF)))

    def put(self, tokens, model=None):
        """Дописать ≥ 24 KB и ответ с контекстом tokens."""
        with open(self.tr, "a", encoding="utf-8") as fh:
            fh.write(user("x" * 25_000) + answer(tokens, model=model))

    def state(self):
        return json.loads((self.budget / "sessions" / (self.sid + ".json")).read_text(encoding="utf-8"))

    def hook(self, tool="Read", tool_input=None, transcript=None):
        payload = {"session_id": self.sid, "transcript_path": str(transcript or self.tr), "tool_name": tool,
                   "tool_input": tool_input or {}}
        r = subprocess.run([sys.executable, "-I", str(HOOK)], input=json.dumps(payload), capture_output=True,
                           text=True, timeout=20, env=self.env)
        self.assertEqual(r.returncode, 0)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"] if r.stdout.strip() else ""

    def cli(self, *args):
        r = subprocess.run([sys.executable, "-I", str(HERE / "ctx_budget.py"), *args], capture_output=True,
                           text=True, timeout=20, env=self.env)
        return r.returncode, r.stdout + r.stderr


class HookTest(Sandbox):
    def test_boundary_at_86_hands_off_once_and_resets_after_compaction(self):
        self.grow(0.80)
        self.assertEqual(self.hook(), "")                     # 80 % — тишина
        self.grow(0.86)
        text = self.hook("Bash", {"command": "git commit -m wip"})  # граница: следующая 10 % + 4 % → 100 %
        self.assertIn("<successor-threshold>передай сейчас", text)
        self.assertIn("= 100 % > потолка 98,5 %", text)
        self.assertIn("spawn_session.sh --handoff <файл>", text)
        self.assertNotIn("80", text.split("(100 %")[0])
        self.grow(0.88)
        self.assertEqual(self.hook(), "")                     # решение не сменилось — тишина
        self.grow(0.30)
        self.assertEqual(self.hook(), "")                     # сжатие: состояние сброшено
        self.assertEqual(self.state()["epoch"], 1)
        self.grow(0.96)
        text = self.hook()                                    # новая эпоха, сразу страховка — шаги целиком
        self.assertIn("страховка", text)
        self.assertIn("По порядку", text)

    def test_task_in_progress_finishes_then_hands_off(self):
        self.grow(0.70)
        self.assertEqual(self.hook(), "")
        self.grow(0.86)                                       # потрачено 16 % > 10 %: остаток 2 % → 0,92
        text = self.hook()
        self.assertIn("<successor-budget>", text)
        self.assertIn("можно закончить текущую", text)
        self.grow(0.95)
        self.assertIn("страховка", self.hook())               # 0,95 ≥ 0,985 − 0,04

    def test_broken_and_missing_transcript_and_switch(self):
        self.tr.write_text('{"usage": oops\n' + "x" * 30_000 + "\n", encoding="utf-8")
        self.assertEqual(self.hook(), "")
        self.assertEqual(self.hook(transcript=Path(self.tmp.name) / "missing.jsonl"), "")
        r = subprocess.run([sys.executable, "-I", str(HOOK)], input="not json", capture_output=True, text=True,
                           timeout=20, env=self.env)
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_switch_off(self):
        self.grow(0.96)
        self.env["SUCCESSOR_AUTO"] = "off"
        self.assertEqual(self.hook(), "")
        del self.env["SUCCESSOR_AUTO"]
        self.assertIn("страховка", self.hook())              # тот же транскрипт — молчал выключатель, не порог


class OneMTest(Sandbox):
    """Окно 1M: U больше настроенного окна — не передача; W_eff 1M — доля выученного 250K (216,9/250)."""

    def setUp(self):
        super().setUp()
        self.env["SUCCESSOR_WINDOW_TOKENS"] = "200000"
        self.budget.mkdir(parents=True)
        (self.budget / "params.json").write_text(json.dumps(
            {"w_eff": {"250000": {"tokens": 216_949, "n": 596}}}), encoding="utf-8")

    def test_1m_model_mark_is_silent(self):
        self.put(494_000, model="claude-opus-5-5[1m]")
        self.assertEqual(self.hook(), "")
        st = self.state()
        self.assertEqual((st["window"], round(st["s"], 2), st["weff"]), (1_000_000, 0.57, 867_796))

    def test_1m_by_u_alone_then_rules_apply(self):
        self.put(494_000)
        self.assertEqual(self.hook(), "")                     # без пометки: U > 200K × 1,02 → окно 1M
        self.assertEqual(self.state()["window"], 1_000_000)
        self.put(30_000)
        self.assertEqual(self.hook(), "")                     # сжатие: окно 1M держится
        self.put(160_000)
        self.assertEqual((self.hook(), self.state()["window"]), ("", 1_000_000))  # 160K < 200K — всё ещё 1M
        self.put(760_000)                                     # s 0,876, задача в работе: остаток 2 % → 0,936
        self.assertIn("можно закончить текущую", self.hook())
        self.put(762_000)                                     # граница: следующая 10 % + 4 % → 1,018
        self.assertIn("<successor-threshold>передай сейчас: контекст 87,8 %",
                      self.hook("Bash", {"command": "git commit -m wip"}))
        self.put(870_000)                                     # s 1,003 ≥ 0,985 − 0,04 — страховка
        self.assertIn("страховка", self.hook())

    def test_status_shows_1m(self):
        self.put(494_000)
        rc, out = self.cli("status")
        self.assertEqual(rc, 0)
        self.assertIn("окно 1000K — U больше окна", out)
        self.assertIn("W_eff 867K — доля 250K по истории", out)
        self.assertIn("решение: контекст 56,9 %", out)


class CliTest(Sandbox):
    def test_next_small_task_at_86_continues(self):
        self.grow(0.86)
        rc, out = self.cli("next", "мелкая правка", "--size", "5%")
        self.assertEqual(rc, 0)
        self.assertIn("можно закончить текущую", out)        # 0,86 + 0,05 + 0,04 = 0,95
        self.grow(0.87)
        self.assertEqual(self.hook(), "")                     # CLI уже сказал — хук не повторяет
        rc, out = self.cli("done")
        self.assertEqual(rc, 0)
        self.assertIn("передай сейчас", out)                  # граница: следующая 10 % → 1,01
        self.grow(0.875)
        self.assertIn("По порядку", self.hook())              # шаги передачи — от хука
        journal = (self.budget / "journal.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("мелкая правка", journal)            # имя задачи не сохраняется
        self.assertNotIn("мелкая правка", (self.budget / "sessions" / (self.sid + ".json")).read_text())

    def test_huge_task_at_70_then_remainder_check(self):
        self.grow(0.70)
        rc, out = self.cli("next", "огромная", "--size", "50%")
        self.assertEqual(rc, 0)
        self.assertIn("передачи до 85 % нет", out)             # 70 % — тишина при любой оценке
        self.grow(0.86)                                       # остаток 50 − 16 = 34 % → 1,24
        text = self.hook()
        self.assertIn("<successor-threshold>передай сейчас: контекст 86 % + задача ~34 %", text)

    def test_status_and_errors(self):
        self.grow(0.5)
        rc, out = self.cli("status")
        self.assertEqual(rc, 0)
        self.assertIn("W_eff 213K — 213/250 окна", out)
        self.assertIn("передача ~4 % (по умолчанию)", out)
        self.assertIn("решение: контекст 50 %", out)
        self.assertFalse((self.budget / "journal.jsonl").exists())  # status ничего не пишет
        self.assertEqual(self.cli("next", "x", "--size", "XL")[0], 2)
        self.env.pop("CLAUDE_CODE_SESSION_ID")
        self.assertEqual(self.cli("status")[0], 2)


class LearnTest(Sandbox):
    def make_history(self):
        proj = Path(self.tmp.name) / "proj"
        (proj / ".claude").mkdir(parents=True)
        (proj / ".claude/settings.json").write_text('{"autoCompactWindow": 250000}', encoding="utf-8")
        cwd = str(proj)
        for i in range(5):  # пять автосжатий: U перед ними 216K
            (self.projects / "p" / ("c%d.jsonl" % i)).write_text(
                answer(150_000, cwd=cwd) + user() + answer(216_000, cwd=cwd) + compact(221_000) + answer(30_000, cwd=cwd),
                encoding="utf-8")
        for i in range(5):  # пять сессий 1M без настроек окна: у трёх пометка модели, у двух — только U
            model = "claude-opus-5-5[1m]" if i < 3 else "claude-opus-5-5"
            (self.projects / "p" / ("m%d.jsonl" % i)).write_text(
                answer(400_000, model=model) + answer(900_000, model=model) + compact(905_000), encoding="utf-8")
        (self.projects / "p" / "work.jsonl").write_text("".join([
            answer(60_000, cwd=cwd), user(),
            answer(90_000, [bash("git commit -m 'fix'")], cwd=cwd),
            answer(500_000, sidechain=True, cwd=cwd),
            answer(120_000, [bash("gh pr create --title t")], cwd=cwd),
            answer(150_000, [bash("git -C /x commit -m y")], cwd=cwd),
            answer(160_000, cwd=cwd), inject(),
            answer(170_000, [("mcp__plugin_claude-mem_mcp-search__work_state_write", {"now": SECRET})], cwd=cwd),
            answer(175_000, [bash("bash eval/tools/spawn_session.sh --handoff /tmp/h.md")], cwd=cwd),
            answer(180_000, cwd=cwd)]), encoding="utf-8")
        (self.projects / "p" / "broken.jsonl").write_text('{"type":"assistant", oops\n\x00\xff', encoding="utf-8")
        self.budget.mkdir(parents=True)
        rows = [{"sid": "work", "role": "release", "ev": "start", "seq": 0, "u": 1, "weff": 1, "t": 0.1}]
        for i in range(5):  # заявленные задачи: оценка 5 %, факт 6 %
            rows += [{"sid": "j", "seq": i, "ev": "start", "u": 0, "weff": 100_000, "t": 0.05, "explicit": True},
                     {"sid": "j", "seq": i, "ev": "end", "u": 6_000, "weff": 100_000}]
        (self.budget / "journal.jsonl").write_text("".join(dumps(r) for r in rows), encoding="utf-8")

    def test_learn_numbers_and_privacy(self):
        self.make_history()
        rc, out = self.cli("learn", "--days", "3650")
        self.assertEqual(rc, 0, out)
        params = json.loads((self.budget / "params.json").read_text(encoding="utf-8"))
        self.assertEqual(params["w_eff"]["250000"]["tokens"], 216_000)
        self.assertEqual(params["w_eff"]["250000"]["n"], 5)
        self.assertNotIn("reserve", params)
        self.assertEqual(params["w_eff"]["1000000"], {"tokens": 900_000, "ratio": 0.9, "n": 5, "p10": 900_000,
                                                      "p90": 900_000})  # 1M: пометка модели или U больше окна
        seg = round(30_000 / 216_000, 4)
        self.assertEqual(params["tasks"]["*"], {"median": seg, "p80": seg, "n": 3})
        self.assertEqual(params["tasks"]["release"]["n"], 3)  # роль — из журнала бюджета
        self.assertEqual(params["handoff"]["n"], 1)
        self.assertAlmostEqual(params["handoff"]["median"], 10_000 / 216_000, places=4)  # с первого work_state
        self.assertEqual(params["calibration"]["declared"], {"median": 1.2, "p80": 1.2, "n": 5})
        blob = json.dumps(params, ensure_ascii=False) + out.split(" → ")[0]
        for leak in ("Иванов", "999", "fix", "proj", "/tmp/h.md"):
            self.assertNotIn(leak, blob)
        self.assertIn("W_eff 250K→216K", out)

    def test_learn_dry_run_and_empty(self):
        rc, out = self.cli("learn", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertIn("learn: 1 транскриптов", out)
        self.assertFalse((self.budget / "params.json").exists())
        rc, _ = self.cli("learn", "--projects", str(Path(self.tmp.name) / "none"), "--out",
                         str(Path(self.tmp.name) / "o.json"))
        self.assertEqual(rc, 0)
        self.assertEqual(self.cli("learn", "--days", "x")[0], 2)

    def test_role_by_lineage_time(self):
        starts = [(1000.0, "plan"), (1026.0, "release")]
        self.assertEqual(cp.role_by_start(starts, 1030.0), "release")
        self.assertEqual(cp.role_by_start(starts, 1020.0), "plan")
        self.assertIsNone(cp.role_by_start(starts, 5000.0))
        self.assertIsNone(cp.role_by_start(starts, 10.0))


if __name__ == "__main__":
    unittest.main()
