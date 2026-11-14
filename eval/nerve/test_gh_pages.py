# -*- coding: utf-8 -*-
"""SE-92: список открытых PR страницами по gh_poll.PAGE, ETag и кэш у каждой страницы, без ложного «закрыт»."""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gh_poll  # noqa: E402
import sources  # noqa: E402
from journal import read_from  # noqa: E402
from test_nerve import FakeCtx, FakeGh, _pr  # noqa: E402


class GhPagesTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.ctx = FakeCtx(self.d)
        self._run = sources.run
        self.addCleanup(setattr, sources, "run", self._run)
        gh_poll._PAGES.clear()
        self.addCleanup(gh_poll._PAGES.clear)

    def kinds(self):
        return [(e["kind"], e["text"]) for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0]]

    @staticmethod
    def seen(sha, upd="2026-11-04T10:00:00Z"):
        return {"head": sha, "updated": upd, "seen": [], "changes_by": [], "author": "backend", "checks": ["SUCCESS"],
                "body_verdicts": []}

    @staticmethod
    def asked(fake, since=0):
        """(список: страницы с If-None-Match или без, комментарии: номера, pr view: номера) после since вызовов."""
        lists, comments, views = [], [], []
        for c in fake.calls[since:]:
            if c[:3] == ["gh", "pr", "view"]:
                views.append(int(c[3]))
            elif "/issues/" in c[-1]:
                comments.append(int(c[-1].split("/")[4]))
            else:
                lists.append((int(c[-1].rsplit("page=", 1)[1]), "-H" in c))
        return lists, comments, views

    def test_all_pages_are_read_and_only_a_changed_page_is_downloaded_again(self):
        """SE-92: открыто 120 PR, читалась одна страница из 50 — #1…#70 ложно «закрыт» и без кворума."""
        sha = {n: f"{n:040x}" for n in range(1, 121)}
        approve = [f"**{lens}: approve на {sha[3][:9]}**" for lens in ("Бэкенд", "Фронтенд", "Продукт")]
        self.ctx.state["github"] = {"rev": gh_poll.GH_STATE_REV, "prs": {"5": self.seen(sha[5])}}
        prs = [_pr(n, sha[n]) for n in range(120, 0, -1)]  # как у GitHub: новые сверху
        sources.run = fake = FakeGh(prs, comments={3: approve})
        gh_poll.poll_github(self.ctx)
        st, kinds = self.ctx.state["github"], self.kinds()
        self.assertEqual(self.asked(fake)[0], [(1, False), (2, False), (3, False)])
        self.assertEqual(len(st["prs"]), 120)
        self.assertNotIn("pr.closed", [k for k, _ in kinds])
        self.assertIn("pr.quorum", [k for k, _ in kinds if "#3 " in _])
        before = len(fake.calls)
        gh_poll.poll_github(self.ctx)  # ничего не менялось: три 304, ни одного PR в разбор
        self.assertEqual(self.asked(fake, before), ([(1, True), (2, True), (3, True)], [], []))
        prs[110] = _pr(10, "a" * 40, "2026-11-04T12:00:00Z")  # новая голова у #10 — меняется только страница 3
        sources.run = fake = FakeGh(prs, etags={3: 'W/"p3-new"'})
        gh_poll.poll_github(self.ctx)
        self.assertEqual(self.asked(fake), ([(1, True), (2, True), (3, True)], [10], [10]),
                         "страницы 1–2 из кэша, без «закрыт» и без лишних gh pr view")
        self.assertEqual(st["prs"]["10"]["head"], "a" * 40)

    def test_shifted_pages_repeat_a_pr_and_hide_an_open_one_without_a_false_close(self):
        """Между запросами страниц PR закрылся: номер на двух страницах, живой PR ни на одной (SE-92)."""
        sha = {n: f"{n:040x}" for n in range(1, 61)}
        prs = [_pr(n, sha[n]) for n in range(60, 0, -1)]  # prs[49] — #11, prs[50] — #10
        self.ctx.state["github"] = {"rev": gh_poll.GH_STATE_REV,
                                    "prs": {"10": self.seen(sha[10]), "99": self.seen("9" * 40)}}
        sources.run = fake = FakeGh(prs, pages={1: prs[:50], 2: [prs[49]] + prs[51:]}, closed={99})
        gh_poll.poll_github(self.ctx)
        kinds = self.kinds()
        self.assertIn("10", self.ctx.state["github"]["prs"])
        self.assertNotIn(("pr.closed", "#10 закрыт"), kinds)
        self.assertIn(("pr.closed", "#99 закрыт"), kinds)
        self.assertEqual(kinds.count(("pr.new", "#11 открыт: PR 11")), 1)
        self.assertEqual(self.asked(fake)[1].count(11), 1, "повтор номера не разбирается второй раз")

    def test_more_pages_than_the_limit_raise_and_close_nothing(self):
        self.addCleanup(setattr, gh_poll, "MAX_PAGES", gh_poll.MAX_PAGES)
        gh_poll.MAX_PAGES = 2
        self.ctx.state["github"] = {"rev": gh_poll.GH_STATE_REV, "prs": {"500": self.seen("5" * 40)}}
        sources.run = FakeGh([_pr(n, "a" * 40) for n in range(100, 0, -1)])
        with self.assertRaisesRegex(RuntimeError, "больше 100 открытых PR, список неполный"):
            gh_poll.poll_github(self.ctx)
        self.assertIn("500", self.ctx.state["github"]["prs"])
        self.assertEqual(self.kinds(), [])
        sources.run = FakeGh([_pr(n, "a" * 40) for n in range(99, 0, -1)], closed={500})  # 2-я страница неполная
        gh_poll.poll_github(self.ctx)
        self.assertIn(("pr.closed", "#500 закрыт"), self.kinds())
        self.assertFalse("500" in self.ctx.state["github"]["prs"])


if __name__ == "__main__":
    unittest.main()
