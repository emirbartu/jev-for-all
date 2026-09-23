# AGENTS.md — jev-for-all

Jev for every agentic development workflow: this repo is the home for using **Jev**,
TypeSafe's System One decision model, wherever an agent codes — OpenCode today, Claude Code
and Hermes adapters planned — so every harness gets the same decisions from one shared
contract. Shipped today: an OpenCode V2 plugin that routes skill and tool choices through Jev
so the coding agent spends its context building instead of deliberating. Plugin id: `system-one`.

## What Jev is (read this before touching decision logic)

Jev is **not an LLM**. It generates no text, writes no code, and calls no tools. It is the
first System One model: unstructured `state` in, typed answers out. The whole design of this
repo follows from three properties: answers are typed by construction, every answer carries a
calibrated confidence, and each call returns in roughly 70–500 ms.

- Transport here: `@openrouter/sdk` → `client.alpha.decisions.create` → `POST
  https://openrouter.ai/api/alpha/decisions` with `{ model, state, questions }`.
- Question → answer shapes (only the first two are used in this repo):
  - `choice` `{ type, instructions, criteria }` → `{ type: "choice", choice, probabilities:
    Record<option, number>, confidence }`
  - `noul` `{ type, instructions }` → `{ type: "noul", noul: 0..1 }` — probability that the
    statement is true.
  - `score` → `{ score, probabilities, confidence }` — available from Jev, unused here.
- `state` is a string, JSON object, or array. `criteria` keys are the only values a `choice`
  can return, so Jev cannot invent a tool or skill name; the plugin still re-validates ids
  against the live catalog before using an answer.
- Default model `~typesafe/jev-latest`; the alias resolves to `jev-1.13.0` and the response's
  `model` reports the versioned id. OpenRouter also serves a stable, TypeSafe-SDK-compatible
  endpoint at `/api/v1/systemone` (bare ids like `jev-1.13` map to the `typesafe/` namespace) —
  relevant only if the alpha transport needs replacing.
- Limits: 64k tokens per request; 32k for `state` plus the longest question; ~1,200 req/min;
  $0.042 per Mtok input, output free.
- TypeSafe's own docs state Jev is not a drop-in coding-agent model. This repo is the intended
  pattern: keep the LLM coding agent, use Jev for the decisions.

Sources (fetch the `.md` variants for clean text; don't re-derive from the web):
- https://docs.typesafe.ai/introduction/coding-agents.md
- https://docs.typesafe.ai/primitives.md
- https://docs.typesafe.ai/cookbooks/skill_suggestion.md — the gate → rank → rerank design in `src/skills.ts`
- https://docs.typesafe.ai/cookbooks/function_calling.md — the Choice-over-tools design in `src/tools.ts`
- https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md

## What this plugin does and why

Problem: a coding agent sees its whole skill catalog and tool catalog every model step. It
burns output tokens deliberating, mis-loads skills, and the catalogs rot context. Fix: Jev
decides, code enforces, the agent acts.

- `prompt` hook (once per user message) → Jev skill decision → pushes at most one `{ id }`
  into `event.prompt.skills`, so OpenCode loads that skill at admission. `null` (no skill) is
  a decision, not a failure.
- `context` hook (every model dispatch, including tool-driven continuations) → Jev tool
  decision → filters `event.tools` in place to top-N ∪ `alwaysVisible` and appends a
  `<system_one_routing>` hint to `event.system`. Low `needs_tool` → hint only ("answer
  directly"), no filtering.

Contract: **fail open**. Timeout, non-2xx, malformed answer, low confidence, unknown id → no
change to the request. Never throw out of a hook; warn once per session (`createWarnOnce`).

Data egress: the `context` hook sends the conversation tail, including tool-result bodies
(file contents, shell output), rendered up to `tools.stateBudget` (6000 chars), plus tool
names and descriptions, to OpenRouter. README "Data egress" is the user-facing disclosure —
update it whenever a change alters what leaves the machine. Excluding tool-result bodies is
deliberately not an option today.

## Commands

| Command | Notes |
| --- | --- |
| `bun test` | Core tests live in `src/decisions.test.ts`; the Claude Code adapter adds `adapters/claude-code/system-one.test.ts` (66 total). Hermes: `python3 -m unittest discover -s adapters/hermes/tests`. |
| `bun run typecheck` | `tsc --noEmit`, strict. There is no build step; OpenCode runs `index.ts` with Bun. |
| `OPENROUTER_API_KEY=... bun scripts/jev-probe.ts decisions` | Live Jev smoke test (noul + choice). |
| `OPENROUTER_API_KEY=... bun scripts/jev-probe.ts catalog tools.json [task]` | Live tool-routing probe against a tool catalog. |
| `bun scripts/eval.ts` | Headless baseline-vs-routed usage eval. Needs `opencode` on PATH, provider auth, and optionally `EVAL_MODEL`. |

Install for use is a local path (`{ "package": "/abs/path/to/repo" }`); not published to npm.

Commits are authored as the repo's configured identity — `emirbartu <bartuekinci42@gmail.com>` —
never overridden with an agent identity.

## Releases

Bump `version` in `package.json`, run `npm publish` (npm 2FA prompts for browser approval), then
push `main`. npm package `jev-for-all`; npm user `emirb42`.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.ts` | `Plugin.define`, `readOptions`, hook wiring, cache, cleanup. Also exports helpers tests import (`readOptions`, `createCache`, `hashKey`, `createWarnOnce`) — moving them breaks tests. |
| `src/jev.ts` | Transport plus runtime guards `asChoice` / `asNoul`. |
| `src/skills.ts` | Gate (3 nouls) → rank (choice) → optional rerank (shortlist + `fits::<id>` nouls) → `{ id }` or `null`. |
| `src/tools.ts` | `renderState`, `routeTools`, `applyToolDecision`. |
| `src/observe.ts` | Usage JSONL recorder, parse/summarize/report helpers. |
| `src/browser.ts` + `src/jev-runner.py` | The `browser_task` tool: builds the `uv run` command, parses one `JEV_RESULT` JSON line, fails open. The Python side runs one Jev Ultrafast goal and prints that line; it never raises. |
| `spec/decisions.json` + `src/policy.ts` | The shared decision contract and its typed loader; adapters read synced copies under their `assets/`. |
| `fixtures/conformance.jsonl` + `scripts/conformance.ts` | The shared 9-case corpus and the TS conformance runner; the Python port runs the same fixtures. |
| `adapters/` | Claude Code and Hermes skill-selection adapters, each with its own tests, assets, and README. |
| `src/decisions.test.ts` | Every test, with `mockJevServer` (Bun.serve on port 0) asserting the exact request path/body. |
| `scripts/` | Live probes, headless eval, eval fixtures. |
| `docs/superpowers/` | Local working docs (specs and plans) — gitignored, not part of the repo. |

## Wiring facts an agent cannot infer from a file read

- Options are parsed once in `readOptions`; invalid values `console.warn` and fall back. A new
  option goes there, in README, and in a test.
- API key comes from `options.apiKey` or `OPENROUTER_API_KEY`. With no key and routing enabled
  the plugin registers nothing (inert).
- Caches: max 200 entries, 10 min TTL, keyed by `sessionID + hash(state|catalog)`. `get`
  returns `undefined` on miss and `null` for a cached "do nothing" decision — code branches on
  `=== undefined`; preserve that distinction.
- `agents` allowlist is evaluated in the `context` hook only (the prompt hook has no agent
  field), so skill routing applies to every agent.
- Transport passes `retries: { strategy: "none" }` on purpose: the SDK default retries 5xx
  with backoff for up to an hour, unacceptable inside a hook. Do not remove it.
- `serverURL` is the test/proxy seam. Tests assert `POST /api/alpha/decisions` and the exact
  body, so changing the request shape requires test updates.
- Hook events are mutable by design; `applyToolDecision` edits `event.tools` and pushes onto
  `event.system` in place.
- `renderState` sends tool results by JSON-stringifying the whole `result` object (which
  carries the body at `result.value`), not `part.text`.
- Observer writes JSONL lines `{ kind: "usage", ... }` to `observe.file` and mirrors the last
  500 samples per session to `ctx.storage` at `observe/usage/<sessionID>`. `parseSamples`
  ignores other `kind`s, so extra record types are safe to add.
- The browser tool is registered through `ctx.tool.transform(editor => editor.add(...))` and
  disposed with the hooks. `src/browser.ts` hands over a plain object typed loosely, with a
  single `as never` cast: the input is a plain JSON Schema, and importing effect's
  `Tool.ValueSchema` for it buys nothing. Registered tools land in `event.tools`, so the
  `context` hook routes `browser_task` like any other tool — no extra wiring, nothing added to
  `alwaysVisible` (Jev decides when the browser is the right step).
- The tool takes its credentials from the **jev checkout's** `.env`, not from the plugin's
  `apiKey`, which is why `setup` now returns early only when neither `observe` nor `browser` is
  enabled. Spawned processes inherit the plugin's own environment, so `BU_CDP_WS` set on the
  OpenCode process reaches the browser-harness daemon.
- `src/jev-runner.py` is spawned as `uv run --directory <checkout> --env-file
  <checkout>/.env --quiet python <runner>`, with the goal/URL/budget passed as `JEV_TASK_*`
  environment variables, and it reports through one `JEV_RESULT ` line, failures included. Keep
  it that way: the tool's fail-open contract depends on a parseable line, never on an exit code.

## Gotchas

- `scripts/eval.ts` must keep `PWD` equal to the scratch project dir and set a per-run empty
  `XDG_CONFIG_HOME`; otherwise the user's global config loads this plugin a second time and
  routing stays on in the baseline arm. `XDG_DATA_HOME` stays untouched because provider auth
  lives there.
- The `context` hook fires on every dispatch, so a Jev call is on the hot path. Anything added
  there must stay cached, timeout-bounded, and fail-open.
- Only v1 routing, usage observation, the goal-driven browser tool, and the Claude Code /
  Hermes skill-selection adapters are shipped. Phases 2–6 (skill authority, namespace routing,
  compaction, pruning, loop control) live in the local, gitignored working spec under
  `docs/superpowers/specs/`; none of it exists in code yet.
- `browser_task` needs a Chromium-family browser connected through browser-harness, a jev
  checkout with filled credentials, and `uv` on `PATH` — all outside this repo, so it fails with
  a readable reason instead of throwing when any of them is missing.
- Probe dumps go to `/tmp`; `.superpowers/` is a gitignored workspace. Don't commit raw dumps.
