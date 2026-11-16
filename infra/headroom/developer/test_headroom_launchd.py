#!/usr/bin/env python3
"""headroom_launchd.py: флаги и окружение — из манифеста канона по спискам; бинарь — только из uv; переключение
снимает только headroom; смена флагов — повторная загрузка (не kickstart); сервис не ответил — запасной процесс,
код 3. launchctl, порт и процессы подменены.

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
        self.manifest(MANIFEST)
        (self.home / "Library" / "Logs").mkdir(parents=True)
        tool = self.home / ".local/share/uv/tools/headroom-ai/bin"
        tool.mkdir(parents=True)
        (tool / "headroom").write_text("#!/bin/sh\n")
        (tool / "headroom").chmod(0o755)
        (self.home / ".local/bin").mkdir(parents=True)
        (self.home / ".local/bin/headroom").symlink_to(tool / "headroom")
        self.env = mock.patch.dict(os.environ, {"HEADROOM_SERVICE_HOME": str(self.home)})
        self.env.start()
        self.calls, self.log = [], []

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def manifest(self, d):
        m = self.home / ".headroom" / "deploy" / "default"
        m.mkdir(parents=True, exist_ok=True)
        (m / "manifest.json").write_text(json.dumps(d))

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
                mock.patch.object(H, "port_free", lambda: True), \
                mock.patch.object(H, "stop", lambda pid, cmd, log: self.calls.append(f"stop {pid}") or stopped), \
                mock.patch.object(H, "ready", lambda timeout=2.0: ready), \
                mock.patch.object(H, "READY_WAIT", 0.2), \
                mock.patch.object(H, "fallback", lambda log: self.calls.append("fallback") or fallback_ok):
            return H.install(self.log.append)


class CanonTest(Base):
    def test_docker_flags_dropped_and_container_paths_mapped(self):
        args, env = H.canon()
        self.assertEqual(args, ["--host", "127.0.0.1", "--port", "8787", "--mode", "cache", "--no-http2", "--no-cache"])
        self.assertEqual(env["TIKTOKEN_CACHE_DIR"], f"{self.home}/.headroom/tiktoken-cache")

    def test_plist(self):
        d = plistlib.loads(H.plist_bytes())
        self.assertEqual(d["ProgramArguments"][1:3], ["proxy", "--host"])
        self.assertIn("--no-cache", d["ProgramArguments"])
        self.assertEqual((d["StandardOutPath"], d["StandardErrorPath"]), ("/dev/null", "/dev/null"))
        self.assertEqual(set(d["EnvironmentVariables"]) - set(MANIFEST["base_env"]), {"PATH", "HOME", "LANG"})

    def test_manifest_is_checked(self):
        """Манифест не защищён хуком: адрес, флаги и переменные — по спискам (launchd запускает это при входе)."""
        bad = [
            {"proxy_args": ["--host", "0.0.0.0", "--port", "8787"]},
            {"proxy_args": ["--host", "127.0.0.1", "--port", "8788"]},
            {"proxy_args": ["--host", "127.0.0.1", "--port", "8787", "--host", "0.0.0.0"]},
            {"proxy_args": ["--host", "127.0.0.1", "--port", "8787", "--log-file", "/tmp/x"]},
            {"proxy_args": ["--host", "127.0.0.1", "--port", "8787"], "base_env": {"DYLD_INSERT_LIBRARIES": "/x"}},
            {"proxy_args": ["--host", "127.0.0.1", "--port", "8787"], "base_env": {"PYTHONPATH": "/x"}},
            {"proxy_args": ["--host", "127.0.0.1", "--port", "8787"], "base_env": {"HEADROOM_HOST": "0.0.0.0"}},
            {"proxy_args": ["--mode", "cache"]},
        ]
        for d in bad:
            self.manifest(d)
            with self.assertRaises(H.Refused, msg=d):
                H.canon()

    def test_binary_only_from_uv(self):
        link = self.home / ".local/bin/headroom"
        link.unlink()
        link.write_text("#!/bin/sh\n")
        link.chmod(0o755)
        with self.assertRaises(H.Refused):
            H.headroom_bin()


class InstallTest(Base):
    def test_foreign_listener_is_left_alone(self):
        rc = self.run_install((77, "/Applications/Docker.app/Contents/MacOS/com.docker.backend"))
        self.assertEqual((rc, self.calls), (1, []))
        self.assertIn("не headroom", self.log[-1])

    def test_foreign_listener_unloads_crash_looping_service(self):
        self.assertEqual(self.run_install((77, "com.docker.backend"), spid=0), 1)
        self.assertEqual(self.calls, ["bootout"])

    def test_manual_headroom_is_replaced_by_service(self):
        self.assertEqual(self.run_install((10880, HEADROOM)), 0)
        self.assertEqual(self.calls, ["stop 10880", "bootstrap"])
        self.assertEqual(os.stat(H.plist_path()).st_mode & 0o777, 0o600)

    def test_bad_manifest_touches_nothing(self):
        self.manifest({"proxy_args": ["--host", "0.0.0.0", "--port", "8787"]})
        self.assertEqual(self.run_install((10880, HEADROOM)), 1)
        self.assertEqual(self.calls, [])
        self.assertFalse(H.plist_path().exists())

    def test_service_not_ready_falls_back_with_code_3(self):
        self.assertEqual(self.run_install((10880, HEADROOM), ready=False), 3)
        self.assertEqual(self.calls, ["stop 10880", "bootstrap", "fallback"])

    def test_port_not_freed_no_service(self):
        self.assertEqual(self.run_install((10880, HEADROOM), stopped=False), 1)
        self.assertNotIn("bootstrap", self.calls)

    def test_already_under_service(self):
        H.write_plist()
        self.assertEqual(self.run_install((4242, HEADROOM), spid=4242), 0)
        self.assertEqual(self.calls, [])

    def test_changed_flags_reload_not_kickstart(self):
        """kickstart -k запускает plist, который launchd держит в памяти с bootstrap, — новые флаги не применились бы."""
        self.assertEqual(self.run_install((4242, HEADROOM), spid=4242), 0)  # plist записан впервые — «сменился»
        self.assertEqual(self.calls, ["bootout", "bootstrap"])

    def test_free_port_just_starts(self):
        self.assertEqual(self.run_install((None, "")), 0)
        self.assertEqual(self.calls, ["bootstrap"])


class HelpersTest(Base):
    def test_is_headroom(self):
        for cmd in (HEADROOM, "/Users/u/.local/bin/headroom proxy --port 8787"):
            self.assertTrue(H.is_headroom(cmd), cmd)
        for cmd in ("vim headroom-proxy-notes.md", "python3 x.py headroom proxy-x", "com.docker.backend"):
            self.assertFalse(H.is_headroom(cmd), cmd)

    def test_drift(self):
        args = ["--host", "127.0.0.1", "--port", "8787", "--no-cache"]
        self.assertEqual(H.drift("/x/headroom proxy --host 127.0.0.1 --port 8787 --no-cache", args), [])
        self.assertEqual(H.drift("/x/headroom proxy --host 127.0.0.1 --port 8787 --no-http2", args),
                         ["--no-cache", "лишний --no-http2"])


if __name__ == "__main__":
    unittest.main()
