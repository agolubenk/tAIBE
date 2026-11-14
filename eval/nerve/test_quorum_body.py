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


def v(lens, verdict, at=None):
    d = {"lens": lens, "verdict": verdict, "sha": H}
    return d if at is None else dict(d, at=at)


class WithBodyTest(unittest.TestCase):
    def never(self):
        raise AssertionError("время тела запрошено без спора линз")

    def test_no_shared_lens_asks_no_body_time(self):
        out = quorum.with_body([v("plan", "approve")], [v("backend", "approve", "2026-11-13T19:00:00Z")], HEAD, self.never)
        self.assertEqual(sorted(x["lens"] for x in out), ["backend", "plan"])

    def test_newer_line_of_the_same_lens_wins(self):
        body_vs, said = [v("plan", "approve")], [v("plan", "changes", "2026-11-13T19:00:00Z")]
        late = quorum.with_body(body_vs, said, HEAD, lambda: "2026-11-13T19:30:00Z")
        early = quorum.with_body(body_vs, said, HEAD, lambda: "2026-11-13T18:30:00Z")
        tie = quorum.with_body(body_vs, said, HEAD, lambda: "2026-11-13T19:00:00Z")
        self.assertEqual([quorum.quorum(x, HEAD, [], 1)[1:3] for x in (late, early, tie)],
                         [(["plan"], []), ([], ["plan"]), ([], ["plan"])])


class BodyGh(FakeGh):
    """FakeGh с датами комментариев, временем правки тела (graphql) и своим CI в gh pr view."""

    def __init__(self, open_prs, dated=None, edited=None, rollup="SUCCESS", **kw):
        super().__init__(open_prs, **kw)
        self.dated, self.edited, self.rollup = dated or {}, edited, rollup

    def __call__(self, cmd, stdin=None, timeout=30):
        if cmd[:3] == ["gh", "api", "graphql"]:
            self.calls.append(list(cmd))
            pr = {"lastEditedAt": self.edited, "createdAt": "2026-11-13T18:00:00Z"}
            return 0, json.dumps({"data": {"repository": {"pullRequest": pr}}}), ""
        if cmd[:2] == ["gh", "api"] and cmd[-1].startswith(f"repos/{self.REPO}/issues/"):
            self.calls.append(list(cmd))
            n = int(cmd[-1].split("/")[4])
            return 0, json.dumps([{"id": 100 + i, "body": b, "created_at": t}
                                  for i, (b, t) in enumerate(self.dated.get(n, []))]), ""
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
        sources.run = fake = BodyGh([hr_pr(hr_body(ROWS))])
        gh_poll.poll_github(self.ctx)
        self.assertIn("pr.quorum", self.kinds())
        self.assertEqual(fake.asked("graphql"), [], "без спора линз время тела не спрашивается")

    def test_newer_comment_of_the_same_lens_beats_the_body_and_a_later_edit_beats_it(self):
        comment = [(f"**Продукт (роль 2): CHANGES на {H}**", "2026-11-14T02:00:00Z")]
        sources.run = fake = BodyGh([hr_pr(hr_body(ROWS))], dated={643: comment}, edited="2026-11-14T01:30:00Z")
        gh_poll.poll_github(self.ctx)
        self.assertNotIn("pr.quorum", self.kinds())
        self.assertEqual(self.pr()["changes_by"], ["plan"])
        q = fake.asked("graphql")
        self.assertEqual(len(q), 1)
        self.assertIn("o=" + FakeGh.REPO.split("/")[0], q[0])
        self.assertIn("r=" + FakeGh.REPO.split("/")[1], q[0])
        self.assertIn("n=643", q[0])
        sources.run = BodyGh([hr_pr(hr_body(ROWS), "2026-11-14T03:10:00Z")], dated={643: comment},
                             edited="2026-11-14T02:30:00Z", etag='W/"e2"')
        gh_poll.poll_github(self.ctx)
        self.assertIn("pr.quorum", self.kinds())

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
