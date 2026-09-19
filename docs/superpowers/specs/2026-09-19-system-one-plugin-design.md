# System One Plugin — Design

Date: 2026-09-19
Status: approved in chat, pending spec review

## Goal

An OpenCode V2 plugin that pairs a System One model (Jev, TypeSafe AI) with a classic LLM
agent (DeepSeek and friends). Jev makes the fast, structured decisions — which skill to
load, which tools this step needs — so the classic agent starts building instead of
deliberating. Target outcomes: fewer input tokens (smaller tool catalog), fewer output
tokens (no tool-choice reasoning), more correct skill loads, no loss of capability.

## Confirmed facts (verified 2026-09-19)

### OpenCode V2 plugin API (`@opencode/plugin@^2.0.8`, installed)

- `Plugin.define({ id, setup(ctx) })`; `setup` may return a cleanup function.
- `ctx.session.hook("prompt", (event) => …)` runs once per prompt admission, before
  attachment/skill resolution. `event.prompt: DeepMutable<PromptInput.Prompt>` has
  `text`, `files?`, `agents?`, `skills?: Array<{ id: Skill.ID; mention? }>`. Edits become
  the canonical persisted input. Not exactly-once: retries/concurrency can re-run it.
- `ctx.session.hook("context", (event) => …)` runs before every agent-loop model dispatch,
  including tool-driven continuations. `event` has readonly `sessionID`, `agent`,
  `model`; mutable `system: SystemPart[]`, `messages: Message[]`,
  `tools: Record<string, { description: string; input: JsonSchema }>`, `options`.
  Async callbacks are awaited. Hooks can be scoped `{ providerID }`.
- `SystemPart = { type: "text"; text: string; cache?; metadata? }`.
- `ctx.skill.list()` → `{ location, data: SkillInfo[] }` (`SkillInfo`: `id`, `name`,
  `description?`, `path`, `content`, `autoinvoke?`).
- `ctx.storage` exists for durable JSON, but v1 needs no persistence.
- Hook registration returns `Registration` with `dispose()`; unloading the plugin
  disposes its registrations.

### TypeSafe / Jev API

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`,
  body `{ state, model, questions }`; `state` is text/JSON; `questions` maps a key to
  `{ type: "choice" | "score" | "noul", instructions, criteria }`.
- Response `{ model, answers, usage: { input_tokens, output_tokens } }`.
  - `choice` → `{ choice, probabilities: Record<option, number>, confidence }`
  - `noul` → `{ noul: 0..1 }`
  - `score` → `{ score, legend, confidence }`
- Limits: 64k tokens per request (state + all questions); 32k for state + longest
  question. Model `jev-latest` → `jev-1.13.0`. Price $0.042/Mtok input, output free.
  1,200 req/min. Latency 70–500 ms. SDK `@typesafe-ai/sdk` exists; we use `fetch`
  directly so a hook fails fast instead of retrying.
- Official cookbooks: "Skill suggestion" (gate + rank + rerank; 16.8% → 7.3% wrong
  loads) and "Function calling" (Choice over tools, `stated` nouls for arguments).
- Transport caveat: Jev is not in OpenRouter's public catalog (`/api/v1/models`, 446
  entries; `~typesafe/jev-latest` and five other slugs 404). Native TypeSafe key needed
  unless the user's OpenRouter beta key proves callable.

## Architecture

Two hooks, one transport, pure decision logic. Every Jev call fails open — the plugin can
never block, fail, or delay-fail a model call beyond its timeout.

```
prompt hook   (once per user message) → Jev skill selection → event.prompt.skills
context hook  (every dispatch)        → Jev tool routing    → filter event.tools + hint
```

### Files

| File | Responsibility |
| --- | --- |
| `index.ts` | Options parsing, hook wiring, cache, cleanup |
| `src/jev.ts` | Transport: `ask(state, questions)` → answers; timeout, typed errors |
| `src/skills.ts` | Skill decision: gate → rank → (conditional) rerank → skill id or null |
| `src/tools.ts` | Tool decision: rank tools, needs-a-tool gate → subset + hint, or null |
| `src/decisions.test.ts` | `bun test`, injected fake transport |

No new dependencies.

## Skill selection (`src/skills.ts`)

Runs in the `prompt` hook. Input: `prompt.text` (user message), `ctx.skill.list()`.
Output: at most one skill id, pushed as `{ id }` into `event.prompt.skills` (dedupe if
already present). Nothing else changes.

- Roster empty → return null immediately.
- **Call 1** (always one request, questions in parallel):
  - `which`: Choice over skill ids, criteria = `name — description` (full description;
    Jev's criteria field holds the roster, no truncation for realistic OpenCode rosters).
  - gate nouls (inverted one marked): `acts_on_user_system`, `would_follow_documented_procedure`,
    `prose_suffices` (inverted). Mean of oriented values < `gateThreshold` (default 0.3)
    → return null.
- **Call 2** (rerank) only when `skills.rerank` resolves true: roster larger than
  `rerankAbove` (default 40) or top choice probability < `rerankBelowP` (default 0.5).
  - Choice over top `shortlist` (default 3) using `description + content[:700]`; one
    `fits::<id>` noul per candidate. Best fits noul < `fitsThreshold` (default 0.3)
    → null; else the Choice winner.
   - With `rerank: "auto"` (default) and a small roster, the single call wins: lower
     latency, and OpenCode rosters rarely approach Hermes size.
- Confidence guard: winner answer `confidence` < `minConfidence` (default 0.3) → null.

Prompt hook safety: selection is a pure read plus an idempotent push; a retry re-runs
Jev (cost, not correctness). Any error/malformed answer → return null.

## Tool routing (`src/tools.ts`)

Runs in the `context` hook, every dispatch. Decision is a pure function of a compact
state string and the current `event.tools` catalog, so tests inject fakes.

- **Call**: one request, questions in parallel:
  - `next`: Choice over visible tool names, criteria = tool description.
  - `needs_tool`: noul — "Does making progress on the last step require calling a tool?"
- Bail out when: catalog empty, Choice confidence < `minConfidence` (0.3), any error, or
  timeout — then nothing is filtered and no hint is pushed. When `needs_tool` <
  `needsToolThreshold` (default 0.3), nothing is filtered either, but the "answer
  directly" hint is still pushed (it steers behavior without restricting capability).
- **Subset**: top `maxTools` (default 12) by probability, dropping options below
  `minToolProbability` (default 0.05), unioned with `alwaysVisible`
  (default `read, write, edit, bash, grep, glob`). Tools outside the subset are
  `delete event.tools[name]`d. If the subset equals the full catalog, no filtering.
- **Hint**: one system part appended:

  ```
  <system_one_routing>
  Start with: <argmax tool>. Available now: <names>. The tool list is
  already narrowed for this step; do not deliberate about tool choice, act. If none of
  these fit, say what you need in your reply instead of guessing.
  </system_one_routing>
  ```

  (needs_tool low → "No tool is needed for this step; answer directly." When the subset
  equals the full catalog, omit the "already narrowed" sentence so the hint stays true.)
- **State** (shared renderer inside `src/tools.ts`): agent name, last user message,
  and the tail of `event.messages` (assistant text + tool results, json-truncated,
  capped at `stateBudget` characters, default 6000). Tool input schemas are never sent;
  only names and descriptions. Descriptions truncated to 300 chars in criteria.
- Bail-out threshold semantics are deliberately conservative: a wrong filter is worse
  than no filter, so we only act on confident answers.

## Wiring (`index.ts`)

- Read `ctx.options` with defaults; invalid values fall back with a logged warning.
- API key from `options.apiKey` or `OPENROUTER_API_KEY`; missing key → register nothing,
  log once, plugin is inert.
- Register both hooks; keep `Registration`s; return a cleanup that disposes them.
- **Cache**: in-memory `Map`, key = `sessionID + hash(questionIds + state)`; max 200
  entries, TTL 10 min, insertion-order eviction. Cached decisions skip Jev entirely.
- `agents` allowlist (default: all) limits tool routing to named agents; it is evaluated
  inside the `context` callback because the prompt hook carries no active-agent field.
  Skill selection therefore applies to every agent.
- `debug` option logs decisions (chosen tools, probabilities, latency) via `console`.

## Config (plugin options)

```jsonc
{
  "plugins": [{
    "package": "opencode-system-one",
    "options": {
      "apiKey": "sk-...",          // or env OPENROUTER_API_KEY
      "model": "~typesafe/jev-latest",
      "timeoutMs": 1000,
      "debug": false,
      "agents": ["build"],
      "skills": { "enabled": true, "rerank": "auto", "gateThreshold": 0.3,
                  "rerankAbove": 40, "rerankBelowP": 0.5, "shortlist": 3,
                  "fitsThreshold": 0.3, "minConfidence": 0.3 },
      "tools":  { "enabled": true, "maxTools": 12, "minToolProbability": 0.05,
                  "needsToolThreshold": 0.3, "minConfidence": 0.3,
                  "alwaysVisible": ["read","write","edit","bash","grep","glob"],
                  "stateBudget": 6000 }
    }
  }]
}
```

Zero config must work (with the env var set). All thresholds live in one place per hook.

## Error handling

| Failure | Behavior |
| --- | --- |
| Timeout (`timeoutMs`) | Abort; skills/tools no-op |
| Non-2xx / network | No-op, logged once per session |
| Malformed / missing answer | No-op |
| Low confidence / low gate | No-op |
| Unknown tool or skill id in answer | Dropped before use |

No retries in the hook path (latency budget is the point). The cache never serves a
failed call.

## Testing and verification

1. `bun test` — `src/decisions.test.ts` with an injected fake `ask`:
   - filter keeps chosen tools and the `alwaysVisible` floor; removes the rest
   - low `needs_tool` / low confidence / thrown error → catalog untouched
   - skill gate below threshold → null; winner id that no longer exists → null
   - cache: identical state → one transport call
   - hint contains the chosen start tool
2. `bun run typecheck`.
3. Offline smoke: with no API key the plugin loads, logs, and is inert.
4. Live (needs a working key, native or OpenRouter): one OpenCode session; confirm in
   logs that skills resolve and tool counts drop; confirm the agent completes a small
   task without asking for hidden tools.

## Non-goals (v1)

Argument filling (function-calling cookbook), permission/guardrails hooks, context
pruning, V1 compat, telemetry.

## Risks

- **Hiding a needed tool** is the core risk; mitigated by the floor, confidence gates,
  fail-open, and the escape-hatch hint. If it bites, disable `tools` per agent and keep
  skill routing.
- **Per-step latency** (70–500 ms). Cache, 1 s timeout, and per-agent disable.
- **Jev context budget**: 32k state + longest question; the state renderer caps at
  `stateBudget` and sends descriptions, not schemas.
- **Prompt hook is not exactly-once**: dedupe the skill push.
- **Transport uncertainty** (OpenRouter beta): resolved by the one-line curl check;
  only `src/jev.ts` changes.
- **Third-party data egress**: every model dispatch ships the conversation tail —
  including tool-result bodies such as file contents and shell output — plus the tool
  catalog names/descriptions to OpenRouter's alpha Decisions endpoint. `README.md` is the
  disclosure point for users.

## Amendment 2026-09-19: OpenRouter transport (supersedes the native TypeSafe transport)

The user has Jev access through OpenRouter's alpha Decisions API only. Superseding the
"TypeSafe / Jev API" section above:

- Transport: `@openrouter/sdk` → `client.alpha.decisions.create({ decisionsRequest })`,
  which POSTs to `https://openrouter.ai/api/alpha/decisions`. Request
  `{ model, state, questions }`, response `{ answers, usage }` — same primitives and answer
  shapes as the native API.
- Default model: `~typesafe/jev-latest`. Env fallback: `OPENROUTER_API_KEY`.
- Per-request `retries: { strategy: "none" }`: the SDK default retries 5xx with backoff for
  up to an hour, which is unacceptable inside a per-model-step hook.
- `serverURL` plugin option (test/proxy seam) replaces the old `fetch` injection; per-request
  `timeoutMs` still defaults to 1000 ms.
- `@openrouter/sdk` is now a runtime dependency; the "no new runtime dependencies" constraint
  is superseded by this amendment.
- Everything else stands: fail-open semantics, thresholds, cache, hooks, hint format.
