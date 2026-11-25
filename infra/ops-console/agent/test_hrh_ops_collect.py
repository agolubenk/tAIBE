"""Тесты сборщиков агента: python3 -m unittest discover -s agent (только stdlib)."""
import json
import os
import tempfile
import time
import unittest
from unittest import mock

import hrh_ops_collect as hc


def line(path, code=200, ago=5, method="GET"):
    ts = time.strftime("%d/%b/%Y:%H:%M:%S +0000", time.gmtime(time.time() - ago))
    return '203.0.113.7 - - [%s] "%s %s HTTP/1.1" %d 512 "-" "curl/8"' % (ts, method, path, code)


class RouteOf(unittest.TestCase):
    def test_ids_tokens_files_become_placeholders(self):
        self.assertEqual(hc.route_of("/api/v1/candidates/3f2dd207-a825-810b-b858-d6122c8cd90b"), "/api/v1/candidates/:id")
        self.assertEqual(hc.route_of("/api/v1/vacancies/42?tab=1"), "/api/v1/vacancies/:n")
        self.assertEqual(hc.route_of("/assets/index-Bx12aZ.js"), "/assets/:file")
        self.assertEqual(hc.route_of("/favicon.ico"), "/favicon.ico")
        self.assertEqual(hc.route_of("/hr-helper-telegram/a/Resume%20Ivanov.pdf"), "/hr-helper-telegram/a/:x")
        self.assertEqual(hc.route_of("/s/abcdefghijklmnopqrstuvwxyz012345"), "/s/:x")
        self.assertEqual(hc.route_of("/a/b/c/d/e/f"), "/a/b/c/d/e/…")
        self.assertEqual(hc.route_of("/api/v1/integrations/telegram/folder-unread-counts"), "/api/v1/integrations/telegram/folder-unread-counts")
        self.assertEqual(hc.route_of("/"), "/")
        self.assertEqual(hc.route_of("http://evil.example/x"), "(не путь)")


class AccessStats(unittest.TestCase):
    def test_counts_only_last_minute_and_groups_routes(self):
        lines = [
            line("/api/v1/candidates/3f2dd207-a825-810b-b858-d6122c8cd90b"),
            line("/api/v1/candidates/9a9dd207-a825-810b-b858-d6122c8cd90b", code=404),
            line("/api/v1/health/ready", code=502),
            line("/old", ago=600),
            "2026/10/07 20:58:47 [error] 36#36: *7758 connect() failed (111: Connection refused)",
        ]
        stats = hc.access_stats(lines)
        self.assertEqual(stats["requestsPerMin"], 3)
        self.assertEqual(stats["errors4xxPerMin"], 1)
        self.assertEqual(stats["errors5xxPerMin"], 1)
        self.assertEqual(stats["topPaths"][0], ("/api/v1/candidates/:id", 2))


class ContainerSource(unittest.TestCase):
    def test_finds_running_nginx_service(self):
        containers = [
            {"name": "backend-frontend-1", "composeService": "frontend", "state": "running"},
            {"name": "backend-nginx-1", "composeService": "nginx", "state": "running"},
        ]
        self.assertEqual(hc.find_nginx_container(containers), "backend-nginx-1")
        self.assertIsNone(hc.find_nginx_container([{"name": "x", "composeService": "nginx", "state": "exited"}]))
        self.assertIsNone(hc.find_nginx_container(None))

    def test_reads_with_margin_and_counts_only_last_minute(self):
        # Окно чтения 75 с, счёта — 60 с: строка 70-секундной давности прочитана, но не посчитана.
        out = "\n".join([line("/"), line("/ws/", code=101), line("/edge", ago=70)])
        with mock.patch.object(hc, "run", return_value=(0, out, "")) as run:
            stats = hc.nginx_container_stats("backend-nginx-1")
        self.assertEqual(run.call_args[0][0], ["docker", "logs", "--since", "75s", "--tail", "20000", "backend-nginx-1"])
        self.assertEqual(stats["requestsPerMin"], 2)
        self.assertGreater(hc.NGINX_READ_WINDOW_S, hc.NGINX_COUNT_WINDOW_S)

    def test_docker_logs_failure_is_an_error_not_zero_traffic(self):
        with mock.patch.object(hc, "run", return_value=(1, "", "No such container")):
            with self.assertRaises(RuntimeError):
                hc.nginx_container_stats("backend-nginx-1")


class CgroupMemory(unittest.TestCase):
    def test_reads_memory_and_swap_peaks(self):
        with tempfile.TemporaryDirectory() as d:
            base = os.path.join(d, "docker-abc.scope")
            os.makedirs(base)
            with open(base + "/memory.peak", "w") as f:
                f.write("2621440000\n")
            with open(base + "/memory.swap.peak", "w") as f:
                f.write("2621440000\n")
            self.assertEqual(hc.cgroup_memory("abc", (d + "/docker-{id}.scope",)), (2500.0, 2500.0))

    def test_second_layout_and_missing_swap_peak(self):
        with tempfile.TemporaryDirectory() as d:
            base = os.path.join(d, "docker", "abc")
            os.makedirs(base)
            with open(base + "/memory.peak", "w") as f:
                f.write("1048576\n")
            self.assertEqual(hc.cgroup_memory("abc", ("/nonexistent/{id}", d + "/docker/{id}")), (1.0, None))

    def test_missing_cgroup_is_none(self):
        self.assertEqual(hc.cgroup_memory("nope", ("/nonexistent/{id}",)), (None, None))


A = "a" * 64
B = "b" * 64
T0 = 1792349294.0


def kill(cid, task, at, glob=False, cpuset=None):
    """Строка журнала ядра в формате journalctl -o short-unix (как на проде 18.10)."""
    where = "global_oom" if glob else "oom_memcg=/system.slice/docker-%s.scope" % cid
    return ("%.6f vmi3609987 kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=docker-%s.scope,"
            "mems_allowed=0,%s,task_memcg=/system.slice/docker-%s.scope,task=%s,pid=7752,uid=0") % (at, cpuset or cid, where, cid, task)


class FakeJournal:
    """Журнал ядра: строки по порядку, курсор — номер прочитанной строки; bad — курсор не принимается."""

    def __init__(self):
        self.lines, self.calls, self.bad, self.down = [], 0, False, False

    def __call__(self, cursor):
        self.calls += 1
        if self.down or (cursor and self.bad):
            return None, None
        start = int(cursor) if cursor else 0
        return self.lines[start:], str(len(self.lines))


class OomJournalTest(unittest.TestCase):
    def setUp(self):
        self.clock = [T0 + 600]
        self.j = FakeJournal()

    def journal(self, state_dir=None):
        return hc.OomJournal(state_dir, reader=self.j, clock=lambda: self.clock[0])

    def tick(self, oom, ids=(A, B)):
        self.clock[0] += hc.OOM_READ_EVERY_SEC
        oom.refresh(list(ids))

    def test_main_process_kill_counts_although_cgroup_restarts_from_zero(self):
        # whisper 05.10: ядро убило uvicorn (главный процесс), контейнер перезапустился с тем же id — счётчик
        # oom_kill в новом scope снова 0, а по журналу случай учтён.
        oom = self.journal()
        self.tick(oom)
        self.assertEqual((oom.ready, oom.total.get(A, 0)), (True, 0))
        self.j.lines.append(kill(A, "uvicorn", T0 + 650))
        self.tick(oom)
        self.assertEqual(oom.total[A], 1)
        self.j.lines += [kill(A, "pluginsmanager", T0 + 700 + i) for i in range(4)]
        self.tick(oom)
        self.assertEqual(oom.total[A], 5)
        self.assertEqual(oom.victims_text(A), "pluginsmanager ×4, uvicorn ×1")

    def test_victim_is_taken_from_task_memcg_and_host_oom_is_marked(self):
        oom = self.journal()
        self.j.lines = [
            kill(B, "uvicorn", T0 + 1, glob=True),
            kill(A, "converter", T0 + 2, cpuset=B),  # cpuset — того, кто выделял память, а не жертвы
            "%.6f vmi3609987 kernel: Memory cgroup out of memory: Killed process 1 (x)" % (T0 + 3),
        ]
        self.tick(oom)
        self.assertEqual((oom.total.get(A), oom.total.get(B)), (1, 1))
        self.assertEqual(oom.victims_text(B), "uvicorn ×1 (память хоста)")
        self.assertEqual(oom.victims_text(A), "converter ×1")

    def test_lost_cursor_rereads_window_without_counting_twice(self):
        oom = self.journal()
        self.j.lines = [kill(A, "pluginsmanager", T0 + i) for i in range(4)]
        self.tick(oom)
        self.j.bad = True  # журнал ротирован: курсор не принят — чтение за 3 суток заново
        self.j.lines.append(kill(A, "pluginsmanager", T0 + 100))
        self.tick(oom)
        self.assertEqual(oom.total[A], 5)

    def test_totals_survive_agent_restart_and_removed_containers_are_forgotten(self):
        with tempfile.TemporaryDirectory() as d:
            oom = self.journal(d)
            self.j.lines = [kill(A, "pluginsmanager", T0 + i) for i in range(4)] + [kill(B, "java", T0 + 9)]
            self.tick(oom)
            again = self.journal(d)
            self.assertTrue(again.ready)  # итоги известны до первого чтения — без провала в отчётах
            self.assertEqual(again.total, {A: 4, B: 1})
            self.tick(again, ids=(A,))  # B удалён (docker rm / пересоздан с новым id)
            self.assertEqual(again.total, {A: 4})
            self.assertIsNone(again.victims_text(B))

    def test_window_of_victims_is_three_days_but_total_keeps_growing(self):
        oom = self.journal()
        self.j.lines = [kill(A, "pluginsmanager", T0)]
        self.tick(oom)
        self.clock[0] += hc.OOM_WINDOW_SEC
        self.tick(oom)
        self.assertEqual((oom.total[A], oom.victims_text(A)), (1, None))

    def test_journal_read_at_most_once_a_minute_and_failure_is_not_zero(self):
        oom = self.journal()
        self.j.down = True
        with mock.patch.object(hc, "log") as log:
            oom.refresh([A])
            oom.refresh([A])
            self.assertEqual(self.j.calls, 1)
            self.clock[0] += hc.OOM_READ_EVERY_SEC
            oom.refresh([A])
        self.assertEqual(self.j.calls, 2)
        self.assertFalse(oom.ready)  # итоги не отправляются, а не «0 убитых»
        self.assertEqual(log.call_count, 1)  # предупреждение — один раз

    def test_reader_replaces_non_utf8_bytes_and_takes_cursor(self):
        out = (kill(A, "pluginsmanager", T0).encode() + b"\n" + ("%.6f h kernel: traps: \xd0" % T0).encode("latin-1")
               + b"\n-- cursor: s=e18;i=6d578\n")
        done = mock.Mock(returncode=0, stdout=out)
        with mock.patch.object(hc.subprocess, "run", return_value=done) as run:
            lines, cursor = hc.read_kernel_journal("s=old")
        self.assertEqual(run.call_args[0][0][-2:], ["--after-cursor", "s=old"])
        self.assertEqual((len(lines), cursor), (2, "s=e18;i=6d578"))
        self.assertIn("�", lines[1])
        with mock.patch.object(hc.subprocess, "run", return_value=done) as run:
            hc.read_kernel_journal(None)
        self.assertEqual(run.call_args[0][0][-2:], ["--since", "-3 days"])


class DockerContainersOom(unittest.TestCase):
    def docker(self, cmd, timeout=15):
        if cmd[:2] == ["docker", "ps"]:
            return 0, A + "\n" + B + "\n", ""
        if cmd[:2] == ["docker", "inspect"]:
            items = [
                {"Id": A, "Name": "/backend-onlyoffice-1", "State": {"Status": "running"}, "Config": {"Labels": {}}},
                {"Id": B, "Name": "/backend-whisper-1", "State": {"Status": "exited", "ExitCode": 137}, "Config": {"Labels": {}}},
            ]
            return 0, json.dumps(items), ""
        return 1, "", "no stats"

    def test_oom_totals_reach_running_and_stopped_containers(self):
        j = FakeJournal()
        j.lines = [kill(A, "pluginsmanager", T0), kill(B, "uvicorn", T0 + 1)]
        # Часы журнала — рядом с T0: окно «кого убили» — 3 суток, а T0 — фиксированная дата.
        cfg = mock.Mock(compose_project="", stateful=[], container_exclude=[], oom=hc.OomJournal(None, reader=j, clock=lambda: T0 + 600))
        with mock.patch.object(hc, "run", side_effect=self.docker), mock.patch.object(hc, "cgroup_memory", return_value=(4096.0, 120.5)):
            containers, err = hc.docker_containers(cfg)
        by = {c["name"]: c for c in containers}
        self.assertIsNone(err)
        self.assertEqual((by["backend-onlyoffice-1"]["oomKills"], by["backend-onlyoffice-1"]["swapPeakMb"]), (1, 120.5))
        self.assertEqual(by["backend-whisper-1"]["oomKills"], 1)
        self.assertEqual(by["backend-whisper-1"]["oomVictims"], "uvicorn ×1")

    def test_oom_failure_does_not_drop_the_snapshot(self):
        cfg = mock.Mock(compose_project="", stateful=[], container_exclude=[], oom=mock.Mock(ready=False))
        cfg.oom.refresh.side_effect = UnicodeDecodeError("utf-8", b"\xd0", 0, 1, "invalid")
        with mock.patch.object(hc, "run", side_effect=self.docker), mock.patch.object(hc, "cgroup_memory", return_value=(None, None)), \
                mock.patch.object(hc, "log"):
            containers, err = hc.docker_containers(cfg)
        self.assertIsNone(err)
        self.assertEqual(len(containers), 2)
        self.assertNotIn("oomKills", containers[0])

    def test_exclude_mask_hides_container(self):
        cfg = mock.Mock(compose_project="", stateful=[], container_exclude=["*-whisper-*"], oom=None)
        with mock.patch.object(hc, "run", side_effect=self.docker), mock.patch.object(hc, "cgroup_memory", return_value=(None, None)):
            containers, err = hc.docker_containers(cfg)
        self.assertIsNone(err)
        self.assertEqual([c["name"] for c in containers], ["backend-onlyoffice-1"])

    def test_health_output_only_for_product_stack(self):
        sick = {"Status": "running", "Health": {"Status": "unhealthy", "Log": [{"Output": "token=s3cr3t refused", "ExitCode": 1}]}}
        items = [
            {"Id": A, "Name": "/backend-api-1", "State": sick, "Config": {"Labels": {"com.docker.compose.project": "backend"}}},
            {"Id": B, "Name": "/neighbour-api-1", "State": sick, "Config": {"Labels": {"com.docker.compose.project": "neighbour"}}},
        ]
        docker = lambda cmd, timeout=15: (0, A + "\n" + B, "") if cmd[1] == "ps" else (0, json.dumps(items), "") if cmd[1] == "inspect" else (1, "", "")
        for main, expect in (("backend", {"backend-api-1": "token=s3cr3t refused", "neighbour-api-1": ""}), ("", {"backend-api-1": "token=s3cr3t refused", "neighbour-api-1": "token=s3cr3t refused"})):
            cfg = mock.Mock(compose_project=main, stateful=[], container_exclude=[], oom=None)
            with mock.patch.object(hc, "run", side_effect=docker), mock.patch.object(hc, "cgroup_memory", return_value=(None, None)):
                containers, _ = hc.docker_containers(cfg)
            self.assertEqual({c["name"]: c["healthLog"] for c in containers}, expect)


class BusinessMetrics(unittest.TestCase):
    def test_failed_command_is_reported_not_zero(self):
        # Число, напечатанное перед ошибкой (awk END после упавшего docker exec), не засчитывается.
        values, failed = hc.business_metrics({
            "ok": "echo 42",
            "printed_then_failed": "echo 0; exit 1",
            "garbage": "echo n/a",
            "silent": "true",
        })
        self.assertEqual(values, {"ok": 42.0})
        self.assertEqual(sorted(failed), ["garbage", "printed_then_failed", "silent"])

    def test_no_commands(self):
        self.assertEqual(hc.business_metrics({}), ({}, []))


class BackgroundInterval(unittest.TestCase):
    def test_min_interval_reuses_last_result(self):
        calls = []
        bg = hc.Background(lambda: calls.append(1) or len(calls), min_interval=300)
        first, _ = bg.get(budget=2, max_age=600)
        second, _ = bg.get(budget=2, max_age=600)
        self.assertEqual((first, second), (1, 1))
        self.assertEqual(len(calls), 1)

    def test_nginx_collection_runs_at_most_once_a_minute(self):
        clock = [1_000_000.0]
        names = iter(["backend-nginx-1", "backend-nginx-2"])
        with mock.patch.object(hc.time, "time", side_effect=lambda: clock[0]), \
                mock.patch.object(hc, "run", return_value=(0, "", "")) as run:
            bg = hc.nginx_background(lambda: next(names))
            bg.get(budget=2, max_age=600)
            clock[0] += hc.NGINX_MIN_INTERVAL_S - 1  # цикл агента 15 с: до минуты — прошлый результат
            bg.get(budget=2, max_age=600)
            self.assertEqual(run.call_count, 1)
            clock[0] += 1
            bg.get(budget=2, max_age=600)
        self.assertEqual(run.call_count, 2)
        # имя контейнера берётся заново на каждом сборе (после пересоздания оно другое)
        self.assertEqual(run.call_args[0][0][-1], "backend-nginx-2")
        self.assertEqual(hc.NGINX_MIN_INTERVAL_S, 60)


if __name__ == "__main__":
    unittest.main()
