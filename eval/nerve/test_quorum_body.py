# -*- coding: utf-8 -*-
"""SE-50: вердикты линз в теле PR. Тела — по форме HR #668–#679 и прежних HR PR (#604, #635, #640): разделы, цифры,
таблицы; текст вымышленный, из HR взяты только структура, колонки и слова вердиктов."""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gh_poll  # noqa: E402
import quorum  # noqa: E402
import sources  # noqa: E402
from journal import read_from  # noqa: E402
from test_nerve import LR, TEAM, FakeCtx, FakeGh, _pr  # noqa: E402

HEAD = "4a88b01d1" + "0" * 31
OLD = "b88b10899" + "1" * 31
H, O = HEAD[:9], OLD[:9]


def hr_body(verdict_rows=None):
    """Тело HR PR: до вердиктов (verdict_rows=None — «Блок дополню вердиктами») и после (таблица вердиктов)."""
    lines = ["## Что сделано", "", "- загрузка ключей: +3 SELECT на каждые 100 строк", "- без конфликта: 0 новых запросов",
             "", "## Адверсариальная проверка", "",
             "Линзы (x = 3: корректность и отказы · ресурсы · продукт и простота). Цифры: ~90 байт JSON на строку.",
             "", "| Возражение | Проверка |", "| --- | --- |", "| нагрузка на БД | одно поле в том же запросе |", ""]
    if verdict_rows is None:
        lines += ["Линзы: в очереди «окна HR». Блок дополню вердиктами.", ""]
    else:
        lines += ["| Линза | Участник | Голова | Вердикт |", "|---|---|---|---|", *verdict_rows, ""]
    return "\n".join(lines + ["Карточка: APP-00.", "", "🤖 Generated with [Claude Code](https://claude.com/claude-code)"])


ROWS = [f"| корректность и отказы | GLM glm-5 (Контроль) | {H} | accept; п. 3 — исправлено |",
        f"| ресурсы (−5 запросов) | GLM glm-5 (Контроль) | {H} | accept |",
        f"| продукт/UX | GLM glm-5 (Контроль) | {O} | fail, 2 major — п. 1 и 2 исправлены |",
        f"| продукт/UX (круг 2) | Контроль | `{H}` | **OK** |",
        "| безопасность | — | — | ждём |"]


def short(vs):
    return [(v["lens"], v["verdict"], v["sha"][:9]) for v in vs]


def body(text):
    return quorum.body_verdicts(text, LR, TEAM)


class BodyVerdictsTest(unittest.TestCase):
    def test_hr_table_after_fill_reaches_quorum(self):
        vs = body(hr_body(ROWS))
        self.assertEqual(short(vs), [("корректность и отказы", "approve", H), ("ресурсы", "approve", H),
                                     ("plan", "changes", O), ("plan", "approve", H)])
        ok, approved, changes, _ = quorum.quorum(vs, HEAD, ["SUCCESS"])
        self.assertTrue(ok)
        self.assertEqual((approved, changes), (["plan", "корректность и отказы", "ресурсы"], []))

    def test_two_rows_of_one_lens_on_one_head_the_last_row_wins(self):
        fail = f"| продукт/UX | GLM glm-5 (Контроль) | {H} | fail, 1 major |"
        ok = f"| продукт/UX (круг 2) | Контроль | {H} | **OK** |"
        for rows, approved, changes in (([fail, ok], ["plan"], []), ([ok, fail], [], ["plan"])):
            text = "\n".join(["| Линза | Участник | Голова | Вердикт |", "|---|---|---|---|", *rows])
            self.assertEqual(quorum.quorum(body(text), HEAD, [], 1)[1:3], (approved, changes), rows[0])

    def test_hr_body_before_fill_has_no_verdicts(self):
        self.assertEqual(body(hr_body()), [])

    def test_two_column_table_takes_the_sha_after_the_word(self):
        text = "\n".join(["| Линза | Вердикт |", "| --- | --- |", f"| Корректность | **OK** на {H}: статус 200 |",
                          f"| Продукт, текст, доступность | CHANGES 3 на {H} (кнопки) |"])
        self.assertEqual(short(body(text)), [("корректность", "approve", H), ("plan", "changes", H)])

    def test_rows_without_sha_word_or_verdict_column_do_not_count(self):
        no_sha = "\n".join(["| Линза | Вердикт | Замечания |", "|---|---|---|", "| корректность и отказы | accept | 6 minor |"])
        no_word = "\n".join(["| Линза | Голова | Вердикт |", "|---|---|---|", f"| безопасность | {H} | major понижен до minor |"])
        other = "\n".join(["| Линза | Возражение | Решение |", "|---|---|---|", f"| корректность | approve на {H} | — |"])
        for text in (no_sha, no_word, other):
            self.assertEqual(body(text), [], text)

    def test_plain_line_uses_the_comment_parser_and_skips_code_and_quotes(self):
        line = f"**Бэкенд: approve на {H}.**"
        self.assertEqual(short(body(f"Описание\n\n{line}\n")), [("backend", "approve", H)])
        self.assertEqual(body(f"```\n{line}\n```\n> {line}\n"), [])

    def test_role_number_in_the_lens_cell_stays_the_key(self):
        text = "\n".join(["| Линза | Голова | Вердикт |", "|---|---|---|", f"| корректность (роль 4) | {H} | accept |"])
        self.assertEqual(short(body(text)), [("backend", "approve", H)])


def v(lens, verdict, sha=HEAD):
    return {"lens": lens, "verdict": verdict, "sha": sha[:9]}


class WithBodyTest(unittest.TestCase):
    def test_lens_without_a_comment_keeps_its_body_line(self):
        out = quorum.with_body([v("plan", "approve")], [v("backend", "approve")], HEAD)
        self.assertEqual(sorted(x["lens"] for x in out), ["backend", "plan"])

    def test_comment_on_the_head_overrides_the_body_line_of_the_same_lens(self):
        for body_word, said_word in (("approve", "changes"), ("changes", "approve")):
            out = quorum.with_body([v("plan", body_word)], [v("plan", said_word)], HEAD)
            self.assertEqual([x["verdict"] for x in out], [said_word])

    def test_body_changes_without_a_comment_of_that_lens_blocks_the_quorum(self):
        out = quorum.with_body([v("plan", "changes")], [v("backend", "approve")], HEAD)
        self.assertEqual(sorted((x["lens"], x["verdict"]) for x in out), [("backend", "approve"), ("plan", "changes")])
        ok, approved, changes, _ = quorum.quorum(out, HEAD, [], 1)
        self.assertEqual((ok, approved, changes), (False, ["backend"], ["plan"]))

    def test_comment_on_an_old_head_does_not_override_the_body_line(self):
        out = quorum.with_body([v("plan", "approve")], [v("plan", "changes", OLD)], HEAD)
        self.assertEqual(quorum.quorum(out, HEAD, [], 1)[1:3], (["plan"], []))


class BodyGh(FakeGh):
    """FakeGh со своим CI в gh pr view."""

    def __init__(self, open_prs, rollup="SUCCESS", **kw):
        super().__init__(open_prs, **kw)
        self.rollup = rollup

    def __call__(self, cmd, stdin=None, timeout=30):
        if cmd[:3] == ["gh", "pr", "view"]:
            self.calls.append(list(cmd))
            d = {"files": [{"path": "apps/backend/src/x.ts"}], "statusCheckRollup": [{"status": self.rollup}],
                 "state": "OPEN", "mergedAt": None}
            return 0, json.dumps(d), ""
        return super().__call__(cmd, stdin, timeout)

    def asked(self, what):
        return [c for c in self.calls if what in " ".join(c)]


def hr_pr(text, upd="2026-11-14T03:00:00Z"):
    return dict(_pr(643, HEAD, upd), body=text)


class PollBodyTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.ctx = FakeCtx(self.d)
        self._run = sources.run
        self.addCleanup(setattr, sources, "run", self._run)

    def kinds(self):
        return [e["kind"] for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0]]

    def pr(self):
        return self.ctx.state["github"]["prs"]["643"]

    def test_body_table_reaches_quorum_without_comments(self):
        sources.run = BodyGh([hr_pr(hr_body(ROWS))])
        gh_poll.poll_github(self.ctx)
        self.assertIn("pr.quorum", self.kinds())

    def test_body_edit_after_a_lens_changes_comment_does_not_drop_it(self):
        """Проба Контроля на af1175836: approve release, plan и «ресурсы» в теле, changes Контроля в комментарии на ту же
        голову. Правка тела позже комментария раньше давала кворум; теперь changes остаётся при любой правке."""
        rows = [f"| гейт и безопасность (роль 5) | Контроль | {H} | accept |", f"| продукт (роль 2) | — | {H} | accept |",
                f"| ресурсы | — | {H} | accept |"]
        said = {643: [f"Гейт и безопасность — Контроль (роль 5): changes на {H}"]}
        for upd in ("2026-11-14T02:00:00Z", "2026-11-14T04:00:00Z"):
            sources.run = BodyGh([hr_pr(hr_body(rows), upd)], comments=said, etag=f'W/"{upd}"')
            gh_poll.poll_github(self.ctx)
            self.assertNotIn("pr.quorum", self.kinds(), upd)
            self.assertEqual(self.pr()["changes_by"], ["release"], upd)
        sources.run = BodyGh([hr_pr(hr_body(rows), "2026-11-14T04:10:00Z")], etag='W/"e3"')  # Контроль снял changes
        gh_poll.poll_github(self.ctx)
        self.assertIn("pr.quorum", self.kinds())

    def test_body_change_on_the_same_head_without_comments_is_read_again(self):
        """Находка цепочки на 74b6237b3: правка строки тела на той же голове, без комментариев линз. Каждая правка
        (новый updated_at) разбирается заново: changes → approve даёт кворум, approve → changes возвращает changes_by."""
        fail = ROWS[:3] + [f"| продукт/UX (круг 2) | Контроль | `{H}` | fail, 1 major |", ROWS[4]]
        steps = [(fail, "03:00", ["plan"], 0), (ROWS, "03:10", [], 1), (fail, "03:20", ["plan"], 1)]
        for rows, hm, changes, quorums in steps:
            upd = f"2026-11-14T{hm}:00Z"
            sources.run = BodyGh([hr_pr(hr_body(rows), upd)], etag=f'W/"{upd}"')
            gh_poll.poll_github(self.ctx)
            self.assertEqual(self.pr()["changes_by"], changes, hm)
            self.assertEqual(self.kinds().count("pr.quorum"), quorums, hm)  # один pr.quorum на голову
        self.assertNotIn("pr.changes", self.kinds())  # строки тела пишет автор: pr.changes о них не шлётся

    def test_304_refresh_keeps_the_body_verdicts(self):
        sources.run = BodyGh([hr_pr(hr_body(ROWS))], rollup="IN_PROGRESS")
        gh_poll.poll_github(self.ctx)
        self.assertNotIn("pr.quorum", self.kinds())
        self.assertTrue(self.pr()["await_ci"])
        sources.run = BodyGh([hr_pr(hr_body(ROWS))], rollup="SUCCESS")  # тот же etag — 304, тела нет
        gh_poll.poll_github(self.ctx)
        self.assertIn("pr.quorum", self.kinds())

    def test_rev2_state_is_parsed_again_for_the_body(self):
        upd = "2026-11-14T03:00:00Z"
        self.ctx.state["github"] = {"rev": 2, "etag": 'W/"e1"', "prs": {"643": {
            "head": HEAD, "updated": upd, "seen": [], "changes_by": [], "author": "backend", "checks": ["SUCCESS"]}}}
        sources.run = fake = BodyGh([hr_pr(hr_body(ROWS), upd)])
        gh_poll.poll_github(self.ctx)
        self.assertTrue(fake.asked("issues/643/comments"))
        self.assertIn("pr.quorum", self.kinds())
        self.assertEqual(self.ctx.state["github"]["rev"], gh_poll.GH_STATE_REV)


if __name__ == "__main__":
    unittest.main()
