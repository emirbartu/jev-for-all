# browser-mcp

One stdio MCP server exposing a single tool, `browser_task`: it runs one natural-language goal
in a real browser through the Jev Ultrafast loop, with a Jev policy model — not the host agent —
choosing every click, field value and target. The contract mirrors the OpenCode plugin's
`src/browser.ts` exactly and reuses `src/jev-runner.py` unchanged, so all three harnesses run the
same loop.

Any MCP host can use it: Hermes, Claude Code, or a generic MCP client.

## Run it

```bash
uv run --no-project --with mcp python adapters/browser-mcp/server.py
```

MCP Python SDK v2 (`mcp.server.mcpserver.MCPServer`), run through `uv 0.12.5`; `uv` materializes
the environment, so no `pip` is involved. The core (`browser_mcp.py`) is plain stdlib and is
importable without the SDK.

## Configuration

MCP clients configure servers through environment variables, so every setting is one:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_MCP_JEV_DIR` | `~/jev-ultrafast` | The jev-ultrafast checkout to run; `~` is expanded. |
| `BROWSER_MCP_ENV_FILE` | `.env` | Credentials file, resolved against the checkout when relative. |
| `BROWSER_MCP_UV` | `uv` | `uv` binary used to launch the loop. |
| `BROWSER_MCP_TIMEOUT_MS` | `180000` | Wall-clock cap on one task. |
| `BROWSER_MCP_MAX_STEPS` | `12` | Default action budget; per-call `max_steps` wins (ceiling 60). |

The loop's credentials come from the **checkout's** `.env`, never from the MCP host.

## Tool contract

- `goal` (required) — one natural-language goal including how to tell it succeeded.
- `url` (optional) — start page; defaults to `about:blank`.
- `max_steps` (optional) — clamped to 1–60; each step is one cheap Jev decision.

The tool returns the run report as text: final URL, title, step trace, decision count, cost, and
a readable reason on every failure. It never raises into the protocol; failures come back with
`isError: false` and a message.

## Hermes wiring

Add this to `~/.hermes/config.yaml` (this repo never writes your Hermes home — edit it
yourself), then restart Hermes:

```yaml
mcp_servers:
  browser-task:
    command: "uv"
    args: ["run", "--no-project", "--with", "mcp", "python", "/home/gerius/Desktop/jev-for-all/adapters/browser-mcp/server.py"]
    env:
      BROWSER_MCP_JEV_DIR: "/home/gerius/jev-ultrafast"
```

Hermes registers `browser_task` at startup; ask in chat for the browser goal and it becomes
available like any other tool. The tool's name is `browser_task`; keep `max_steps` small for
simple goals.

## Hermes-style stdio smoke (recorded 2026-09-23)

Run exactly as the wiring above spawns it, with a deliberately bad checkout path so the failure
path is the one exercised (`BROWSER_MCP_JEV_DIR=/nonexistent/jev-checkout`):

```text
initialize -> system-one-browser 2025-11-25
tools/list -> ['browser_task']
tools/call ->
browser_task did not finish — error
error: browser_task produced no result (exit 2). error: No such file or directory (os error 2)
goal: open the fixture page
final url: (unchanged)
steps: 0 — 0 Jev decisions, $0.000000, 0 ms
Not confirmed by the caller: check the page or the outcome before reporting success.
isError: False
```

Every failure is a readable result, never a thrown protocol error.

## Tests

```bash
python3 -m unittest discover -s adapters/browser-mcp/tests -v
```

Offline and free: pure parity tests against `src/browser.ts`'s behavior, plus stdio handshake and
tool-call tests that spawn the real server through `uv` with a fake launcher (no browser, no paid
calls).

## Data egress

While a task runs, the goal and start URL leave the machine, and for **every step** the loop
sends the current page's URL, title, visible text, indexed controls and recent actions to the
policy model. That is the page the browser is on, so anything rendered on that tab — including
content behind a session you are already signed into — can be sent. No screenshots and no HTML
are sent, only the extracted text and control list; a step that types a value also sends that
field's meaning and page context to the text model. The trace and cost figures stay local.
