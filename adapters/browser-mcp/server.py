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
