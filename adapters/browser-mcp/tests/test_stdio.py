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
