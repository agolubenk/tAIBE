#!/usr/bin/env python3
"""AI Council — самопроверка цепочки ревью opencode → GLM → Claude (решение владельца 13.11). stdlib, сети нет.

Вызывается из selftest_pr_review.run: перенос прошедших частей (--resume) без повторного вызова, отметка рецензента,
классы отказов клиента opencode по stderr (не по тексту модели), пустой ответ, таймаут, memguard, нет бинарника.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from ollama import Completion


class _Proc:
    def __init__(self, code=0, out="", err="", hang=False):
        self.returncode, self.out, self.err, self.hang, self.pid = code, out, err, hang, 0

    def communicate(self, timeout=None):
        if self.hang:
            raise subprocess.TimeoutExpired("opencode", timeout or 0)
        return self.out, self.err


def _runner(proc, seen):
    def run(argv, **kw):
        seen.append((argv, kw.get("env", {}).get("OPENCODE_DISABLE_PROJECT_CONFIG")))
        return proc
    return run


def _client(oc, tmp: Path, proc, seen):
    return oc.OpencodeClient(binary=sys.executable, timeout=5, lock_path=tmp / "oc.lock",
                             runner=_runner(proc, seen), killer=lambda _p: None)


def _opencode(check, gr, tmp: Path) -> None:
    import opencode_client as oc
    mg = tmp / "memguard.json"
    mg.write_text(json.dumps({"level": "ok"}))
    oc.MEMGUARD_STATE = mg
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "p"}]
    seen: list = []
    good = '\x1b[0m{"verdict": "accept", "findings": [], "checked": ["rate limit 429 в диффе"]}'
    res = _client(oc, tmp, _Proc(0, good), seen).chat("pr-1", "pr_review.x", "opencode-go/glm-5.3", msgs)
    check("opencode: ответ с ANSI и словами «limit 429» в тексте модели — ok, не квота",
          res.ok and res.text.startswith("{") and gr.parse_answer(res).get("verdict") == "accept"
          and seen and seen[0][1] == "1" and "--agent" in seen[0][0], res.error)
    cases = [(_Proc(1, "", "Error: usage limit reached for this model"), "quota"),
             (_Proc(1, "", "Error: not logged in. Run opencode auth login"), "config"),
             (_Proc(0, "", ""), "other"),
             (_Proc(0, "", "", hang=True), "provider"),
             (_Proc(2, "", "segfault"), "other")]
    kinds = [gr.classify_failure(_client(oc, tmp, p, []).chat("pr-1", "r", "m", msgs).error) for p, _k in cases]
    check("opencode: классы отказов по stderr — квота, нет входа, пусто, таймаут, сбой",
          kinds == [k for _p, k in cases], str(kinds))
    mg.write_text(json.dumps({"level": "critical"}))
    seen = []
    res = _client(oc, tmp, _Proc(0, good), seen).chat("pr-1", "r", "m", msgs)
    check("opencode: memguard critical — не запускается, класс budget (стоп, код 3 → GLM)",
          not res.ok and not seen and gr.classify_failure(res.error) == "budget", res.error)
    mg.write_text(json.dumps({"level": "ok"}))
    res = oc.OpencodeClient(binary="opencode-нет-такого", lock_path=tmp / "oc.lock").chat("pr-1", "r", "m", msgs)
    check("opencode: не установлен — класс config (код 1, цепочка идёт к GLM)",
          gr.classify_failure(res.error) == "config", res.error)


class _Fake:
    def __init__(self, script):
        self.script, self.calls = list(script), 0

    def chat(self, *_a, **_kw):
        self.calls += 1
        return self.script.pop(0)


def _ok(verdict="accept") -> Completion:
    return Completion(True, '{"verdict": "%s", "findings": [{"severity": "minor", "where": "a.py:1", '
                            '"scenario": "s", "fix": "f"}], "checked": ["x"]}' % verdict, None, "m")


def _resume(check, gr) -> None:
    from selftest_pr_review import _sample_diff
    lenses = {"корр": {"focus": "f", "split": True}, "рес": "g", "прод": "h"}
    calls, _s, _w = gr.plan_calls(lenses, _sample_diff(), 3000)
    n_split = sum(c.lens == "корр" for c in calls)
    quota = Completion(False, "", None, "m", 0, 0, 0, "квота подписки opencode: usage limit reached")

    def run(client, prior=None, backend="glm"):
        return gr.run_review(client, calls, pr="1", model="m", prompt_of=lambda c: "p", max_tokens=100,
                             deadline_s=3600.0, log=lambda _m: None, prior=prior, backend=backend)

    first, code1 = run(_Fake([_ok()] * n_split + [quota]), backend="opencode")
    glm = _Fake([_ok("fail"), _ok()])
    second, code2 = run(glm, prior=first)
    check("цепочка: opencode упёрся в квоту (код 3), GLM доделал только непрошедшее (2 вызова), код 0",
          code1 == gr.EXIT_LIMIT and code2 == gr.EXIT_OK and glm.calls == 2 and not second["_meta"]["not_passed"]
          and second["корр"]["status"] == "ok" and len(second["корр"]["findings"]) == n_split,
          f"code1={code1} code2={code2} вызовов GLM {glm.calls}")
    check("цепочка: рецензент каждой линзы в _meta.reviewers, вердикт fail сохранён",
          second["_meta"]["reviewers"] == {"корр": ["opencode"], "рес": ["glm"], "прод": ["glm"]}
          and second["рес"]["verdict"] == "fail", str(second["_meta"]["reviewers"]))


def run(tmp: Path, check) -> None:
    import glm_pr_review as gr
    _opencode(check, gr, tmp)
    _resume(check, gr)
