# System One Phase 0+1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the live probe that settles the core's request shapes, and the measurement layer (usage records + headless before/after eval) that every later phase's token claims depend on.

**Architecture:** A throwaway probe plugin loaded by a scratch project dumps one real turn's `system`/`tools`/`messages` shapes and the normalized per-message token usage. Then a pure `src/observe.ts` module parses and summarizes usage, `index.ts` records it on `session.idle` (provider-agnostic: read `ctx.session.context`, not the raw HTTP body), and `scripts/eval.ts` runs two golden tasks with routing off/on and prints the delta.

**Tech Stack:** TypeScript (strict) on Bun, `@opencode/plugin@^2.0.8`, `bun:test`, `node:fs`, OpenCode CLI (`opencode run --standalone`).

**Spec:** `docs/superpowers/specs/2026-09-19-system-one-context-engineering-design.md`

## Global Constraints

- Every Jev call fails open; a hook never throws. New behavior defaults off (`observe.enabled: false`, routing unchanged).
- No new runtime dependencies. `node:fs` and `node:path` are builtins; `@opencode/plugin` and `@openrouter/sdk` already exist.
- Options parse in `readOptions` only; invalid values warn and fall back (`index.ts` existing pattern).
- Tests live in `src/decisions.test.ts` (repo convention: one test file). Run with `bun test`; typecheck with `bun run typecheck`.
- Numeric token fields are `TokenUsage.Info`: `{ input, output, reasoning, cache: { read, write } }` on assistant messages (`@opencode/schema`).
- This repo has no configured git identity. Commit with:
  `git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "..."`
- The probe (Task 1) is throwaway; only its findings and the probe plugin itself are committed. Raw dumps stay in `/tmp`.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `scripts/probe/index.ts` | Create | Local probe plugin: dumps prompt/context/idle shapes to `PROBE_OUT` |
| `src/observe.ts` | Create | Pure usage parsing/summarizing/formatting + JSONL recorder |
| `src/decisions.test.ts` | Modify | Tests for the new module, options, recorder |
| `index.ts` | Modify | `observe` options, keyless observe-only setup, idle usage recording |
| `scripts/eval-fixtures/basic/` | Create | Tiny scratch project used by the eval |
| `scripts/eval.ts` | Create | Headless baseline-vs-routed run + report |
| `docs/superpowers/specs/2026-09-19-system-one-context-engineering-design.md` | Modify | Append Phase 0 findings and Phase 1 baseline |

---

### Task 1: Live probe (Phase 0)

**Files:**
- Create: `scripts/probe/index.ts`
- Scratch (not committed): `/tmp/opencode/probe-project/`
- Modify: `docs/superpowers/specs/2026-09-19-system-one-context-engineering-design.md` (findings)

**Interfaces:**
- Consumes: nothing.
- Produces: findings only — exact shape of `event.system` parts (skill list location), `event.tools` weights, `event.messages` parts, and whether `ctx.session.context` at `session.idle` returns assistant `tokens` (and whether `input` includes cache reads).

- [ ] **Step 1: Write the probe plugin**

Create `scripts/probe/index.ts`:

```ts
import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const file = process.env.PROBE_OUT ?? "/tmp/system-one-probe/events.jsonl"

function write(value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(value) + "\n")
  } catch {
    // probe must never break the session
  }
}

const clip = (text: string) => (text.length > 200 ? text.slice(0, 200) : text)

export default Plugin.define({
  id: "probe",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      write({ hook: "prompt", sessionID: event.sessionID, text: clip(event.prompt.text) })
    })

    await ctx.session.hook("context", (event) => {
      write({
        hook: "context",
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        system: event.system.map((part, index) => ({
          index,
          type: part.type,
          metadata: part.metadata,
          length: part.text.length,
          hasSkills: part.text.includes("<available_skills>"),
          prefix: clip(part.text),
        })),
        tools: Object.entries(event.tools).map(([name, tool]) => ({
          name,
          descriptionLength: tool.description.length,
          descriptionPrefix: clip(tool.description),
        })),
        messages: event.messages.map((message) => ({
          role: message.role,
          content: (message.content ?? []).map((part) => {
            const candidate = part as { type?: string; text?: string; name?: string }
            return { type: candidate.type, name: candidate.name, length: candidate.text?.length }
          }),
        })),
      })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.idle") continue
        try {
          const messages = await ctx.session.context({ sessionID: event.data.sessionID })
          write({
            hook: "idle",
            sessionID: event.data.sessionID,
            messageCount: messages.length,
            assistants: messages
              .filter((message) => (message as { type?: string }).type === "assistant")
              .map((message) => {
                const cast = message as { id?: unknown; tokens?: unknown; cost?: unknown; model?: unknown }
                return { id: cast.id, tokens: cast.tokens, cost: cast.cost, model: cast.model }
              }),
          })
        } catch (error) {
          write({ hook: "idle", error: String(error) })
        }
      }
    })().catch(() => {})

    return () => controller.abort()
  },
})
```

- [ ] **Step 2: Create the scratch probe project**

```bash
mkdir -p /tmp/opencode/probe-project/.opencode/skills/demo
printf 'hello from the probe project\n' > /tmp/opencode/probe-project/demo.txt
cat > /tmp/opencode/probe-project/.opencode/skills/demo/SKILL.md <<'EOF'
---
name: Demo Skill
description: Use when the user asks about the probe demo file
---

Read demo.txt and quote it verbatim.
EOF
cat > /tmp/opencode/probe-project/opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/gerius/Desktop/opencode-system-one/scripts/probe"]
}
EOF
```

- [ ] **Step 3: Run the probe on one turn**

```bash
rm -rf /tmp/system-one-probe
cd /tmp/opencode/probe-project && \
  PROBE_OUT=/tmp/system-one-probe/events.jsonl \
  opencode run --standalone --auto "Read demo.txt and quote its contents."
```

Expected: exit 0; `/tmp/system-one-probe/events.jsonl` exists with `prompt`, several `context`, and one or more `idle` lines.

- [ ] **Step 4: Read the probe output and answer the four questions**

```bash
bun -e '
(async () => {
  const lines = (await Bun.file("/tmp/system-one-probe/events.jsonl").text()).trim().split("\n").map((l) => JSON.parse(l));
  for (const line of lines) {
    if (line.hook === "context") {
      console.log("system:", line.system.map((p) => `${p.index} meta=${JSON.stringify(p.metadata)} len=${p.length} skills=${p.hasSkills}`).join(" | "));
      console.log("tools:", line.tools.length, "totalDescChars:", line.tools.reduce((s, t) => s + t.descriptionLength, 0));
      const skill = line.tools.find((t) => t.name === "skill");
      if (skill) console.log("skill tool:", JSON.stringify(skill).slice(0, 400));
      console.log("messages:", line.messages.length);
    }
    if (line.hook === "idle") console.log("idle assistants:", JSON.stringify(line.assistants).slice(0, 600));
  }
})()
'
```

Answer in writing: (1) which system part index/key holds `<available_skills>` and its `metadata`; (2) tool count, total description chars, and whether the `skill` tool description lists skills; (3) the shape of a tool-result message part; (4) does `idle.assistants[].tokens` exist, and does `input` already include `cache.read` (compare `input` against a known prompt size, or just note the raw numbers for later).

- [ ] **Step 5: Append findings to the spec**

Add a `## Phase 0 findings (2026-09-19)` section to the spec with the four answers, each as a bullet with the raw numbers observed. If a finding contradicts the spec (e.g. the skill list is not in `event.system`), amend the affected section of the spec in the same commit. Also amend the Risks row "Core format changes (skill guidance text)": its mitigation is re-running the committed `scripts/probe` after an OpenCode upgrade (the eval script does not re-run it).

- [ ] **Step 6: Commit**

```bash
git add scripts/probe/index.ts docs/superpowers/specs/2026-09-19-system-one-context-engineering-design.md
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "chore: add live probe and phase 0 findings"
```

---

### Task 2: Usage parsing and reporting (`src/observe.ts`)

**Files:**
- Create: `src/observe.ts`
- Test: `src/decisions.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface UsageSample { sessionID: string; messageID: string; agent: string; model: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost?: number; time: number }`
  - `usageFromMessages(sessionID: string, messages: readonly unknown[], seen?: ReadonlySet<string>): UsageSample[]`
  - `interface UsageSummary { messages: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number }`
  - `summarize(samples: readonly UsageSample[]): UsageSummary`
  - `interface ReportRow { label: string; summary: UsageSummary }`
  - `formatReport(rows: readonly ReportRow[]): string`
  - `parseSamples(jsonl: string): UsageSample[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/decisions.test.ts`:

```ts
import { formatReport, parseSamples, summarize, usageFromMessages } from "./observe"

const assistantMessage = {
  id: "msg_1",
  type: "assistant",
  agent: "build",
  model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
  time: { created: 1000 },
  cost: 0.002,
  tokens: { input: 1200, output: 340, reasoning: 12, cache: { read: 900, write: 100 } },
}

test("usageFromMessages maps assistant token usage and skips seen ids", () => {
  const messages = [
    { id: "msg_0", type: "user" },
    assistantMessage,
    { id: "msg_2", type: "assistant" }, // no tokens yet
    { id: "msg_1", type: "assistant", tokens: { input: 1, output: 1 } }, // duplicate id
  ]
  const first = usageFromMessages("ses_1", messages)
  expect(first).toEqual([
    {
      sessionID: "ses_1",
      messageID: "msg_1",
      agent: "build",
      model: "opencode-go/deepseek-v4.1-flash",
      input: 1200,
      output: 340,
      reasoning: 12,
      cacheRead: 900,
      cacheWrite: 100,
      cost: 0.002,
      time: 1000,
    },
  ])

  const seen = new Set(["msg_1"])
  expect(usageFromMessages("ses_1", messages, seen)).toEqual([])
})

test("summarize and formatReport aggregate samples", () => {
  const summary = summarize(usageFromMessages("ses_1", [assistantMessage]))
  expect(summary).toEqual({
    messages: 1,
    input: 1200,
    output: 340,
    reasoning: 12,
    cacheRead: 900,
    cacheWrite: 100,
    cost: 0.002,
  })
  const report = formatReport([
    { label: "baseline", summary },
    { label: "routed", summary: summarize([]) },
  ])
  expect(report).toContain("baseline")
  expect(report).toContain("routed")
  expect(report.split("\n").length).toBe(3)
})

test("parseSamples reads usage lines and ignores other kinds", () => {
  const jsonl = [
    JSON.stringify({ kind: "usage", ...usageFromMessages("s", [assistantMessage])[0] }),
    JSON.stringify({ kind: "decision", hook: "skills" }),
    "",
  ].join("\n")
  expect(parseSamples(jsonl).length).toBe(1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/decisions.test.ts`
Expected: FAIL — `Cannot find module './observe'`.

- [ ] **Step 3: Implement `src/observe.ts`**

```ts
export interface UsageSample {
  sessionID: string
  messageID: string
  agent: string
  model: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost?: number
  time: number
}

export interface UsageSummary {
  messages: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export interface ReportRow {
  label: string
  summary: UsageSummary
}

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

export function usageFromMessages(
  sessionID: string,
  messages: readonly unknown[],
  seen: ReadonlySet<string> = new Set(),
): UsageSample[] {
  const samples: UsageSample[] = []
  const emitted = new Set<string>()
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const candidate = message as {
      id?: unknown
      type?: unknown
      agent?: unknown
      time?: { created?: unknown }
      model?: { providerID?: unknown; id?: unknown }
      tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }
      cost?: unknown
    }
    if (candidate.type !== "assistant") continue
    if (typeof candidate.id !== "string" || seen.has(candidate.id) || emitted.has(candidate.id)) continue
    if (!candidate.tokens || typeof candidate.tokens !== "object") continue
    emitted.add(candidate.id)
    const model = candidate.model && typeof candidate.model === "object" ? candidate.model : {}
    samples.push({
      sessionID,
      messageID: candidate.id,
      agent: typeof candidate.agent === "string" ? candidate.agent : "?",
      model: `${typeof model.providerID === "string" ? model.providerID : "?"}/${typeof model.id === "string" ? model.id : "?"}`,
      input: finite(candidate.tokens.input),
      output: finite(candidate.tokens.output),
      reasoning: finite(candidate.tokens.reasoning),
      cacheRead: finite(candidate.tokens.cache?.read),
      cacheWrite: finite(candidate.tokens.cache?.write),
      cost: typeof candidate.cost === "number" && Number.isFinite(candidate.cost) ? candidate.cost : undefined,
      time: typeof candidate.time?.created === "number" ? candidate.time.created : 0,
    })
  }
  return samples
}

export function summarize(samples: readonly UsageSample[]): UsageSummary {
  const summary: UsageSummary = {
    messages: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  }
  for (const sample of samples) {
    summary.messages += 1
    summary.input += sample.input
    summary.output += sample.output
    summary.reasoning += sample.reasoning
    summary.cacheRead += sample.cacheRead
    summary.cacheWrite += sample.cacheWrite
    summary.cost += sample.cost ?? 0
  }
  return summary
}

export function formatReport(rows: readonly ReportRow[]): string {
  const header = ["label", "msgs", "input", "output", "reason", "cacheRead", "cacheWrite", "cost"]
  const cells = rows.map((row) => [
    row.label,
    String(row.summary.messages),
    String(row.summary.input),
    String(row.summary.output),
    String(row.summary.reasoning),
    String(row.summary.cacheRead),
    String(row.summary.cacheWrite),
    row.summary.cost.toFixed(4),
  ])
  const widths = header.map((title, index) =>
    Math.max(title.length, ...cells.map((row) => (row[index] ?? "").length)),
  )
  const line = (values: readonly string[]) =>
    values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ")
  return [line(header), ...cells.map(line)].join("\n")
}

export function parseSamples(jsonl: string): UsageSample[] {
  const samples: UsageSample[] = []
  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object") continue
    const line = parsed as { kind?: unknown; sessionID?: unknown; messageID?: unknown }
    if (line.kind !== "usage" || typeof line.sessionID !== "string" || typeof line.messageID !== "string") continue
    const sample = line as unknown as UsageSample
    samples.push({
      sessionID: sample.sessionID,
      messageID: sample.messageID,
      agent: typeof sample.agent === "string" ? sample.agent : "?",
      model: typeof sample.model === "string" ? sample.model : "?",
      input: finite(sample.input),
      output: finite(sample.output),
      reasoning: finite(sample.reasoning),
      cacheRead: finite(sample.cacheRead),
      cacheWrite: finite(sample.cacheWrite),
      cost: typeof sample.cost === "number" ? sample.cost : undefined,
      time: finite(sample.time),
    })
  }
  return samples
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/decisions.test.ts`
Expected: all pass (30 pass total, previous 27 + 3).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/observe.ts src/decisions.test.ts
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add usage parsing and report formatting"
```

---

### Task 3: Recorder and wiring (`index.ts`)

**Files:**
- Modify: `src/observe.ts` (append `createRecorder`)
- Modify: `index.ts`
- Test: `src/decisions.test.ts` (append)

**Interfaces:**
- Consumes: `UsageSample`, `usageFromMessages` (Task 2).
- Produces:
  - `interface RecorderOptions { file?: string; maxSessions?: number }`
  - `interface Recorder { take(sessionID: string, messages: readonly unknown[]): UsageSample[]; flush(samples: readonly UsageSample[]): void }`
  - `createRecorder(options?: RecorderOptions): Recorder`
  - `ResolvedOptions.observe: { enabled: boolean; file?: string; retain: number }`

- [ ] **Step 1: Write the failing tests**

Append to `src/decisions.test.ts`:

```ts
import { createRecorder } from "./observe"
import { readFileSync, rmSync } from "node:fs"

test("createRecorder dedupes by message and writes usage JSONL", () => {
  const file = `/tmp/opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  const recorder = createRecorder({ file })
  recorder.flush(recorder.take("ses_1", [assistantMessage]))
  expect(recorder.take("ses_1", [assistantMessage]).length).toBe(0)
  recorder.flush(
    recorder.take("ses_1", [{ id: "msg_9", type: "assistant", tokens: { input: 5, output: 1 } }]),
  )

  const written = parseSamples(readFileSync(file, "utf8"))
  expect(written.length).toBe(2)
  expect(written[1].messageID).toBe("msg_9")
  rmSync(file, { force: true })
})

test("readOptions parses observe options", () => {
  const defaults = readOptions({})
  expect(defaults.observe).toEqual({ enabled: false, file: undefined, retain: 20 })

  const custom = readOptions({ observe: { enabled: true, file: "/tmp/u.jsonl", retain: 3 } })
  expect(custom.observe).toEqual({ enabled: true, file: "/tmp/u.jsonl", retain: 3 })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/decisions.test.ts`
Expected: FAIL — `createRecorder` not exported; `defaults.observe` undefined.

- [ ] **Step 3: Append `createRecorder` to `src/observe.ts`**

Add these imports to the top of `src/observe.ts`:

```ts
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
```

Then append the rest:

```ts
export interface RecorderOptions {
  file?: string
  maxSessions?: number
}

export interface Recorder {
  take(sessionID: string, messages: readonly unknown[]): UsageSample[]
  flush(samples: readonly UsageSample[]): void
}

export function createRecorder(options: RecorderOptions = {}): Recorder {
  const maxSessions = options.maxSessions ?? 20
  const seen = new Map<string, Set<string>>()

  return {
    take(sessionID, messages) {
      const already = seen.get(sessionID) ?? new Set<string>()
      const samples = usageFromMessages(sessionID, messages, already)
      for (const sample of samples) already.add(sample.messageID)
      seen.delete(sessionID)
      seen.set(sessionID, already)
      while (seen.size > maxSessions) {
        const oldest = seen.keys().next().value
        if (oldest === undefined) break
        seen.delete(oldest)
      }
      return samples
    },
    flush(samples) {
      if (!options.file || samples.length === 0) return
      try {
        mkdirSync(dirname(options.file), { recursive: true })
        appendFileSync(options.file, samples.map((sample) => JSON.stringify({ kind: "usage", ...sample })).join("\n") + "\n")
      } catch {
        // recording must never break the session
      }
    },
  }
}
```

- [ ] **Step 4: Wire options and the idle hook in `index.ts`**

Add to the imports:

```ts
import { createRecorder, summarize, type UsageSample } from "./src/observe"
```

Add the interface and parser field (`ResolvedOptions` and `readOptions`):

```ts
export interface ResolvedObserve {
  enabled: boolean
  file?: string
  retain: number
}

// inside ResolvedOptions:
observe: ResolvedObserve

// inside readOptions, before the return:
const observe = (raw.observe ?? {}) as Record<string, unknown>

// inside the returned object:
observe: {
  enabled: bool("observe.enabled", observe.enabled, false),
  file: typeof observe.file === "string" ? observe.file : undefined,
  retain: number("observe.retain", observe.retain, 20),
},
```

Replace the key check in `setup` (currently `if (!apiKey) { … return }`) with:

```ts
const routing = options.skills.enabled || options.tools.enabled
if (!apiKey) {
  if (routing) {
    console.warn("[system-one] disabled: set options.apiKey or OPENROUTER_API_KEY")
    return
  }
  if (!options.observe.enabled) return
}
const ask = apiKey
  ? createJev({ apiKey, model: options.model, timeoutMs: options.timeoutMs, serverURL: options.serverURL })
  : undefined
```

Guard both routing hook callbacks with `if (!ask) return` at the top (after the `enabled` check), so observe-only setups never call Jev.

After `agentEnabled`, add the recorder and the usage subscription. Subscribe to `session.idle` **and** the three `session.execution.*` terminal events: Phase 0 found `session.idle` does not fire under `opencode run --standalone` (the execution ends with `session.execution.succeeded`), so idle alone would record nothing headless. Dedupe by message ID makes the extra triggers harmless.

```ts
const recorder = createRecorder({ file: options.observe.file, maxSessions: options.observe.retain })
const observeAbort = new AbortController()

if (options.observe.enabled) {
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: observeAbort.signal })) {
        if (
          event.type !== "session.idle" &&
          event.type !== "session.execution.succeeded" &&
          event.type !== "session.execution.failed" &&
          event.type !== "session.execution.interrupted"
        ) {
          continue
        }
        const sessionID = event.data.sessionID
        try {
          const messages = await ctx.session.context({ sessionID })
          const samples = recorder.take(sessionID, messages)
          if (samples.length === 0) continue
          recorder.flush(samples)
          const key = `observe/usage/${sessionID}`
          const previous = ((await ctx.storage.get(key)) as UsageSample[] | undefined) ?? []
          await ctx.storage.set(key, [...previous, ...samples].slice(-500))
          log("usage", summarize(samples))
        } catch (error) {
          warnOnce(sessionID, "usage recording failed", error)
        }
      }
    } catch {
      // subscription ended
    }
  })()
}
```

Update the cleanup return to abort the subscription first:

```ts
return async () => {
  observeAbort.abort()
  await Promise.allSettled(registrations.map((registration) => registration.dispose()))
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: all tests pass, typecheck clean. If `event.data.sessionID` does not narrow, cast that one access: `const sessionID = (event.data as { sessionID: string }).sessionID`.

- [ ] **Step 6: Commit**

```bash
git add src/observe.ts index.ts src/decisions.test.ts
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: record per-message usage on session idle"
```

---

### Task 4: Eval fixture and headless before/after (Phase 1)

**Files:**
- Create: `scripts/eval-fixtures/basic/facts.txt`
- Create: `scripts/eval.ts`
- Modify: `docs/superpowers/specs/2026-09-19-system-one-context-engineering-design.md` (baseline)
- Scratch (not committed): `/tmp/opencode/eval/`

**Interfaces:**
- Consumes: `parseSamples`, `summarize`, `formatReport` (Task 2); the plugin package at the repo root (Task 3 wiring).
- Produces: a printed baseline-vs-routed table; the Phase 1 baseline recorded in the spec.

- [ ] **Step 1: Create the fixture**

```bash
mkdir -p scripts/eval-fixtures/basic
printf 'The quick brown fox jumps over the lazy dog.\nThe colur of the sky is blue.\n' > scripts/eval-fixtures/basic/facts.txt
```

- [ ] **Step 2: Write the eval script**

Create `scripts/eval.ts`:

```ts
// Headless before/after eval. Runs each fixture task twice:
//   baseline = plugin loaded, skill + tool routing disabled, usage recorded
//   routed   = plugin defaults
// Usage comes from the plugin's own JSONL (observe.file), so both modes
// are measured by the same code path.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { formatReport, parseSamples, summarize, type UsageSample } from "../src/observe"

const repo = resolve(import.meta.dir, "..")
const root = process.env.EVAL_ROOT ?? "/tmp/opencode/eval"
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const model = process.env.EVAL_MODEL
const modes = ["baseline", "routed"] as const
const tasks = [
  { id: "read-lines", prompt: "Read facts.txt and reply with the exact number of lines it contains." },
  { id: "fix-typo", prompt: "Fix the typo colur in facts.txt to color using the edit tool." },
]

function options(dir: string, mode: (typeof modes)[number]) {
  const observe = { enabled: true, file: join(dir, "usage.jsonl") }
  return mode === "routed"
    ? { observe }
    : { skills: { enabled: false }, tools: { enabled: false }, observe }
}

function run(mode: (typeof modes)[number], task: (typeof tasks)[number]): UsageSample[] {
  const dir = join(root, stamp, mode, task.id)
  mkdirSync(dir, { recursive: true })
  cpSync(join(repo, "scripts/eval-fixtures/basic"), dir, { recursive: true })
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [{ package: repo, options: options(dir, mode) }] }, null, 2),
  )
  const args = ["run", "--standalone", "--auto", ...(model ? ["--model", model] : []), task.prompt]
  const result = Bun.spawnSync(["opencode", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env })
  if (result.exitCode !== 0) {
    console.error(`[eval] ${mode}/${task.id} exited ${result.exitCode}: ${result.stderr.toString().slice(0, 400)}`)
  }
  const file = join(dir, "usage.jsonl")
  if (!existsSync(file)) {
    console.error(`[eval] no usage written for ${mode}/${task.id} (plugin not loaded?)`)
    return []
  }
  return parseSamples(readFileSync(file, "utf8"))
}

const rows = modes.map((mode) => ({
  label: mode,
  summary: summarize(tasks.flatMap((task) => run(mode, task))),
}))
console.log(formatReport(rows))
```

- [ ] **Step 3: Run the eval**

Run: `bun scripts/eval.ts`
Expected: a 3-line table (header + baseline + routed). Exit 0. If `usage.jsonl` is missing, the plugin was not loaded: check that the scratch `opencode.json` exists and that `opencode run --standalone` started in that directory.

- [ ] **Step 4: Sanity-check the numbers**

Baseline and routed must both have `msgs > 0`. Confirm from the tables that `routed` input (plus cacheRead) is not worse than baseline; a difference here is the baseline this project will optimize against. If routed is worse, record it — do not tune anything yet.

- [ ] **Step 5: Record the baseline in the spec and commit**

Append to the spec under a `## Phase 1 baseline (2026-09-19)` heading: the two rows, the model used (`EVAL_MODEL` or the configured default), and the task list. Note explicitly that Phase 1 success criteria are set from this baseline.

```bash
git add scripts/eval-fixtures/basic/facts.txt scripts/eval.ts docs/superpowers/specs/2026-09-19-system-one-context-engineering-design.md
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add headless eval and record phase 1 baseline"
```

---

## Self-Review

- **Spec coverage:** Phase 0 probe → Task 1. Phase 1 (usage records, storage, eval script, baseline, success criteria) → Tasks 2–4. Skill/tool/compaction/pruning/control phases are out of scope by design (separate plans). The spec's `scripts/probe.ts` is realized as `scripts/probe/index.ts` (plugin needs a directory entrypoint); the spec's `http.response` idea was replaced by `session.idle` + `ctx.session.context`, which yields the same normalized `tokens` without parsing provider bodies — the spec's confirmed facts already establish `TokenUsage.Info` on assistant messages, so no spec amendment is needed beyond the probe findings.
- **Placeholder scan:** none; every step has exact code or an exact command.
- **Type consistency:** `UsageSample`/`UsageSummary`/`Recorder` fields are used identically in Tasks 2–4; `observe.file` is emitted by `createRecorder` and consumed by `parseSamples`; `readOptions` returns `observe.retain` for `maxSessions`.
