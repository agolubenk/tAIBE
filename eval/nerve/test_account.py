# -*- coding: utf-8 -*-
"""Квота окна 5 ч по аккаунту входа (account.py): метка волны, пересчёт по тарифу, случай 18–19.11."""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import account  # noqa: E402
import actions  # noqa: E402
import budget  # noqa: E402
from test_nerve import CFG, MSK, FakeCtx  # noqa: E402

UUID_A, UUID_B = "11111111-aaaa-4aaa-8aaa-000000000001", "22222222-bbbb-4bbb-8bbb-000000000002"
LIMIT = "You've hit your session limit · resets 2:40pm (Europe/Minsk)"


def write_login(d, uuid, tier, email="owner@example.com"):
    p = os.path.join(d, "claude.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"numStartups": 7, "oauthAccount": {"accountUuid": uuid, "emailAddress": email,
                                                       "organizationRateLimitTier": tier}}, f)
    return p


class TierTest(unittest.TestCase):
    def test_multiplier_by_tier(self):
        self.assertEqual(account.tier_mult("default_claude_max_20x"), 20)
        self.assertEqual(account.tier_mult("default_claude_max_5x"), 5)
        self.assertEqual(account.tier_mult("default_claude_pro"), 1)
        for t in (None, "", "default_claude_ai", 5, "max_0x"):
            self.assertIsNone(account.tier_mult(t), t)


class CurrentTest(unittest.TestCase):
    def test_login_gives_short_hash_and_multiplier_without_personal_data(self):
        with tempfile.TemporaryDirectory() as d:
            a = account.current(write_login(d, UUID_A, "default_claude_max_5x"))
            self.assertEqual(a["mult"], 5)
            self.assertRegex(a["id"], r"^[0-9a-f]{12}$")
            self.assertNotIn("example", json.dumps(a))
            self.assertNotIn(UUID_A[:8], json.dumps(a))
            self.assertNotEqual(a["id"], account.current(write_login(d, UUID_B, "default_claude_max_5x"))["id"])

    def test_no_file_bad_json_or_no_account_is_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(account.current(os.path.join(d, "nope.json")))
            bad = os.path.join(d, "bad.json")
            for body in ("{", "[]", '{"oauthAccount": null}', '{"oauthAccount": {"accountUuid": ""}}'):
                with open(bad, "w") as f:
                    f.write(body)
                self.assertIsNone(account.current(bad), body)

    def test_env_path(self):
        with tempfile.TemporaryDirectory() as d:
            p = write_login(d, UUID_A, "default_claude_max_20x")
            with mock.patch.dict(os.environ, {account.ENV: p}):
                self.assertEqual(account.current()["mult"], 20)

    def test_observe_keeps_first_seen_until_login_changes(self):
        with tempfile.TemporaryDirectory() as d:
            st = {}
            p = write_login(d, UUID_A, "default_claude_max_20x")
            self.assertEqual(account.observe(st, 100.0, p)["since"], 100.0)
            self.assertEqual(account.observe(st, 200.0, p)["since"], 100.0, "тот же вход — since не двигается")
            p = write_login(d, UUID_B, "default_claude_max_5x")
            self.assertEqual(account.observe(st, 300.0, p)["since"], 300.0, "новый вход — since заново")
            self.assertIsNone(account.observe(st, 400.0, os.path.join(d, "nope.json")))
            self.assertEqual(st["acct_seen"]["since"], 300.0, "нет файла — память о входе не трогается")


def wave(usd, acct=None, mult=None):
    w = {"hit": "", "reset": "", "usd": usd}
    if acct:
        w.update(acct=acct, mult=mult)
    return w


class QuotaTest(unittest.TestCase):
    A = {"id": "aaaaaaaaaaaa", "mult": 20}
    B = {"id": "bbbbbbbbbbbb", "mult": 5}

    def test_own_waves_first(self):
        ws = [wave(170, "aaaaaaaaaaaa", 20), wave(180, "aaaaaaaaaaaa", 20), wave(40, "bbbbbbbbbbbb", 5)]
        self.assertEqual(account.quota(ws, 6, self.B), (40, "account"))
        self.assertEqual(account.quota(ws, 6, self.A), (175, "account"))

    def test_new_account_scaled_by_tier(self):
        ws = [wave(170, "aaaaaaaaaaaa", 20), wave(190, "aaaaaaaaaaaa", 20)]
        q, src = account.quota(ws, 6, self.B)
        self.assertEqual(src, "tier")
        self.assertAlmostEqual(q, 45.0)
        self.assertAlmostEqual(account.quota([wave(45, "bbbbbbbbbbbb", 5)], 6, self.A)[0], 180.0)

    def test_untagged_waves_and_unknown_login_keep_old_median(self):
        ws = [wave(160), wave(170), wave(0), wave(180)]
        self.assertEqual(account.quota(ws, 6, None), (170, "all"))
        self.assertEqual(account.quota(ws, 6, {"id": "cccccccccccc", "mult": None}), (170, "all"))
        self.assertEqual(account.quota(ws, 6, self.B), (170, "all"), "волн с множителем нет — пересчитать нечем")
        self.assertEqual(account.quota([], 6, self.B), (None, "default"))

    def test_last_n_waves_only(self):
        ws = [wave(10, "aaaaaaaaaaaa", 20)] * 5 + [wave(200, "aaaaaaaaaaaa", 20)] * 3
        self.assertEqual(account.quota(ws, 3, self.A)[0], 200)

    def test_incident_1911_quota_follows_the_5x_account(self):
        """18–19.11: шесть волн 20x ~$165–190, вход сменили на 5x, окна $28 и $45. До фикса квота $175 (медиана
        всех) — предвестник 80 % не сработал; теперь квота — по волнам 5x."""
        ws = [wave(u, "aaaaaaaaaaaa", 20) for u in (162.19, 168.17, 184.62, 187.81, 185.58)] + \
             [wave(27.98, "bbbbbbbbbbbb", 5), wave(45.52, "bbbbbbbbbbbb", 5)]
        legacy = budget.median([w["usd"] for w in ws][-6:])
        self.assertGreater(legacy, 160)
        q, src = account.quota(ws, 6, self.B)
        self.assertEqual(src, "account")
        self.assertAlmostEqual(q, 36.75)
        self.assertLess(0.8 * q, 45.52, "предвестник теперь раньше отказа")


class ActionsTest(unittest.TestCase):
    def test_quota5_reads_login_and_records_source(self):
        with tempfile.TemporaryDirectory() as d:
            p = write_login(d, UUID_B, "default_claude_max_5x")
            st = {"waves": [wave(170, "x", 20), wave(190, "x", 20)]}
            with mock.patch.dict(os.environ, {account.ENV: p}):
                self.assertAlmostEqual(actions.quota5(st, CFG), 45.0)
            self.assertEqual(st["quota_src"], "tier")
            st2 = {"waves": []}
            self.assertEqual(actions.quota5(st2, CFG, acct=None), CFG["budget"]["quota5h_default"])
            self.assertEqual(st2["quota_src"], "default")

    def run_limit(self, d, seen_since):
        ctx = FakeCtx(d)
        p = write_login(d, UUID_B, "default_claude_max_5x")
        st = {"waves": [], "limit": None}
        ts = datetime(2026, 10, 28, 10, 52, tzinfo=MSK)
        if seen_since is not None:
            st["acct_seen"] = {"id": account.current(p)["id"], "since": seen_since(ts).timestamp()}
        with mock.patch.dict(os.environ, {account.ENV: p}):
            actions._on_limit(ctx, st, budget.Meter({}), ts, LIMIT)
        return st["waves"][0]

    def test_wave_tagged_when_login_seen_before_the_hit(self):
        with tempfile.TemporaryDirectory() as d:
            w = self.run_limit(d, lambda ts: ts - timedelta(hours=1))
            self.assertEqual((w["mult"], len(w["acct"])), (5, 12))

    def test_wave_untagged_when_login_changed_after_the_hit(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertNotIn("acct", self.run_limit(d, lambda ts: ts + timedelta(minutes=1)))
        with tempfile.TemporaryDirectory() as d:  # свой журнал: ключ limit.hit второй раз волну не пишет
            self.assertNotIn("acct", self.run_limit(d, None), "вход впервые виден на проходе после отказа")


if __name__ == "__main__":
    unittest.main()
