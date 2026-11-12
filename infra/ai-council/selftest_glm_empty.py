"""AI Council — самопроверка: пустой ответ GLM (OPS-47).

Вызывается из selftest_glm.run. Сети не трогает: ответ провайдера подменён на уровне `_post`.
12.11: линза correctness-failures трижды из трёх вернула пустой content при 9–12K токенов вывода — ниже лимита.
Клиент считал это успехом (ok=True, пустой текст), ревью писало «не JSON» с пустым raw, причина терялась.
Теперь пустой content — отказ с finish_reason, ключами message и completion_tokens_details.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from store import Store  # noqa: E402


def _answer(content, finish="stop", tokens_out=9057, details=None, **message):
    usage = {"prompt_tokens": 3933, "completion_tokens": tokens_out}
    if details is not None:
        usage["completion_tokens_details"] = details
    return {"choices": [{"finish_reason": finish, "message": {"role": "assistant", "content": content, **message}}],
            "usage": usage}


def run(tmp: Path, check, cfg) -> None:
    import cloud as cloud_mod
    import glm_mode
    import glm_pr_review as gr

    with Store(tmp / "glm-empty.db") as store:
        client = cloud_mod.build(cfg, store)
        client.providers["zai"]["key"], client.budget.enabled, client.headroom = "test-key", True, {}
        glm_mode.apply_budget(client, cfg, True)
        model = glm_mode.model_for(cfg, "arbiter")
        msgs = [{"role": "user", "content": "x"}]

        def ask(data):
            client._post = lambda provider, url, body, headers, timeout: (data, "", 200)
            return client.chat("run-e", "pr_review.correctness", model, msgs)

        empty = ask(_answer("", details={"reasoning_tokens": 0}))
        check("пустой ответ GLM (OPS-47): content пуст, рассуждения нет — отказ, а не ok с пустым текстом; в ошибке "
              "finish_reason, ключи message и completion_tokens_details",
              not empty.ok and "finish_reason=stop" in empty.error and "message: content,role" in empty.error
              and '"reasoning_tokens": 0' in empty.error and empty.tokens_out == 9057, empty.error)

        limit = ask(_answer("", finish="length", tokens_out=6000, details={"reasoning_tokens": 5990},
                            reasoning_content="думаю…"))
        check("пустой ответ GLM: finish_reason=length — «израсходовала весь лимит на reasoning» с числом токенов",
              not limit.ok and limit.error.startswith("модель израсходовала весь лимит на reasoning (5990 токенов)")
              and "finish_reason=length" in limit.error, limit.error)

        legacy = ask({"choices": [{"message": {"content": "", "reasoning_content": "x" * 50}}],
                      "usage": {"completion_tokens": 4000}})
        check("пустой ответ GLM: рассуждение без finish_reason — тот же отказ «лимит на reasoning», как до OPS-47",
              not legacy.ok and "израсходовала весь лимит на reasoning (4000 токенов)" in legacy.error, legacy.error)

        other_name = ask(_answer(None, reasoning="r" * 120))
        check("пустой ответ GLM: рассуждение в поле с другим именем и finish_reason=stop — диагностика с длиной "
              "рассуждения, а не догадка про лимит",
              not other_name.ok and "reasoning 120 симв." in other_name.error
              and "message: content,reasoning,role" in other_name.error, other_name.error)

        sensitive = ask(_answer("  ", finish="sensitive"))
        check("пустой ответ GLM: finish_reason=sensitive (фильтр) виден в ошибке",
              not sensitive.ok and "finish_reason=sensitive" in sensitive.error, sensitive.error)

        no_choices = ask({"choices": [], "usage": {}})
        check("пустой ответ GLM: нет choices — отказ с finish_reason=None, без исключения",
              not no_choices.ok and "finish_reason=None" in no_choices.error, no_choices.error)

        normal = ask(_answer('{"verdict": "accept"}'))
        check("пустой ответ GLM: обычный ответ — ok, как раньше", normal.ok and normal.text == '{"verdict": "accept"}',
              normal.error)

        calls, _skipped, _whole = gr.plan_calls({"корр": "корректность"}, "diff --git a/x b/x\n+1\n", 24000)
        client._post = lambda provider, url, body, headers, timeout: (_answer("", finish="stop"), "", 200)
        report, _code = gr.run_review(client, calls, pr="1", model=model, prompt_of=lambda c: "p",
                                      max_tokens=6000, deadline_s=3600.0, log=lambda _m: None)
        part = report["корр"]["parts"][0]
        check("пустой ответ GLM в ревью PR: часть не прошла с причиной finish_reason, а не «не JSON, см. raw»",
              not part["ok"] and "finish_reason=stop" in part["error"] and "raw" not in part, part["error"])

        for text, verdict in (('```json\n{"verdict": "changes", "findings": []}\n```', "fail"),
                              ('{"verdict": "Request changes", "findings": []}', "fail"),
                              ('{"verdict": "APPROVED", "findings": []}', "accept")):
            client._post = (lambda t: lambda provider, url, body, headers, timeout: (_answer(t), "", 200))(text)
            report, _code = gr.run_review(client, calls, pr="1", model=model, prompt_of=lambda c: "p",
                                          max_tokens=6000, deadline_s=3600.0, log=lambda _m: None)
            part = report["корр"]["parts"][0]
            check(f"вердикт-синоним (OPS-47, линза «accept|changes»): {text[:40]!r} → {verdict}",
                  part["ok"] and part["verdict"] == verdict and report["корр"]["verdict"] == verdict, str(part))

        for text, want in (('{"summary": "ok", "findings": []}', "в JSON нет verdict (ключи: findings, summary)"),
                           ('{"verdict": "needs_work", "findings": []}', "verdict «needs_work» — не accept/fail"),
                           ("не json", "ответ не JSON")):
            client._post = (lambda t: lambda provider, url, body, headers, timeout: (_answer(t), "", 200))(text)
            report, _code = gr.run_review(client, calls, pr="1", model=model, prompt_of=lambda c: "p",
                                          max_tokens=6000, deadline_s=3600.0, log=lambda _m: None)
            part = report["корр"]["parts"][0]
            check(f"ответ без вердикта в ревью PR (OPS-47, повтор 12.11 20:58): «{want}», raw — исходный текст",
                  not part["ok"] and part["error"].startswith(want) and part.get("raw") == text, str(part))
