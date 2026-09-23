# Jev Everywhere Phase B — Skill-Selection Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Jev skill selection to Claude Code and Hermes from the shared contract, with each harness using the strongest seam it actually has: Claude Code injects the chosen skill and can deny the `Skill` tool when Jev says none; Hermes injects a `<skill_relevance>` line and skill body only, because its prompt-cache invariant forbids hiding the skill index.

**Architecture:** Two adapters under `adapters/`, both reading the Phase A contract (`spec/decisions.json`, copied into each adapter as `assets/decisions.json` by a sync script) and both held to the same 9-case corpus (`fixtures/conformance.jsonl`, copied as `assets/conformance.jsonl`) by a per-harness conformance runner. The Claude Code adapter imports the TS core (`selectSkill`, `createJev`) directly; the Hermes adapter is a stdlib-only Python port of the decision logic plus a `urllib` transport. The Hermes adapter is a self-contained plugin directory that installs into `~/.hermes/plugins/system-one/` and is proven on a real `hermes chat -q` run via its decision log.

**Tech Stack:** TypeScript (strict) on Bun for the Claude Code adapter and scripts; Python 3.11 stdlib only for the Hermes adapter; `bun:test` and `unittest`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-jev-everywhere-design.md` (Phase B, per-harness mapping, resolved decisions 1–6)

## Global Constraints

- **Fail open, always.** A timeout, non-2xx, malformed answer, unreadable roster, or missing API key changes nothing about the request. No hook may throw; hook scripts exit 0.
- **The contract is the only source.** Question ids, question text, criteria templates, thresholds, and the injection cap come from `assets/decisions.json`; no adapter hardcodes a decision value. The cap value lives in the contract as `skills.injection.chars` (added in Task 1).
- **Jev model:** `~typesafe/jev-latest` (resolved decision 4), overridable; the resolved versioned id and token usage from each response are recorded in the decision log via the new transport callback.
- **Harness ceilings are honest, not worked around:**
  - OpenCode: can filter tools and load a skill at admission (already shipped; untouched this phase).
  - Claude Code: can inject context (`UserPromptSubmit.additionalContext`) and deny the `Skill` tool (`PreToolUse`); it **cannot** filter the tool catalog or rewrite the system prompt.
  - Hermes: `pre_llm_call` context injection **only**. It must not touch the system prompt or toolset — the prompt cache is a core invariant.
- **"None" vs "no-change" rule (implemented identically in both ports):** a skill id → authoritative load; `selectSkill` returned null **and** the first (rank) ask succeeded with confidence ≥ `minConfidence` → authoritative none; anything else (transport, timeout, malformed, low confidence, empty roster) → no-change. Confidence is captured from the **first** ask only; the rerank answer never overwrites it.
- **Decision log** (shared shape, local only): `{ kind: "decision", harness, sessionID, hook, chosen, event?, model?, inputTokens?, outputTokens?, latencyMs, calls?, time }`. `chosen` is a skill id, `"none"`, or `"no-change"`; cap/warn records use `chosen: "no-change"` plus `event: "cap" | "warn"`. Per-session call cap 500, warning logged at 80% (resolved decision 5). No message text is logged.
- **WIP files must not be touched or staged:** `README.md`, `index.ts`, `package.json`, `src/browser.ts`, `src/jev-runner.py`, and the browser-test region of `src/decisions.test.ts`. Appending to `src/decisions.test.ts` is allowed (Task 2), but the commit must stage only the appended block (procedure in Task 2).
- **Do not push.** `main` stays ahead of origin.
- **Commit identity:** `git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "..."`.

## Review focus

- **Task 1:** byte-equality of the copied assets; `--check` exits 1 on drift; tsconfig change is exactly one include line; `policy.skills.injection.chars` is 8000.
- **Task 2:** the callback is additive (no `Ask` signature change); `onMeta` fires only on a successful response; existing transport tests unchanged.
- **Task 3:** the adapter uses `selectSkill` rather than reimplementing the gate/rerank; the conformance runner reads the **adapter's** asset copy; the none/no-change rule and first-call confidence capture match the Global Constraints.
- **Task 4:** hook output JSON matches the Claude Code hook contract exactly (event name inside `hookSpecificOutput`, `additionalContext` for `UserPromptSubmit`, `permissionDecision` for `PreToolUse`); state is per session and expires; every failure path exits 0 with no stdout.
- **Task 5:** the Python decision logic is a faithful port (same gate math, rerank triggers, shortlist ordering, fits threshold, confidence guard, first-call capture, `select_skill` swallowing errors exactly like the TS core); the conformance runner replays the same 9 fixtures with call-count assertions; stdlib only.
- **Task 6:** the plugin manifest is valid for Hermes (v2, `api_version: 1`); `register(ctx)` registers only `pre_llm_call`; the hook returns `{"context": ...}` or `None`; nothing mutates the system prompt or toolset; the README's install/proof steps are exact.
- **Task 7:** every gate command exits 0 on the final tree; the two real-run proofs have recorded evidence; the WIP diff is unchanged.

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `scripts/sync-adapter-assets.ts` | Create | Copy canonical `spec/decisions.json` + `fixtures/conformance.jsonl` into each adapter's `assets/`; `--check` mode for the gate |
| `spec/decisions.json` | Modify | Add `skills.injection.chars` (8000) |
| `src/policy.ts` | Modify | `SkillPolicy.injection: { chars: number }` |
| `src/jev.ts` | Modify | Optional `onMeta` callback: resolved model id + token usage |
| `src/decisions.test.ts` | Modify | Two appended transport tests (WIP-safe staging) |
| `tsconfig.json` | Modify | Include `adapters/**/*.ts` |
| `adapters/claude-code/lib/roster.ts` | Create | Skill directory scan + frontmatter parse |
| `adapters/claude-code/lib/decide.ts` | Create | Decision rule + injection text (pure) |
| `adapters/claude-code/lib/state.ts` | Create | Per-session decision state + call counter |
| `adapters/claude-code/lib/log.ts` | Create | Decision log JSONL |
| `adapters/claude-code/hooks/system-one.ts` | Create | Hook entry: reads stdin JSON, dispatches by event, writes stdout JSON |
| `adapters/claude-code/hooks/hooks.json` | Create | Hook wiring for `UserPromptSubmit` + `PreToolUse(Skill)` |
| `adapters/claude-code/.claude-plugin/plugin.json` | Create | Plugin manifest |
| `adapters/claude-code/conformance.ts` | Create | Replays `assets/conformance.jsonl` through `decide` |
| `adapters/claude-code/mock-jev.ts` | Create | Mock Jev server for the hook end-to-end test |
| `adapters/claude-code/system-one.test.ts` | Create | Adapter unit tests + hook end-to-end against the mock |
| `adapters/claude-code/README.md` | Create | Install via `--plugin-dir`, what it injects, egress, proof steps |
| `adapters/hermes/system_one/decision.py` | Create | Python port: contract load, roster scan, decision, injection, transport, log |
| `adapters/hermes/system_one/__init__.py` | Create | `register(ctx)` + `pre_llm_call` handler |
| `adapters/hermes/system_one/plugin.yaml` | Create | Hermes manifest v2 + config schema |
| `adapters/hermes/system_one/assets/` | Create | Synced `decisions.json` + `conformance.jsonl` |
| `adapters/hermes/tests/test_conformance.py` | Create | Shared fixtures through the Python port |
| `adapters/hermes/tests/test_decision.py` | Create | Decision rules, injection cap, roster scan, transport fail-open, plugin registration |
| `adapters/hermes/README.md` | Create | Install, enable, what it reads/injects, decision log, real-run proof |

---

### Task 1: Adapter assets and the injection cap in the contract

**Files:**
- Create: `scripts/sync-adapter-assets.ts`
- Modify: `spec/decisions.json` (add `skills.injection`)
- Modify: `src/policy.ts` (add `SkillPolicy.injection`)
- Modify: `tsconfig.json` (include `adapters/**/*.ts`)
- Create (generated): `adapters/claude-code/assets/decisions.json`, `adapters/claude-code/assets/conformance.jsonl`, `adapters/hermes/system_one/assets/decisions.json`, `adapters/hermes/system_one/assets/conformance.jsonl`

**Interfaces:**
- Consumes: the canonical files from Phase A.
- Produces: `bun scripts/sync-adapter-assets.ts` (copies) and `bun scripts/sync-adapter-assets.ts --check` (exit 1 on drift); `policy.skills.injection.chars === 8000`.

- [ ] **Step 1: Add the injection cap to the contract**

In `spec/decisions.json`, inside `"skills"`, after the `"criteria"` object, add:

```json
    "injection": {
      "chars": 8000
    }
```

In `src/policy.ts`, inside `interface SkillPolicy`, after the `criteria` field, add:

```ts
  injection: {
    chars: number
  }
```

- [ ] **Step 2: Write the sync script**

Create `scripts/sync-adapter-assets.ts`:

```ts
// Copies the canonical contract and conformance corpus into each adapter so the
// adapter directories stay installable on their own. Run with --check in the gate.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const repo = join(import.meta.dir, "..")
const assets = [
  { from: join(repo, "spec", "decisions.json"), to: join(repo, "adapters", "claude-code", "assets", "decisions.json") },
  { from: join(repo, "fixtures", "conformance.jsonl"), to: join(repo, "adapters", "claude-code", "assets", "conformance.jsonl") },
  { from: join(repo, "spec", "decisions.json"), to: join(repo, "adapters", "hermes", "system_one", "assets", "decisions.json") },
  { from: join(repo, "fixtures", "conformance.jsonl"), to: join(repo, "adapters", "hermes", "system_one", "assets", "conformance.jsonl") },
]

const check = process.argv.includes("--check")
let drifted = 0

for (const asset of assets) {
  if (check) {
    let same = false
    try {
      same = readFileSync(asset.from, "utf8") === readFileSync(asset.to, "utf8")
    } catch {
      same = false
    }
    if (!same) {
      console.error(`drift: ${asset.to}`)
      drifted += 1
    }
    continue
  }
  mkdirSync(dirname(asset.to), { recursive: true })
  copyFileSync(asset.from, asset.to)
  console.log(`synced ${asset.to}`)
}

if (check) {
  console.log(drifted === 0 ? "adapter assets: up to date" : `adapter assets: ${drifted} drifted`)
  process.exitCode = drifted === 0 ? 0 : 1
}
```

- [ ] **Step 3: Run the sync, the check, and the cap smoke**

Run: `bun scripts/sync-adapter-assets.ts`
Expected: four `synced` lines, files created.

Run: `bun scripts/sync-adapter-assets.ts --check`
Expected: `adapter assets: up to date`, exit 0.

Run: `bun -e 'const { policy } = await import("./src/policy.ts"); if (policy.skills.injection.chars !== 8000) process.exit(1); console.log("cap", policy.skills.injection.chars)'`
Expected: `cap 8000`.

- [ ] **Step 4: Typecheck the adapters**

In `tsconfig.json`, change the include to:

```json
  "include": ["index.ts", "src/**/*.ts", "scripts/**/*.ts", "adapters/**/*.ts"]
```

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-adapter-assets.ts spec/decisions.json src/policy.ts tsconfig.json adapters/claude-code/assets adapters/hermes/system_one/assets
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: sync the decision contract into each adapter"
```

**Gate:** `bun scripts/sync-adapter-assets.ts --check` exits 0; the cap smoke prints `cap 8000`; `bun run typecheck` clean; `bun test` still 52 pass.

---

### Task 2: Transport metadata callback

**Files:**
- Modify: `src/jev.ts` (add `onMeta` to `JevOptions`, invoke after a successful response)
- Modify: `src/decisions.test.ts` (append two tests)

**Interfaces:**
- Consumes: the existing `createJev` transport and its mock-server test pattern.
- Produces: `createJev({ apiKey, model?, serverURL?, timeoutMs?, onMeta? })` where
  `onMeta?: (meta: { model?: string; inputTokens?: number; outputTokens?: number }) => void` — called once per successful response, never on errors. `Ask` is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/decisions.test.ts`:

```ts
test("createJev reports the resolved model and usage through onMeta", async () => {
  const mock = mockJevServer(() => ({
    body: {
      answers: { which: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 } },
      model: "~typesafe/jev-1.13.0",
      usage: { input_tokens: 123, output_tokens: 7 },
    },
  }))
  try {
    const seen: Array<{ model?: string; inputTokens?: number; outputTokens?: number }> = []
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL, onMeta: (meta) => seen.push(meta) })
    await ask({ state: { request: "hi" }, questions: {} })
    expect(seen).toEqual([{ model: "~typesafe/jev-1.13.0", inputTokens: 123, outputTokens: 7 }])
  } finally {
    mock.server.stop(true)
  }
})

test("createJev does not call onMeta on a failed request", async () => {
  const mock = mockJevServer(() => ({ status: 500, body: { error: { message: "boom" } } }))
  try {
    let called = 0
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL, onMeta: () => (called += 1) })
    await expect(ask({ state: {}, questions: {} })).rejects.toThrow()
    expect(called).toBe(0)
  } finally {
    mock.server.stop(true)
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/decisions.test.ts`
Expected: FAIL — `onMeta` does not exist on `JevOptions` (typecheck) and `seen` is empty.

- [ ] **Step 3: Implement the callback**

In `src/jev.ts`, extend the options interface:

```ts
export interface JevOptions {
  apiKey: string
  model?: string
  serverURL?: string
  timeoutMs?: number
  onMeta?: (meta: { model?: string; inputTokens?: number; outputTokens?: number }) => void
}
```

In `createJev`, after `const answers = response?.answers` and the missing-answers guard, add:

```ts
    const resolved = (response as { model?: unknown }).model
    const usage = (response as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage
    options.onMeta?.({
      model: typeof resolved === "string" ? resolved : undefined,
      inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
    })
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/decisions.test.ts`
Expected: PASS, 54 tests.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit (WIP-safe staging)**

`src/decisions.test.ts` carries pre-existing browser WIP. Stage only the appended block:

```bash
git add src/jev.ts
git show HEAD:src/decisions.test.ts > /tmp/opencode/staged-tests.ts
B=$(grep -n 'test("createJev reports the resolved model' src/decisions.test.ts | cut -d: -f1)
sed -n "$((B-1)),\$p" src/decisions.test.ts >> /tmp/opencode/staged-tests.ts
BLOB=$(git hash-object -w /tmp/opencode/staged-tests.ts)
git update-index --cacheinfo 100644,$BLOB,src/decisions.test.ts
git diff --cached --stat   # expect src/jev.ts + src/decisions.test.ts only
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: report resolved model and usage from the transport"
```

If `git diff --cached` shows browser-test lines, stop and report — do not commit.

**Gate:** 54 tests pass, typecheck clean, the commit contains no WIP lines.

---

### Task 3: Claude Code decision core and conformance runner

**Files:**
- Create: `adapters/claude-code/lib/roster.ts`
- Create: `adapters/claude-code/lib/decide.ts`
- Create: `adapters/claude-code/conformance.ts`
- Create: `adapters/claude-code/system-one.test.ts`

**Interfaces:**
- Consumes: `selectSkill`, `SkillLike` (`src/skills.ts`), `asChoice` (`src/jev.ts`), `policy` (`src/policy.ts`), `assets/decisions.json` + `assets/conformance.jsonl` (Task 1).
- Produces:
  - `interface SkillFile { id: string; name: string; description?: string; content: string; path: string }`
  - `scanSkillDirs(dirs: readonly string[]): SkillFile[]`
  - `defaultSkillDirs(cwd: string): string[]`
  - `type Decision = { kind: "skill"; id: string } | { kind: "none" } | { kind: "no-change" }`
  - `decide(ask: Ask | undefined, request: string, skills: readonly SkillLike[]): Promise<Decision>`
  - `injectionFor(skill: SkillFile): string`
  - `NONE_CONTEXT: string`
  - `bun adapters/claude-code/conformance.ts` → `conformance: 9/9 passed`, exit 1 on failure.

- [ ] **Step 1: Write the failing tests**

Create `adapters/claude-code/system-one.test.ts`:

```ts
import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Ask } from "../../src/jev"
import { defaultSkillDirs, scanSkillDirs } from "./lib/roster"
import { NONE_CONTEXT, decide, injectionFor } from "./lib/decide"

function skillDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "system-one-skills-"))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, "SKILL.md"), text)
  }
  return dir
}

function stubAsk(...responses: Array<Record<string, unknown> | Error>) {
  const calls: unknown[] = []
  const ask: Ask = async (input) => {
    calls.push(input)
    const response = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (response instanceof Error) throw response
    return response
  }
  return { ask, calls }
}

const openGate = {
  "gate::acts": { type: "noul", noul: 0.9 },
  "gate::procedure": { type: "noul", noul: 0.8 },
  "gate::prose": { type: "noul", noul: 0.2 },
}

test("scanSkillDirs parses frontmatter and skips non-skill dirs", () => {
  const dir = skillDir({
    alpha: "---\nname: Alpha\ndescription: Does alpha things\n---\n\nAlpha body\n",
    beta: "---\nname: Beta\n---\n\nBeta body\n",
    broken: "no frontmatter here",
  })
  const skills = scanSkillDirs([dir])
  const alpha = skills.find((skill) => skill.id === "alpha")
  expect(alpha?.name).toBe("Alpha")
  expect(alpha?.description).toBe("Does alpha things")
  expect(alpha?.content.trim()).toBe("Alpha body")
  expect(alpha?.path.endsWith("alpha/SKILL.md")).toBe(true)
  const beta = skills.find((skill) => skill.id === "beta")
  expect(beta?.name).toBe("Beta")
  expect(beta?.description).toBeUndefined()
  const broken = skills.find((skill) => skill.id === "broken")
  expect(broken?.name).toBe("broken")
  expect(broken?.content).toBe("no frontmatter here")
})

test("defaultSkillDirs includes the user and project skills directories", () => {
  const dirs = defaultSkillDirs("/work/project")
  expect(dirs).toEqual([join(process.env.HOME ?? "", ".claude", "skills"), "/work/project/.claude/skills"])
})

test("decide returns the skill when Jev picks one", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
    ...openGate,
  })
  const decision = await decide(ask, "build me a deck", [
    { id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" },
  ])
  expect(decision).toEqual({ kind: "skill", id: "pptx-author" })
})

test("decide returns none when Jev answers but picks no skill", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
    "gate::acts": { type: "noul", noul: 0.1 },
    "gate::procedure": { type: "noul", noul: 0.1 },
    "gate::prose": { type: "noul", noul: 0.9 },
  })
  const decision = await decide(ask, "explain monads", [
    { id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" },
  ])
  expect(decision).toEqual({ kind: "none" })
})

test("decide returns no-change on transport errors and low confidence", async () => {
  const roster = [{ id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" }]
  const transport = await decide(stubAsk(new Error("boom")).ask, "build me a deck", roster)
  expect(transport).toEqual({ kind: "no-change" })

  const low = await decide(
    stubAsk({
      which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.5 }, confidence: 0.1 },
      ...openGate,
    }).ask,
    "build me a deck",
    roster,
  )
  expect(low).toEqual({ kind: "no-change" })
})

test("decide returns no-change without an ask or a roster", async () => {
  const roster = [{ id: "pptx-author", name: "pptx-author", content: "x" }]
  expect(await decide(undefined, "build me a deck", roster)).toEqual({ kind: "no-change" })
  expect(await decide(stubAsk({}).ask, "build me a deck", [])).toEqual({ kind: "no-change" })
})

test("injectionFor caps the body and points at the path past the cap", () => {
  const short = injectionFor({ id: "a", name: "Alpha", description: "Does alpha", content: "body", path: "/s/a/SKILL.md" })
  expect(short).toContain("Alpha (a)")
  expect(short).toContain("body")

  const long = injectionFor({
    id: "b",
    name: "Beta",
    description: "Does beta",
    content: "x".repeat(8001),
    path: "/s/b/SKILL.md",
  })
  expect(long).toContain("/s/b/SKILL.md")
  expect(long).not.toContain("x".repeat(8001))

  expect(NONE_CONTEXT).toContain("routed externally")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test adapters/claude-code/system-one.test.ts`
Expected: FAIL — `Cannot find module './lib/roster'`.

- [ ] **Step 3: Implement `lib/roster.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface SkillFile {
  id: string
  name: string
  description?: string
  content: string
  path: string
}

function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  if (!text.startsWith("---")) return { body: text }
  const end = text.indexOf("\n---", 3)
  if (end === -1) return { body: text }
  const head = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, "")
  const fields: Record<string, string> = {}
  for (const line of head.split("\n")) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    fields[match[1]] = match[2].replace(/^["']|["']$/g, "").trim()
  }
  return { name: fields.name, description: fields.description, body }
}

export function scanSkillDirs(dirs: readonly string[]): SkillFile[] {
  const skills: SkillFile[] = []
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry, "SKILL.md")
      try {
        const parsed = parseFrontmatter(readFileSync(path, "utf8"))
        skills.push({
          id: entry,
          name: parsed.name ?? entry,
          description: parsed.description,
          content: parsed.body,
          path,
        })
      } catch {
        // not a skill directory
      }
    }
  }
  return skills
}

export function defaultSkillDirs(cwd: string): string[] {
  return [join(process.env.HOME ?? "", ".claude", "skills"), join(cwd, ".claude", "skills")]
}
```

- [ ] **Step 4: Implement `lib/decide.ts`**

```ts
import { asChoice, type Ask } from "../../../src/jev"
import { policy } from "../../../src/policy"
import { selectSkill, type SkillLike } from "../../../src/skills"
import type { SkillFile } from "./roster"

export type Decision = { kind: "skill"; id: string } | { kind: "none" } | { kind: "no-change" }

export const NONE_CONTEXT = "Skills are routed externally for this session; do not call the Skill tool."

export function injectionFor(skill: SkillFile): string {
  const header = `A routed skill is loaded for this turn: ${skill.name} (${skill.id}).`
  if (skill.content.length <= policy.skills.injection.chars) return `${header}\n\n${skill.content}`
  const summary = skill.description ?? skill.name
  return `${header} ${summary} Read the full skill at ${skill.path}.`
}

export async function decide(ask: Ask | undefined, request: string, skills: readonly SkillLike[]): Promise<Decision> {
  if (!ask || skills.length === 0 || request.trim() === "") return { kind: "no-change" }
  let answered = false
  let rankConfidence: number | undefined
  const tracked: Ask = async (input) => {
    const answers = await ask(input)
    if (!answered) {
      answered = true
      rankConfidence = asChoice(answers[policy.skills.ids.rank])?.confidence
    }
    return answers
  }
  try {
    const decision = await selectSkill(tracked, { request, skills })
    if (decision) return { kind: "skill", id: decision.id }
    const confident = (rankConfidence ?? 1) >= policy.skills.minConfidence
    return answered && confident ? { kind: "none" } : { kind: "no-change" }
  } catch {
    return { kind: "no-change" }
  }
}
```

- [ ] **Step 5: Implement `conformance.ts`**

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Ask } from "../../src/jev"
import { decide } from "./lib/decide"

interface FixtureCall {
  answers?: Record<string, unknown>
  throw?: boolean
}

interface Fixture {
  id: string
  decision: string
  task: string
  roster: Array<{ id: string; name?: string; description?: string; content?: string }>
  calls: FixtureCall[]
  expected: { skill: string | null }
}

function replayAsk(calls: readonly FixtureCall[], made: { count: number }): Ask {
  return async () => {
    const call = calls[made.count]
    made.count += 1
    if (!call) throw new Error("conformance: fixture provided no answer for this call")
    if (call.throw) throw new Error("conformance: fixture transport error")
    return call.answers ?? {}
  }
}

export async function runConformance(jsonl: string): Promise<{ total: number; passed: number; failures: string[] }> {
  const fixtures: Fixture[] = []
  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue
    fixtures.push(JSON.parse(raw) as Fixture)
  }
  const failures: string[] = []
  let passed = 0
  for (const fixture of fixtures) {
    if (fixture.decision !== "skills") {
      failures.push(`${fixture.id}: unsupported decision ${fixture.decision}`)
      continue
    }
    const roster = fixture.roster.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      description: entry.description,
      content: entry.content ?? "",
    }))
    const made = { count: 0 }
    const decision = await decide(replayAsk(fixture.calls, made), fixture.task, roster)
    const actual = decision.kind === "skill" ? decision.id : null
    if (actual !== fixture.expected.skill) {
      failures.push(`${fixture.id}: expected ${JSON.stringify(fixture.expected.skill)}, got ${JSON.stringify(actual)}`)
      continue
    }
    if (made.count !== fixture.calls.length) {
      failures.push(`${fixture.id}: expected ${fixture.calls.length} ask call(s), made ${made.count}`)
      continue
    }
    passed += 1
  }
  return { total: fixtures.length, passed, failures }
}

if (import.meta.main) {
  const path = join(import.meta.dir, "assets", "conformance.jsonl")
  const result = await runConformance(readFileSync(path, "utf8"))
  for (const failure of result.failures) console.error(`FAIL ${failure}`)
  console.log(`conformance: ${result.passed}/${result.total} passed`)
  process.exitCode = result.failures.length > 0 ? 1 : 0
}
```

- [ ] **Step 6: Run the adapter tests and the runner**

Run: `bun test adapters/claude-code/system-one.test.ts`
Expected: PASS.

Run: `bun adapters/claude-code/conformance.ts`
Expected: `conformance: 9/9 passed`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add adapters/claude-code/lib adapters/claude-code/conformance.ts adapters/claude-code/system-one.test.ts
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add the claude code decision core and conformance runner"
```

**Gate:** adapter tests green; conformance 9/9 through the adapter's asset copy; `bun run typecheck` clean.

---

### Task 4: Claude Code hooks, plugin scaffold, and install proof

**Files:**
- Create: `adapters/claude-code/lib/state.ts`
- Create: `adapters/claude-code/lib/log.ts`
- Create: `adapters/claude-code/hooks/system-one.ts`
- Create: `adapters/claude-code/hooks/hooks.json`
- Create: `adapters/claude-code/.claude-plugin/plugin.json`
- Create: `adapters/claude-code/mock-jev.ts`
- Create: `adapters/claude-code/README.md`
- Modify: `adapters/claude-code/system-one.test.ts` (append hook tests)

**Interfaces:**
- Consumes: `decide`, `injectionFor`, `NONE_CONTEXT`, `scanSkillDirs`, `defaultSkillDirs` (Task 3); `createJev` (Task 2).
- Produces: a hook script that reads one JSON object on stdin and writes zero or one JSON object on stdout; `readState(sessionID)`, `writeState(sessionID, state)` with `{ decision?: "skill" | "none"; at: number; calls: number }`.

- [ ] **Step 1: Write the failing tests**

Append to `adapters/claude-code/system-one.test.ts`:

```ts
import { readState, writeState } from "./lib/state"
import { startMockJev } from "./mock-jev"

test("session state round-trips, counts calls, and expires", () => {
  const dir = mkdtempSync(join(tmpdir(), "system-one-state-"))
  process.env.SYSTEM_ONE_STATE_DIR = dir
  writeState("s1", { decision: "none", at: Date.now(), calls: 3 })
  const state = readState("s1")
  expect(state?.decision).toBe("none")
  expect(state?.calls).toBe(3)
  writeState("s2", { at: Date.now() - 3 * 60 * 60 * 1000, calls: 1 })
  expect(readState("s2")).toBeUndefined()
  delete process.env.SYSTEM_ONE_STATE_DIR
})

test("the hook injects a routed skill and writes state", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "system-one-hook-"))
  const skills = mkdtempSync(join(tmpdir(), "system-one-hook-skills-"))
  mkdirSync(join(skills, "pptx-author"), { recursive: true })
  writeFileSync(
    join(skills, "pptx-author", "SKILL.md"),
    "---\nname: pptx-author\ndescription: Author decks\n---\n\nUse python-pptx\n",
  )
  const { serverURL, server } = startMockJev()
  try {
    const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "hooks", "system-one.ts")], {
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-1",
          prompt: "build me a deck",
          cwd: process.cwd(),
        }),
      ]),
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "test",
        SYSTEM_ONE_STATE_DIR: stateDir,
        SYSTEM_ONE_SKILL_DIRS: skills,
        SYSTEM_ONE_SERVER_URL: serverURL,
      },
      stdout: "pipe",
    })
    expect(proc.exitCode).toBe(0)
    const output = JSON.parse(proc.stdout.toString())
    expect(output.hookSpecificOutput.additionalContext).toContain("pptx-author")
    expect(readState("sess-1")?.decision).toBe("skill")
  } finally {
    server.stop(true)
  }
})

test("the PreToolUse hook denies the Skill tool only after a none decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "system-one-deny-"))
  process.env.SYSTEM_ONE_STATE_DIR = dir
  try {
    writeState("sess-deny", { decision: "none", at: Date.now(), calls: 1 })
    const denied = Bun.spawnSync(["bun", "run", join(import.meta.dir, "hooks", "system-one.ts")], {
      stdin: new Blob([JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sess-deny", tool_name: "Skill" })]),
      env: { ...process.env },
      stdout: "pipe",
    })
    const output = JSON.parse(denied.stdout.toString())
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny")

    writeState("sess-allow", { decision: "skill", at: Date.now(), calls: 1 })
    const allowed = Bun.spawnSync(["bun", "run", join(import.meta.dir, "hooks", "system-one.ts")], {
      stdin: new Blob([JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sess-allow", tool_name: "Skill" })]),
      env: { ...process.env },
      stdout: "pipe",
    })
    expect(allowed.stdout.toString().trim()).toBe("")
  } finally {
    delete process.env.SYSTEM_ONE_STATE_DIR
  }
})

test("the hook is silent and exits 0 without an API key", () => {
  const dir = mkdtempSync(join(tmpdir(), "system-one-nokey-"))
  const skills = mkdtempSync(join(tmpdir(), "system-one-nokey-skills-"))
  mkdirSync(join(skills, "pptx-author"), { recursive: true })
  writeFileSync(join(skills, "pptx-author", "SKILL.md"), "---\nname: pptx-author\n---\n\nbody\n")
  const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "hooks", "system-one.ts")], {
    stdin: new Blob([JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "hi" })]),
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "",
      SYSTEM_ONE_STATE_DIR: dir,
      SYSTEM_ONE_SKILL_DIRS: skills,
      SYSTEM_ONE_SERVER_URL: "",
    },
    stdout: "pipe",
  })
  expect(proc.exitCode).toBe(0)
  expect(proc.stdout.toString().trim()).toBe("")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test adapters/claude-code/system-one.test.ts`
Expected: FAIL — `Cannot find module './lib/state'`.

- [ ] **Step 3: Implement `lib/state.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface SessionState {
  decision?: "skill" | "none"
  at: number
  calls: number
}

const TTL_MS = 2 * 60 * 60 * 1000

function stateDir(): string {
  return process.env.SYSTEM_ONE_STATE_DIR ?? join(process.env.CLAUDE_PLUGIN_DATA ?? process.env.TMPDIR ?? "/tmp", "system-one-cc")
}

export function writeState(sessionID: string, state: SessionState): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(join(stateDir(), `${sessionID}.json`), JSON.stringify(state))
  } catch {
    // state is an optimization; never fail the hook
  }
}

export function readState(sessionID: string): SessionState | undefined {
  try {
    const state = JSON.parse(readFileSync(join(stateDir(), `${sessionID}.json`), "utf8")) as SessionState
    if (typeof state.at !== "number" || Date.now() - state.at > TTL_MS) return undefined
    return state
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: Implement `lib/log.ts`**

```ts
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export function logDecision(record: Record<string, unknown>): void {
  try {
    const base = process.env.SYSTEM_ONE_STATE_DIR ?? join(process.env.CLAUDE_PLUGIN_DATA ?? process.env.TMPDIR ?? "/tmp", "system-one-cc")
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, "decisions.jsonl"), JSON.stringify({ kind: "decision", harness: "claude-code", ...record }) + "\n")
  } catch {
    // logging never fails the hook
  }
}
```

- [ ] **Step 5: Implement `hooks/system-one.ts`**

```ts
import { readFileSync } from "node:fs"
import { createJev, type Ask } from "../../../src/jev"
import { NONE_CONTEXT, decide, injectionFor } from "../lib/decide"
import { defaultSkillDirs, scanSkillDirs } from "../lib/roster"
import { readState, writeState } from "../lib/state"
import { logDecision } from "../lib/log"

interface HookInput {
  hook_event_name?: string
  session_id?: string
  prompt?: string
  cwd?: string
  tool_name?: string
}

const CAP = 500
const WARN_AT = 0.8

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n")
}

function skillDirs(input: HookInput): string[] {
  const override = process.env.SYSTEM_ONE_SKILL_DIRS
  if (override) return override.split(":").filter(Boolean)
  return defaultSkillDirs(input.cwd ?? process.cwd())
}

async function userPromptSubmit(input: HookInput): Promise<void> {
  const sessionID = input.session_id ?? "unknown"
  const skills = scanSkillDirs(skillDirs(input))
  if (skills.length === 0) return

  const state = readState(sessionID) ?? { at: Date.now(), calls: 0 }
  if (state.calls >= CAP) {
    logDecision({ sessionID, hook: "UserPromptSubmit", chosen: "no-change", event: "cap", calls: state.calls })
    return
  }
  if (state.calls + 1 === Math.floor(CAP * WARN_AT)) {
    logDecision({ sessionID, hook: "UserPromptSubmit", chosen: "no-change", event: "warn", calls: state.calls + 1 })
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  const meta: { model?: string; inputTokens?: number; outputTokens?: number } = {}
  const ask: Ask | undefined = apiKey
    ? createJev({
        apiKey,
        onMeta: (info) => Object.assign(meta, info),
        ...(process.env.SYSTEM_ONE_SERVER_URL ? { serverURL: process.env.SYSTEM_ONE_SERVER_URL } : {}),
      })
    : undefined

  const started = Date.now()
  const decision = await decide(ask, input.prompt ?? "", skills)
  const calls = state.calls + 1

  if (decision.kind === "skill") {
    const skill = skills.find((candidate) => candidate.id === decision.id)
    writeState(sessionID, { decision: "skill", at: Date.now(), calls })
    if (skill) emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: injectionFor(skill) } })
  } else if (decision.kind === "none") {
    writeState(sessionID, { decision: "none", at: Date.now(), calls })
    emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NONE_CONTEXT } })
  } else {
    writeState(sessionID, { at: Date.now(), calls })
  }

  logDecision({
    sessionID,
    hook: "UserPromptSubmit",
    chosen: decision.kind === "skill" ? decision.id : decision.kind,
    model: meta.model,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    latencyMs: Date.now() - started,
    calls,
    time: Date.now(),
  })
}

function preToolUse(input: HookInput): void {
  if (input.tool_name !== "Skill") return
  const state = readState(input.session_id ?? "unknown")
  if (state?.decision === "none") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: NONE_CONTEXT,
      },
    })
  }
}

async function main(): Promise<void> {
  let input: HookInput = {}
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput
  } catch {
    return
  }
  if (input.hook_event_name === "UserPromptSubmit") await userPromptSubmit(input)
  else if (input.hook_event_name === "PreToolUse") preToolUse(input)
}

if (import.meta.main) {
  main().catch(() => {})
}
```

- [ ] **Step 6: Create `mock-jev.ts` and the plugin scaffold**

`adapters/claude-code/mock-jev.ts`:

```ts
export function startMockJev() {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(
        JSON.stringify({
          answers: {
            which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
            "gate::acts": { type: "noul", noul: 0.9 },
            "gate::procedure": { type: "noul", noul: 0.8 },
            "gate::prose": { type: "noul", noul: 0.2 },
          },
          model: "~typesafe/jev-1.13.0",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  return { server, serverURL: `http://localhost:${server.port}` }
}
```

`adapters/claude-code/hooks/hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"${CLAUDE_PLUGIN_ROOT}/hooks/system-one.ts\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"${CLAUDE_PLUGIN_ROOT}/hooks/system-one.ts\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

`adapters/claude-code/.claude-plugin/plugin.json`:

```json
{
  "name": "system-one",
  "description": "Jev-routed skill selection: at most one skill is injected per prompt, and the Skill tool is denied when no skill applies.",
  "version": "0.1.0"
}
```

- [ ] **Step 7: Write `README.md`**

Include, in this order: what it does and the harness ceiling (injects context, denies `Skill`; cannot filter tools or rewrite the system prompt); install with `claude --plugin-dir /home/gerius/Desktop/jev-for-all/adapters/claude-code`; environment (`OPENROUTER_API_KEY`, optional `SYSTEM_ONE_SERVER_URL`, `SYSTEM_ONE_SKILL_DIRS`, `SYSTEM_ONE_STATE_DIR`); the roster source (`~/.claude/skills`, `<cwd>/.claude/skills`; plugin-provided skills are not scanned); what it injects; the decision log path (`${CLAUDE_PLUGIN_DATA}/system-one-cc/decisions.jsonl` or the `SYSTEM_ONE_STATE_DIR` fallback); Data egress (prompt text + skill roster go to OpenRouter's decisions endpoint; the injected skill body stays local); fail-open behavior; and the proof steps:

```bash
# 1. unit + conformance
bun test adapters/claude-code/system-one.test.ts
bun adapters/claude-code/conformance.ts

# 2. live smoke (needs OPENROUTER_API_KEY): run one prompt, then read the decision log
claude --plugin-dir /home/gerius/Desktop/jev-for-all/adapters/claude-code -p "build me a deck"
cat "${CLAUDE_PLUGIN_DATA:-/tmp}/system-one-cc/decisions.jsonl"
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `bun test adapters/claude-code/system-one.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add adapters/claude-code
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add the claude code plugin hooks and install proof"
```

**Gate:** all adapter tests pass; typecheck clean; the hook's live smoke has been run once (or explicitly deferred in the task report with the reason) and a decision-log line is recorded.

---

### Task 5: Hermes decision port and conformance

**Files:**
- Create: `adapters/hermes/system_one/decision.py`
- Create: `adapters/hermes/tests/test_conformance.py`
- Create: `adapters/hermes/tests/test_decision.py`

**Interfaces:**
- Consumes: `assets/decisions.json`, `assets/conformance.jsonl` (Task 1).
- Produces (all stdlib):
  - `load_policy`-style module constant `POLICY: dict`
  - `format_template(template: str, values: dict[str, str]) -> str`
  - `scan_skills(dirs: Sequence[str]) -> list[dict]` (keys `id`, `name`, `description`, `content`, `path`)
  - `as_choice(value) -> dict | None`, `as_noul(value) -> float | None`
  - `select_skill(ask, request, skills) -> str | None` (swallows errors exactly like `src/skills.ts`)
  - `decide(ask, request, skills) -> tuple[str, str | None]` with `"skill" | "none" | "no-change"`
  - `injection_for(skill) -> str`, `NONE_CONTEXT: str`
  - `ask_openrouter(state, questions, *, api_key, model, timeout_s, on_meta=None) -> dict` (raises on failure)
  - `log_decision(path, record) -> None`

- [ ] **Step 1: Write the failing conformance test**

Create `adapters/hermes/tests/test_conformance.py`:

```python
"""Shared-fixture conformance for the Python port of the skill decision."""
import json
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from system_one.decision import select_skill  # noqa: E402

ASSETS = Path(__file__).resolve().parents[1] / "system_one" / "assets"


def replay(calls, made):
    def ask(_state, _questions):
        index = made["count"]
        made["count"] += 1
        if index >= len(calls):
            raise AssertionError("fixture provided no answer for this call")
        call = calls[index]
        if call.get("throw"):
            raise RuntimeError("fixture transport error")
        return call.get("answers", {})

    return ask


class ConformanceTest(unittest.TestCase):
    def test_shared_fixtures(self):
        fixtures = [
            json.loads(line)
            for line in (ASSETS / "conformance.jsonl").read_text().splitlines()
            if line.strip()
        ]
        self.assertEqual(len(fixtures), 9)
        failures = []
        for fixture in fixtures:
            self.assertEqual(fixture["decision"], "skills")
            roster = [
                {
                    "id": entry["id"],
                    "name": entry.get("name", entry["id"]),
                    "description": entry.get("description"),
                    "content": entry.get("content", ""),
                }
                for entry in fixture["roster"]
            ]
            made = {"count": 0}
            actual = select_skill(replay(fixture["calls"], made), fixture["task"], roster)
            if actual != fixture["expected"]["skill"]:
                failures.append(f"{fixture['id']}: expected {fixture['expected']['skill']!r}, got {actual!r}")
                continue
            if made["count"] != len(fixture["calls"]):
                failures.append(f"{fixture['id']}: expected {len(fixture['calls'])} ask call(s), made {made['count']}")
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
```

Create `adapters/hermes/tests/test_decision.py`:

```python
"""Decision rules, injection cap, roster scan, transport fail-open, plugin registration."""
import json
import os
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from system_one import decision  # noqa: E402

OPEN_GATE = {
    "gate::acts": {"type": "noul", "noul": 0.9},
    "gate::procedure": {"type": "noul", "noul": 0.8},
    "gate::prose": {"type": "noul", "noul": 0.2},
}


def stub_ask(*responses):
    calls = []

    def ask(_state, _questions):
        calls.append((_state, _questions))
        response = responses[min(len(calls) - 1, len(responses) - 1)]
        if isinstance(response, Exception):
            raise response
        return response

    return ask, calls


class DecisionTest(unittest.TestCase):
    def test_skill_none_and_no_change(self):
        roster = [{"id": "a", "name": "A", "description": "Does A", "content": "body"}]
        ask, _ = stub_ask(
            {
                "which": {"type": "choice", "choice": "a", "probabilities": {"a": 0.9}, "confidence": 0.9},
                **OPEN_GATE,
            }
        )
        self.assertEqual(decision.decide(ask, "do A", roster), ("skill", "a"))

        ask, _ = stub_ask(
            {
                "which": {"type": "choice", "choice": "a", "probabilities": {"a": 0.9}, "confidence": 0.9},
                "gate::acts": {"type": "noul", "noul": 0.1},
                "gate::procedure": {"type": "noul", "noul": 0.1},
                "gate::prose": {"type": "noul", "noul": 0.9},
            }
        )
        self.assertEqual(decision.decide(ask, "explain", roster), ("none", None))

        ask, _ = stub_ask(RuntimeError("boom"))
        self.assertEqual(decision.decide(ask, "do A", roster), ("no-change", None))

        ask, _ = stub_ask(
            {
                "which": {"type": "choice", "choice": "a", "probabilities": {"a": 0.5}, "confidence": 0.1},
                **OPEN_GATE,
            }
        )
        self.assertEqual(decision.decide(ask, "do A", roster), ("no-change", None))

    def test_injection_cap_and_none_line(self):
        short = decision.injection_for({"id": "a", "name": "A", "description": "Does A", "content": "body", "path": "/s/a"})
        self.assertIn("body", short)
        long = decision.injection_for(
            {"id": "b", "name": "B", "description": "Does B", "content": "x" * 8001, "path": "/s/b"}
        )
        self.assertIn("/s/b", long)
        self.assertNotIn("x" * 8001, long)
        self.assertIn("routed externally", decision.NONE_CONTEXT)

    def test_scan_skills(self):
        with tempfile.TemporaryDirectory() as root:
            skill = Path(root) / "alpha"
            skill.mkdir()
            (skill / "SKILL.md").write_text("---\nname: Alpha\ndescription: Does alpha\n---\n\nAlpha body\n")
            broken = Path(root) / "broken"
            broken.mkdir()
            (broken / "SKILL.md").write_text("no frontmatter")
            skills = {entry["id"]: entry for entry in decision.scan_skills([root])}
            self.assertEqual(skills["alpha"]["name"], "Alpha")
            self.assertEqual(skills["alpha"]["description"], "Does alpha")
            self.assertEqual(skills["alpha"]["content"].strip(), "Alpha body")
            self.assertEqual(skills["broken"]["name"], "broken")

    def test_transport_parses_answers_and_reports_meta(self):
        class FakeResponse:
            def __init__(self, body):
                self.body = body

            def read(self):
                return json.dumps(self.body).encode()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        original = decision.urllib.request.urlopen
        meta = {}

        def fake_urlopen(request, timeout=None):
            return FakeResponse(
                {
                    "answers": {"which": {"type": "choice", "choice": "a", "probabilities": {"a": 1}, "confidence": 1}},
                    "model": "~typesafe/jev-1.13.0",
                    "usage": {"input_tokens": 12, "output_tokens": 3},
                }
            )

        decision.urllib.request.urlopen = fake_urlopen
        try:
            answers = decision.ask_openrouter(
                {"request": "hi"},
                {"which": {"type": "choice", "instructions": "pick", "criteria": {"a": "A"}}},
                api_key="k",
                model="~typesafe/jev-latest",
                timeout_s=1,
                on_meta=lambda info: meta.update(info),
            )
        finally:
            decision.urllib.request.urlopen = original
        self.assertEqual(answers["which"]["choice"], "a")
        self.assertEqual(meta["model"], "~typesafe/jev-1.13.0")
        self.assertEqual(meta["input_tokens"], 12)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest discover -s adapters/hermes/tests -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'system_one'`.

- [ ] **Step 3: Implement `decision.py`**

```python
"""Jev skill decision for Hermes: contract load, roster scan, decision, injection, transport.

Stdlib only. Mirrors src/skills.ts against the shared contract; the shared
conformance fixtures are the parity check.
"""
from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

ASSETS = Path(__file__).resolve().parent / "assets"
POLICY = json.loads((ASSETS / "decisions.json").read_text())

NONE_CONTEXT = "Skills are routed externally for this turn; do not call the skill tool unless the user names one."

Ask = Callable[[Any, dict], dict]


def format_template(template: str, values: dict[str, str]) -> str:
    return re.sub(r"\{\{(\w+)\}\}", lambda match: values.get(match.group(1), match.group(0)), template)


def as_choice(value: Any) -> dict | None:
    if not isinstance(value, dict) or value.get("type") != "choice" or not isinstance(value.get("choice"), str):
        return None
    probabilities = {
        key: probability
        for key, probability in (value.get("probabilities") or {}).items()
        if isinstance(probability, (int, float))
    }
    confidence = value.get("confidence")
    return {
        "choice": value["choice"],
        "probabilities": probabilities,
        "confidence": confidence if isinstance(confidence, (int, float)) else None,
    }


def as_noul(value: Any) -> float | None:
    if not isinstance(value, dict) or value.get("type") != "noul":
        return None
    noul = value.get("noul")
    return float(noul) if isinstance(noul, (int, float)) else None


def _parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {"body": text}
    end = text.find("\n---", 3)
    if end == -1:
        return {"body": text}
    head = text[3:end]
    body = text[end + 4 :].lstrip("\r\n")
    fields = {}
    for line in head.splitlines():
        match = re.match(r"^([\w-]+):\s*(.*)$", line)
        if match:
            fields[match.group(1)] = match.group(2).strip().strip("\"'")
    return {"name": fields.get("name"), "description": fields.get("description"), "body": body}


def scan_skills(dirs: Sequence[str]) -> list[dict]:
    skills = []
    for directory in dirs:
        try:
            entries = sorted(Path(directory).iterdir())
        except OSError:
            continue
        for entry in entries:
            path = entry / "SKILL.md"
            try:
                parsed = _parse_frontmatter(path.read_text())
            except OSError:
                continue
            skills.append(
                {
                    "id": entry.name,
                    "name": parsed.get("name") or entry.name,
                    "description": parsed.get("description"),
                    "content": parsed["body"],
                    "path": str(path),
                }
            )
    return skills


def _label(skill: dict) -> str:
    criteria = POLICY["skills"]["criteria"]
    if skill.get("description"):
        return format_template(criteria["withDescription"], {"name": skill["name"], "description": skill["description"]})
    return format_template(criteria["withoutDescription"], {"name": skill["name"]})


def select_skill(ask: Ask, request: str, skills: Iterable[dict]) -> str | None:
    config = POLICY["skills"]
    ids = config["ids"]
    questions = config["questions"]
    roster = [skill for skill in skills if skill.get("id")]
    if not roster or not request.strip():
        return None

    state = {"request": request}
    try:
        criteria = {skill["id"]: _label(skill) for skill in roster}
        first = ask(
            state,
            {
                ids["rank"]: {"type": "choice", "instructions": questions["rank"], "criteria": criteria},
                ids["gateActs"]: {"type": "noul", "instructions": questions["gateActs"]},
                ids["gateProcedure"]: {"type": "noul", "instructions": questions["gateProcedure"]},
                ids["gateProse"]: {"type": "noul", "instructions": questions["gateProse"]},
            },
        )
        acts = as_noul(first.get(ids["gateActs"]))
        procedure = as_noul(first.get(ids["gateProcedure"]))
        prose = as_noul(first.get(ids["gateProse"]))
        if acts is None or procedure is None or prose is None:
            return None
        gate = (acts + procedure + (1 - prose)) / 3
        if gate < config["gateThreshold"]:
            return None

        choice = as_choice(first.get(ids["rank"]))
        if choice is None or not any(skill["id"] == choice["choice"] for skill in roster):
            return None
        confidence = choice["confidence"] if choice["confidence"] is not None else 1
        if confidence < config["minConfidence"]:
            return None

        winner = choice["choice"]
        probabilities = choice["probabilities"]
        top = max(probabilities.values()) if probabilities else 0
        want_rerank = config["rerank"] is True or (
            config["rerank"] == "auto" and (len(roster) > config["rerankAbove"] or top < config["rerankBelowP"])
        )
        if want_rerank:
            by_id = {skill["id"]: skill for skill in roster}
            shortlist = sorted(
                (name for name in probabilities if name in by_id),
                key=lambda name: probabilities.get(name, 0),
                reverse=True,
            )[: max(1, config["shortlist"])]
            if len(shortlist) > 1:
                rerank_criteria = {}
                for name in shortlist:
                    skill = by_id[name]
                    rerank_criteria[name] = _label(skill) + format_template(
                        config["criteria"]["withContent"],
                        {"content": skill["content"][: config["criteria"]["contentChars"]]},
                    )
                rerank_questions = {
                    ids["rerank"]: {"type": "choice", "instructions": questions["rerank"], "criteria": rerank_criteria}
                }
                for name in shortlist:
                    skill = by_id[name]
                    rerank_questions[format_template(ids["fits"], {"id": name})] = {
                        "type": "noul",
                        "instructions": format_template(questions["fits"], {"name": skill["name"]}),
                    }
                second = ask(state, rerank_questions)
                fits = [as_noul(second.get(format_template(ids["fits"], {"id": name}))) or 0 for name in shortlist]
                if max(fits) < config["fitsThreshold"]:
                    return None
                reranked = as_choice(second.get(ids["rerank"]))
                if reranked and reranked["choice"] in shortlist:
                    rerank_confidence = reranked["confidence"] if reranked["confidence"] is not None else 1
                    if rerank_confidence >= config["minConfidence"]:
                        winner = reranked["choice"]
        return winner
    except Exception:
        return None


def decide(ask: Ask | None, request: str, skills: Iterable[dict]) -> tuple[str, str | None]:
    roster = [skill for skill in skills if skill.get("id")]
    if ask is None or not roster or not request.strip():
        return ("no-change", None)
    state = {"answered": False, "confidence": None}

    def tracked(st, questions):
        answers = ask(st, questions)
        if not state["answered"]:
            state["answered"] = True
            choice = as_choice(answers.get(POLICY["skills"]["ids"]["rank"]))
            state["confidence"] = choice["confidence"] if choice else None
        return answers

    try:
        winner = select_skill(tracked, request, roster)
    except Exception:
        return ("no-change", None)
    if winner:
        return ("skill", winner)
    confident = (state["confidence"] if state["confidence"] is not None else 1) >= POLICY["skills"]["minConfidence"]
    return ("none", None) if state["answered"] and confident else ("no-change", None)


def injection_for(skill: dict) -> str:
    header = f"<skill_relevance>\nRouted skill: {skill['name']} ({skill['id']}).\n</skill_relevance>"
    cap = POLICY["skills"]["injection"]["chars"]
    if len(skill["content"]) <= cap:
        return f"{header}\n\n{skill['content']}"
    summary = skill.get("description") or skill["name"]
    return f"{header} {summary} Read the full skill at {skill['path']}."


def ask_openrouter(
    state: Any,
    questions: dict,
    *,
    api_key: str,
    model: str,
    timeout_s: float,
    on_meta: Callable[[dict], None] | None = None,
) -> dict:
    request = urllib.request.Request(
        "https://openrouter.ai/api/alpha/decisions",
        data=json.dumps({"model": model, "state": state, "questions": questions}).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        body = json.loads(response.read().decode())
    answers = body.get("answers")
    if not isinstance(answers, dict):
        raise RuntimeError("system-one response missing answers")
    if on_meta is not None:
        usage = body.get("usage") or {}
        on_meta(
            {
                "model": body.get("model"),
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
            }
        )
    return answers


def log_decision(path: str | Path, record: dict) -> None:
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a") as handle:
            handle.write(json.dumps({"kind": "decision", **record}) + "\n")
    except OSError:
        pass
```

Parity notes the implementer must honor: `select_skill` catches every error and returns `None`, exactly like `src/skills.ts`; `decide` captures confidence from the **first** ask only, so the rerank answer cannot overwrite it; the rerank criteria dict is filled before the request is made; `contentChars` slicing matches JS `slice` for the ASCII fixture content.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest discover -s adapters/hermes/tests -v`
Expected: PASS (conformance 9/9 plus the decision tests).

- [ ] **Step 5: Commit**

```bash
git add adapters/hermes/system_one/decision.py adapters/hermes/tests
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: port the skill decision to python with shared conformance"
```

**Gate:** `python3 -m unittest discover -s adapters/hermes/tests` exits 0 with 9/9 conformance and the decision tests green.

---

### Task 6: Hermes plugin, install, and real-run proof

**Files:**
- Create: `adapters/hermes/system_one/__init__.py`
- Create: `adapters/hermes/system_one/plugin.yaml`
- Create: `adapters/hermes/README.md`
- Modify: `adapters/hermes/tests/test_decision.py` (append the registration test)

**Interfaces:**
- Consumes: `decision.py` (Task 5).
- Produces: `register(ctx)` registering exactly one hook, `pre_llm_call`, whose callback returns `{"context": str}` or `None`; plugin settings `model`, `max_calls_per_session`, `timeout_ms`, `skill_dirs`.

- [ ] **Step 1: Write the failing test**

Append to `adapters/hermes/tests/test_decision.py`:

```python
class PluginRegistrationTest(unittest.TestCase):
    def test_register_wires_only_pre_llm_call_and_returns_context(self):
        import importlib
        import os
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HERMES_HOME": home}, clear=False):
            os.environ.pop("OPENROUTER_API_KEY", None)
            import system_one as plugin

            importlib.reload(plugin)

            hooks = {}

            class FakeCtx:
                def register_hook(self, name, callback):
                    hooks[name] = callback

                def get_config(self):
                    return {}

            plugin.register(FakeCtx())
            self.assertEqual(list(hooks), ["pre_llm_call"])
            self.assertIsNone(
                hooks["pre_llm_call"](
                    session_id="s",
                    user_message="hi",
                    conversation_history=[],
                    is_first_turn=True,
                    model="m",
                    platform="cli",
                )
            )


if __name__ == "__main__":
    unittest.main()
```

(The appended `if __name__` block duplicates the existing one; harmless, but place the new class before the existing `if __name__` block if the file already ends with one.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m unittest discover -s adapters/hermes/tests -v`
Expected: FAIL — `register` missing.

- [ ] **Step 3: Implement `__init__.py`**

```python
"""Hermes plugin: Jev-routed skill selection via pre_llm_call context injection."""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from . import decision

logger = logging.getLogger(__name__)

NONE_CONTEXT = decision.NONE_CONTEXT
DEFAULT_SKILL_DIRS = [str(Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "skills")]


def _plugin_data_dir() -> Path:
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    return home / "plugin-data" / "system-one"


def _handle_turn(ctx, *, session_id: str, user_message: str, **kwargs) -> dict | None:
    try:
        config = {}
        try:
            config = ctx.get_config() or {}
        except Exception:
            config = {}
        model = config.get("model") or "~typesafe/jev-latest"
        timeout_ms = config.get("timeout_ms") or 1000
        cap = config.get("max_calls_per_session") or 500
        skill_dirs = config.get("skill_dirs") or DEFAULT_SKILL_DIRS
        if isinstance(skill_dirs, str):
            skill_dirs = [skill_dirs]

        log_path = _plugin_data_dir() / "decisions.jsonl"
        skills = decision.scan_skills(skill_dirs)
        if not skills:
            return None

        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            return None

        calls = 0
        try:
            for line in log_path.read_text().splitlines():
                if f'"sessionID": "{session_id}"' in line:
                    calls += 1
        except OSError:
            calls = 0
        if calls >= cap:
            decision.log_decision(
                log_path,
                {"harness": "hermes", "sessionID": session_id, "hook": "pre_llm_call", "chosen": "no-change", "event": "cap", "calls": calls, "time": time.time()},
            )
            return None
        if calls + 1 == int(cap * 0.8):
            decision.log_decision(
                log_path,
                {"harness": "hermes", "sessionID": session_id, "hook": "pre_llm_call", "chosen": "no-change", "event": "warn", "calls": calls + 1, "time": time.time()},
            )

        meta: dict = {}
        started = time.time()

        def ask(state, questions):
            return decision.ask_openrouter(
                state,
                questions,
                api_key=api_key,
                model=model,
                timeout_s=timeout_ms / 1000,
                on_meta=meta.update,
            )

        kind, skill_id = decision.decide(ask, user_message, skills)
        decision.log_decision(
            log_path,
            {
                "harness": "hermes",
                "sessionID": session_id,
                "hook": "pre_llm_call",
                "chosen": skill_id if kind == "skill" else kind,
                "model": meta.get("model"),
                "inputTokens": meta.get("input_tokens"),
                "outputTokens": meta.get("output_tokens"),
                "latencyMs": int((time.time() - started) * 1000),
                "calls": calls + 1,
                "time": time.time(),
            },
        )

        if kind == "skill":
            skill = next((entry for entry in skills if entry["id"] == skill_id), None)
            return {"context": decision.injection_for(skill)} if skill else None
        if kind == "none":
            return {"context": NONE_CONTEXT}
        return None
    except Exception:
        logger.debug("system-one hook failed", exc_info=True)
        return None


def register(ctx):
    """Wire the skill decision into pre_llm_call. Nothing else is touched."""
    ctx.register_hook(
        "pre_llm_call",
        lambda session_id, user_message, conversation_history, is_first_turn, model, platform, **kwargs: _handle_turn(
            ctx, session_id=session_id, user_message=user_message
        ),
    )
```

- [ ] **Step 4: Create `plugin.yaml`**

```yaml
name: system-one
version: 0.1.0
manifest_version: 2
api_version: 1
license: MIT
description: >-
  Jev-routed skill selection for Hermes: pre_llm_call injects at most one skill
  per turn, or a routed-externally line when none applies. It never touches the
  system prompt or the toolset, so the prompt cache stays intact.
config_schema:
  model: {type: str, default: "~typesafe/jev-latest", description: "Jev model slug"}
  max_calls_per_session: {type: int, default: 500, description: "Stop calling Jev past this many calls in one session"}
  timeout_ms: {type: int, default: 1000, description: "Per-request timeout in milliseconds"}
  skill_dirs: {type: list, default: [], description: "Skill directories to scan; empty uses $HERMES_HOME/skills"}
```

- [ ] **Step 5: Run the tests**

Run: `python3 -m unittest discover -s adapters/hermes/tests -v`
Expected: PASS.

- [ ] **Step 6: Validate and install into Hermes**

Run (from the repo root):

```bash
hermes plugins doctor adapters/hermes/system_one --ci
hermes plugins validate adapters/hermes/system_one
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/system-one"
cp -R adapters/hermes/system_one "${HERMES_HOME:-$HOME/.hermes}/plugins/system-one"
hermes plugins enable system-one
```

Expected: doctor/validate report no errors; the installed directory contains `plugin.yaml`, `__init__.py`, `decision.py`, `assets/`.

- [ ] **Step 7: Real-run proof**

```bash
OPENROUTER_API_KEY=... hermes chat -q "summarize the file /tmp/opencode/system-one-proof.txt"
tail -1 "${HERMES_HOME:-$HOME/.hermes}/plugin-data/system-one/decisions.jsonl"
```

Expected: one decision line with `"harness": "hermes"`, the resolved `model`, and a `chosen` value (`none`/`no-change`/a skill id). Then run a skill-matching prompt against a real installed skill (for example the user's `email` skill with a draft-an-email request) and confirm the line's `chosen` names that skill. Record both lines in the task report. The injection itself is observable in the turn's user message; the log is the durable proof the hook ran.

- [ ] **Step 8: Write `README.md`**

Include: what it reads (`$HERMES_HOME/skills/*/SKILL.md` plus configured `skill_dirs`; the contract in `assets/decisions.json`); what it injects (the `<skill_relevance>` line + skill body up to the contract cap, or the routed-externally line); what it never touches (system prompt, toolset — cache invariant); settings; the decision log path; Data egress (user message + skill roster to OpenRouter; the skill body stays local); fail-open behavior; install commands from Step 6; and the proof procedure from Step 7.

- [ ] **Step 9: Commit**

```bash
git add adapters/hermes/system_one/__init__.py adapters/hermes/system_one/plugin.yaml adapters/hermes/README.md adapters/hermes/tests/test_decision.py
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add the hermes plugin with install and run proof"
```

**Gate:** unit tests green; `hermes plugins doctor/validate` clean; both real-run proof lines recorded (or explicitly deferred with the reason — for example, no `OPENROUTER_API_KEY` in the Hermes process environment — in the task report).

---

### Task 7: Phase B gate

**Files:** none (verification only).

- [ ] **Step 1: Run every gate**

```bash
bun scripts/sync-adapter-assets.ts --check
bun test
bun run typecheck
bun scripts/conformance.ts
bun adapters/claude-code/conformance.ts
python3 -m unittest discover -s adapters/hermes/tests
git status --porcelain
```

Expected: assets up to date; `bun test` green (Phase A 52 + Task 2's 2 + Task 3/4 adapter tests); typecheck clean; core conformance 9/9; CC conformance 9/9; Python tests green; WIP files still modified/untracked exactly as before, with no staged leftovers.

- [ ] **Step 2: Record the phase result**

Report: commit list, gate output, the two real-run proof lines, and anything the plan got wrong. Do not push.

**Gate:** all six commands exit 0 and the WIP diff is unchanged.

---

## Out of scope (Phase B)

- No browser work (Phase C) and no tool-hint routing (Phase D).
- No OpenCode changes; its Phase 2–6 roadmap is untouched.
- No enforcement on Hermes beyond injection (the cache invariant), and no `pre_tool_call` gating.
- No marketplace distribution, no bundling of the Claude Code plugin, no catalog entry for the Hermes plugin.
- No spend-ledger aggregation or report unification (Phase D4); each adapter only writes its own decision log and enforces its own cap.

## Self-review

- **Spec coverage:** Phase B's two deliverables (Claude Code adapter, Hermes adapter) are Tasks 3–4 and 5–6; "shared fixtures + a per-harness runner" is Tasks 3 and 5; "the exact shape of the Hermes plugin" is Task 6; the harness-limits table drives the Global Constraints and both READMEs. Resolved decisions: roster dirs (Task 3), 8000-char cap (Task 1 contract + Tasks 3/5), Hermes injection-only (Task 6), model alias + resolved-id logging (Task 2 + both logs), 500-call cap (Global Constraints + Tasks 4/6).
- **Placeholder scan:** every code step carries full code; every command has an expected result.
- **Type consistency:** `SkillFile`, `Decision`, `SessionState`, and the Python `decide` tuple are defined in their tasks and consumed with the same shapes in later tasks; `policy.skills.injection.chars` is added in Task 1 and read in Tasks 3 and 5.
- **Parity edge case:** confidence is captured from the first ask only in both ports, so a rerank answer can never flip a low-confidence first call into an authoritative "none"; `select_skill` swallows errors exactly like the TS core, and `decide` distinguishes answered-but-none from unavailable via the first call.
