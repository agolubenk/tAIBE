"""Тесты доменов nginx и перезапуска по проекту: python3 -m unittest discover -s agent (только stdlib)."""
import importlib.util
import os
import sys
import time
import unittest
from types import SimpleNamespace
from unittest import mock

import hrh_ops_edge as he

HERE = os.path.dirname(os.path.abspath(__file__))

DUMP = """# configuration file /etc/nginx/nginx.conf:
events { worker_connections 1024; }
http {
    map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    include /etc/nginx/conf.d/*.conf;
    server {
        listen 80 default_server;
        server_name _;
        location / { return 301 https://$host$request_uri; }
    }
}
stream {
    server { listen 5432; server_name db.example.com; }
}

# configuration file /etc/nginx/conf.d/app.conf:
server {
    listen 443 ssl http2;
    listen [::]:443 ssl;
    server_name App.Example.com "www.example.com" *.wild.example.com ~^re\\.example\\.com$ 10.0.0.1 localhost;
    # server { server_name commented.example.com; }
    location /api { proxy_pass http://backend:3001; }
}
server {
    listen 10.77.0.1:8443 ssl;
    server_name boards.example.com;
}
server {
    server_name plain.example.com;
}
"""


class Parser(unittest.TestCase):
    def test_clean_name_drops_masks_ips_and_local(self):
        self.assertEqual(he.clean_name("App.Example.com."), "app.example.com")
        self.assertEqual(he.clean_name('"www.example.com"'), "www.example.com")
        for raw in ("_", "*.example.com", "~^x$", "localhost", "a.localhost", "10.0.0.1", "::1", "intranet", "bad_name.example"):
            self.assertIsNone(he.clean_name(raw), raw)

    def test_parse_listen(self):
        self.assertEqual(he.parse_listen(["443", "ssl", "http2"]), (None, 443, True))
        self.assertEqual(he.parse_listen(["[::]:443", "ssl"]), (None, 443, True))
        self.assertEqual(he.parse_listen(["10.77.0.1:8443", "ssl"]), ("10.77.0.1", 8443, True))
        self.assertEqual(he.parse_listen(["*:80"]), (None, 80, False))
        self.assertEqual(he.parse_listen(["127.0.0.1"]), ("127.0.0.1", 80, False))
        self.assertIsNone(he.parse_listen(["unix:/run/nginx.sock"]))
        self.assertIsNone(he.parse_listen(["example.com:443"]))
        self.assertIsNone(he.parse_listen(["70000"]))
        self.assertIsNone(he.parse_listen(["²"]))  # '²'.isdigit() — True, а int('²') упал бы
        self.assertIsNone(he.parse_listen(["10.0.0.1:४४३"]))
        self.assertIsNone(he.parse_listen([]))

    def test_dump_files_blocks_and_comments(self):
        got = dict(he.parse_nginx_dump(DUMP))
        self.assertEqual(sorted(got), ["app.example.com", "boards.example.com", "plain.example.com", "www.example.com"])
        self.assertEqual(got["app.example.com"], [(None, 443, True)])
        self.assertEqual(got["boards.example.com"], [("10.77.0.1", 8443, True)])
        self.assertEqual(got["plain.example.com"], [(None, 80, False)])

    def test_dump_without_headers_is_one_file(self):
        self.assertEqual(he.parse_nginx_dump("http { server { listen 443 ssl; server_name a.example.com; } }"), [("a.example.com", [(None, 443, True)])])


class Endpoint(unittest.TestCase):
    def test_host_network(self):
        net = (True, {}, [])
        self.assertEqual(he.endpoint((None, 443, True), net, {"10.77.0.1"}), ("127.0.0.1", 443))
        self.assertEqual(he.endpoint(("10.77.0.1", 8443, True), net, {"10.77.0.1"}), ("10.77.0.1", 8443))
        self.assertIsNone(he.endpoint(("10.9.9.9", 443, True), net, {"10.77.0.1"}))

    def test_bridge_published_or_container_ip(self):
        ports = {"443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8443"}], "80/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]}
        net = (False, ports, ["172.18.0.5"])
        self.assertEqual(he.endpoint((None, 443, True), net, set()), ("127.0.0.1", 8443))
        self.assertEqual(he.endpoint((None, 80, False), net, set()), ("127.0.0.1", 8080))
        self.assertEqual(he.endpoint((None, 9443, True), net, set()), ("172.18.0.5", 9443))
        self.assertIsNone(he.endpoint((None, 9443, True), (False, {}, []), set()))
        # macvlan/ipvlan с публичным адресом — не локальный вход, туда агент не ходит.
        self.assertIsNone(he.endpoint((None, 9443, True), (False, {}, ["8.8.8.8"]), set()))
        self.assertEqual(he.endpoint((None, 9443, True), (False, {}, ["8.8.8.8", "172.18.0.5"]), set()), ("172.18.0.5", 9443))


class RunCapped(unittest.TestCase):
    py = sys.executable

    def test_ok_timeout_cap_missing(self):
        self.assertEqual(he.run_capped([self.py, "-c", "print('hi')"], 10), (0, b"hi\n"))
        code, _ = he.run_capped([self.py, "-c", "import time; time.sleep(5)"], 0.3)
        self.assertEqual(code, 124)
        self.assertEqual(he.run_capped([self.py, "-c", "print('x' * 5000)"], 10, cap=100), (125, b""))
        self.assertEqual(he.run_capped(["/nonexistent/binary-xyz"], 1)[0], 127)


class IsNginx(unittest.TestCase):
    def test_default_and_patterns(self):
        c = {"name": "backend-nginx-1", "state": "running", "image": "nginx:1.27-alpine", "composeService": "proxy"}
        self.assertTrue(he.is_nginx(c, []))
        self.assertTrue(he.is_nginx(dict(c, image="ghcr.io/nginxinc/nginx-unprivileged:stable"), []))
        self.assertTrue(he.is_nginx(dict(c, image="custom/edge:1", composeService="nginx"), []))
        self.assertFalse(he.is_nginx(dict(c, image="custom/edge:1"), []))
        self.assertTrue(he.is_nginx(dict(c, state="restarting"), []))
        self.assertTrue(he.is_nginx(dict(c, image="custom/edge:1"), ["backend-nginx-*"]))
        self.assertFalse(he.is_nginx(c, ["tls"]))
        self.assertFalse(he.is_nginx(c, ["-"]))


class Scanner(unittest.TestCase):
    def setUp(self):
        self.patches = [
            mock.patch.object(he, "local_addresses", return_value={"10.77.0.1"}),
            mock.patch.object(he, "inspect_network", return_value=(True, {}, [])),
            mock.patch.object(he, "probe", return_value=({"validTo": 2_000_000_000, "issuer": "R3"}, None)),
        ]
        for p in self.patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self.patches])
        self.scanner = he.DomainScanner([])
        self.nginx = {"name": "nginx", "state": "running", "image": "nginx:1", "composeService": "nginx"}

    def test_not_ready_until_docker_answers(self):
        self.assertIsNone(self.scanner.scan())

    def test_rows_probe_and_failure_keeps_previous_parse(self):
        self.scanner.set_containers([self.nginx])
        with mock.patch.object(he, "run_capped", return_value=(0, DUMP.encode())):
            res = self.scanner.scan()
        rows = {r["name"]: r for r in res["rows"]}
        self.assertEqual(res["total"], 4)
        self.assertEqual(rows["app.example.com"], {"name": "app.example.com", "source": "nginx", "tls": True, "stale": False, "port": 443, "validTo": 2_000_000_000, "issuer": "R3", "checkedAt": mock.ANY})
        self.assertEqual(rows["plain.example.com"]["port"], 80)
        self.assertNotIn("checkedAt", rows["plain.example.com"])
        with mock.patch.object(he, "run_capped", return_value=(1, b"")):
            again = self.scanner.scan()
        self.assertEqual(again["failed"], ["nginx"])
        self.assertEqual(len(again["rows"]), 4)
        # Сертификаты не перепроверяются раньше PROBE_EVERY_SEC.
        self.assertEqual(he.probe.call_count, 3)

    def test_gone_container_drops_its_names(self):
        self.scanner.set_containers([self.nginx])
        with mock.patch.object(he, "run_capped", return_value=(0, DUMP.encode())):
            self.scanner.scan()
            self.scanner.set_containers([])
            self.assertEqual(self.scanner.scan()["rows"], [])

    def test_restarting_nginx_keeps_names_without_rereading(self):
        self.scanner.set_containers([self.nginx])
        with mock.patch.object(he, "run_capped", return_value=(0, DUMP.encode())) as run:
            self.scanner.scan()
            self.scanner.set_containers([dict(self.nginx, state="restarting")])
            res = self.scanner.scan()
        self.assertEqual(len(res["rows"]), 4)
        self.assertEqual(run.call_count, 1)

    def test_main_project_owns_name_and_comes_first_under_cap(self):
        scanner = he.DomainScanner([], main_project="backend")
        neighbour = dict(self.nginx, name="a-proxy", composeProject="neighbour")
        scanner.set_containers([neighbour, dict(self.nginx, composeProject="backend")])
        fake = "server { listen 443 ssl; server_name app.example.com %s; }" % " ".join("a%03d.example.com" % i for i in range(he.DOMAINS_MAX))
        dumps = {"a-proxy": fake, "nginx": "server { listen 443 ssl; server_name app.example.com ops.example.com; }"}
        with mock.patch.object(he, "run_capped", side_effect=lambda cmd, _t: (0, dumps[cmd[2]].encode())):
            res = scanner.scan()
        rows = {r["name"]: r for r in res["rows"]}
        self.assertEqual(res["total"], he.DOMAINS_MAX + 2)
        self.assertEqual(len(res["rows"]), he.DOMAINS_MAX)
        # Самоподписанный сертификат соседа не становится сертификатом продукта, имена продукта не вытеснены.
        self.assertEqual(rows["app.example.com"]["source"], "nginx")
        self.assertIn("ops.example.com", rows)

    def test_broken_config_fails_only_its_container(self):
        other = dict(self.nginx, name="edge")
        self.scanner.set_containers([self.nginx, other])
        real = he.parse_nginx_dump

        def parse(text):
            if "boom" in text:
                raise ValueError("boom")
            return real(text)

        dumps = {"nginx": "server { listen 80; server_name boom.example.com; }", "edge": DUMP}
        with mock.patch.object(he, "run_capped", side_effect=lambda cmd, _t: (0, dumps[cmd[2]].encode())), mock.patch.object(he, "parse_nginx_dump", side_effect=parse):
            res = self.scanner.scan()
        self.assertEqual(res["failed"], ["nginx"])
        self.assertEqual(res["total"], 4)

    def test_tls_listen_not_visible_from_host(self):
        self.scanner.set_containers([self.nginx])
        dump = "server { listen 10.9.9.9:443 ssl; server_name far.example.com; }"
        with mock.patch.object(he, "run_capped", return_value=(0, dump.encode())):
            row = self.scanner.scan()["rows"][0]
        self.assertEqual(row["error"], "unreachable")


class Feed(unittest.TestCase):
    def setUp(self):
        self.feed = he.DomainFeed([])
        self.result = {"rows": [{"name": "a.example.com", "tls": False}], "total": 1, "failed": []}
        self.feed.bg = SimpleNamespace(get=lambda **_: (self.result, 1_700_000_000.0))
        self.ctr = [{"name": "nginx", "state": "running", "image": "nginx:1"}]

    def attach(self, containers=None):
        payload = {}
        self.feed.attach(payload, containers)
        return payload

    def test_send_on_change_and_after_delivery_only(self):
        self.assertEqual(self.attach(), {})  # docker ещё не ответил
        first = self.attach(self.ctr)
        self.assertEqual(first["domains"], self.result["rows"])
        self.assertEqual((first["domainsAt"], first["domainsTotal"]), (1_700_000_000, 1))
        self.assertIn("domains", self.attach())  # не доставлен — уходит снова
        self.feed.delivered()
        self.assertEqual(self.attach(), {})
        self.result = dict(self.result, rows=[{"name": "b.example.com", "tls": False}])
        self.assertEqual(self.attach()["domains"][0]["name"], "b.example.com")

    def test_hourly_resend_and_failed_every_report(self):
        self.attach(self.ctr)
        self.feed.delivered()
        self.result = dict(self.result, failed=["nginx"])
        self.assertEqual(self.attach(), {"domainsFailed": ["nginx"]})
        self.feed.sent_at = time.time() - he.DomainFeed.RESEND_SEC - 1
        self.assertIn("domains", self.attach())

    def test_truncation_reported_every_report(self):
        self.result = dict(self.result, total=150)
        self.attach(self.ctr)
        self.feed.delivered()
        self.assertEqual(self.attach(), {"domainsTotal": 150})

    def test_collector_error_logs_type_only(self):
        self.feed.bg = SimpleNamespace(get=lambda **_: (ValueError("server_name secret.example.com"), 0.0))
        with mock.patch.object(he, "log") as log:
            self.assertEqual(self.attach(self.ctr), {})
            self.attach()
        log.assert_called_once()
        self.assertNotIn("secret", log.call_args[0][0])


def load_agent():
    spec = importlib.util.spec_from_file_location("hrh_ops_agent", os.path.join(HERE, "hrh-ops-agent.py"))
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ExecutorScope(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agent = load_agent()

    def executor(self):
        cfg = SimpleNamespace(restart_deny=[], restart_allow=["*"], restart_projects=["backend"], restart_cooldown=0)
        return self.agent.Executor(cfg)

    def test_allowed_by_project(self):
        ex = self.executor()
        self.assertIsNone(ex.allowed("backend-api-1", "backend"))
        self.assertIn("neighbour", ex.allowed("tls", "neighbour"))
        self.assertIn("без проекта", ex.allowed("adhoc", ""))

    def test_current_parses_inspect(self):
        ex = self.executor()
        cid = "a" * 64
        with mock.patch.object(self.agent, "run", return_value=(0, "%s /api backend\n" % cid, "")) as run:
            self.assertEqual(ex._current("api"), (cid, "backend"))
            self.assertEqual(run.call_args[0][0][:4], ["docker", "inspect", "--type", "container"])
        with mock.patch.object(self.agent, "run", return_value=(0, "%s /api <no value>\n" % cid, "")):
            self.assertEqual(ex._current("api"), (cid, ""))
        with mock.patch.object(self.agent, "run", return_value=(1, "", "No such object")):
            self.assertIsNone(ex._current("api"))
        # Имя из hex-символов docker сопоставил с префиксом Id другого контейнера — это не тот контейнер.
        with mock.patch.object(self.agent, "run", return_value=(0, "%s /other backend\n" % cid, "")):
            self.assertIsNone(ex._current("abcdef123456"))

    def test_restart_rechecks_project_and_restarts_by_id(self):
        ex = self.executor()
        cid = "b" * 64
        calls = []

        def fake_run(cmd, _timeout):
            calls.append(cmd)
            if cmd[1] == "inspect":
                return 0, "%s /api %s\n" % (cid, project), ""
            return 0, cid, ""

        project = "neighbour"  # пересоздан под тем же именем в чужом проекте
        with mock.patch.object(self.agent, "run", side_effect=fake_run):
            ex.running.add("api")
            ex._restart(1, "api")
            project = "backend"
            ex.running.add("api")
            ex._restart(2, "api")
        results = {r["id"]: r for r in ex.take_results()}
        self.assertEqual(results[1]["status"], "failed")
        self.assertIn("OPS_RESTART_PROJECTS", results[1]["output"])
        self.assertEqual(results[2]["status"], "succeeded")
        self.assertEqual(calls[-1][:4], ["docker", "restart", "-t", "30"])
        self.assertEqual(calls[-1][4], cid)
        self.assertNotIn("api", ex.running)


if __name__ == "__main__":
    unittest.main()
