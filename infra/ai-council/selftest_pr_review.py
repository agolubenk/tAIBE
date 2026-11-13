#!/usr/bin/env python3
"""AI Council — самопроверка ревью PR на GLM (`glm_pr_review.py`, §17.7). Только stdlib, сети нет.

Вызывается из selftest.py: деление диффа по файлам и ханкам без потерь строк, потолок попыток `_post`
(умолчание воркера не меняется), остановка на квоте/бюджете/сети, снятие линзы после 5xx подряд,
общий потолок времени, ответ не JSON, дифф из одних сгенерированных файлов, коды выхода.
"""
from __future__ import annotations

import io
import sys
import urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ollama import Completion        # noqa: E402


def _file(path: str, hunks: list[str]) -> str:
    out = f"diff --git a/{path} b/{path}\nindex 1111111..2222222 100644\n--- a/{path}\n+++ b/{path}\n"
    for i, body in enumerate(hunks):
        out += f"@@ -{i * 10 + 1},3 +{i * 10 + 1},4 @@ ctx\n{body}"
    return out


def _sample_diff() -> str:
    core_hunks = [f" a{i}\n-b{i}\n+c{i}\n+d{i}\n" * 40 for i in range(6)]
    return (_file("infra/ai-council/council.py", core_hunks)
            + _file("infra/ai-council/selftest_x.py", ["+ok = True\n"])
            + _file("apps/frontend/src/App.tsx", ["+<div/>\n"])
            + _file("package-lock.json", ["+\"lock\": 1\n" * 50])
            + _file("docs/specs/ai-council.md", ["+## 17.7\n"]))


def _changed_lines(text: str) -> list[str]:
    return [ln for ln in text.splitlines() if ln[:1] in "+-" and not ln.startswith(("+++", "---"))]


def _split(check, gr) -> None:
    diff = _sample_diff()
    sections = gr.split_diff(diff)
    check("ревью PR: дифф делится по файлам", [p for p, _ in sections] == [
        "infra/ai-council/council.py", "infra/ai-council/selftest_x.py", "apps/frontend/src/App.tsx",
        "package-lock.json", "docs/specs/ai-council.md"])
    check("ревью PR: группы файлов", [gr.file_group(p) for p, _ in sections] ==
          ["core", "tests", "ui", "generated", "core"], str([gr.file_group(p) for p, _ in sections]))
    parts, skipped = gr.plan_parts(diff, 3000)
    check("ревью PR: сгенерированное не отправляется", skipped == ["package-lock.json"]
          and all("package-lock" not in "".join(p.files) for p in parts))
    groups = [p.group for p in parts]
    check("ревью PR: ядро отдельно от тестов и UI, по порядку",
          groups == sorted(groups, key=gr.GROUPS.index) and {"core", "tests", "ui"} <= set(groups), str(groups))
    check("ревью PR: часть не больше лимита", all(len(p.text) <= 3000 for p in parts),
          str([len(p.text) for p in parts]))
    sent = [ln for p in parts for ln in _changed_lines(p.text)]
    want = [ln for path, s in sections if path != "package-lock.json" for ln in _changed_lines(s)]
    check("ревью PR: ни одна строка диффа не потеряна и не задвоена", sorted(sent) == sorted(want),
          f"{len(sent)} vs {len(want)}")
    check("ревью PR: заголовок файла повторяется в каждой части",
          all(p.text.startswith("diff --git") for p in parts))
    core = [p.label for p in parts if p.group == "core"]
    check("ревью PR: подписи частей", len(core) > 1 and core[0] == f"core 1/{len(core)}", str(core))
    check("ревью PR: дифф без заголовков — одной частью", gr.split_diff("+x\n") == [("(дифф)", "+x\n")]
          and gr.split_diff("") == [])
    calls, skipped, whole = gr.plan_calls({"a": {"focus": "f", "split": True}, "b": "g"}, diff, 3000)
    check("ревью PR: делится только линза с split", sum(c.lens == "a" for c in calls) == len(parts)
          and [c.part for c in calls if c.lens == "b"] == [None] and "package-lock" not in whole)
    prompt = gr.build_prompt(calls[0], "описание", whole, skipped, [p for p, _ in sections])
    check("ревью PR: в части — её файлы и список остальных",
          "Часть core 1/" in prompt and "apps/frontend/src/App.tsx" in prompt and "Не показаны" in prompt)
    try:
        gr.normalize_lenses({"x": 1})
        check("ревью PR: кривая линза отклоняется", False)
    except ValueError:
        check("ревью PR: кривая линза отклоняется", True)


def _generated_only(check, gr, tmp: Path) -> None:
    lock_only = _file("package-lock.json", ["+\"x\": 1\n" * 30])
    _calls, skipped, whole = gr.plan_calls({"a": "f"}, lock_only, 3000)
    check("ревью PR: только сгенерированное — отправлять нечего", whole == "" and skipped == ["package-lock.json"])
    path = tmp / "lock-only.diff"
    path.write_text(lock_only)
    code = gr.main(["1", str(tmp / "out.json"), "--diff-file", str(path)])
    check("ревью PR: только сгенерированное — выход 0 без вызовов и без базы", code == gr.EXIT_OK
          and not (tmp / "out.json").exists())


def _retries(check) -> None:
    import cloud
    import urllib.request
    seen: list = []

    def fake_urlopen(req, timeout=None, context=None):
        seen.append(timeout)
        raise urllib.error.HTTPError(req.full_url, 502, "Bad Gateway", {}, io.BytesIO(b'{"error":"proxy_error"}'))

    orig_open, orig_sleep = urllib.request.urlopen, cloud.time.sleep
    urllib.request.urlopen, cloud.time.sleep = fake_urlopen, (lambda _s: None)
    try:
        client = cloud.CloudClient()
        data, err, code = client._post("zai", "http://127.0.0.1:9/x", {}, {}, 7)
        check("ревью PR: умолчание воркера — прежние 4 попытки на 502",
              data is None and code == 502 and len(seen) == cloud.MAX_RETRIES_429 + 1, f"{len(seen)} попыток")
        seen.clear()
        client.max_retries = 1
        client._post("zai", "http://127.0.0.1:9/x", {}, {}, 7)
        check("ревью PR: max_retries=1 — ровно 2 попытки", len(seen) == 2 and seen == [7, 7], str(seen))
    finally:
        urllib.request.urlopen, cloud.time.sleep = orig_open, orig_sleep


class _FakeClient:
    def __init__(self, script):
        self.script, self.roles = list(script), []

    def chat(self, run_id, role, model, messages, **_kw):
        self.roles.append(role)
        return self.script.pop(0)


def _ok(verdict: str, where: str = "a.py:1") -> Completion:
    return Completion(True, '{"verdict": "%s", "findings": [{"severity": "major", "where": "%s", "scenario": "s", '
                            '"fix": "f"}], "checked": ["x"]}' % (verdict, where), None, "glm-5")


def _err(error: str) -> Completion:
    return Completion(False, "", None, "glm-5", 0, 0, 0, error)


def _review(check, gr) -> None:
    import cloud
    diff = _sample_diff()
    calls, skipped, whole = gr.plan_calls({"корр": {"focus": "f", "split": True}, "рес": "g", "прод": "h"},
                                          diff, 3000)
    n_split = sum(c.lens == "корр" for c in calls)

    def run(script, clock=None, deadline=3600.0):
        client = _FakeClient(script)
        kw = {"clock": clock} if clock else {}
        report, code = gr.run_review(client, calls, pr="1", model="glm-5", prompt_of=lambda c: "p", max_tokens=6000,
                                     deadline_s=deadline, log=lambda _m: None, **kw)
        return report, code, client

    report, code, _c = run([_ok("accept")] * (n_split - 1) + [_ok("fail")] + [_ok("accept"), _ok("accept")])
    check("ревью PR: всё прошло — код 0, вердикт части fail = fail линзы",
          code == gr.EXIT_OK and report["корр"]["verdict"] == "fail" and report["корр"]["status"] == "ok"
          and report["рес"]["verdict"] == "accept" and not report["_meta"]["not_passed"]
          and all("part" in f for f in report["корр"]["findings"]), f"code={code}")

    quota = f"HTTP 429: 1310 — {cloud.QUOTA_ERROR_MARK}. Повторы не помогут"
    report, code, client = run([_err(quota)])
    check("ревью PR: квота — стоп сразу, код 3, остальное не запускалось",
          code == gr.EXIT_LIMIT and len(client.roles) == 1 and report["рес"]["status"] == "skipped"
          and len(report["_meta"]["not_passed"]) == len(calls) and report["_meta"]["stopped"].startswith("quota"),
          f"code={code}, вызовов {len(client.roles)}")
    report, code, client = run([_err("исчерпано окно плана: 100/100 вызовов за последние 5 ч")])
    check("ревью PR: окно бюджета — стоп, код 3", code == gr.EXIT_LIMIT and len(client.roles) == 1)

    bad = "HTTP 502: proxy_error"
    report, code, client = run([_err(bad), _err(bad)] + [_ok("accept")] * len(calls))
    check("ревью PR: два 502 подряд в линзе — её остаток не идёт, другие линзы идут, код 2",
          code == gr.EXIT_NOT_PASSED and len(client.roles) == len(calls) - n_split + 2
          and report["корр"]["status"] == "failed" and report["рес"]["ok"] and report["прод"]["ok"]
          and len(report["_meta"]["not_passed"]) == n_split and "корр" in report["_meta"]["dropped_lenses"]
          and not report["_meta"]["stopped"], f"code={code}, вызовов {len(client.roles)}")
    report, code, client = run([_err("сеть/zai: timed out")] + [_ok("accept")] * len(calls))
    check("ревью PR: сеть недоступна — стоп всего ревью", code == gr.EXIT_NOT_PASSED and len(client.roles) == 1
          and report["_meta"]["stopped"].startswith("network"), f"вызовов {len(client.roles)}")
    report, code, client = run([_err(bad), _ok("accept"), _err(bad)] + [_ok("accept")] * len(calls))
    check("ревью PR: сбой, затем успех — счётчик подряд сброшен, ревью дошло до конца",
          len(client.roles) == len(calls) and report["корр"]["status"] == "partial"
          and len(report["_meta"]["not_passed"]) == 2, f"вызовов {len(client.roles)}")

    report, code, client = run([Completion(True, "не json", None, "glm-5")] + [_ok("accept")] * len(calls))
    check("ревью PR: ответ не JSON — часть не пройдена, raw сохранён, ревью идёт дальше",
          code == gr.EXIT_NOT_PASSED and len(client.roles) == len(calls)
          and report["корр"]["parts"][0].get("raw") == "не json")

    ticks = iter(range(0, 100000, 1000))
    report, code, client = run([_ok("accept")] * len(calls), clock=lambda: next(ticks), deadline=1500.0)
    check("ревью PR: общий потолок времени — дальше не запускается",
          len(client.roles) < len(calls) and "потолок" in report["_meta"]["stopped"] and code == gr.EXIT_NOT_PASSED,
          f"вызовов {len(client.roles)} из {len(calls)}")

    kinds = [gr.classify_failure(e) for e in (quota, "квота подписки zai исчерпана до 16.10 01:14",
                                               "исчерпан суточный лимит вызовов (5/5)", "нет ключа для zai",
                                               "HTTP 429: ... — обращение ушло на pay-as-you-go контур", bad,
                                               "сеть/zai: timed out", "zai недоступен (кэш-маркер сбоя)",
                                               "модель израсходовала весь лимит на reasoning")]
    check("ревью PR: классы отказов", kinds == ["quota", "quota", "budget", "config", "config", "provider",
                                                "network", "network", "other"], str(kinds))


def run(tmp: Path, check) -> None:
    import glm_pr_review as gr
    _split(check, gr)
    _generated_only(check, gr, tmp)
    _retries(check)
    _review(check, gr)
    import selftest_review_chain
    selftest_review_chain.run(tmp, check)
