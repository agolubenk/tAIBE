#!/usr/bin/env python3
"""headroom_launchd.py: флаги и окружение — из манифеста канона без флагов Docker; переключение снимает только
headroom; сервис не ответил — запасной процесс (API у сессий не пропадает). launchctl, порт и процессы подменены.

Run: python3 -I infra/headroom/developer/test_headroom_launchd.py
"""
import json
import os
import plistlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import headroom_launchd as H  # noqa: E402

MANIFEST = {
    "proxy_args": ["--host", "127.0.0.1", "--port", "8787", "--headroom-deployment-profile", "default",
                   "--headroom-deployment-runtime", "docker", "--mode", "cache", "--no-http2", "--no-cache"],
    "base_env": {"HEADROOM_LOSSLESS": "1", "HEADROOM_RPM": "600",
                 "TIKTOKEN_CACHE_DIR": "/tmp/headroom-home/.headroom/tiktoken-cache"},
}
HEADROOM = "/u/.local/share/uv/tools/headroom-ai/bin/python -m headroom.cli proxy --port 8787"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        m = self.home / ".headroom" / "deploy" / "default"
        m.mkdir(parents=True)
        (m / "manifest.json").write_text(json.dumps(MANIFEST))
        (self.home / "Library" / "Logs").mkdir(parents=True)
        self.env = mock.patch.dict(os.environ, {"HEADROOM_SERVICE_HOME": str(self.home)})
        self.env.start()
        self.calls, self.log = [], []

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def run_install(self, listener, spid=None, ready=True, fallback_ok=True, stopped=True):
        state = {"spid": spid}

        def launchctl(*a):
            self.calls.append(a[0])
            if a[0] == "bootstrap":
                state["spid"] = 4242
            if a[0] == "bootout":
                state["spid"] = None
            return mock.Mock(returncode=0, stdout="", stderr="")

        with mock.patch.object(H, "launchctl", launchctl), \
                mock.patch.object(H, "service_pid", lambda: state["spid"]), \
                mock.patch.object(H, "listener", lambda: listener), \
                mock.patch.object(H, "stop", lambda pid, log: self.calls.append(f"stop {pid}") or stopped), \
                mock.patch.object(H, "wait_ready", lambda s: ready), \
                mock.patch.object(H, "fallback", lambda log: self.calls.append("fallback") or fallback_ok):
            return H.install(self.log.append)


class CanonTest(Base):
    def test_docker_flags_dropped_and_container_paths_mapped(self):
        args, env = H.canon()
        self.assertEqual(args, ["--host", "127.0.0.1", "--port", "8787", "--mode", "cache", "--no-http2", "--no-cache"])
        self.assertEqual(env["TIKTOKEN_CACHE_DIR"], f"{self.home}/.headroom/tiktoken-cache")
        self.assertEqual(env["HEADROOM_LOSSLESS"], "1")

    def test_plist(self):
        d = plistlib.loads(H.plist_bytes())
        self.assertEqual(d["ProgramArguments"][1:3], ["proxy", "--host"])
        self.assertIn("--no-cache", d["ProgramArguments"])  # кэш ответов выключен каноном
        self.assertTrue(d["KeepAlive"])
        self.assertEqual(d["StandardOutPath"], "/dev/null")  # строка uvicorn на каждый запрос — не в журнал
        self.assertEqual(d["WorkingDirectory"], f"{self.home}/.headroom")

    def test_manifest_without_port_is_refused(self):
        (self.home / ".headroom/deploy/default/manifest.json").write_text(json.dumps({"proxy_args": ["--mode", "x"]}))
        with self.assertRaises(ValueError):
            H.canon()


class InstallTest(Base):
    def test_foreign_listener_is_left_alone(self):
        rc = self.run_install((77, "/Applications/Docker.app/Contents/MacOS/com.docker.backend"))
        self.assertEqual(rc, 1)
        self.assertEqual(self.calls, [])
        self.assertIn("не headroom", self.log[-1])

    def test_manual_headroom_is_replaced_by_service(self):
        self.assertEqual(self.run_install((10880, HEADROOM)), 0)
        self.assertEqual(self.calls, ["stop 10880", "bootstrap"])
        self.assertEqual(os.stat(H.plist_path()).st_mode & 0o777, 0o600)

    def test_service_not_ready_falls_back(self):
        self.assertEqual(self.run_install((10880, HEADROOM), ready=False), 1)
        self.assertEqual(self.calls, ["stop 10880", "bootstrap", "fallback"])

    def test_port_not_freed_no_service(self):
        self.assertEqual(self.run_install((10880, HEADROOM), stopped=False), 1)
        self.assertNotIn("bootstrap", self.calls)

    def test_already_under_service(self):
        H.write_plist()
        self.assertEqual(self.run_install((4242, HEADROOM), spid=4242), 0)
        self.assertEqual(self.calls, [])

    def test_changed_flags_restart_service(self):
        self.assertEqual(self.run_install((4242, HEADROOM), spid=4242), 0)  # plist записан впервые — «сменился»
        self.assertEqual(self.calls, ["kickstart"])

    def test_free_port_just_starts(self):
        self.assertEqual(self.run_install((None, "")), 0)
        self.assertEqual(self.calls, ["bootstrap"])


if __name__ == "__main__":
    unittest.main()
