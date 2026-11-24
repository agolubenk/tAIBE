# -*- coding: utf-8 -*-
"""SE-50: вердикты линз в теле PR. Тела — по форме HR #668–#679 и прежних HR PR (#604, #635, #640): разделы, цифры,
таблицы; текст вымышленный, из HR взяты только структура, колонки и слова вердиктов."""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gh_source  # noqa: E402
import quorum  # noqa: E402
import sources  # noqa: E402
from journal import read_from  # noqa: E402
from test_nerve import CFG, LR, TEAM, FakeCtx, FakeGh, _pr  # noqa: E402

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


def hr_gh(text, upd="2026-11-14T03:00:00Z", ci="SUCCESS", comments=None):
    """FakeGh с одним HR PR #643 на HEAD: тело — text, CI — ci в gh pr view."""
    return FakeGh([_pr(643, HEAD, upd)], bodies={643: text}, ci={643: ci}, comments=comments)


def views(fake):
    """Поля --json каждого gh pr view."""
    return [c[c.index("--json") + 1] for c in fake.calls if c[:3] == ["gh", "pr", "view"]]


def body_reads(fake):
    return [f for f in views(fake) if "body" in f.split(",")]


class PollBodyTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.ctx = FakeCtx(self.d)
        self.addCleanup(setattr, sources, "run", sources.run)

    def kinds(self):
        return [e["kind"] for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0]]

    def pr(self):
        return self.ctx.state["github"]["prs"]["643"]

    def poll(self, fake):
        sources.run = fake
        gh_source.poll_github(self.ctx)
        return fake

    def test_body_table_reaches_quorum_without_comments(self):
        self.poll(hr_gh(hr_body(ROWS)))
        self.assertIn("pr.quorum", self.kinds())

    def test_body_edit_after_a_lens_changes_comment_does_not_drop_it(self):
        """Проба Контроля на af1175836: approve release, plan и «ресурсы» в теле, changes Контроля в комментарии на ту же
        голову. Правка тела позже комментария раньше давала кворум; теперь changes остаётся при любой правке."""
        rows = [f"| гейт и безопасность (роль 5) | Контроль | {H} | accept |", f"| продукт (роль 2) | — | {H} | accept |",
                f"| ресурсы | — | {H} | accept |"]
        said = {643: [f"Гейт и безопасность — Контроль (роль 5): changes на {H}"]}
        for upd in ("2026-11-14T02:00:00Z", "2026-11-14T04:00:00Z"):
            self.poll(hr_gh(hr_body(rows), upd, comments=said))
            self.assertNotIn("pr.quorum", self.kinds(), upd)
            self.assertEqual(self.pr()["changes_by"], ["release"], upd)
        self.poll(hr_gh(hr_body(rows), "2026-11-14T04:10:00Z"))  # Контроль снял changes
        self.assertIn("pr.quorum", self.kinds())

    def test_body_change_on_the_same_head_without_comments_is_read_again(self):
        """Находка цепочки на 74b6237b3: правка строки тела на той же голове, без комментариев линз. Каждая правка
        (новый updatedAt) разбирается заново: changes → approve даёт кворум, approve → changes возвращает changes_by.
        Тело на той же голове при зелёном CI — один `gh pr view --json body`: без файлов и проверок."""
        fail = ROWS[:3] + [f"| продукт/UX (круг 2) | Контроль | `{H}` | fail, 1 major |", ROWS[4]]
        steps = [(fail, "03:00", ["plan"], 0), (ROWS, "03:10", [], 1), (fail, "03:20", ["plan"], 1)]
        for rows, hm, changes, quorums in steps:
            fake = self.poll(hr_gh(hr_body(rows), f"2026-11-14T{hm}:00Z"))
            self.assertEqual(self.pr()["changes_by"], changes, hm)
            self.assertEqual(self.kinds().count("pr.quorum"), quorums, hm)  # один pr.quorum на голову
            if hm != "03:00":
                self.assertEqual(views(fake), ["body,headRefOid"], hm)
        self.assertNotIn("pr.changes", self.kinds())  # строки тела пишет автор: pr.changes о них не шлётся

    def test_ci_recheck_keeps_the_body_verdicts_without_reading_the_body(self):
        self.poll(hr_gh(hr_body(ROWS), ci="IN_PROGRESS"))
        self.assertNotIn("pr.quorum", self.kinds())
        self.assertTrue(self.pr()["await_ci"])
        fake = self.poll(hr_gh(hr_body(ROWS), ci="SUCCESS"))  # PR не менялся: перепроверка CI, тело не читается
        self.assertEqual((views(fake), body_reads(fake)), (["statusCheckRollup,headRefOid"], []))
        self.assertIn("pr.quorum", self.kinds())

    def test_pending_ci_and_body_are_one_view(self):
        """PR изменился на той же голове при CI pending: тело и проверки — один gh pr view (SE-123)."""
        self.poll(hr_gh(hr_body(), ci="IN_PROGRESS"))
        fake = self.poll(hr_gh(hr_body(ROWS), "2026-11-14T03:10:00Z", ci="SUCCESS"))
        self.assertEqual(views(fake), ["statusCheckRollup,body,headRefOid"])
        self.assertIn("pr.quorum", self.kinds())

    def test_author_line_added_without_push_is_seen(self):
        """Строка «роль N — автор», дописанная без push, видна со следующего изменения PR: approve автора из строки
        тела в кворум не идёт (SE-121)."""
        self.poll(hr_gh(hr_body()))
        self.assertIsNone(self.pr()["author_line"])
        self.poll(hr_gh(f"роль {TEAM.index('plan') + 1} — автор\n\n" + hr_body(ROWS), "2026-11-14T03:10:00Z"))
        self.assertEqual((self.pr()["author_line"], self.pr()["author"]), ("plan", "plan"))
        self.assertNotIn("pr.quorum", self.kinds())

    def test_state_before_se50_is_read_again_20_prs_per_pass(self):
        """PR, разобранные до SE-50 (нет body_verdicts), перечитываются ради тела — не больше GH_NEW_PER_PASS за
        проход. Ревизия состояния та же: догон новых PR не начинается заново."""
        upd, first, many = "2026-11-14T03:00:00Z", 700, gh_source.GH_NEW_PER_PASS + 5
        self.ctx.state["github"] = {"rev": gh_source.GH_STATE_REV, "prs": {str(n): {
            "head": HEAD, "updated": upd, "seen": [], "changes_by": [], "author": "backend", "author_line": None,
            "checks": ["SUCCESS"]} for n in range(first, first + many)}}
        open_prs = [_pr(n, HEAD, upd) for n in range(first, first + many)]
        reads = [len(body_reads(self.poll(FakeGh(open_prs, bodies={first: hr_body(ROWS)})))) for _ in range(3)]
        self.assertEqual(reads, [gh_source.GH_NEW_PER_PASS, 5, 0])
        self.assertIn("pr.quorum", self.kinds())  # #700: вердикты тела старого PR
        self.assertNotIn("pr.new", self.kinds())


def body_519():
    """Тело tAIBE #519 (24.11): таблица раундов opencode автора и строка вердикта Backend, вписанная автором в тело.
    Головы заменены на HEAD/OLD; строки вердиктов — как в PR."""
    rows = [(lens, sha, word) for sha, words in ((O, ("accept, 3 minor → внесены", "accept, 1 major + 1 minor → внесены",
                                                          "accept, 2 minor → внесены")),
                                                 (H, ("accept, 2 minor — без правки", "accept, 1 minor — без правки",
                                                      "accept, 3 minor — без правки")))
            for lens, word in zip(("корректность и отказы", "ресурсы (сервер → сеть → Mac)", "продукт и простота"), words)]
    return "\n".join(["## Адверсариальная проверка", "", "| Линза | Кто | Голова | Вердикт |", "|---|---|---|---|",
                      *[f"| {lens} | opencode | {sha} | {word} |" for lens, sha, word in rows], "",
                      f"**Линза команды — Backend, роль 4** (решение coord 24.11 07:53: аварийный режим, одна линза на "
                      f"PR). Вердикт: **approve на {H}**", ""])


OFF = dict(CFG, github=dict(CFG["github"], body_verdicts=False))
LENS_COMMENTS = [f"Линза Бэкенд (роль 4): approve на {H}", f"Линза Продукт (роль 2): approve на {H}",
                 f"Линза Контроль (роль 5): approve на {H}"]


class BodyVerdictsOffTest(unittest.TestCase):
    """github.body_verdicts: false (tAIBE, COMMON п. 4): кворум — только первые строки комментариев. #519 получил
    ложный pr.quorum 24.11 04:55Z без единого комментария: голоса дали таблица opencode и строка автора в теле."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.ctx = FakeCtx(self.d)
        self.addCleanup(setattr, sources, "run", sources.run)

    def kinds(self):
        return [e["kind"] for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0]]

    def poll(self, fake, cfg=OFF):
        self.ctx.cfg = cfg
        sources.run = fake
        gh_source.poll_github(self.ctx)
        return self.ctx.state["github"]["prs"]["643"]

    def test_519_body_gives_quorum_only_with_body_verdicts_on(self):
        """Правило HR (SE-50) не тронуто: на его конфиге тело #519 — 4 линзы и кворум; у tAIBE — ни одной."""
        self.assertEqual(sorted({v["lens"] for v in body(body_519())}),
                         ["backend", "plan", "корректность и отказы", "ресурсы"])
        self.poll(hr_gh(body_519()), CFG)
        self.assertIn("pr.quorum", self.kinds())

    def test_519_body_gives_no_body_verdicts_for_taibe(self):
        p = self.poll(hr_gh(body_519()))
        self.assertEqual((p["body_verdicts"], p["changes_by"]), ([], []))
        self.assertNotIn("pr.quorum", self.kinds())

    def test_comment_verdicts_still_reach_quorum(self):
        self.poll(hr_gh(body_519(), comments={643: LENS_COMMENTS[:2]}))
        self.assertNotIn("pr.quorum", self.kinds())
        self.poll(hr_gh(body_519(), "2026-11-14T03:10:00Z", comments={643: LENS_COMMENTS}))
        self.assertIn("pr.quorum", self.kinds())

    def test_body_changes_line_does_not_block(self):
        """Тело не голосует и против: changes в теле пишет автор, у tAIBE вердикт — комментарий линзы."""
        text = f"Линза Бэкенд (роль 4): changes на {H}\n\n" + body_519()
        p = self.poll(hr_gh(text, comments={643: LENS_COMMENTS}))
        self.assertEqual(p["changes_by"], [])
        self.assertIn("pr.quorum", self.kinds())

    def test_body_verdicts_stored_before_the_switch_do_not_count(self):
        """Демон разобрал тело по старому правилу (CI шёл), затем продукт выключил голоса тела: перепроверка CI без
        чтения тела кворума не даёт."""
        p = self.poll(hr_gh(body_519(), ci="IN_PROGRESS"), CFG)
        self.assertTrue(p["body_verdicts"] and p["await_ci"])
        p = self.poll(hr_gh(body_519(), ci="SUCCESS"))
        self.assertNotIn("pr.quorum", self.kinds())
        self.assertFalse(p["await_ci"])


if __name__ == "__main__":
    unittest.main()
