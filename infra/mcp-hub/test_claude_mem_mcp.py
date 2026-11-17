"""claude-mem-mcp.sh: which mcp-server.cjs the hub starts (OPS-21).

Order: the marketplace copy, then `installPath` from `installed_plugins.json`, then the newest cache copy by mtime.
Each case builds a fake config dir; the fake server prints its own path, so the test sees the choice and starts
nothing real. HOME and PATH point away from the real `claude-mem` command, so no worker is started.
"""
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "claude-mem-mcp.sh")
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is not installed")
class ClaudeMemPath(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())  # node prints the real path (/private/var on macOS)
        self.conf = os.path.join(self.tmp, "claude")
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        os.symlink(NODE, os.path.join(self.bin, "node"))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def server(self, rel, mtime=None):
        path = os.path.join(self.conf, "plugins", rel, "scripts", "mcp-server.cjs")
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("process.stdout.write(__filename)\n")
        if mtime is not None:
            os.utime(os.path.dirname(path), (mtime, mtime))
        return path

    def installed(self, rel):
        path = os.path.join(self.conf, "plugins", "installed_plugins.json")
        entry = {"scope": "user", "installPath": os.path.join(self.conf, "plugins", rel), "version": "x"}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"version": 2, "plugins": {"claude-mem@thedotmack": [entry]}}, fh)

    def run_script(self):
        env = {"CLAUDE_CONFIG_DIR": self.conf, "HOME": self.home, "PATH": self.bin + ":/usr/bin:/bin"}
        r = subprocess.run(["sh", SCRIPT], capture_output=True, text=True, env=env, timeout=30)
        return r.returncode, r.stdout, r.stderr

    def test_marketplace_first(self):
        want = self.server("marketplaces/thedotmack/plugin")
        self.server("cache/thedotmack/claude-mem/15.7.0")
        self.installed("cache/thedotmack/claude-mem/15.7.0")
        self.assertEqual(self.run_script()[1], want)

    def test_install_path_beats_newer_mtime(self):
        now = time.time()
        want = self.server("cache/thedotmack/claude-mem/15.7.0", mtime=now - 3600)
        self.server("cache/thedotmack/claude-mem/15.6.0", mtime=now)
        self.installed("cache/thedotmack/claude-mem/15.7.0")
        self.assertEqual(self.run_script()[1], want)

    def test_mtime_without_installed_plugins(self):
        now = time.time()
        self.server("cache/thedotmack/claude-mem/15.6.0", mtime=now - 3600)
        want = self.server("cache/thedotmack/claude-mem/15.7.0", mtime=now)
        self.assertEqual(self.run_script()[1], want)

    def test_mtime_when_install_path_is_gone(self):
        want = self.server("cache/thedotmack/claude-mem/15.7.0")
        self.installed("cache/thedotmack/claude-mem/15.8.0")
        self.assertEqual(self.run_script()[1], want)

    def test_no_copy_fails(self):
        os.makedirs(os.path.join(self.conf, "plugins"))
        code, out, err = self.run_script()
        self.assertEqual((code, out), (1, ""))
        self.assertIn("не найден", err)


if __name__ == "__main__":
    unittest.main()
