# system-one for Claude Code

Jev-routed skill selection for Claude Code. On every `UserPromptSubmit` the plugin asks
[Jev](https://docs.typesafe.ai) whether the prompt needs a skill; if one fits, its body is
injected as `additionalContext`, otherwise a short "skills are routed externally" note is
injected and the `Skill` tool is denied in that session. An optional `Stop` gate asks Jev
whether a completion claim is backed by a check that actually ran, and every user message is
recorded as a usage line next to the decision log.

**Harness ceiling.** Claude Code hooks can inject context and deny a tool call. They cannot
filter the tool catalog or rewrite the system prompt, so the skill list stays visible and the
denial only covers `Skill` after Jev explicitly answered "none" — this plugin cannot do what
the OpenCode adapter does for tool routing.

## Install

Per invocation, nothing is written to your Claude Code configuration:

```bash
claude --plugin-dir /home/gerius/Desktop/jev-for-all/adapters/claude-code
```

`claude plugin install` has no local-path mode — it resolves plugins through marketplaces
only — so the repo ships one at `adapters/claude-code/marketplace`. To install the plugin
permanently from this machine:

```bash
claude plugin marketplace add /home/gerius/Desktop/jev-for-all/adapters/claude-code/marketplace
claude plugin install system-one@jev-local
```

`marketplace/system-one` is a symlink to the adapter directory, which is how the marketplace
points at the plugin without copying it. `claude plugin validate
/home/gerius/Desktop/jev-for-all/adapters/claude-code` passes, and `claude plugin details
system-one@jev-local` lists all three hooks, the `browser-task` skill, and the MCP server.

## Environment

| Variable | Meaning |
| --- | --- |
| `OPENROUTER_API_KEY` | Required. Without it the hook stays inert (exits 0, no output). |
| `SYSTEM_ONE_SERVER_URL` | Optional. Override the decisions endpoint (tests/proxies). |
| `SYSTEM_ONE_SKILL_DIRS` | Optional. Colon-separated skill directories; replaces the default roster source. |
| `SYSTEM_ONE_STATE_DIR` | Optional. Per-session state and decision log directory. |
| `SYSTEM_ONE_VERIFY` | Optional. `1`/`true` turns the Stop verification gate on. Unset or `0` leaves it off. |

## Roster

By default the roster is scanned from `~/.claude/skills` and `<cwd>/.claude/skills`. Skills
provided by plugins are not scanned. `SYSTEM_ONE_SKILL_DIRS` replaces both defaults when set.

## What it injects

- Jev picked a skill: the skill body (capped at 8000 chars; past the cap, a pointer to the
  `SKILL.md` path) as `additionalContext`.
- Jev answered "none": the fixed line `Skills are routed externally for this session; do not
  call the Skill tool.`, and `Skill` calls in that session are denied with the same reason
  until the next prompt overwrites the decision.
- Transport error, low confidence, no API key, malformed stdin, empty roster: nothing is
  printed and the hook exits 0.

## Verification gate (`Stop`, off by default)

`SYSTEM_ONE_VERIFY=1` turns on a `Stop` hook. When the final assistant message reads as a
completion claim ("done", "complete", "fixed", "all tests pass", ...), Jev answers three
questions about the turn — is this a claim, was an automated check run, did it pass — and the
hook emits `{"decision": "block", "reason": "<the contract hint>"}` when a claim has no
passing check. Claude keeps working instead of stopping on an unverified claim.

The gate reuses the shared `src/verify.ts` decision and the `control` block of
`spec/decisions.json`; no threshold is hardcoded here. It is off by default, and it fails open
at every step: no API key, a transport error, a malformed answer, an answer below
`control.claimMin`, a missing transcript, or `stop_hook_active: true` all leave the turn
exactly as Claude Code would have ended it. The gate never blocks a turn because Jev was
unavailable.

## Decision and usage log

Every Jev call appends one JSON line to `$SYSTEM_ONE_STATE_DIR/decisions.jsonl` when
`SYSTEM_ONE_STATE_DIR` is set, otherwise to
`${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}/system-one-cc/decisions.jsonl`. The line records the
chosen skill (or `none` / `no-change`), the resolved model id, token usage, latency, and the
per-session call count.

Every `UserPromptSubmit` also appends one `kind: "usage"` line to the same file, whether or
not a decision was taken: the session and message id, the agent name, the model, the Jev
input/output tokens spent on that turn, the prompt length in characters, and the per-session
call count. Because both record kinds live in one file, the shared `parseSamples` /
`summarize` / `formatReport` helpers in `src/observe.ts` read the decision log and the usage
log together — Claude Code hooks expose no per-message token counts of their own, so `input`
and `output` are Jev's own cost for the turn.

## Browser tasks (MCP)

The plugin ships `.mcp.json`, so the same session also exposes `browser_task` — one
natural-language goal in a real browser, with a Jev policy model choosing every click. The
server lives in the sibling adapter and is spawned per session as:

```text
uv run --no-project --with mcp python ${CLAUDE_PLUGIN_ROOT}/../browser-mcp/server.py
```

`BROWSER_MCP_JEV_DIR` defaults to `~/jev-ultrafast`, and the loop's credentials come from that
checkout's `.env`. The bundled `browser-task` skill tells Claude when the tool is the right move
and requires an outcome check before reporting success.

Two harness truths: MCP tools are model-invoked, so `browser_task` appears in the catalog and
Claude decides when to call it — the skill guides that choice rather than enforcing it. And the
returned trace is a report, not proof.

## Data egress

The `UserPromptSubmit` hook sends the prompt text, the skill roster (names, ids,
descriptions), and, when rerank runs, the first 700 characters of each shortlisted skill's
body to OpenRouter's decisions endpoint. The injected skill body stays local. No other data
leaves the machine; logging is local-only.

With `SYSTEM_ONE_VERIFY=1` the `Stop` hook additionally sends the conversation tail — the
transcript's text, tool calls and tool results, capped at 2000 characters — plus the final
assistant message, to the same endpoint. With the gate off, nothing new leaves the machine.

`browser_task` adds its own, larger egress path while it runs: the goal, start URL and every
step's page state (URL, title, visible text, controls) go to the policy model; the trace and
cost figures stay local. See `adapters/browser-mcp/README.md` for details.

## Fail-open

The hook never throws out of a hook and never changes the request on failure. A missing API
key, a transport error, a malformed answer, an unknown skill id, a low-confidence answer, or
an expired session state all leave Claude Code's behavior exactly as it was. The same holds
for the `Stop` gate, which additionally stays quiet when the transcript is unreadable or
Claude Code is already continuing because of an earlier stop hook.

## Proof

```bash
# 1. unit + conformance
bun test adapters/claude-code/system-one.test.ts
bun adapters/claude-code/conformance.ts

# 2. manifests
claude plugin validate /home/gerius/Desktop/jev-for-all/adapters/claude-code
claude plugin validate /home/gerius/Desktop/jev-for-all/adapters/claude-code/marketplace

# 3. live smoke (needs OPENROUTER_API_KEY): run one prompt, then read the decision log
claude --plugin-dir /home/gerius/Desktop/jev-for-all/adapters/claude-code -p "build me a deck"
cat "${CLAUDE_PLUGIN_DATA:-/tmp}/system-one-cc/decisions.jsonl"

# 4. live verification gate (needs OPENROUTER_API_KEY and SYSTEM_ONE_VERIFY=1)
SYSTEM_ONE_VERIFY=1 claude --plugin-dir /home/gerius/Desktop/jev-for-all/adapters/claude-code -p "fix the failing test"
grep '"hook":"Stop"' "${CLAUDE_PLUGIN_DATA:-/tmp}/system-one-cc/decisions.jsonl"
```
