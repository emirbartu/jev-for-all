"""Offline parity tests for the browser-mcp core. Stdlib only, no MCP SDK, no network."""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from browser_mcp import (  # noqa: E402
    STEP_CEILING,
    BrowserConfig,
    SpawnOutcome,
    build_runner_command,
    clamp,
    failed_run,
    format_run,
    parse_runner_output,
    run_browser_task,
    stderr_tail,
)

HOME = os.environ.get("HOME", "")

DONE_PAYLOAD = {
    "ok": True,
    "status": "done",
    "url": "https://example.test/a",
    "title": "A",
    "steps": [{"step": 1, "operation": "CLICK", "action": "Go", "url": "https://example.test/a", "text": None}],
    "decisions": 2,
    "cost_usd": 0.000031,
    "elapsed_ms": 1200,
    "error": None,
}


def run_line(payload):
    import json

    return f"noise on stdout\nJEV_RESULT {json.dumps(payload)}\n"


class ParseTest(unittest.TestCase):
    def test_parses_the_shared_done_payload_like_the_ts_side(self):
        run = parse_runner_output(run_line(DONE_PAYLOAD))
        self.assertEqual(
            run,
            {
                "ok": True,
                "status": "done",
                "url": "https://example.test/a",
                "title": "A",
                "steps": DONE_PAYLOAD["steps"],
                "decisions": 2,
                "costUsd": 0.000031,
                "elapsedMs": 1200,
                "error": None,
            },
        )

    def test_rejects_junk_and_keeps_the_last_sentinel_line(self):
        self.assertIsNone(parse_runner_output("nothing to see"))
        self.assertIsNone(parse_runner_output("JEV_RESULT {not json}"))
        self.assertIsNone(parse_runner_output('JEV_RESULT {"status": "done"}'))
        second = run_line({**DONE_PAYLOAD, "status": "blocked", "ok": False})
        first = run_line(DONE_PAYLOAD)
        self.assertEqual(parse_runner_output(first + second)["status"], "blocked")

    def test_missing_fields_fall_back_to_defaults(self):
        run = parse_runner_output('JEV_RESULT {"ok": false, "status": "error"}')
        self.assertEqual(run["url"], "")
        self.assertEqual(run["title"], "")
        self.assertEqual(run["steps"], [])
        self.assertEqual(run["decisions"], 0)
        self.assertEqual(run["costUsd"], 0)
        self.assertEqual(run["elapsedMs"], 0)
        self.assertIsNone(run["error"])


class CommandTest(unittest.TestCase):
    def test_build_runner_command_pins_uv_at_the_jev_checkout(self):
        command = build_runner_command(
            BrowserConfig(jev_dir="~/jev-ultrafast"), "/plugin/src/jev-runner.py"
        )
        self.assertEqual(
            command,
            [
                "uv",
                "run",
                "--directory",
                f"{HOME}/jev-ultrafast",
                "--env-file",
                f"{HOME}/jev-ultrafast/.env",
                "--quiet",
                "python",
                "/plugin/src/jev-runner.py",
            ],
        )

    def test_absolute_env_file_wins(self):
        command = build_runner_command(
            BrowserConfig(jev_dir="/opt/jev", env_file="/etc/jev.env"), "/r.py"
        )
        self.assertIn("/etc/jev.env", command)
        self.assertIn("/opt/jev", command)

    def test_config_from_env_defaults_and_overrides(self):
        defaults = BrowserConfig.from_env({})
        self.assertEqual(defaults.jev_dir, "~/jev-ultrafast")
        self.assertEqual(defaults.max_steps, 12)
        custom = BrowserConfig.from_env(
            {"BROWSER_MCP_JEV_DIR": "/opt/jev", "BROWSER_MCP_UV": "/x/uv", "BROWSER_MCP_MAX_STEPS": "3"}
        )
        self.assertEqual(custom.jev_dir, "/opt/jev")
        self.assertEqual(custom.uv_path, "/x/uv")
        self.assertEqual(custom.max_steps, 3)
        self.assertEqual(BrowserConfig.from_env({"BROWSER_MCP_MAX_STEPS": "many"}).max_steps, 12)


class ClampTest(unittest.TestCase):
    def test_clamp_bounds_and_non_finite(self):
        self.assertEqual(clamp(999, 1, STEP_CEILING), STEP_CEILING)
        self.assertEqual(clamp(0, 1, STEP_CEILING), 1)
        self.assertEqual(clamp("x", 1, STEP_CEILING), 1)
        self.assertEqual(clamp(float("nan"), 1, STEP_CEILING), 1)
        self.assertEqual(clamp(2.6, 1, STEP_CEILING), 3)


class RunTest(unittest.TestCase):
    def test_passes_goal_url_and_budget_over_env_and_clamps(self):
        calls = []

        def spawn(command, env, timeout_ms):
            calls.append((command, env, timeout_ms))
            return SpawnOutcome(0, run_line(DONE_PAYLOAD), "", False)

        config = BrowserConfig(timeout_ms=5000)
        run, _ = run_browser_task("  Find stays in Lisbon  ", config, max_steps=999, spawn=spawn)
        self.assertEqual(calls[0][1]["JEV_TASK_GOAL"], "Find stays in Lisbon")
        self.assertEqual(calls[0][1]["JEV_TASK_URL"], "about:blank")
        self.assertEqual(calls[0][1]["JEV_TASK_MAX_STEPS"], str(STEP_CEILING))
        self.assertEqual(calls[0][2], 5000)
        self.assertTrue(run["ok"])
        self.assertEqual(run["decisions"], 2)

        explicit = []

        def spawn2(command, env, timeout_ms):
            explicit.append(env)
            return SpawnOutcome(0, run_line(DONE_PAYLOAD), "", False)

        run_browser_task("x", config, url=" https://a.test/ ", max_steps=3, spawn=spawn2)
        self.assertEqual(explicit[0]["JEV_TASK_URL"], "https://a.test/")
        self.assertEqual(explicit[0]["JEV_TASK_MAX_STEPS"], "3")

    def test_fails_open_with_readable_reasons(self):
        no_result, _ = run_browser_task(
            "x", BrowserConfig(), spawn=lambda c, e, t: SpawnOutcome(1, "", "daemon default didn't come up\n", False)
        )
        self.assertFalse(no_result["ok"])
        self.assertIn("no result", no_result["error"])
        self.assertIn("daemon default", no_result["error"])

        hung, _ = run_browser_task("x", BrowserConfig(), spawn=lambda c, e, t: SpawnOutcome(None, "", "", True))
        self.assertIn("timed out", hung["error"])

        def boom(command, env, timeout_ms):
            raise OSError("ENOENT uv")

        threw, _ = run_browser_task("x", BrowserConfig(), spawn=boom)
        self.assertIn("could not start", threw["error"])
        self.assertIn("ENOENT uv", threw["error"])

        homeless, _ = run_browser_task("   ", BrowserConfig(), spawn=lambda c, e, t: SpawnOutcome(0, "", "", False))
        self.assertIn("needs a goal", homeless["error"])

    def test_failed_result_with_stderr_gets_a_tail(self):
        payload = {"ok": False, "status": "blocked", "error": None}
        run, _ = run_browser_task(
            "x", BrowserConfig(), spawn=lambda c, e, t: SpawnOutcome(0, run_line(payload), "chrome not connected\n", False)
        )
        self.assertEqual(run["error"], "chrome not connected")


class FormatTest(unittest.TestCase):
    def test_format_run_matches_the_ts_layout(self):
        run = parse_runner_output(run_line(DONE_PAYLOAD))
        text = format_run(run, "Find a stay in Lisbon")
        self.assertIn("browser_task reported done — done", text)
        self.assertIn("goal: Find a stay in Lisbon", text)
        self.assertIn("final url: https://example.test/a", text)
        self.assertIn("steps: 1 — 2 Jev decisions, $0.000031, 1200 ms", text)
        self.assertIn('  1. CLICK "Go" -> https://example.test/a', text)
        self.assertNotIn("Not confirmed", text)

        failed = failed_run("boom")
        text = format_run(failed, "x")
        self.assertIn("did not finish — error", text)
        self.assertIn("error: boom", text)
        self.assertIn("Not confirmed by the caller", text)

    def test_stderr_tail_keeps_last_three_lines(self):
        stderr = "one\n\ntwo\nthree\nfour\n"
        self.assertEqual(stderr_tail(stderr), "two | three | four")


if __name__ == "__main__":
    unittest.main()
