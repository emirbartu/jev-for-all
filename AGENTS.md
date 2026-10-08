# AGENTS.md

Jev for every agentic development workflow. This repo is the home for using Jev, TypeSafe's
System One decision model, wherever an agent codes. It targets OpenCode, Claude Code, Hermes and
pi today, so every harness gets the same decisions from one shared contract. Shipped today: an
OpenCode V2 plugin that routes skill and tool choices through Jev, skill-selection adapters for
Claude Code, Hermes and pi, and a `browser_task` server for any MCP client. Plugin id:
`jev-for-all`.

## What Jev is

Read this before touching decision logic.

Jev is not an LLM. It generates no text, writes no code, and calls no tools. It is the first
System One model: unstructured `state` in, typed answers out. The whole design of this repo
follows from three properties. Answers are typed by construction, every answer carries a
calibrated confidence, and each call returns in roughly 70 to 500 ms.

- Transport here: `@openrouter/sdk` -> `client.alpha.decisions.create` -> `POST
  https://openrouter.ai/api/alpha/decisions` with `{ model, state, questions }`.
- Question and answer shapes (only the first two are used in this repo):
  - `choice` `{ type, instructions, criteria }` -> `{ type: "choice", choice, probabilities:
    Record<option, number>, confidence }`
  - `noul` `{ type, instructions }` -> `{ type: "noul", noul: 0..1 }`, the probability that the
    statement is true.
  - `score` -> `{ score, probabilities, confidence }`, available from Jev but unused here.
- `state` is a string, JSON object or array. The keys of `criteria` are the only values a
  `choice` can return, so Jev cannot invent a tool or skill name. The plugin still re-validates
  ids against the live catalog before using an answer.
- Default model `~typesafe/jev-latest`. The alias resolves to `jev-1.13.0`, and the response's
  `model` reports the versioned id. OpenRouter also serves a stable, TypeSafe-SDK-compatible
  endpoint at `/api/v1/systemone` (bare ids like `jev-1.13` map to the `typesafe/` namespace).
  That matters only if the alpha transport needs replacing.
- Limits: 64k tokens per request, 32k for `state` plus the longest question, about 1,200 req/min,
  $0.042 per Mtok input, output free.
- TypeSafe's own docs state Jev is not a drop-in coding-agent model. This repo is the intended
  pattern: keep the LLM coding agent, and let Jev make the decisions.

Sources (fetch the `.md` variants for clean text; do not re-derive from the web):
- https://docs.typesafe.ai/introduction/coding-agents.md
- https://docs.typesafe.ai/primitives.md
- https://docs.typesafe.ai/cookbooks/skill_suggestion.md, the gate, rank and rerank design in
  `src/skills.ts`
- https://docs.typesafe.ai/cookbooks/function_calling.md, the Choice-over-tools design in
  `src/tools.ts`
- https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md

## What this plugin does and why

A coding agent sees its whole skill catalog and tool catalog every model step. It burns output
tokens deliberating, mis-loads skills, and the catalogs eat context. This plugin changes that:
Jev decides, code enforces, the agent acts.

- `prompt` hook (once per user message) -> Jev skill decision -> pushes at most one `{ id }` into
  `event.prompt.skills`, so OpenCode loads that skill at admission. `null` (no skill) is a
  decision, not a failure.
- `context` hook (every model dispatch, including tool-driven continuations) -> Jev tool decision
  -> filters `event.tools` in place to top-N plus `alwaysVisible`, and appends a
  `<system_one_routing>` hint to `event.system`. A low `needs_tool` value produces the hint only
  ("answer directly"), with no filtering.

Contract: fail open. A timeout, non-2xx response, malformed answer, low confidence or unknown id
means the plugin changes nothing in the request. It never throws out of a hook, and it warns once
per session (`createWarnOnce`).

Data egress: the `context` hook sends the conversation tail, including tool-result bodies (file
contents, shell output), rendered up to `tools.stateBudget` (6000 chars), plus tool names and
descriptions, to OpenRouter. The README "Privacy and fail-open behavior" section is the
user-facing disclosure. Update it whenever a change alters what leaves the machine. Excluding
tool-result bodies is not an option today.

## Commands

| Command | Notes |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit`, strict. There is no build step; OpenCode runs `index.ts` with Bun. |
| `bun scripts/conformance.ts` | Shared 9-case conformance against the TS core and the Claude Code adapter. |
| `OPENROUTER_API_KEY=... bun scripts/jev-probe.ts decisions` | Live Jev smoke test (noul and choice). |
| `OPENROUTER_API_KEY=... bun scripts/jev-probe.ts catalog tools.json [task]` | Live tool-routing probe against a tool catalog. |
| `OPENROUTER_API_KEY=... bun scripts/agents-l1.ts` | Live subagent-selection check (12 cases). |
| `OPENROUTER_API_KEY=... bun scripts/tier-l1.ts` | Live model-tier router check (48 labelled cases, tuned and held-out halves). |
| `OPENROUTER_API_KEY=... bun scripts/bench-claude.ts run haiku,sonnet[,opus]` then `report` | Real-model benchmark: 12 tasks with hidden checks, real `claude -p` cost and pass/fail. Uses your quota. |
| `bun scripts/eval.ts` | Headless baseline-vs-routed usage eval. Needs `opencode` on PATH, provider auth, and optionally `EVAL_MODEL`. |

Install for use is a local path (`{ "package": "/abs/path/to/repo" }`); the package is not
published to npm.

Commits are authored as the repo's configured identity, `emirbartu <bartuekinci42@gmail.com>`,
and never overridden with an agent identity.

## Releases

Bump `version` in `package.json`, run `npm publish` (npm 2FA prompts for browser approval), then
push `main`. npm package `jev-for-all`; npm user `emirb42`.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.ts` | `Plugin.define`, `readOptions`, hook wiring, cache, cleanup. Also exports helpers (`readOptions`, `createCache`, `hashKey`, `createWarnOnce`). |
| `src/jev.ts` | Transport plus runtime guards `asChoice` and `asNoul`. |
| `src/skills.ts` | Gate (3 nouls + `gate::mechanical` veto) -> rank (choice) -> optional rerank (shortlist plus `fits::<id>` nouls) -> `{ id }` or `null`. |
| `src/agents.ts` | `selectAgent`: `delegate` noul plus a choice over subagents with a `none` option (used by the Claude Code adapter). |
| `src/models.ts` | `selectTier` (one Jev choice: light, standard, heavy; asymmetric thresholds, falls back to standard) and the user-editable tier-to-model catalog. |
| `bin/pick.ts` | Session-start launcher: picks one model for the whole session and starts `claude` or `opencode` with it. Also prints per-tier OpenCode subagents. |
| `src/tools.ts` | `renderState`, `routeTools`, `applyToolDecision`. |
| `src/observe.ts` | Usage JSONL recorder, parse, summarize and report helpers. |
| `src/browser.ts` plus `src/jev-runner.py` | The `browser_task` tool: builds the `uv run` command, parses one `JEV_RESULT` JSON line, fails open. The Python side runs one Jev Ultrafast goal and prints that line; it never raises. |
| `spec/decisions.json` plus `src/policy.ts` | The shared decision contract and its typed loader; adapters read synced copies under their `assets/`. |
| `fixtures/conformance.jsonl` plus `scripts/conformance.ts` | The shared 9-case corpus and the TS conformance runner. |
| `adapters/` | Claude Code, pi-senpi and Hermes adapters plus the browser-mcp server, each with its own assets and README. |
| `scripts/` | Live probes, headless eval, eval fixtures. |
| `docs/install.md` | Install instructions for agents. |

## Wiring facts an agent cannot infer from a file read

- Options are parsed once in `readOptions`; invalid values `console.warn` and fall back. A new
  option goes there and in the README.
- The API key comes from `options.apiKey` or `OPENROUTER_API_KEY`. With no key and routing
  enabled, the plugin registers nothing (inert).
- Caches hold at most 200 entries for 10 minutes, keyed by `sessionID` plus a hash of
  `state|catalog`. `get` returns `undefined` on a miss and `null` for a cached "do nothing"
  decision. Code branches on `=== undefined`; keep that distinction.
- The `agents` allowlist is evaluated in the `context` hook only (the prompt hook has no agent
  field), so skill routing applies to every agent.
- The transport passes `retries: { strategy: "none" }` on purpose. The SDK default retries 5xx
  with backoff for up to an hour, which is not acceptable inside a hook. Do not remove it.
- `serverURL` is the test and proxy seam. Conformance asserts `POST /api/alpha/decisions` and the
  exact body, so changing the request shape requires updating the fixtures.
- Hook events are mutable by design. `applyToolDecision` edits `event.tools` and pushes onto
  `event.system` in place.
- `renderState` sends tool results by JSON-stringifying the whole `result` object (which carries
  the body at `result.value`), not `part.text`.
- The observer writes JSONL lines `{ kind: "usage", ... }` to `observe.file` and mirrors the last
  500 samples per session to `ctx.storage` at `observe/usage/<sessionID>`. `parseSamples` ignores
  other `kind` values, so extra record types are safe to add.
- The browser tool is registered through `ctx.tool.transform(editor => editor.add(...))` and
  disposed with the hooks. `src/browser.ts` hands over a plain object typed loosely, with a single
  `as never` cast: the input is a plain JSON Schema, and importing effect's `Tool.ValueSchema` for
  it buys nothing. Registered tools land in `event.tools`, so the `context` hook routes
  `browser_task` like any other tool. Nothing else is wired, and nothing is added to
  `alwaysVisible`, because Jev decides when the browser is the right step.
- The tool takes its credentials from the **jev checkout's** `.env`, not from the plugin's
  `apiKey`. That is why `setup` returns early only when neither `observe` nor `browser` is
  enabled. Spawned processes inherit the plugin's own environment, so `BU_CDP_WS` set on the
  OpenCode process reaches the browser-harness daemon.
- `src/jev-runner.py` is spawned as `uv run --directory <checkout> --env-file <checkout>/.env
  --quiet python <runner>`, with the goal, URL and budget passed as `JEV_TASK_*` environment
  variables, and it reports through one `JEV_RESULT ` line, failures included. Keep it that way:
  the tool's fail-open contract depends on a parseable line, never on an exit code.

## Gotchas

- `scripts/eval.ts` must keep `PWD` equal to the scratch project dir and set a per-run empty
  `XDG_CONFIG_HOME`. Otherwise the user's global config loads this plugin a second time and
  routing stays on in the baseline arm. `XDG_DATA_HOME` stays untouched because provider auth
  lives there.
- The `context` hook fires on every dispatch, so a Jev call is on the hot path. Anything added
  there must stay cached, timeout-bounded, and fail-open.
- Only v1 routing, usage observation, the goal-driven browser tool, and the Claude Code, Hermes
  and pi skill-selection adapters are shipped. Phases 2 to 6 (skill authority, namespace routing,
  compaction, pruning, loop control) live in the local, gitignored working spec under
  `docs/superpowers/specs/`; none of it exists in code yet.
- `browser_task` needs a Chromium-family browser connected through browser-harness, a jev
  checkout with filled credentials, and `uv` on `PATH`, all outside this repo. When one of them is
  missing, it fails with a readable reason instead of throwing.
- Probe dumps go to `/tmp`; `.superpowers/` is a gitignored workspace. Do not commit raw dumps.
