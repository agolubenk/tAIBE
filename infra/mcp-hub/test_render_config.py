"""Тесты render_config.py: python3 -I -m unittest discover -s infra/mcp-hub -p 'test_*.py' (make check-infra)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_config as rc  # noqa: E402

LAYER = "/opt/layer"
HOST = "/opt/host"

TEMPLATE = {
    "mcpServers": {
        "ai-council": {
            "command": "python3",
            "args": ["infra/ai-council/mcp_server.py"],
            "cwd": "${HR_HELPER_ROOT}",
            "env": {"TAIBE_HOST_ROOT": "${TAIBE_HOST_ROOT}"},
        },
        "git": {"command": "uvx", "args": ["mcp-server-git", "--repository", "${TAIBE_HOST_ROOT}"]},
        "postgres-readonly": {"command": "bash", "args": ["x.sh"], "cwd": "${TAIBE_HOST_ROOT}"},
        "serena": {"type": "http", "url": "http://127.0.0.1:${SERENA_HTTP_PORT}/mcp"},
        "figma": {"type": "http", "url": "https://mcp.figma.com/mcp", "tags": ["connector"]},
    }
}


def live_for(host: str, serve_literal: bool = True) -> dict:
    """Живой конфиг, как его пишет sync для `host` (HR_HELPER_ROOT — литералом или заглушкой)."""
    cfg = rc.render(TEMPLATE, set(), host)
    return rc.substitute(cfg, rc.SERVE_VAR, LAYER) if serve_literal else cfg


class RenderTest(unittest.TestCase):
    def test_host_substituted_other_vars_left_for_1mcp(self):
        out = rc.render(TEMPLATE, set(), HOST)["mcpServers"]
        self.assertEqual(out["git"]["args"][2], HOST)
        self.assertEqual(out["postgres-readonly"]["cwd"], HOST)
        self.assertEqual(out["ai-council"]["env"]["TAIBE_HOST_ROOT"], HOST)
        self.assertEqual(out["ai-council"]["cwd"], "${HR_HELPER_ROOT}")
        self.assertIn("${SERENA_HTTP_PORT}", out["serena"]["url"])
        self.assertNotIn("${TAIBE_HOST_ROOT}", json.dumps(out))

    def test_connectors_only_enabled(self):
        self.assertNotIn("figma", rc.render(TEMPLATE, set(), HOST)["mcpServers"])
        self.assertIs(rc.render(TEMPLATE, {"figma"}, HOST)["mcpServers"]["figma"]["disabled"], False)

    def test_template_not_mutated(self):
        before = json.dumps(TEMPLATE)
        rc.render(TEMPLATE, {"figma"}, HOST)
        self.assertEqual(json.dumps(TEMPLATE), before)


class HostGuardTest(unittest.TestCase):
    def test_same_host_passes(self):
        self.assertEqual(rc.host_mismatch(TEMPLATE, live_for(HOST), HOST, LAYER), [])

    def test_forgotten_env_is_caught(self):
        # TAIBE_HOST_ROOT не задан → host_root = папка слоя, а живой конфиг обслуживает хост.
        self.assertEqual(rc.host_mismatch(TEMPLATE, live_for(HOST), LAYER, LAYER), [HOST])

    def test_old_live_with_serve_placeholder(self):
        # До переезда: --repository "${HR_HELPER_ROOT}" — хост = обслуживаемая копия.
        old = json.loads(json.dumps(TEMPLATE).replace("${TAIBE_HOST_ROOT}", "${HR_HELPER_ROOT}"))
        self.assertEqual(rc.host_mismatch(TEMPLATE, old, LAYER, LAYER), [])
        self.assertEqual(rc.host_mismatch(TEMPLATE, old, HOST, LAYER), [LAYER])

    def test_shifted_args_not_taken_for_host(self):
        live = live_for(HOST)
        live["mcpServers"]["git"]["args"] = ["mcp-server-git", HOST, "--repository"]
        live["mcpServers"]["postgres-readonly"].pop("cwd")
        live["mcpServers"]["ai-council"].pop("env")
        self.assertEqual(rc.live_hosts(TEMPLATE, live, LAYER), {})


class DriftTest(unittest.TestCase):
    def test_no_drift(self):
        self.assertEqual(rc.drift(TEMPLATE, set(), live_for(HOST), HOST, LAYER), [])
        self.assertEqual(rc.drift(TEMPLATE, set(), live_for(HOST, serve_literal=False), HOST, LAYER), [])

    def test_changed_added_removed(self):
        live = live_for(HOST)
        live["mcpServers"]["serena"]["url"] = "http://127.0.0.1:1/mcp"
        live["mcpServers"]["extra"] = {"command": "x"}
        del live["mcpServers"]["git"]
        lines = rc.drift(TEMPLATE, set(), live, HOST, LAYER)
        self.assertIn("⚠ sync перепишет из шаблона: serena", lines)
        self.assertIn("⚠ sync добавит: git", lines)
        self.assertIn("⚠ sync уберёт: extra", lines)
        self.assertEqual(lines[-1], "  применить: npm run mcp-hub:sync")

    def test_host_mismatch_reported_instead_of_server_list(self):
        lines = rc.drift(TEMPLATE, set(), live_for(HOST), LAYER, LAYER)
        self.assertEqual(len(lines), 1)
        self.assertIn(f"TAIBE_HOST_ROOT={HOST} npm run mcp-hub:sync", lines[0])


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.template, self.live = d / "mcp.json", d / "live.json"
        self.template.write_text(json.dumps(TEMPLATE), encoding="utf-8")
        self.live.write_text(json.dumps(live_for(HOST)), encoding="utf-8")
        os.environ.pop(rc.HOST_CHANGE_ENV, None)

    def tearDown(self):
        os.environ.pop(rc.HOST_CHANGE_ENV, None)
        self.tmp.cleanup()

    def run_cli(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        base = ["--template", str(self.template), "--serve-root", LAYER]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rc.main([args[0], *base, *args[1:]])
        return code, out.getvalue(), err.getvalue()

    def test_render_refuses_host_change(self):
        code, out, err = self.run_cli("render", "--host-root", LAYER, "--live", str(self.live))
        self.assertEqual((code, out), (rc.EXIT_HOST_MISMATCH, ""))
        self.assertIn(f"TAIBE_HOST_ROOT={HOST} npm run mcp-hub:sync", err)

    def test_render_host_change_on_purpose(self):
        os.environ[rc.HOST_CHANGE_ENV] = "1"
        code, out, _ = self.run_cli("render", "--host-root", LAYER, "--live", str(self.live))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["mcpServers"]["git"]["args"][2], LAYER)

    def test_broken_live_json_one_line_error(self):
        self.live.write_text("{oops", encoding="utf-8")
        for mode in ("render", "drift"):
            code, out, err = self.run_cli(mode, "--host-root", HOST, "--live", str(self.live))
            self.assertEqual((code, out), (rc.EXIT_BAD_INPUT, ""))
            self.assertTrue(err.startswith(f"✗ render_config.py {mode}:"), err)
            self.assertEqual(err.count("\n"), 1)

    def test_render_without_live_and_drift_without_live(self):
        code, out, _ = self.run_cli("render", "--host-root", HOST, "--live", "")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["mcpServers"]["postgres-readonly"]["cwd"], HOST)
        self.assertEqual(self.run_cli("drift", "--host-root", HOST)[:2], (0, ""))

    def test_host_of_live_config(self):
        """mcp-hub.sh без TAIBE_HOST_ROOT берёт хост отсюда: одна строка, без --host-root."""
        self.assertEqual(self.run_cli("host", "--live", str(self.live))[:2], (0, HOST + "\n"))

    def test_host_without_live_or_without_host_is_empty(self):
        self.assertEqual(self.run_cli("host", "--live", "")[:2], (0, ""))
        self.live.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
        self.assertEqual(self.run_cli("host", "--live", str(self.live))[:2], (0, ""))

    def test_host_several_hosts_one_per_line(self):
        live = live_for(HOST)
        live["mcpServers"]["postgres-readonly"]["cwd"] = "/opt/other"
        self.live.write_text(json.dumps(live), encoding="utf-8")
        self.assertEqual(self.run_cli("host", "--live", str(self.live))[:2], (0, "/opt/host\n/opt/other\n"))

    def test_render_and_drift_need_host_root(self):
        for mode in ("render", "drift"):
            with self.assertRaises(SystemExit) as exit_info, contextlib.redirect_stderr(io.StringIO()):
                self.run_cli(mode, "--live", str(self.live))
            self.assertEqual(exit_info.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
