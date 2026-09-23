# Jev Everywhere Phase C — Browser Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One stdio MCP server (`adapters/browser-mcp/`) exposes the goal-driven `browser_task` tool with the same contract as the OpenCode plugin's `src/browser.ts`, so Hermes and Claude Code can run the Jev Ultrafast loop through their own MCP clients; both adapters get the wiring and the docs.

**Architecture:** `browser_mcp.py` holds the whole contract — config from env, the `uv run` command builder, the `JEV_RESULT` parser, formatting, and the spawn wrapper — as pure stdlib functions mirroring `src/browser.ts` branch for branch. `server.py` is a thin MCP v2 `MCPServer` wrapper around them. `src/jev-runner.py` is reused unchanged. Hermes and Claude Code consume the server over stdio; this phase writes their config/docs only — nothing under `~/.hermes`.

**Tech Stack:** Python 3 stdlib for the core and tests; MCP Python SDK v2 (`mcp.server.mcpserver.MCPServer`) run through `uv run --no-project --with mcp`; `unittest`; no new repo dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-jev-everywhere-design.md` (Phase C, per-harness mapping)

## Global Constraints

- **Fail open, never raise.** Every failure — missing goal, missing `uv`, missing checkout, missing browser, timeout, unparseable output — becomes readable tool text; the MCP tool returns a string, not a protocol error.
- **Contract parity with `src/browser.ts`:** `goal` required, `url` defaults to `about:blank`, `max_steps` clamped to `[1, 60]` (default 12); command is exactly `uv run --directory <jevDir> --env-file <resolved> --quiet python <repo>/src/jev-runner.py`; the parser takes the **last** `JEV_RESULT ` line, rejects junk, and maps `cost_usd`/`elapsed_ms` to `costUsd`/`elapsedMs`; `stderr_tail` keeps the last 3 non-empty lines, capped at 300 chars; failure copy mirrors the TS strings.
- **`src/jev-runner.py` is reused unchanged.**
- **No `~/.hermes` writes.** The Hermes block is documentation; the user edits their own `config.yaml`.
- **No new repo dependencies; no changes to `src/`, `index.ts`, `package.json`, or the existing adapters' code** — only new files under `adapters/browser-mcp/`, the two Claude Code wiring files, and doc updates.
- **Run command (verified on this machine):** `uv run --no-project --with mcp python adapters/browser-mcp/server.py` — `uv 0.12.5`, MCP SDK v2, `python3` 3.14 with no pip.
- **Tests are offline and free:** no live browser, no paid calls. A fake `uv` executable (a shell script) stands in for the real launcher.
- **Commit style:** conventional, one concern per commit. Local commits only — this repo never pushes.

## Review focus

- **Task 1:** parity of each pure function against `src/browser.ts` (strings, clamping, last-sentinel parsing, stderr tail); tests assert real values, not just shapes.
- **Task 2:** the protocol layer is thin (no logic beyond wrapping); the stdio test exercises the real server through `uv` and a fake launcher; a failure call returns text with `isError` false.
- **Task 3:** the documented command and Hermes block are exactly what was run; the transcript is real output.
- **Task 4:** the `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}` correctly and resolves to the sibling `browser-mcp/server.py`; the skill states when to use the tool and to verify outcomes.
- **Task 5:** every gate command exits 0; the live-smoke outcome is recorded as it happened.

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `adapters/browser-mcp/browser_mcp.py` | Create | Pure core: config, command, parser, format, spawn, run |
| `adapters/browser-mcp/server.py` | Create | MCP v2 stdio wrapper exposing `browser_task` |
| `adapters/browser-mcp/tests/test_browser_mcp.py` | Create | Offline unit + parity tests (stdlib only) |
| `adapters/browser-mcp/tests/test_stdio.py` | Create | Real stdio handshake/tool-call tests through `uv` with a fake launcher |
| `adapters/browser-mcp/README.md` | Create | Run command, env config, Hermes wiring block, smoke transcript, egress |
| `adapters/claude-code/.mcp.json` | Create | Claude Code MCP wiring for the server |
| `adapters/claude-code/skills/browser-task/SKILL.md` | Create | When to reach for `browser_task`; verify outcomes |
| `adapters/claude-code/README.md` | Modify | Browser section: install, usage, egress |

---

### Task 1: browser-mcp core and parity tests

**Files:**
- Create: `adapters/browser-mcp/browser_mcp.py`
- Create: `adapters/browser-mcp/tests/test_browser_mcp.py`

**Interfaces:**
- Consumes: `src/jev-runner.py` (path only; unchanged).
- Produces:
  - `BrowserConfig` dataclass (`jev_dir`, `env_file`, `uv_path`, `timeout_ms`, `max_steps`) + `BrowserConfig.from_env(environ=None)`
  - `expand_home(path, home=None) -> str`, `resolve_against(directory, path) -> str`, `runner_script() -> str`
  - `build_runner_command(config, script=None) -> list[str]`
  - `parse_runner_output(stdout) -> dict | None` with keys `ok, status, url, title, steps, decisions, costUsd, elapsedMs, error`
  - `failed_run(reason, **extra) -> dict`, `format_run(run, goal) -> str`, `stderr_tail(stderr, limit=300) -> str`
  - `clamp(value, low, high) -> int`, `SpawnOutcome(code, stdout, stderr, timed_out)`
  - `spawn_process(command, env, timeout_ms) -> SpawnOutcome`
  - `run_browser_task(goal, config, *, url=None, max_steps=None, spawn=spawn_process) -> tuple[dict, list[str]]`

- [ ] **Step 1: Write the failing tests**

Create `adapters/browser-mcp/tests/test_browser_mcp.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest discover -s adapters/browser-mcp/tests -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'browser_mcp'`.

- [ ] **Step 3: Implement `browser_mcp.py`**

```python
"""Pure core for the browser_task MCP server: config, command building, parsing, spawning.

The protocol layer lives in server.py and is deliberately thin. Everything here is
importable and testable without the MCP SDK, a browser, or network access.
Mirrors src/browser.ts branch for branch.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

SENTINEL = "JEV_RESULT "
STEP_CEILING = 60
DEFAULT_MAX_STEPS = 12
DEFAULT_TIMEOUT_MS = 180_000

BROWSER_TASK_DESCRIPTION = (
    "Run one natural-language goal in a real browser. A Jev policy model — not you — chooses "
    "every click, field value and target, so state the goal and its acceptance criteria instead "
    "of scripting steps. Return the final URL, the page title and the action trace. The trace is "
    "a report, not proof: verify the outcome before reporting success, and do not retry a browser "
    "mutation blindly."
)


@dataclass(frozen=True)
class BrowserConfig:
    jev_dir: str = "~/jev-ultrafast"
    env_file: str = ".env"
    uv_path: str = "uv"
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    max_steps: int = DEFAULT_MAX_STEPS

    @staticmethod
    def from_env(environ=None) -> "BrowserConfig":
        env = os.environ if environ is None else environ

        def number(name: str, default: int) -> int:
            try:
                return int(env.get(name) or default)
            except ValueError:
                return default

        return BrowserConfig(
            jev_dir=env.get("BROWSER_MCP_JEV_DIR") or "~/jev-ultrafast",
            env_file=env.get("BROWSER_MCP_ENV_FILE") or ".env",
            uv_path=env.get("BROWSER_MCP_UV") or "uv",
            timeout_ms=number("BROWSER_MCP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
            max_steps=number("BROWSER_MCP_MAX_STEPS", DEFAULT_MAX_STEPS),
        )


def expand_home(path: str, home: str | None = None) -> str:
    home = os.environ.get("HOME", "") if home is None else home
    if path == "~":
        return home or path
    if path.startswith("~/"):
        return f"{home}/{path[2:]}" if home else path[2:]
    return path


def resolve_against(directory: str, path: str) -> str:
    expanded = expand_home(path)
    if expanded.startswith("/"):
        return expanded
    return f"{directory.rstrip('/')}/{expanded}"


def runner_script() -> str:
    # adapters/browser-mcp/browser_mcp.py -> repo root -> src/jev-runner.py
    return str(Path(__file__).resolve().parents[2] / "src" / "jev-runner.py")


def build_runner_command(config: BrowserConfig, script: str | None = None) -> list[str]:
    directory = expand_home(config.jev_dir)
    return [
        config.uv_path,
        "run",
        "--directory",
        directory,
        "--env-file",
        resolve_against(directory, config.env_file),
        "--quiet",
        "python",
        script or runner_script(),
    ]


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def parse_runner_output(stdout: str) -> dict | None:
    line = next((candidate for candidate in reversed(stdout.split("\n")) if candidate.startswith(SENTINEL)), None)
    if line is None:
        return None
    try:
        raw = json.loads(line[len(SENTINEL) :])
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, dict) or not isinstance(raw.get("ok"), bool) or not isinstance(raw.get("status"), str):
        return None
    return {
        "ok": raw["ok"],
        "status": raw["status"],
        "url": raw.get("url") if isinstance(raw.get("url"), str) else "",
        "title": raw.get("title") if isinstance(raw.get("title"), str) else "",
        "steps": raw.get("steps") if isinstance(raw.get("steps"), list) else [],
        "decisions": raw.get("decisions") if _number(raw.get("decisions")) else 0,
        "costUsd": raw.get("cost_usd") if _number(raw.get("cost_usd")) else 0,
        "elapsedMs": raw.get("elapsed_ms") if _number(raw.get("elapsed_ms")) else 0,
        "error": raw.get("error") if isinstance(raw.get("error"), str) and raw.get("error") else None,
    }


def failed_run(reason: str, **extra) -> dict:
    run = {
        "ok": False,
        "status": "error",
        "url": "",
        "title": "",
        "steps": [],
        "decisions": 0,
        "costUsd": 0,
        "elapsedMs": 0,
        "error": reason,
    }
    run.update(extra)
    return run


def format_run(run: dict, goal: str) -> str:
    lines = [f"browser_task {'reported done' if run['ok'] else 'did not finish'} — {run['status']}"]
    if run.get("error"):
        lines.append(f"error: {run['error']}")
    if goal:
        lines.append(f"goal: {goal}")
    lines.append(f"final url: {run['url'] or '(unchanged)'}")
    if run.get("title"):
        lines.append(f"title: {run['title']}")
    lines.append(
        f"steps: {len(run['steps'])} — {run['decisions']} Jev decisions, ${run['costUsd']:.6f}, {run['elapsedMs']} ms"
    )
    for step in run["steps"]:
        typed = f" = {json.dumps(step.get('text'), ensure_ascii=False)}" if step.get("text") else ""
        lines.append(
            f"  {step.get('step')}. {step.get('operation')} \"{step.get('action')}\"{typed} -> {step.get('url')}"
        )
    if not run["ok"]:
        lines.append("Not confirmed by the caller: check the page or the outcome before reporting success.")
    return "\n".join(lines)


def stderr_tail(stderr: str, limit: int = 300) -> str:
    lines = [line for line in stderr.split("\n") if line.strip()][-3:]
    text = " | ".join(lines)
    return text[-limit:] if len(text) > limit else text


def clamp(value, low: int, high: int) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return low
    if math.isnan(number) or math.isinf(number):
        return low
    return min(high, max(low, int(math.floor(number + 0.5))))


@dataclass
class SpawnOutcome:
    code: int | None
    stdout: str
    stderr: str
    timed_out: bool


def spawn_process(command: list[str], env: dict[str, str], timeout_ms: int) -> SpawnOutcome:
    try:
        proc = subprocess.run(
            command,
            env={**os.environ, **env},
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
        )
    except subprocess.TimeoutExpired as error:
        def text(value) -> str:
            if value is None:
                return ""
            return value if isinstance(value, str) else value.decode(errors="replace")

        return SpawnOutcome(code=None, stdout=text(error.stdout), stderr=text(error.stderr), timed_out=True)
    return SpawnOutcome(code=proc.returncode, stdout=proc.stdout, stderr=proc.stderr, timed_out=False)


def run_browser_task(
    goal: str,
    config: BrowserConfig,
    *,
    url: str | None = None,
    max_steps=None,
    spawn=spawn_process,
) -> tuple[dict, list[str]]:
    goal = goal.strip() if isinstance(goal, str) else ""
    command = build_runner_command(config)
    if not goal:
        return failed_run("browser_task needs a goal."), command
    start_url = url.strip() if isinstance(url, str) and url.strip() else "about:blank"
    budget = clamp(max_steps if _number(max_steps) else config.max_steps, 1, STEP_CEILING)

    try:
        outcome = spawn(
            command,
            {"JEV_TASK_GOAL": goal, "JEV_TASK_URL": start_url, "JEV_TASK_MAX_STEPS": str(budget)},
            config.timeout_ms,
        )
    except Exception as error:  # noqa: BLE001 — every spawn failure is a readable result
        return failed_run(f"browser_task could not start {config.uv_path}: {error}"), command

    if outcome.timed_out:
        return failed_run(f"browser_task timed out after {config.timeout_ms} ms."), command
    run = parse_runner_output(outcome.stdout)
    if run is None:
        tail = stderr_tail(outcome.stderr)
        suffix = f" {tail}" if tail else ""
        code = outcome.code if outcome.code is not None else "?"
        return failed_run(f"browser_task produced no result (exit {code}).{suffix}"), command
    if not run["ok"] and not run.get("error") and outcome.stderr.strip():
        run["error"] = stderr_tail(outcome.stderr)
    return run, command
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s adapters/browser-mcp/tests -v`
Expected: PASS (all `test_browser_mcp` cases; the stdio file does not exist yet).

- [ ] **Step 5: Commit**

```bash
git add adapters/browser-mcp/browser_mcp.py adapters/browser-mcp/tests/test_browser_mcp.py
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add the browser-mcp core with ts parity tests"
```

**Gate:** `python3 -m unittest discover -s adapters/browser-mcp/tests -v` green; `bun test` and `bun run typecheck` untouched and green.

---

### Task 2: stdio protocol layer and handshake tests

**Files:**
- Create: `adapters/browser-mcp/server.py`
- Create: `adapters/browser-mcp/tests/test_stdio.py`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: a stdio MCP server exposing one tool, `browser_task(goal, url="about:blank", max_steps=None) -> str`, with the `BROWSER_TASK_DESCRIPTION` description; run as `uv run --no-project --with mcp python adapters/browser-mcp/server.py`.

- [ ] **Step 1: Write the failing tests**

Create `adapters/browser-mcp/tests/test_stdio.py`:

```python
"""Stdio smoke tests: spawn the real server through uv, with a fake launcher.

No browser, no paid calls. The fake `uv` is a shell script that ignores the uv flags and
prints a canned JEV_RESULT line (or fails), standing in for the real launcher.
"""
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from browser_mcp import BROWSER_TASK_DESCRIPTION  # noqa: E402

SERVER = Path(__file__).resolve().parents[1] / "server.py"
PROTOCOL_VERSION = "2026-07-28"
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


def uv_command() -> list[str]:
    return [shutil.which("uv") or "uv", "run", "--no-project", "--with", "mcp", "python", str(SERVER)]


def fake_uv(directory: Path, body: str) -> str:
    path = directory / "fake-uv"
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)
    return str(path)


def read_message(proc, timeout: float = 60.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], 0.5)
        if not ready:
            continue
        line = proc.stdout.readline()
        if not line:
            raise AssertionError("server closed stdout")
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise AssertionError("timed out waiting for a message")


def request(proc, message_id: int, method: str, params=None):
    payload = {"jsonrpc": "2.0", "id": message_id, "method": method}
    if params is not None:
        payload["params"] = params
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    while True:
        message = read_message(proc)
        if message.get("id") == message_id:
            return message


def start_server(env: dict) -> subprocess.Popen:
    return subprocess.Popen(
        uv_command(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env={**os.environ, **env},
    )


def initialize(proc) -> None:
    response = request(
        proc,
        1,
        "initialize",
        {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "browser-mcp-smoke", "version": "0"},
        },
    )
    assert "result" in response, response
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
    proc.stdin.flush()


class StdioTest(unittest.TestCase):
    def test_handshake_and_tool_list(self):
        proc = start_server({})
        try:
            initialize(proc)
            response = request(proc, 2, "tools/list", {})
            tools = {tool["name"]: tool for tool in response["result"]["tools"]}
            self.assertIn("browser_task", tools)
            schema = tools["browser_task"]["inputSchema"]
            self.assertEqual(schema["required"], ["goal"])
            self.assertIn("max_steps", schema["properties"])
            self.assertEqual(tools["browser_task"]["description"], BROWSER_TASK_DESCRIPTION)
        finally:
            proc.terminate()
            proc.wait(timeout=10)

    def test_tool_call_passes_through_a_successful_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake = fake_uv(root, f"echo 'JEV_RESULT {json.dumps(DONE_PAYLOAD)}'")
            proc = start_server({"BROWSER_MCP_UV": fake, "BROWSER_MCP_JEV_DIR": tmp})
            try:
                initialize(proc)
                response = request(
                    proc, 2, "tools/call", {"name": "browser_task", "arguments": {"goal": "build me a deck"}}
                )
                text = response["result"]["content"][0]["text"]
                self.assertFalse(response["result"].get("isError", False))
                self.assertIn("browser_task reported done — done", text)
                self.assertIn("final url: https://example.test/a", text)
                self.assertIn("steps: 1 — 2 Jev decisions, $0.000031, 1200 ms", text)
            finally:
                proc.terminate()
                proc.wait(timeout=10)

    def test_tool_call_failure_is_readable_text_not_a_protocol_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake = fake_uv(root, "echo 'daemon default did not come up' >&2\nexit 1")
            proc = start_server({"BROWSER_MCP_UV": fake, "BROWSER_MCP_JEV_DIR": tmp})
            try:
                initialize(proc)
                response = request(
                    proc, 2, "tools/call", {"name": "browser_task", "arguments": {"goal": "x"}}
                )
                text = response["result"]["content"][0]["text"]
                self.assertFalse(response["result"].get("isError", False))
                self.assertIn("produced no result", text)
                self.assertIn("daemon default did not come up", text)
            finally:
                proc.terminate()
                proc.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest discover -s adapters/browser-mcp/tests -v`
Expected: FAIL — `server.py` missing / the stdio tests cannot start it (`No such file or directory`).

- [ ] **Step 3: Implement `server.py`**

```python
"""Thin stdio protocol layer for the browser_task MCP server.

Run it with:

    uv run --no-project --with mcp python adapters/browser-mcp/server.py

The core (config, command building, parsing, spawning) lives in browser_mcp.py and is
importable without the MCP SDK.
"""
from __future__ import annotations

from mcp.server.mcpserver import MCPServer

from browser_mcp import BROWSER_TASK_DESCRIPTION, BrowserConfig, format_run, run_browser_task

mcp = MCPServer("system-one-browser")


@mcp.tool(description=BROWSER_TASK_DESCRIPTION)
def browser_task(goal: str, url: str = "about:blank", max_steps: int | None = None) -> str:
    """Run one natural-language goal in a real browser and return the run report."""
    try:
        run, _ = run_browser_task(goal=goal, config=BrowserConfig.from_env(), url=url, max_steps=max_steps)
        return format_run(run, goal)
    except Exception as error:  # noqa: BLE001 — never raise into the protocol
        return f"browser_task failed: {error}"


if __name__ == "__main__":
    mcp.run()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s adapters/browser-mcp/tests -v`
Expected: PASS, including the stdio handshake and both tool calls. The first run may take longer while `uv` materializes the `mcp` environment.

- [ ] **Step 5: Commit**

```bash
git add adapters/browser-mcp/server.py adapters/browser-mcp/tests/test_stdio.py
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add the browser-mcp stdio server and smoke tests"
```

**Gate:** the unittest command is green end to end; `bun test` and `bun run typecheck` remain green.

---

### Task 3: Hermes wiring docs and the Hermes-style smoke transcript

**Files:**
- Create: `adapters/browser-mcp/README.md`

**Interfaces:**
- Consumes: the server from Task 2.
- Produces: the documented run command, the env table, the Hermes `mcp_servers` block, the smoke procedure, and the transcript of the smoke that was actually run.

- [ ] **Step 1: Run the Hermes-style smoke and capture the transcript**

Write the transcript by running exactly the documented command (this is what the README will show):

```bash
python3 - <<'PY'
import json, os, select, subprocess, sys, time

SERVER = "/home/gerius/Desktop/jev-for-all/adapters/browser-mcp/server.py"
proc = subprocess.Popen(
    ["uv", "run", "--no-project", "--with", "mcp", "python", SERVER],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
    env={**os.environ, "BROWSER_MCP_JEV_DIR": "/nonexistent/jev-checkout"},
)

def read():
    while True:
        ready, _, _ = select.select([proc.stdout], [], [], 60)
        if ready:
            line = proc.stdout.readline().strip()
            if line:
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue

def call(mid, method, params=None):
    payload = {"jsonrpc": "2.0", "id": mid, "method": method}
    if params is not None:
        payload["params"] = params
    proc.stdin.write(json.dumps(payload) + "\n"); proc.stdin.flush()
    while True:
        message = read()
        if message.get("id") == mid:
            return message

print(json.dumps(call(1, "initialize", {"protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "hermes-style-smoke", "version": "0"}}), indent=2)[:400])
proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); proc.stdin.flush()
print(json.dumps(call(2, "tools/list", {}), indent=2)[:300])
result = call(3, "tools/call", {"name": "browser_task", "arguments": {"goal": "open the fixture page"}})
print(result["result"]["content"][0]["text"])
proc.terminate()
PY
```

Expected: the tool call returns readable text beginning `browser_task did not finish — error` with `produced no result` and `uv`'s own error about the missing directory in the tail — record the exact output.

- [ ] **Step 2: Write the README with the real transcript**

Create `adapters/browser-mcp/README.md` containing, in order:

1. What it is: one stdio MCP server exposing `browser_task`, shared by any MCP client (Hermes, Claude Code, OpenCode).
2. Run command: `uv run --no-project --with mcp python adapters/browser-mcp/server.py` (MCP Python SDK v2; `uv 0.12.5` on this machine).
3. Env config table: `BROWSER_MCP_JEV_DIR` (default `~/jev-ultrafast`), `BROWSER_MCP_ENV_FILE` (default `.env`), `BROWSER_MCP_UV` (default `uv`), `BROWSER_MCP_TIMEOUT_MS` (default 180000), `BROWSER_MCP_MAX_STEPS` (default 12, ceiling 60).
4. Tool contract: `goal` required, `url` optional (`about:blank`), `max_steps` optional (clamped 1–60); output is the run report, never a protocol error.
5. Hermes wiring — the exact block for `~/.hermes/config.yaml` (the user edits it; this repo never writes it):

   ```yaml
   mcp_servers:
     browser-task:
       command: "uv"
       args: ["run", "--no-project", "--with", "mcp", "python", "/home/gerius/Desktop/jev-for-all/adapters/browser-mcp/server.py"]
       env:
         BROWSER_MCP_JEV_DIR: "/home/gerius/jev-ultrafast"
   ```

   Then: restart Hermes; `hermes chat` and ask for the browser goal; Hermes registers `browser_task` at startup.
6. The Hermes-style smoke transcript from Step 1 (a fenced block with the initialize/tools list/tool-call output).
7. Tests: `python3 -m unittest discover -s adapters/browser-mcp/tests -v` (offline, free).
8. Egress: the goal and, for every step, the current page's URL, title, visible text, controls and recent actions go to the policy model; credentials come from the jev checkout's `.env`; the trace and cost stay local.

- [ ] **Step 3: Commit**

```bash
git add adapters/browser-mcp/README.md
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "docs: document the browser-mcp server and the hermes wiring"
```

**Gate:** the README's commands are exactly the ones run; the transcript is real; nothing was written under `~/.hermes`.

---

### Task 4: Claude Code wiring

**Files:**
- Create: `adapters/claude-code/.mcp.json`
- Create: `adapters/claude-code/skills/browser-task/SKILL.md`
- Modify: `adapters/claude-code/README.md`

**Interfaces:**
- Consumes: the server from Task 2 (path: `adapters/browser-mcp/server.py`, a sibling of the plugin directory).
- Produces: the CC plugin's MCP wiring and the skill that routes the model to it.

- [ ] **Step 1: Create the MCP wiring**

`adapters/claude-code/.mcp.json`:

```json
{
  "mcpServers": {
    "browser-task": {
      "command": "uv",
      "args": [
        "run",
        "--no-project",
        "--with",
        "mcp",
        "python",
        "${CLAUDE_PLUGIN_ROOT}/../browser-mcp/server.py"
      ],
      "env": {
        "BROWSER_MCP_JEV_DIR": "~/jev-ultrafast"
      }
    }
  }
}
```

- [ ] **Step 2: Create the skill**

`adapters/claude-code/skills/browser-task/SKILL.md`:

```markdown
---
name: browser-task
description: Use when a task needs a real browser — navigating, filling, clicking, or reading a live page. State the goal and its acceptance criteria for the browser_task tool, then verify the outcome.
---

# Browser tasks

`browser_task` runs one natural-language goal in a real browser. A Jev policy model — not
you — chooses every click, field value and target, so state the goal and how to tell it
succeeded instead of scripting selectors.

- Reach for it when the work needs a live page: filling a form, walking a site, reading a
  rendered page that a plain fetch cannot reach.
- Give it a goal with acceptance criteria, and a start URL when the page matters.
- The returned trace is a report, not proof. Verify the outcome (re-read the page, check the
  result) before reporting success.
- Never retry a browser mutation blindly. If the run is `blocked`, report what was observed
  and ask how to proceed.
- Keep `max_steps` small for simple goals; each step is one cheap Jev decision.
```

- [ ] **Step 3: Update the Claude Code README**

Add a "Browser tasks (MCP)" section after the skill-selection material: what the server is, that the plugin ships `.mcp.json` (per-invocation install via `claude --plugin-dir`), that `${CLAUDE_PLUGIN_ROOT}/../browser-mcp/server.py` resolves to the sibling adapter in this repo, the env overrides, the skill that guides its use, and the egress note (the goal and every step's page state go to the policy model; credentials come from the jev checkout's `.env`). Keep the existing Data egress rules unchanged.

- [ ] **Step 4: Verify the wiring resolves and the server starts from that path**

```bash
CLAUDE_PLUGIN_ROOT=/home/gerius/Desktop/jev-for-all/adapters/claude-code \
python3 -c "import json,os; cfg=json.load(open('/home/gerius/Desktop/jev-for-all/adapters/claude-code/.mcp.json')); path=cfg['mcpServers']['browser-task']['args'][-1].replace('\${CLAUDE_PLUGIN_ROOT}', os.environ['CLAUDE_PLUGIN_ROOT']); print(path); import pathlib; print(pathlib.Path(path).exists())"
```

Expected: prints `/home/gerius/Desktop/jev-for-all/adapters/claude-code/../browser-mcp/server.py` and `True`.

Then run one stdio smoke exactly as the CC wiring would (same command, same env), asserting `tools/list` contains `browser_task`:

```bash
python3 - <<'PY'
import json, os, select, subprocess
server = "/home/gerius/Desktop/jev-for-all/adapters/browser-mcp/server.py"
proc = subprocess.Popen(["uv", "run", "--no-project", "--with", "mcp", "python", server],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
    env={**os.environ, "BROWSER_MCP_JEV_DIR": "~/jev-ultrafast"})
def call(mid, method, params=None):
    payload = {"jsonrpc": "2.0", "id": mid, "method": method}
    if params is not None: payload["params"] = params
    proc.stdin.write(json.dumps(payload) + "\n"); proc.stdin.flush()
    while True:
        ready, _, _ = select.select([proc.stdout], [], [], 60)
        if not ready: continue
        line = proc.stdout.readline().strip()
        if not line: continue
        try: message = json.loads(line)
        except json.JSONDecodeError: continue
        if message.get("id") == mid: return message
print(json.dumps(call(1, "initialize", {"protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "cc-wiring-smoke", "version": "0"}}))[:80])
proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); proc.stdin.flush()
tools = [t["name"] for t in call(2, "tools/list", {})["result"]["tools"]]
print("tools:", tools)
proc.terminate()
PY
```

Expected: `tools: ['browser_task']`.

- [ ] **Step 5: Commit**

```bash
git add adapters/claude-code/.mcp.json adapters/claude-code/skills/browser-task/SKILL.md adapters/claude-code/README.md
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: wire browser_task into the claude code plugin"
```

**Gate:** the `.mcp.json` path resolves to an existing `server.py`; the wiring smoke lists `browser_task`; `bun test` and `bun run typecheck` stay green.

---

### Task 5: live smoke attempt and the phase gate

**Files:** none (verification only).

- [ ] **Step 1: Check the browser stack, then attempt at most one real run**

```bash
curl -s --max-time 2 http://127.0.0.1:9222/json/version | head -3 || true
ls ~/jev-ultrafast/.env >/dev/null 2>&1 && echo "credentials present" || echo "no credentials"
ls ~/jev-ultrafast/jev_ultrafast/static/fixture.html 2>/dev/null || ls ~/jev-ultrafast/static/fixture.html 2>/dev/null || echo "no fixture"
```

If a browser is reachable, run **one** goal through the server (a stdio `tools/call` with `url` set to the existing fixture path) and record the `JEV_RESULT` line or the readable failure. If no browser is reachable, still make **one** real attempt with the real checkout so the failure path is captured as it happened, and record the exact output. Do not retry and do not fake success.

- [ ] **Step 2: Run every gate**

```bash
bun test
bun run typecheck
python3 -m unittest discover -s adapters/hermes/tests
python3 -m unittest discover -s adapters/browser-mcp/tests
git status --porcelain
```

Expected: all green; the working tree clean except any generated `__pycache__/` (gitignored).

- [ ] **Step 3: Record the phase result**

Report: files changed, the live-smoke outcome exactly as observed, and anything unfinished. Do not push.

**Gate:** all five commands exit 0 and the live-smoke outcome is recorded.

---

## Out of scope (Phase C)

- No changes to `src/`, `index.ts`, or the OpenCode plugin — its `browser_task` already ships.
- No `~/.hermes` writes, no Hermes enable, no Hermes install.
- No Phase D (tool hints, observation unification).
- No marketplace packaging or bundling; the Claude Code plugin still installs by `--plugin-dir`.

## Self-review

- **Spec coverage:** C1 is Tasks 1–2 (server + parity + stdio tests), C3 is Task 3 (Hermes docs + real smoke), C2 is Task 4 (CC wiring + skill + README), the optional live smoke and the phase gate are Task 5.
- **Placeholder scan:** every code step carries full code; every command has an expected result; the transcript step says to record real output.
- **Type consistency:** `BrowserConfig`, `SpawnOutcome`, `run_browser_task`'s `(run, command)` tuple, and the parsed dict keys (`ok/status/url/title/steps/decisions/costUsd/elapsedMs/error`) are defined in Task 1 and consumed unchanged in Tasks 2–4; the MCP tool returns `format_run`'s string.
- **Parity edge cases:** bool values are rejected where TS rejects them (`_number`), rounding mirrors `Math.round`, and the parser takes the last sentinel line like `parseRunnerOutput`.
