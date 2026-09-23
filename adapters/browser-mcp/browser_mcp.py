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
