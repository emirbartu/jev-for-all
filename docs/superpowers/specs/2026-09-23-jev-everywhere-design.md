# Jev Everywhere — Cross-Harness System One Design

Date: 2026-09-23
Status: approved in chat; open questions resolved 2026-09-23

## Goal

Turn System One from a single OpenCode plugin into a shared decision layer for every coding
agent harness in use: **OpenCode, Claude Code and Hermes**. Jev makes the fast structured
decisions — which skill to load, which tools this step needs, whether a browser run is the
right move — and each adapter maps those decisions onto the strongest extension point its
harness offers. Three priorities, in order: **skill selection**, **Jev-driven browser use**,
and **the context/tool routing this repo already ships**.

## Confirmed facts (verified 2026-09-23)

### Harness seams

**OpenCode** (unchanged from the existing specs): the `prompt` hook can push a skill for real
admission; the `context` hook can rewrite system parts, filter `event.tools` and mutate
`event.messages` per dispatch; `ctx.tool.transform` adds tools; `ctx.event.subscribe` +
`ctx.session.context` yields per-message usage. v1 (skill routing, tool routing, usage
observation, `browser_task`) is shipped; Phases 2–6 live in
`docs/superpowers/specs/2026-09-19-system-one-context-engineering-design.md`.

**Claude Code** (v2.1.269, installed):

- Hook events: `SessionStart` (context only; `reloadSkills`), `UserPromptSubmit` (30 s
  default timeout; `additionalContext`; `decision: "block"`), `PreToolUse`
  (`permissionDecision` allow/deny/ask; `updatedInput`), `PostToolUse` (`additionalContext`;
  `updatedToolOutput` replaces a tool result), `PreCompact` (block only — cannot replace the
  summary), `Stop`/`SubagentStop`, `SessionEnd`.
- There is **no** per-turn hook that filters the tool catalog or rewrites the system prompt.
  `additionalContext` is injected as a system reminder next to the prompt.
- Hooks and MCP servers can both ship inside a plugin. Skill content can be injected as
  context; a `Skill` tool call can be denied in `PreToolUse`.
- Skill rosters: `~/.claude/skills/` and `.claude/skills/` are filesystem-readable; on this
  machine the user skills directory is empty. Plugin-provided skills live inside plugin
  caches and are not enumerable by a fixed glob (resolved decision 1).
- Headless runs (`claude -p`) exist for behavioral eval.

**Hermes** (local checkout `~/.hermes/hermes-agent`; our plugin `ourines/hermes-jev` v0.1.2):

- Plugin surface: `ctx.register_hook` for `pre_tool_call` (may return
  `{"action":"block"|"approve"}`), `post_tool_call`, `pre_llm_call` (the only hook whose
  return value injects context, appended to the current turn's user message),
  `post_llm_call`, `on_session_start/end`, auxiliary and API-request observer hooks;
  `ctx.register_tool`; CLI and slash commands.
- Prompt caching is an explicit core invariant: swapping toolsets or rewriting the system
  prompt mid-conversation is forbidden; `ContextEngine.select_context` may replace the
  request messages per request (and owns its cache-prefix consequences), but never the tool
  catalog. Tool routing on Hermes is therefore **hint-only**.
- MCP client exists (`mcp_servers` in `config.yaml`); plugin catalog entries support a
  `subdir` and require 40-char SHA pins with declared capabilities.
- An in-repo eval already judged Jev compaction and rejected it (see below).

### Jev (unchanged transport facts)

OpenRouter alpha Decisions API, `~typesafe/jev-latest`; typed answers; 70–500 ms;
$0.042/Mtok input, output free; usage reported per response. Jev is not an LLM and does not
generate text.

### Evidence against maximalism

`~/.hermes/hermes-agent/evals/compaction/results/SCORECARD-2026-09-19-jev.md`: Jev-based
compaction loses to Hermes' shipped summary + `session_search` path (75.5% @ 115K vs 78.9% @
55K), and the economics are wrong (retained context re-billed every turn, repeated
compactions break prompt cache). Verdict: compaction is out of scope for this design.

## Principles

1. **Fail-open, unchanged.** A Jev error, timeout, malformed answer or low confidence means
   no change to the request.
2. **Jev's explicit "none" is authoritative only where the harness can enforce it.** Where
   it cannot (Hermes), the adapter documents that it is a strong hint, not enforcement.
3. **One contract, at most two implementations.** Decision logic lives in the TS core and one
   Python port; both are held to the same fixtures. Nothing is written three times.
4. **Measure before believing.** Baseline first per harness; each behavior ships behind a
   flag, default off, and is enabled only after its eval shows no regression.
5. **Spend guard always on.** Every Jev response is logged locally and every adapter enforces
   a per-session call cap, so a hook loop cannot drain the OpenRouter balance.
6. **Egress honesty.** Each adapter documents what it sends. No new data categories beyond
   conversation tail + catalogs + browser state.
7. **No new infrastructure.** No daemon, no sidecar service.

## Architecture

```
opencode-system-one/
├── index.ts, src/              OpenCode adapter + shared TS core (today's code)
├── spec/decisions.json         the decision contract: questions, criteria, thresholds
├── fixtures/conformance.jsonl  golden cases; both ports must pass
├── scripts/conformance.ts      TS conformance runner
├── adapters/
│   ├── claude-code/            CC plugin (bun hook script importing the shared core)
│   ├── hermes/                 Hermes plugin (Python port + conformance test)
│   └── browser-mcp/            one Python stdio MCP server over src/jev-runner.py
└── docs/superpowers/           specs and plans
```

Boundaries:

- `src/` is the TS core plus the OpenCode adapter's hook wiring. Moving OpenCode code into
  `adapters/opencode/` is a later mechanical cleanup (resolved decision 6), not part of
  Phase A.
- `adapters/*` never import from each other. Shared behavior flows through
  `spec/decisions.json` and `fixtures/`, not through cross-imports.
- **Distribution** (approved defaults): Claude Code via
  `claude --plugin-dir <repo>/adapters/claude-code` first, marketplace after the hooks are
  proven; Hermes via local copy or a catalog entry with `subdir: adapters/hermes`. No repo
  split, no vendoring now. When the CC plugin is distributed, its hooks are bundled with
  `bun build` into a self-contained file — in-repo development imports the shared core
  directly.

### Shared contract

- `spec/decisions.json` — question ids, instructions, criteria wording, thresholds
  (`gateThreshold`, `rerank`, `rerankAbove`, `rerankBelowP`, `fitsThreshold`,
  `minConfidence`, `needsToolThreshold`, `minToolProbability`, `maxTools`, `stateBudget`,
  cache TTL/cap, per-session call cap).
  Both implementations load it; neither hardcodes a number. Values are copied from the
  shipped defaults in `src/skills.ts` / `src/tools.ts`, not re-tuned.
- `fixtures/conformance.jsonl` — one case per line:
  `{ id, task, roster: [{ id, name, description }], expected: { skill } }`, where
  `expected.skill` is a skill id, `null` for Jev's explicit "none", or the string
  `"no-change"` when the correct outcome is to leave the request untouched (transport
  failure, low confidence). Cases include the screenshot case (brainstorming-style
  request), a Hermes-scale roster, an empty roster, and a clearly-non-skill request.
  Tool-decision cases join the same file in Phase D.
- **Decision log** (append-only JSONL, local): `{ kind: "decision", harness, sessionID,
  hook, chosen, confidence?, probabilities?, tokens, latencyMs, model, time }`. One format
  for every adapter; a report script aggregates. `model` records the resolved versioned id
  Jev reports on every call, so alias drift is visible. `parseSamples` ignores non-`usage`
  kinds, so this is additive to the existing observe file.
- **Spend guard**: each adapter counts Jev calls per session and stops calling (fails open)
  past the cap. Default cap: 500 calls/session, with a warning logged at 80%. The cap exists
  to stop a runaway hook loop, not to ration normal long sessions.

### Per-harness mapping

| Capability | OpenCode | Claude Code | Hermes |
| --- | --- | --- | --- |
| Skill pick | push `{ id }` into `event.prompt.skills` (real admission) | `UserPromptSubmit`: inject skill body (8000-char cap, else path to read) or "no skill applies" | `pre_llm_call`: inject `<skill_relevance>` line + skill body, or "skills are routed externally" line |
| Skill authority | rewrite `<available_skills>` system part (Phase 2) | deny `Skill` tool when Jev said none (enforcement); list stays visible | none possible; injection only |
| Tool catalog | filter `event.tools` | not possible; hint via `additionalContext` | not possible (cache invariant); hint via `pre_llm_call` |
| Tool-result aging | mutate `event.messages` (Phase 5) | `PostToolUse.updatedToolOutput` rewrites a result as it lands, not the historical tail | `ContextEngine.select_context` (per request) |
| Browser | native `browser_task` (shipped) | `browser-mcp` | `browser-mcp` |
| Usage | observe recorder (shipped) | transcript JSONL via hook payload | usage / API-request hooks, `state.db` |

### Data flow

- **OpenCode**: prompt hook → skill decision; context hook → tool decision; both cached by
  session + state hash, fail-open, hint appended to system.
- **Claude Code**: `UserPromptSubmit` → roster read → Jev decision → `additionalContext`
  (skill body or "no skill"); `PreToolUse(Skill)` → deny iff this session's last decision
  was "none".
- **Hermes**: `pre_llm_call` → roster read → Jev decision → injected context; nothing else
  changes; cache invariant untouched.

## Workstreams

### Phase A — shared contract (foundation)

Files: `spec/decisions.json`, `fixtures/conformance.jsonl`, `scripts/conformance.ts`,
`src/policy.ts` (loads the spec, exports typed constants), `src/skills.ts` and
`src/tools.ts` switched to the loaded constants, additions to `src/decisions.test.ts`.

Done when: TS conformance runs green against the fixtures; `bun test` and
`bun run typecheck` stay green; behavior matches today (defaults copied into the spec, not
tuned).

### Phase B — skill selection parity (priority 1)

- **B1 Claude Code adapter.** Plugin scaffold
  (`adapters/claude-code/.claude-plugin/plugin.json`, `hooks/hooks.json`,
  `hooks/system-one.ts`, `lib/roster.ts`). One hook script branches on `hook_event_name`:
  `UserPromptSubmit` runs the skill decision and emits `additionalContext`;
  `PreToolUse` on the `Skill` tool denies only when the session's last decision was "none".
  Roster scan from configured dirs (default `~/.claude/skills`, `.claude/skills`).
  Per-session decision memory, fail-open, README with a Data egress section, `claude -p`
  eval fixture.
- **B2 Hermes adapter.** Plugin scaffold (`adapters/hermes/plugin.yaml`, `__init__.py`,
  `decision.py`), `pre_llm_call` skill injection, roster scan (default `~/.hermes/skills`),
  Python conformance test running the shared fixtures, fail-open, README with a Data egress
  section.

Done when: each adapter routes the conformance cases identically to the TS core, and each
has a headless smoke run recorded.

### Phase C — browser parity (priority 2)

- **C1 `adapters/browser-mcp/`** — Python stdio MCP server exposing one `browser_task` tool
  (`goal`, `url`, optional `maxSteps`) that spawns
  `uv run --directory <jevDir> --env-file <jevDir>/.env --quiet python <runner>` with
  `JEV_TASK_*` env, parses exactly one `JEV_RESULT ` line, and never raises. Same contract
  as `src/browser.ts`; `src/jev-runner.py` is reused unchanged.
- **C2 Claude Code wiring** — `.mcp.json` in the plugin plus a skill that tells Claude when
  to use the tool and to verify outcomes before reporting success.
- **C3 Hermes wiring** — `mcp_servers` snippet + docs; smoke test against a local page.

Done when: a goal-driven run completes from Claude Code and Hermes using the same runner,
and a missing browser returns a readable failure instead of an error.

### Phase D — context/tool routing parity (priority 3)

- **D1** tool hints in the Claude Code adapter (`additionalContext`, from the shared tool
  decision).
- **D2** tool hints in the Hermes adapter (`pre_llm_call`).
- **D3** OpenCode Phases 2–6 continue per the existing roadmap spec — this design does not
  restate them.
- **D4** decision-log/report unification across adapters; tool-decision fixtures join
  `fixtures/conformance.jsonl`.

Done when: all three harnesses emit decision records in one format and the report shows
per-harness call counts and spend.

### Phase E — inventory of remaining Jev opportunities (verdicts)

| Opportunity | Verdict | Reason |
| --- | --- | --- |
| Browser use on CC/Hermes | **adopt** (Phase C) | the runner already exists; MCP makes it portable |
| Skill selection on CC/Hermes | **adopt** (Phase B) | same decision, different seam |
| Tool routing hints on CC/Hermes | **adopt** (Phase D) | hint is the strongest allowed seam |
| Usage/decision observation parity | **adopt** (Phase D4) | needed to prove anything |
| Approvals / safety gate | defer | `jev-approvals` (Hermes) exists; a fail-closed gate needs its own eval and threat model |
| Loop control / stuck detection | defer | rules first (OpenCode Phase 6), port only if rules fail |
| Skill curation / relations | defer | `jev-curator` exists for Hermes |
| Model routing | defer | `ourines/hermes-jev` already exposes `jev_route` |
| Memory selection | defer | `jev-memory-selector` exists |
| Guardrails / message screening | defer | adds egress and a threat model of its own |
| Jev as the compactor | **rejected** | Hermes scorecard: worse retention economics, cache breaks |
| Namespace routing, pruning, loop control (OpenCode Phases 3, 5, 6) | stays in the OpenCode roadmap | already specced, not cross-harness |
| OpenCode Phase 4 compaction | stays in the OpenCode roadmap | different use: a cheap model writes the summary, Jev only validates it — not what the Hermes scorecard rejected |

Promotion from defer to adopt requires a measured baseline and a failing behavior the
decision fixes — the same rule as every other phase.

## Egress

- **Claude Code adapter**: on each user prompt, the prompt text and the skill roster go to
  OpenRouter's decisions endpoint; the injected skill body stays local. The tool-hint phase
  adds the conversation tail as already disclosed by the OpenCode plugin.
- **Hermes adapter**: same categories via the `pre_llm_call` state.
- **Browser**: unchanged from the existing disclosure — goal, start URL and per-step page
  text/controls go to the policy model; trace and cost stay local.
- Every adapter README carries a Data egress section before it ships enabled.

## Error handling

| Failure | Behavior |
| --- | --- |
| timeout / non-2xx / malformed / low confidence | no change to the request; one warning per session |
| unknown skill id in answer | dropped |
| roster unreadable | no decision |
| per-session cap reached | no further Jev calls this session |
| CC hook script crash | exit 0 with no output |
| MCP server missing/broken | tool absent, or a readable failure; the agent continues |

## Testing and verification

1. `bun test` and `bun run typecheck` stay green; TS conformance green.
2. Python conformance in `adapters/hermes/` against the same fixtures.
3. Per-harness behavioral eval before enabling: Claude Code via `claude -p` fixtures;
   Hermes via its batch runner; OpenCode via `scripts/eval.ts`. Baseline first; no tuning
   before data.
4. Decision-log sanity: one record per Jev call, cap respected.

## Non-goals

- No daemon or sidecar service; MCP is used for browser delivery only, never for automatic
  routing.
- No Jev compaction; no Jev argument filling; no remote telemetry.
- No repo split; no vendoring of the core into adapters (bundling for distribution is a
  build step, not a source copy).
- No enforcement claims where the harness cannot enforce (Hermes skill authority).

## Risks

| Risk | Mitigation |
| --- | --- |
| Two ports drift | fixtures + conformance in both languages; `spec/decisions.json` is the only threshold source |
| CC roster cannot see plugin-provided skills | resolved decision 1: configured dirs only; an explicit registry is added only if a real gap bites |
| `additionalContext` read as a system command and surfaced to the user | factual phrasing, not imperative system instructions (per CC docs) |
| Hermes cache invariant violated | hint-only; no toolset or system-prompt mutation |
| Spend runaway | per-session cap + decision log; ~$0.00006 per Jev call |
| `UserPromptSubmit` hook stalls the session | 1 s Jev timeout, no retries, fail-open; CC cancels the hook at its own timeout |
| Distribution drift (bundled plugin copies) | bundle step + a publish script per adapter, added with distribution, not before |

## Resolved decisions (2026-09-23)

1. **CC roster source: configured dirs only** (`~/.claude/skills`, `.claude/skills`). Plugin
   caches are not enumerable; an explicit registry is added only if a real gap bites in use.
2. **Skill body injection cap: 8000 chars**, else inject the skill path plus a one-line
   summary. Keeps injected context bounded without losing the pointer to the full skill.
3. **Hermes "no skill" authority: injection-only, accepted.** Breaking the prompt-cache
   invariant for a hint is not worth it; revisit only if an eval shows it failing.
4. **Jev model: keep `~typesafe/jev-latest`**, with the resolved versioned id logged in the
   decision log on every call so alias drift is visible. Pin only if the first behavioral
   eval shows it matters.
5. **Per-session call cap: 500**, warning at 80%. The cap exists to stop a runaway hook
   loop, not to ration normal long sessions.
6. **`src/` → `adapters/opencode/` move: stays deferred.** No file moves for aesthetics.

## Sequencing

A → B1/B2 → C → D. Each phase gets its own implementation plan and commits; every behavior
defaults off until its eval passes.
