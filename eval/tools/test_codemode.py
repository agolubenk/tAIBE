#!/usr/bin/env python3
"""Тесты code mode C-1 (SE-159, спека `docs/specs/code-mode.md`): AC-1 (`pr`), AC-4 (net, gh, R-3), AC-5 (R-7), AC-7.
Без сети: подменённый opener и runner, HTTP-сервер на 127.0.0.1 для переадресации, 503 и тайм-аута."""
import contextlib
import http.server
import io
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cm  # noqa: E402
from codemode import NotAllowed, SourceDown, gh, keys, net, out, pr  # noqa: E402

HEAD = "d840d5d81b22a3423235b420c79d4b3c555a0119"
OLD = "5a1c5cffa0000000000000000000000000000000"
TEAM = ("coord", "plan", "frontend", "backend", "release", "boards")
LENSES = [["бэкенд", "backend"], ["backend", "backend"], ["контрол", "release"]]
TOKEN = "s3cr3t-token-value"


class FakeOpener:
    def __init__(self, body=b'{"ok": true}'):
        self.body, self.reqs = body, []

    def open(self, req, timeout):
        self.reqs.append((req, timeout))
        return contextlib.closing(io.BytesIO(self.body))


class Net(unittest.TestCase):
    HOSTS = {"d4dev.admin.hrhelper.space", "ops.admin.hrhelper.space"}

    def test_get_sends_only_get_with_session_header(self):
        o = FakeOpener()
        got = net.get("https://d4dev.admin.hrhelper.space/api/x", source="board", session="r.8q28", token=TOKEN,
                      hosts=self.HOSTS, opener=o)
        req, timeout = o.reqs[0]
        self.assertEqual(got, {"ok": True})
        self.assertEqual((req.get_method(), req.data, timeout), ("GET", None, 2.0))
        self.assertEqual(req.get_header("X-t-boards-session"), "r.8q28")
        self.assertEqual(req.get_header("Authorization"), f"Bearer {TOKEN}")

    def test_method_is_not_a_parameter(self):
        with self.assertRaises(TypeError):
            net.get("https://d4dev.admin.hrhelper.space/", source="board", method="POST", hosts=self.HOSTS)
        with self.assertRaises(TypeError):
            net.get("https://d4dev.admin.hrhelper.space/", source="board", data=b"x", hosts=self.HOSTS)

    def test_hosts_and_schemes(self):
        for ok in ("https://d4dev.admin.hrhelper.space/a", "https://ops.admin.hrhelper.space/api/oq/v1/db/work",
                   "http://127.0.0.1:3050/x", "https://127.0.0.1/x"):
            net.check_url(ok, self.HOSTS)
        for bad in ("https://evil.example/x", "http://d4dev.admin.hrhelper.space/a", "ftp://127.0.0.1/x",
                    "https://d4dev.admin.hrhelper.space@evil.example/", "https://u:p@d4dev.admin.hrhelper.space/",
                    "http://localhost:3050/x"):
            with self.subTest(bad=bad), self.assertRaises(NotAllowed):
                net.check_url(bad, self.HOSTS)

    def test_allowed_hosts_from_env_and_queue_config(self):
        hosts = net.allowed_hosts(env={"T_BOARDS_URL": "https://boards.example"})
        self.assertIn("boards.example", hosts)
        self.assertNotIn("d4dev.admin.hrhelper.space", hosts)
        self.assertIn("ops.admin.hrhelper.space", net.allowed_hosts(env={}))   # instances/_shared.json queue.url

    def test_bad_session_label_is_caller_error(self):
        for label in ("", "a" * 81, "роль\n6", "x;y"):
            with self.subTest(label=label), self.assertRaises(ValueError):
                net.get("http://127.0.0.1:1/", source="board", session=label, opener=FakeOpener())
        self.assertTrue(net.session_ok("successor bb · роль 6"[:10]))

    def test_not_json_and_too_big(self):
        with self.assertRaises(SourceDown) as e:
            net.get("http://127.0.0.1:1/", source="queue", opener=FakeOpener(b"<html>"))
        self.assertEqual(str(e.exception), "queue: недоступно (ответ не JSON)")
        with mock.patch.object(net, "MAX_BYTES", 4), self.assertRaises(SourceDown):
            net.get("http://127.0.0.1:1/", source="queue", opener=FakeOpener(b'"12345"'))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/slow":
            time.sleep(0.6)
        code = {"/redirect": 302, "/down": 503, "/auth": 401}.get(path, 200)
        self.send_response(code)
        if code == 302:
            self.send_header("Location", "https://evil.example/")
        self.end_headers()
        self.wfile.write(b'{"ok": 1}')

    def log_message(self, *a):
        pass


class LocalServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def down(self, path, **kw):
        with self.assertRaises(SourceDown) as e:
            net.get(self.base + path, source="board", hosts=set(), **kw)
        return str(e.exception)

    def test_ok(self):
        self.assertEqual(net.get(self.base + "/", source="board", hosts=set()), {"ok": 1})

    def test_redirect_is_not_followed(self):
        self.assertEqual(self.down("/redirect"), "board: недоступно (HTTP 302)")

    def test_503_and_401_one_line_without_token(self):
        self.assertEqual(self.down("/down"), "board: недоступно (HTTP 503)")
        msg = self.down("/auth?key=" + TOKEN, token=TOKEN)
        self.assertEqual(msg, "board: недоступно (HTTP 401)")
        self.assertNotIn(TOKEN, msg)

    def test_timeout(self):
        self.assertEqual(self.down("/slow", timeout=0.2), "board: недоступно (тайм-аут 0.2 с)")

    def test_no_listener(self):
        with self.assertRaises(SourceDown) as e:
            net.get("http://127.0.0.1:9/", source="board", hosts=set(), timeout=0.5)   # порт discard: никто не слушает
        self.assertTrue(str(e.exception).startswith("board: недоступно (нет связи"), str(e.exception))


class Gh(unittest.TestCase):
    def test_refused(self):
        for args in (["pr", "merge", "1"], ["pr", "comment", "1", "-b", "x"], ["api", "-X", "POST", "repos/o/r"],
                     ["api", "--method", "PATCH", "repos/o/r"], ["api", "repos/o/r/issues", "-f", "k=v"],
                     ["api", "--input", "f.json", "repos/o/r"], ["api", "-XPOST", "repos/o/r"],
                     ["api", "--method=POST", "repos/o/r"], ["api", "repos/o/r", "-F", "k=v"],
                     ["api", "repos/o/r", "--raw-field", "k=v"], ["api", "repos/o/r", "-fk=v"], ["api", "graphql"],
                     ["api", "/graphql?x=1"], ["api", "repos/o/r", "-H", "X-HTTP-Method-Override: POST"],
                     ["api", "https://evil.example/x"], ["api", "repos/o/r", "--", "-X"], ["pr", "view", "1", "--web"],
                     ["pr", "checks", "1", "--watch"], ["run", "rerun", "1"], ["workflow", "run", "x"], ["api"], [],
                     ["api", "repos/a", "repos/b"]):
            with self.subTest(args=args), self.assertRaises(NotAllowed):
                gh.check(args)

    def test_reads_pass(self):
        for args in (["pr", "view", "1", "--repo", "o/r", "--json", "headRefOid"], ["pr", "checks", "1"],
                     ["pr", "list", "--state", "open"], ["run", "list", "-L", "5"], ["run", "view", "9", "--log"],
                     ["api", "repos/o/r/pulls?per_page=1", "--paginate", "-q", ".[].number"],
                     ["api", "-H", "Accept: application/vnd.github+json", "repos/o/r"],
                     ["api", "repos/o/r", "--jq=.x"]):
            with self.subTest(args=args):
                gh.check(args)

    def test_refused_before_start(self):
        runner = mock.Mock()
        with self.assertRaises(NotAllowed):
            gh.run(["pr", "merge", "1"], runner=runner)
        runner.assert_not_called()

    def test_run_parses_json_and_reports_failures(self):
        ok = mock.Mock(return_value=subprocess.CompletedProcess([], 0, '{"a": 1}', ""))
        self.assertEqual(gh.run(["pr", "view", "1", "--json", "a"], runner=ok), {"a": 1})
        self.assertEqual(ok.call_args.kwargs["timeout"], 2.0)
        self.assertEqual(ok.call_args.kwargs["env"]["GH_PROMPT_DISABLED"], "1")
        text = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "1\n2\n", ""))
        self.assertEqual(gh.run(["api", "repos/o/r", "-q", ".x"], runner=text), "1\n2\n")
        cases = {
            "gh: недоступно (тайм-аут 2 с)": mock.Mock(side_effect=subprocess.TimeoutExpired("gh", 2)),
            "gh: недоступно (HTTP 503: Service Unavailable)": mock.Mock(
                return_value=subprocess.CompletedProcess([], 1, "", "\nHTTP 503: Service Unavailable\nmore")),
            "gh: недоступно (код 4)": mock.Mock(return_value=subprocess.CompletedProcess([], 4, "", "")),
            "gh: недоступно (ответ не JSON)": mock.Mock(return_value=subprocess.CompletedProcess([], 0, "<x>", "")),
            "gh: недоступно (нет команды gh)": mock.Mock(side_effect=FileNotFoundError("gh")),
        }
        for want, runner in cases.items():
            with self.subTest(want=want), self.assertRaises(SourceDown) as e:
                gh.run(["pr", "view", "1", "--json", "a"], runner=runner)
            self.assertEqual(str(e.exception), want)


class Cap(unittest.TestCase):
    def test_short_text_unchanged(self):
        self.assertEqual(out.cap("строка\nещё"), "строка\nещё")

    def test_cut_on_line_boundary_keeps_cyrillic(self):
        lines = [f"строка {i}: вердикт линзы — approve на голове" for i in range(60)]
        got = out.cap("\n".join(lines))
        self.assertLessEqual(len(got), out.RECIPE_LIMIT)
        body, label = got.rsplit("\n", 1)
        kept = body.split("\n")
        self.assertEqual(kept, lines[:len(kept)])   # только целые строки
        self.assertEqual(label, f"…+{60 - len(kept)} строк: `--json > файл`")
        got.encode("utf-8").decode("utf-8")

    def test_long_first_line_and_free_limit(self):
        got = out.cap("я" * 5000 + "\nb")
        self.assertLessEqual(len(got), out.RECIPE_LIMIT)
        self.assertTrue(got.endswith("…+1 строк: `--json > файл`"))
        free = out.cap("ж\n" * 3000, out.FREE_LIMIT)
        self.assertLessEqual(len(free), out.FREE_LIMIT)
        self.assertGreater(len(free), out.RECIPE_LIMIT)


class Keys(unittest.TestCase):
    def test_env_first_then_secret_cmd(self):
        runner = mock.Mock()
        self.assertEqual(keys.token("OQ_TOKEN", env={"OQ_TOKEN": " t1 \n"}, runner=runner), "t1")
        runner.assert_not_called()
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "t2\n", ""))
        self.assertEqual(keys.token("T_BOARDS_API_KEY", env={}, runner=runner), "t2")
        self.assertEqual(runner.call_args.args[0][-1], "T_BOARDS_API_KEY")
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 1, "", ""))
        self.assertIsNone(keys.token("NOPE", env={}, runner=runner))


def comment(body):
    return {"body": body, "author": {"login": "agolubenk"}}


def fixture(**kw):
    d = {"number": 457, "title": "fix(spawn): SE-155 — release после «ВКЛ» становится Контролем", "state": "OPEN",
         "isDraft": False, "headRefOid": HEAD, "baseRefName": "board-agents", "mergeable": "MERGEABLE",
         "labels": [{"name": "do-not-merge"}], "body": "роль 6 — автор (boards).\n\nТекст.",
         "statusCheckRollup": [{"name": "kit-tests", "conclusion": "SUCCESS", "status": "COMPLETED"},
                               {"name": "dependency advisories (ratchet)", "conclusion": "FAILURE"},
                               {"name": "unittest", "conclusion": "", "status": "IN_PROGRESS"},
                               {"context": "legacy", "state": "SUCCESS"}],
         "comments": [comment(f"Линза backend (роль 4): approve на {OLD}"),
                      comment(f"Линза backend (роль 4): approve на {HEAD}"),
                      comment(f"Линза продукт (роль 1): changes на {HEAD[:9]}"),
                      comment(f"Линза plan (роль 2): approve на {OLD}"),
                      comment(f"Линза boards (роль 6): approve на {HEAD}"),
                      comment("просто комментарий")]}
    d.update(kw)
    return d


class Recipe(unittest.TestCase):
    def summary(self, **kw):
        return pr.summarize(fixture(**kw), LENSES, TEAM, 3)

    def test_head_checks_and_lenses_on_head(self):
        s = self.summary()
        self.assertEqual(s["head"], HEAD)
        self.assertEqual(s["checks"], {"pass": ["kit-tests", "legacy"], "fail": ["dependency advisories (ratchet)"],
                                       "pending": ["unittest"]})
        self.assertEqual(s["ci"], "failure")
        self.assertEqual(s["on_head"], {"backend": "approve", "boards": "approve", "coord": "changes"})
        self.assertEqual(s["older"], {"plan": {"verdict": "approve", "sha": OLD[:9]}})   # backend — уже на голове
        self.assertEqual((s["author"], s["approved"], s["changes"]), ("boards", ["backend"], ["coord"]))
        self.assertTrue(s["author_approve_dropped"])
        self.assertFalse(s["quorum"])

    def test_render_within_limit(self):
        text = pr.render(self.summary())
        self.assertLessEqual(len(out.cap(text)), out.RECIPE_LIMIT)
        for part in (f"голова {HEAD}", "метки: do-not-merge", "CI failure: pass 2 · fail 1 · pending 1",
                     "fail: dependency advisories (ratchet)", "на голове: backend approve · boards approve · "
                     "coord changes", f"на старых головах: plan approve@{OLD[:9]}",
                     "кворум: нет — approve 1/3, changes: coord, CI failure, approve автора boards не засчитан"):
            self.assertIn(part, text)

    def test_quorum_same_as_nerve(self):
        comments = [comment(f"Линза {n}: approve на {HEAD}") for n in ("backend (роль 4)", "plan (роль 2)",
                                                                       "продукт (роль 1)")]
        green = [{"name": "kit-tests", "conclusion": "SUCCESS"}]
        s = self.summary(comments=comments, statusCheckRollup=green)
        self.assertTrue(s["quorum"])
        self.assertIn("кворум: есть — approve 3/3", pr.render(s))

    def test_body_line_counts_until_comment(self):
        body = f"роль 6 — автор.\n\nЛинза release (роль 5): approve на {HEAD}"
        s = self.summary(body=body, comments=[])
        self.assertEqual(s["on_head"], {"release": "approve"})

    def test_many_checks_and_lenses_still_capped(self):
        many = [{"name": f"job-{i}-" + "х" * 30, "conclusion": "FAILURE"} for i in range(40)]
        text = out.cap(pr.render(self.summary(statusCheckRollup=many, title="т" * 300)))
        self.assertLessEqual(len(text), out.RECIPE_LIMIT)
        self.assertIn("+36", text)

    def test_schema_change_is_source_failure(self):
        with self.assertRaises(SourceDown) as e:
            pr.fetch(1, "o/r", run=lambda args: {"number": 1})
        self.assertEqual(str(e.exception), "gh: недоступно (схема ответа: нет headRefOid)")


class Entry(unittest.TestCase):
    def run_main(self, argv, run):
        so, se = io.StringIO(), io.StringIO()
        real = pr.recipe
        with mock.patch.object(pr, "recipe", lambda n, product=None, repo=None: real(n, product, repo, run=run)), \
                contextlib.redirect_stdout(so), contextlib.redirect_stderr(se):
            rc = cm.main(argv)
        return rc, so.getvalue(), se.getvalue()

    def test_text_and_json(self):
        rc, so, _ = self.run_main(["pr", "457", "--product", "taibe"], lambda args: fixture())
        self.assertEqual(rc, 0)
        self.assertLessEqual(len(so.rstrip("\n")), out.RECIPE_LIMIT)
        self.assertTrue(so.startswith("PR #457 OPEN"))
        rc, so, _ = self.run_main(["pr", "457", "--json", "--product", "taibe"], lambda args: fixture())
        self.assertEqual((rc, json.loads(so)["head"]), (0, HEAD))

    def test_repo_from_product_and_override(self):
        seen = []
        self.run_main(["pr", "5", "--product", "taibe"], lambda args: seen.append(args) or fixture())
        self.run_main(["pr", "5", "--product", "taibe", "--repo", "o/r"], lambda args: seen.append(args) or fixture())
        self.assertEqual([a[a.index("--repo") + 1] for a in seen], ["agolubenk/tAIBE", "o/r"])

    def test_source_down_one_line_code_3(self):
        def down(args):
            raise SourceDown("gh", "тайм-аут 2 с")
        rc, so, se = self.run_main(["pr", "5", "--product", "taibe"], down)
        self.assertEqual((rc, so, se), (3, "", "gh: недоступно (тайм-аут 2 с)\n"))

    def test_unknown_product_code_2(self):
        rc, _, se = self.run_main(["pr", "5", "--product", "nope"], lambda args: fixture())
        self.assertEqual(rc, 2)
        self.assertIn("nope", se)


if __name__ == "__main__":
    unittest.main()
