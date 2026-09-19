# System One — Context Engineering Roadmap

Date: 2026-09-19
Status: draft for review

## Goal

Extend the System One plugin from **routing** (v1: one skill pick, one tool subset) into
**context engineering** for the agent loop: keep the working set small and relevant at every
model dispatch, so the classic agent spends its context on the task instead of on catalogs,
stale tool output, and deliberation.

The v1 outcomes stand (fewer input tokens, fewer output tokens, more correct skill loads, no
loss of capability). This spec adds the levers the platform exposes but v1 does not use, plus
the measurement needed to prove any of it.

### Why now (evidence)

- Context rot: every one of 18 frontier models degrades as input grows, even far below the
  window ([Chroma 2025](https://www.trychroma.com/research/context-rot)); "lost in the middle"
  (Liu et al.) is the same phenomenon.
- Tool overload: selection accuracy degrades measurably past roughly 10–15 tools; attention
  dilution and tool hallucination rise with catalog size (RAG-MCP, MetaTool, BFCL-adjacent
  work; over-tooled-agent literature).
- The screenshot case in this repo's history: Jev declined a skill, and the model burned
  hundreds of output tokens deliberating before self-loading `brainstorming` anyway. That is
  exactly the tax v1 was built to remove, and it survived because the skill catalog is still
  advertised to the model.

## Confirmed facts (verified 2026-09-19, OpenCode v2.0.8)

Platform seams from the installed `@opencode/plugin` and the compiled core:

- **Skill guidance is a rendered instruction block** with internal key `core/skill-guidance` (not
  exposed on `SystemPart.metadata` — see Phase 0 findings; identify by the `<available_skills>`
  text). The core renders, per model step, permitted skills that have a description and do not
  set `autoinvoke: false`:

  ```text
  Skills provide specialized instructions and workflows for specific tasks.
  Use the skill tool to load a skill when a task matches its description.
  <available_skills>
    <skill>
      <id>...</id>
      <name>...</name>
      <description>...</description>
    </skill>
  </available_skills>
  ```

  The block is part of the system context (`SystemPart[]` is mutable in the `context` hook).
  The core itself supplies the removal copy: "Skill guidance is no longer available. Do not
  use any previously listed skill."
- `metadata.opencode/autoinvoke: false` hides a skill from that list only; the skill stays
  registered and loadable by exact ID ([skills docs](https://opencode.ai/v2/docs/skills/)).
- `ctx.session.hook("compaction")` exposes the transcript and, via `result`, replaces the
  checkpoint summary entirely. Local compaction runs on the **session's own model**; there is
  no separate compaction model ([compaction docs](https://opencode.ai/v2/docs/compaction/)).
  A summary must contain at least one requested heading (e.g. `## Objective`) or the core
  makes one corrective request, then fails.
- `context`, `compaction`, `generate`, and `title` hooks each carry `kind`; `http.response`
  exposes the raw response (one-shot body; clone to read), so per-request usage
  (`inputTokens`, `outputTokens`, `cacheRead`/`cacheWrite`, cost) is observable.
- `event.messages` is mutable per dispatch; persisted history is untouched.
- `ctx.generate.text({ model, prompt })` runs a model call without a session.
- `ctx.storage` provides durable JSON; `ctx.event.subscribe` provides the event stream.
- `ctx.skill.transform` and `ctx.agent.transform` exist; agent `permissions` support the
  `skill` action (allow/ask/deny).
- Decisions request supports `score` questions, `noul` questions with `criteria: {true,
  false}` anchoring, and a `sessionId` for observability grouping — all unused by v1.
- `tool_output.max_lines` / `tool_output.max_bytes` exist as native config
  (`opencode.jsonc`), and per-tool limits already truncate read/shell output at the source.
- Prompt caching: tool schemas and system parts sit in the prompt prefix; changing them can
  invalidate provider caches. Savings must be judged by `cacheRead`/`cacheWrite` ratios, not
  raw token counts.

## Principles

1. **Fail-open, unchanged.** A Jev error, timeout, malformed answer, or low confidence means
   *no change* to the request. Degradation always lands on today's behavior.
2. **Jev's explicit "none" is authoritative.** When Jev answers "no skill applies", the model
   is not offered a menu. This is a decision, not a failure, so it is not fail-open.
3. **Measure before believing.** Every token claim is a before/after from real usage records
   (Phase 1), not an estimate.
4. **One flag per behavior, default off** until its eval passes. `readOptions` stays the single
   parse point; invalid values warn and fall back.
5. **Never mutate identity.** Pruning and rewriting touch text and tool entries only — never
   message IDs, roles, order, or provider state.

## Architecture

```
prompt hook     → Jev skill decision → event.prompt.skills            (v1, unchanged)
                  + remember decision per session for the context hook
context hook    → Jev tool routing   → filter event.tools + hint       (v1)
                  + skill visibility policy → rewrite core/skill-guidance system part
                  + context pruning   → elide stale tool-result bodies
                  + control hints     → verification / stuck detection
compaction hook → cheap-model checkpoint + Jev validation → result.summary
http.response   → usage records → ctx.storage (local only)
```

### Files

| File | Responsibility |
| --- | --- |
| `src/skills.ts` | v1 routing; add `skillVisibility(decision, loaded)` pure policy → rewrite text |
| `src/tools.ts` | v1 routing; add stable ordering + namespace routing |
| `src/prune.ts` | `elideMessages(messages, config) → {changed, receipts}` pure function |
| `src/compact.ts` | checkpoint prompt template, summary validation (headings + Jev nouls) |
| `src/observe.ts` | usage/decision records, storage layout, report aggregation |
| `scripts/probe.ts` | Phase 0: dump one live turn's `system`, `tools`, `messages` shapes |
| `scripts/eval.ts` | golden tasks, on/off runs, delta report |
| `index.ts` | wiring, options, per-session decision memory, cleanup |

## Phase 0 — Live probe (throwaway)

One `opencode run` with a temporary local plugin that prints, for one turn:

1. Every `event.system` part: index, `metadata`, first 200 chars — confirms the
   `core/skill-guidance` part and whether we can match on `<available_skills>`.
2. `event.tools` names + description lengths — confirms where the skill tool and its
   description sit, and the real catalog weight.
3. Message shapes after a skill loads and after a tool call — confirms the skill-load marker
   and tool-result part shapes used by pruning.
4. `event.messages` length vs. `usage.inputTokens` for the same dispatch.

Output goes to `/tmp`; nothing is committed except findings appended to this spec's
"Confirmed facts". Everything else in this spec is written so the mechanisms are chosen after
this probe; if a probe finding contradicts a section, that section is amended before its
implementation plan.

## Phase 0 findings (2026-09-19)

Live probe: one `opencode run --standalone --auto "Read demo.txt and quote its contents."` in
`/tmp/opencode/probe-project` (OpenCode v2.0.8; model `opencode-go/deepseek-v4.1-flash` because
the configured default model was unavailable), output at `/tmp/system-one-probe/events.jsonl`.
Run: exit 0; 1 `prompt` line, 3 `context` lines; **no `idle` line** (see below).

- **Skill list location.** `event.system` has 5 parts; the `<available_skills>` block is in
  **index 2** (0-based): `len=17735` chars, `hasSkills=true`. Every part has
  `metadata === undefined`, including the skill part. The backing `SystemPart` schema is
  `{ type: "text", text, cache?, metadata? }` — there is no `key` field, so the core's internal
  `core/skill-guidance` key is **not observable** in the `context` hook. Match on the
  `<available_skills>` text (as Phase 2 already specifies), not on metadata.
- **Tool catalog.** `event.tools` = **12 tools**, total description weight **5733 chars**. The
  `skill` tool description is a generic 220 chars ("Load a specialized skill's instructions …
  The skill ID must match an available skill or a skill explicitly referenced by the user.") and
  does **not** enumerate skills; the catalog lives only in system part 2.
- **Tool-result part shape** (`event.messages`, role `tool`): `{ type: "tool-result", id, name,
  namespace, result: { type: "text", value: "<body>" }, providerExecuted, cache?, metadata?,
  providerMetadata? }` — the body is at **`part.result.value`**, not `part.text` (why the probe's
  `length` is `undefined` for tool parts). The skill-load marker is a tool-result named `skill`
  whose `result.value` starts `<skill_content name="Demo Skill">`.
- **Token usage.** `ctx.session.context({ sessionID })` includes assistant records with
  `tokens: { input, output, reasoning, cache: { read, write } }` plus `cost` and `model`.
  Observed across a 3-step turn: `input=9531, cache.read=0` → `input=2926, cache.read=9728` →
  `input=246, cache.read=12544`; `cache.write=0` throughout. `input` **excludes** `cache.read`:
  call 2's `input` (2926) is smaller than call 1's full prompt (9531) while call 2 carries
  `cache.read=9728`; effective input `input + cache.read` grows monotonically (9531 → 12654 →
  12790).
- **`session.idle` does not fire under `opencode run --standalone`.** The event stream's terminal
  events were `session.execution.succeeded` then `location.shutdown`; `session.idle` was never
  delivered. Because the committed probe writes only on `session.idle`, this mode yields
  `prompt` + `context` lines but **no `idle` line**. Phase 1 measures usage from `http.response`
  and is unaffected; the token numbers above were read at `session.execution.succeeded` with a
  temporary variant. A future probe that needs per-session usage from the event stream should
  subscribe to `session.execution.succeeded` (or `session.usage.updated`), not `session.idle`.

## Phase 1 — Measurement (O4)

**Problem.** The plugin makes token claims with no data. Unknown: real catalog sizes, actual
input/cache ratios, Jev latency in production, routing mistakes.

**Design.**
- `http.response` hook (kind `primary` only by default): clone the body, parse usage from JSON
  or SSE, append one record to a bounded per-session ring in `ctx.storage`
  (`observe/usage/<sessionID>`): timestamp, kind, inputTokens, outputTokens, cacheRead,
  cacheWrite, cost, `tools.length`, and whether routing applied.
- Decision log (`observe/decisions/<sessionID>`): hook, decision summary, cache hit, latency.
- `scripts/eval.ts`: ~5 golden tasks run headless (`opencode run`) twice — plugin off, plugin
  on — then prints tokens, cache ratios, wall time, and pass/fail. No frameworks; Bun script
  and JSON output.
- Config: `observe.enabled` (default false), `observe.retain` (default 20 sessions).
- Privacy: records are usage numbers and decisions only — no message text. Local storage only.

**Done when** one eval run prints a believable before/after table; success criteria are set
from that baseline (target: tool-definition tokens ≥ 50% lower on MCP-heavy catalogs, no
task-failure regression, cache-read ratio not worse than baseline, Jev overhead p95 < 500 ms
cached).

## Phase 2 — Skill authority (O1)

**Problem.** The model sees the whole skill catalog every step and re-litigates Jev's
decision (screenshot: `brainstorming`). The catalog costs tokens and the deliberation costs
output tokens and consistency.

**Policy** (user-approved):

| Situation this turn | Guidance rendered to the model | `skill` tool |
| --- | --- | --- |
| Jev picked `S` (loaded at admission) | list hidden; a one-line "skill S is loaded; follow it" note | removed unless Jev chose it |
| Jev answered **none** | list replaced with "Skills are routed externally for this session; do not call the skill tool." | removed |
| Jev errored/timed out | untouched — today's behavior | untouched |
| User explicitly selected/named a skill | list hidden; loaded skill note | untouched |

**Mechanism.** In the `context` hook, find the system part whose text contains
`<available_skills>` and rewrite its text per this table. `index.ts` keeps a per-session map
of the last prompt-hook decision (`{ id } | null | "unavailable"`). Three-way decision state is
required so "none" and "failure" differ; the prompt hook stores it, and stale state expires
after the next user prompt.

**Fallback mechanism** (only if Phase 0 shows the list is not reachable in `event.system`): a
second `ctx.skill.transform` registration that captures a mutable module-level flag; on Jev
failure flip the flag and `ctx.skill.reload()`, and flip it back after the next successful
decision (rare path). This hides rather than rewrites, so the policy table degrades to: Jev healthy
→ hidden; failure → visible.

**Gate fix.** The gate (`src/skills.ts:62-67`) averages "acts on user system", "documented
procedure", and "prose suffices". Advisory-but-procedural skills (brainstorming, planning,
review) score low and never route. Add one oriented question — "does this request match a
documented workflow whose steps the assistant should follow?" — to the averaged gate. Keep
the change to one function, with a fixture test from the screenshot case
("App strategy for $1M annual" must route to the brainstorming-style skill when present).

**Config.** `skills.visibility: "authoritative" | "hint" | "off"` (default `"off"` until eval),
`skills.alwaysVisible: string[]` (default `[]`) for skills the model may still self-load.

## Phase 3 — Tool routing refinements (O5)

**Problem.** v1 filters the catalog but reorders it on every dispatch, which can invalidate
prompt caches; MCP catalogs route badly at tool granularity; subagent choice is argument-level
and unassisted.

**Design.**
- **Stable ordering:** the subset is returned in canonical catalog order, not probability
  order; the probability leader goes in the hint, not the array order. Cache-friendly, same
  capability.
- **Namespace routing** (`tools.namespaceRouting`, default false): when the catalog exceeds
  `tools.namespaceAbove` (default 40) and names share a namespace prefix, Jev first chooses
  namespaces (`choice`), then the plugin exposes all tools of the chosen namespaces plus the
  floor. Two-level selection is how large MCP catalogs are meant to be routed.
- **Subagent hint** (`tools.subagentHint`, default false): when the `subagent` tool is in the
  routed set and `ctx.agent.list()` has more than one candidate, Jev picks the agent ID and
  the hint names it. This is a hint, not argument filling (still a non-goal).
- **`noul` anchoring:** pass `criteria: {true, false}` text on the gate questions to sharpen
  the boolean. Reuse the `sessionId` field for observability grouping in Jev requests.

**Config.** `tools.namespaceRouting`, `tools.namespaceAbove`, `tools.subagentHint`.
**Test.** Fixture: catalog with two namespaces routes to one namespace; stable order equals
canonical order; floor still present.

## Phase 4 — Checkpoint compaction (O2)

**Problem.** Compaction summarizes with the frontier session model, a fixed template, and no
quality gate. Bad checkpoints lose the thread; expensive checkpoints cost main-model tokens.

**Design.**
- `compaction` hook: build the checkpoint ourselves with a small configured model via
  `ctx.generate.text({ model: options.compaction.model, prompt })` using the core's required
  headings (`## Objective`, decisions, blockers, next moves, files). Satisfy the heading
  requirement exactly — an invalid summary causes a corrective call, which is worse than the
  default path.
- Validate before use: required headings present, file paths preserved, next move non-empty.
  Optionally ask Jev (`noul`: "Does this summary contain the objective and the open
  blockers?"). Any failure → do not set `result`; the core's default compaction runs.
- Summarize `event.messages` exactly as the hook provides them; the prune phase does not run
  inside the compaction hook.

**Config.** `compaction.enabled` (default false), `compaction.model` (required when enabled),
`compaction.validate` (default true), `compaction.maxChars`.
**Test.** Fixture summaries: valid passes, missing heading fails to default, Jev low-confidence
falls back.

## Phase 5 — Context pruning (O3)

**Problem.** Tool results (file dumps, shell output) dominate long sessions and rot attention.
Native truncation happens at the source; nothing ages results out of the tail.

**Design.** `src/prune.ts`, pure: walk `event.messages` (never mutating identity), keep the
last `prune.keepResults` tool-result bodies intact, and for results older than that and larger
than `prune.minChars`, replace the body with a receipt:
`[tool read src/foo.ts — 412 lines elided; re-read if needed]`. Never touch user messages,
assistant text, the current in-flight step, or parts without a string body.
- `prune.mode: "rules" | "jev"` (default rules). In `jev` mode, one `score` question ranks the
  large stale results by relevance to the last user request; only scores below
  `prune.scoreBelow` are elided. One call, cached by state hash.
- Elide once, keep elided: the same receipt must survive subsequent dispatches so the prefix
  stays stable and the model is never shown a result that later changes again.
- Cache interaction is the main risk: measure with Phase 1 before enabling by default.

**Config.** `prune.enabled` (default false), `prune.keepResults` (default 6),
`prune.minChars` (default 2000), `prune.mode`, `prune.scoreBelow` (default 0.3),
`prune.budgetChars` (default 24000) as a hard cap.
**Test.** Receipts are stable across runs; last-N and user messages untouched; disabled flag =
identity; jev mode falls back to rules on transport error.

## Phase 6 — Loop control (O6)

**Problem.** Two chronic agent failures: claiming completion without verification, and loops
that repeat the same failing call.

**Design.**
- **Verification gate** (`control.verify`, default false): when the latest assistant text
  asserts completion (pattern + optional Jev `noul`: "has a check been run for this change?"),
  append a system hint: run the relevant check or state explicitly that none exists. Hint
  only; never blocks.
- **Stuck detection** (`control.stuck`, default false): identical tool name + input repeated
  `control.stuckAfter` times (default 3) → one hint naming the repeated action and asking for
  a different approach. Rule-based; no Jev call.
- Both hints expire after one dispatch; both fail open.

**Config.** `control.verify`, `control.stuck`, `control.stuckAfter`.

## Sequencing

Phase 0 probe → Phase 1 (measurement) → Phase 2 (skill authority) → Phase 3 (tools) →
Phase 4 (compaction) → Phase 5 (pruning) → Phase 6 (control). Each phase gets its own
implementation plan and PR; each behavior ships behind its config flag, default off, and is
enabled only after its eval shows no regression.

## Non-goals

- Jev filling tool arguments (v1 non-goal stands; Phase 3 is a hint only).
- Remote telemetry or any upload of usage/decision records.
- Switching the session model mid-loop.
- Automating permissions or reviews.
- V1 compatibility.

## Risks

| Risk | Mitigation |
| --- | --- |
| Prompt-cache invalidation erases token savings | Phase 1 measures cache ratios; stable ordering; elide-once rule |
| Hiding a skill the turn needed | Jev's pick is loaded at admission; `skills.alwaysVisible`; failure path stays visible |
| Bad compaction summary loses state | Heading + content validation; Jev gate; default fallback |
| Pruning removes needed detail | Receipts name the source; last-N intact; budget cap; off by default |
| Extra latency per dispatch | One cached Jev call per hook; 1 s timeout; fail-open |
| Egress surface grows | No new data leaves the machine; compaction model is user-configured; README updated per phase |
| Core format changes (skill guidance text) | Match on `<available_skills>`; re-run the committed `scripts/probe` after an OpenCode upgrade (the eval script does not re-run it); fallback to transform mechanism |

## Testing and verification

1. `bun test` grows per phase: pure functions first (visibility policy, elision, summary
   validation, stable ordering, option parsing), hook tests with the existing mock server.
2. `bun run typecheck`.
3. `scripts/probe.ts` output committed as findings (raw dumps not committed).
4. `scripts/eval.ts` before/after table recorded in the PR for each phase that claims savings.

## Phase 1 baseline (2026-09-19)

Headless eval (`scripts/eval.ts`, fixture `scripts/eval-fixtures/basic/facts.txt`), one run per
mode over both tasks, usage read from the plugin's own `observe.file` JSONL. The script
config-isolates every run: each spawn gets its own empty `XDG_CONFIG_HOME` scratch directory
(`<run>/<mode>/config`) so exactly one plugin instance loads (the scratch project's), while
`XDG_DATA_HOME` is left untouched because provider auth lives there.

Model: `opencode-go/deepseek-v4.1-flash` (`EVAL_MODEL`; the configured default model was
unavailable in this environment).

```text
label     msgs  input  output  reason  cacheRead  cacheWrite  cost
baseline  5     17169  245     44      24576      0           0.0028
routed    6     30330  287     245     19456      0           0.0049
```

- Tasks:
  - `read-lines` — "Read facts.txt and reply with the exact number of lines it contains."
  - `fix-typo` — "Fix the typo colur in facts.txt to color using the edit tool."
- `baseline` = plugin loaded with `skills.enabled=false`, `tools.enabled=false`; `routed` = plugin
  defaults (skill and tool routing enabled). Both modes have `msgs > 0`.
- Effective input (`input + cacheRead`): baseline `41745`, routed `49786` (~19% worse). Routed is
  worse on this baseline; recorded as-is, with no tuning applied.
- **Phase 1 success criteria are set from this baseline.**

Caveats (both should be addressed before later-phase comparisons are trusted):

1. Environment (resolved in the script): this machine's global
   `~/.config/opencode/opencode.jsonc` also lists this repo as a plugin, so a non-isolated
   `opencode run` loads the plugin twice — once with global default options (routing enabled) and
   once with the scratch project options — leaving routing active in the `baseline` arm. That
   earlier non-isolated run was discarded. Since the isolation fix, `scripts/eval.ts` sets
   `XDG_CONFIG_HOME` to a per-mode scratch dir by default; verification with `--print-logs` shows
   exactly one `loading plugin` line.
2. Variance: direction is not stable across runs. This isolated baseline has routed ~19% worse on
   effective input, while an earlier isolated cross-check had routed ~23% better; per-task message
   counts also vary (baseline 2–3, routed 3–5). One run per mode over two trivial tasks cannot set
   a stable success threshold; repeated runs are needed before Phase 2+ regressions can be judged.
