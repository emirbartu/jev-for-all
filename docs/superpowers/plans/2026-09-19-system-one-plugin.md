# System One Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An OpenCode V2 plugin where Jev (TypeSafe System One model) picks the skill and the tool subset for each turn, so a classic agent (DeepSeek, etc.) starts building immediately with a smaller context.

**Architecture:** Two session hooks. The `prompt` hook runs Jev once per user message and hard-loads the chosen skill via `event.prompt.skills`. The `context` hook runs Jev before every model dispatch, filters `event.tools` to a confident subset, and appends a one-line routing hint to `event.system`. All Jev calls fail open — a decision that errors, times out, or scores below threshold changes nothing. Decisions are cached in-memory.

**Tech Stack:** TypeScript (strict) on Bun, `@opencode/plugin@^2.0.8`, direct `fetch` to `https://api.typesafe.ai/v1/systemone`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-19-system-one-plugin-design.md`

## Global Constraints

- No new runtime dependencies. The only added dev dependency is `@types/bun` (types for `bun:test` so `tsc --noEmit` passes). Do not add `@typesafe-ai/sdk`.
- Every Jev call fails open: timeout, non-2xx, malformed answer, or low confidence → no filter, no skill, no hint. Never throw out of a hook.
- Default values are exactly: `model: "jev-latest"`, `timeoutMs: 1000`, `skills.rerank: "auto"`, `skills.gateThreshold: 0.3`, `skills.rerankAbove: 40`, `skills.rerankBelowP: 0.5`, `skills.shortlist: 3`, `skills.fitsThreshold: 0.3`, `skills.minConfidence: 0.3`, `tools.maxTools: 12`, `tools.minToolProbability: 0.05`, `tools.needsToolThreshold: 0.3`, `tools.minConfidence: 0.3`, `tools.alwaysVisible: ["read", "write", "edit", "bash", "grep", "glob"]`, `tools.stateBudget: 6000`.
- Plugin id stays `"system-one"`.
- This directory is not a git repository. Task 1, Step 1 initializes it. If the user has said no to git by execution time, skip every `git` step and keep the files.
- Run all commands from the repository root.

## File Structure

| File | Responsibility |
| --- | --- |
| `index.ts` | Options parsing, wiring, in-memory cache, cleanup. The only file that touches the OpenCode context. |
| `src/jev.ts` | Transport: `createJev` posts `{state, questions}`; `asChoice`/`asNoul` guard answers. |
| `src/skills.ts` | Skill decision: gate → rank → conditional rerank → `{id} | null`; `applySkillDecision`. |
| `src/tools.ts` | Tool decision: `renderState`, `routeTools`, `applyToolDecision`. |
| `src/decisions.test.ts` | All tests, grown across tasks. |

`index.ts` is excluded from most unit tests by design: all decision logic lives in `src/`, and Task 4 tests only options + hook registration against a fake context.

---

### Task 1: Scaffold + Jev transport

**Files:**
- Modify: `package.json`, `tsconfig.json`
- Create: `.gitignore`, `src/jev.ts`, `src/decisions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Ask = (input: { state: unknown; questions: Record<string, Question> }) => Promise<Answers>`
  - `createJev(options: { apiKey: string; model?: string; baseURL?: string; timeoutMs?: number; fetch?: typeof fetch }): Ask`
  - `class JevError extends Error { status?: number }`
  - `asChoice(value: unknown): { choice: string; probabilities: Record<string, number>; confidence?: number } | null`
  - `asNoul(value: unknown): { noul: number } | null`

- [ ] **Step 1: Initialize git and ignore build noise**

```bash
git init
printf 'node_modules/\n' > .gitignore
git add -A
git commit -m "chore: initialize repository"
```

- [ ] **Step 2: Update package metadata and add test types**

Edit `package.json` to:

```json
{
  "name": "opencode-system-one",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "files": [
    "index.ts",
    "src"
  ],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@opencode/plugin": "^2.0.8"
  },
  "devDependencies": {
    "@types/bun": "^1.4.2",
    "typescript": "^5.9.0"
  }
}
```

Edit `tsconfig.json` `include` to:

```json
"include": ["index.ts", "src/**/*.ts"]
```

Then:

```bash
bun add -d @types/bun
bun run typecheck
```

Expected: typecheck passes (the template `index.ts` still compiles).

- [ ] **Step 3: Write the failing transport tests**

Create `src/decisions.test.ts`:

```ts
import { expect, test } from "bun:test"
import { JevError, asChoice, asNoul, createJev } from "./jev"

test("createJev posts state and questions and returns answers", async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(
      JSON.stringify({
        answers: { which: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 } },
      }),
      { status: 200 },
    )
  }
  const ask = createJev({ apiKey: "k", fetch: fakeFetch })
  const answers = await ask({
    state: { request: "hi" },
    questions: { which: { type: "choice", instructions: "pick", criteria: { read: "read a file" } } },
  })

  expect(calls.length).toBe(1)
  expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone")
  expect(calls[0].body).toEqual({
    state: { request: "hi" },
    model: "jev-latest",
    questions: { which: { type: "choice", instructions: "pick", criteria: { read: "read a file" } } },
  })
  expect(asChoice(answers.which)?.choice).toBe("read")
})

test("createJev throws JevError on non-2xx", async () => {
  const ask = createJev({ apiKey: "k", fetch: async () => new Response("nope", { status: 429 }) })
  await expect(ask({ state: {}, questions: {} })).rejects.toThrow(JevError)
})

test("answer guards reject malformed payloads", () => {
  expect(asChoice({ type: "choice" })).toBeNull()
  expect(asChoice(null)).toBeNull()
  expect(asNoul({ type: "noul", noul: "high" })).toBeNull()
  expect(asNoul({ type: "noul", noul: 0.7 })?.noul).toBe(0.7)
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test src/decisions.test.ts`

Expected: FAIL — `Cannot find module './jev'`.

- [ ] **Step 5: Implement the transport**

Create `src/jev.ts`:

```ts
export interface QuestionChoice {
  type: "choice"
  instructions: string
  criteria: Record<string, string>
}

export interface QuestionNoul {
  type: "noul"
  instructions: string
}

export type Question = QuestionChoice | QuestionNoul

export type Answers = Record<string, unknown>

export type Ask = (input: { state: unknown; questions: Record<string, Question> }) => Promise<Answers>

export interface JevOptions {
  apiKey: string
  model?: string
  baseURL?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export class JevError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "JevError"
    this.status = status
  }
}

export function createJev(options: JevOptions): Ask {
  const model = options.model ?? "jev-latest"
  const baseURL = (options.baseURL ?? "https://api.typesafe.ai").replace(/\/$/, "")
  const timeoutMs = options.timeoutMs ?? 1000
  const doFetch = options.fetch ?? fetch

  return async ({ state, questions }) => {
    let response: Response
    try {
      response = await doFetch(`${baseURL}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ state, model, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new JevError(`system-one request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new JevError(`system-one request failed: ${response.status}`, response.status)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new JevError("system-one returned invalid JSON")
    }
    const answers = (body as { answers?: unknown } | null)?.answers
    if (!answers || typeof answers !== "object") throw new JevError("system-one response missing answers")
    return answers as Answers
  }
}

export interface ChoiceAnswer {
  choice: string
  probabilities: Record<string, number>
  confidence?: number
}

export interface NoulAnswer {
  noul: number
}

export function asChoice(value: unknown): ChoiceAnswer | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown }
  if (candidate.type !== "choice" || typeof candidate.choice !== "string") return null
  const probabilities: Record<string, number> = {}
  if (candidate.probabilities && typeof candidate.probabilities === "object") {
    for (const [key, probability] of Object.entries(candidate.probabilities as Record<string, unknown>)) {
      if (typeof probability === "number" && Number.isFinite(probability)) probabilities[key] = probability
    }
  }
  return {
    choice: candidate.choice,
    probabilities,
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : undefined,
  }
}

export function asNoul(value: unknown): NoulAnswer | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { type?: unknown; noul?: unknown }
  if (candidate.type !== "noul" || typeof candidate.noul !== "number" || !Number.isFinite(candidate.noul)) return null
  return { noul: candidate.noul }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/decisions.test.ts`

Expected: 3 pass, 0 fail.

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
git add package.json tsconfig.json bun.lock .gitignore src/jev.ts src/decisions.test.ts
git commit -m "feat: add Jev transport and answer guards"
```

---

### Task 2: Skill selection

**Files:**
- Create: `src/skills.ts`
- Modify: `src/decisions.test.ts` (append tests)

**Interfaces:**
- Consumes: `Ask`, `asChoice`, `asNoul` from Task 1.
- Produces:
  - `interface SkillLike { id: string; name: string; description?: string; content: string }`
  - `interface SkillRoutingConfig { gateThreshold: number; rerank: boolean | "auto"; rerankAbove: number; rerankBelowP: number; shortlist: number; fitsThreshold: number; minConfidence: number }`
  - `defaultSkillRouting: SkillRoutingConfig`
  - `selectSkill(ask: Ask, input: { request: string; skills: readonly SkillLike[]; config?: Partial<SkillRoutingConfig> }): Promise<{ id: string } | null>`
  - `applySkillDecision(prompt: { skills?: Array<{ id: string }> }, decision: { id: string } | null): boolean`

- [ ] **Step 1: Append the failing tests**

Append to `src/decisions.test.ts`:

```ts
import { applySkillDecision, selectSkill } from "./skills"
import type { Ask } from "./jev"

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

const skillRoster = [
  { id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" },
  { id: "pptx-edit", name: "pptx-edit", description: "Edit decks", content: "Use the editor" },
]

const openGate = { "gate::acts": { type: "noul", noul: 0.9 }, "gate::procedure": { type: "noul", noul: 0.8 }, "gate::prose": { type: "noul", noul: 0.2 } }
const closedGate = { "gate::acts": { type: "noul", noul: 0.1 }, "gate::procedure": { type: "noul", noul: 0.1 }, "gate::prose": { type: "noul", noul: 0.9 } }

test("selectSkill returns null when the gate is closed", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9, "pptx-edit": 0.1 }, confidence: 0.9 },
    ...closedGate,
  })
  expect(await selectSkill(ask, { request: "explain monads", skills: skillRoster, config: { rerank: false } })).toBeNull()
})

test("selectSkill returns the ranked winner", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.8, "pptx-edit": 0.2 }, confidence: 0.9 },
    ...openGate,
  })
  expect(await selectSkill(ask, { request: "build me a deck", skills: skillRoster, config: { rerank: false } })).toEqual({
    id: "pptx-author",
  })
})

test("selectSkill rejects a winner that is not in the roster", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "nope", probabilities: { nope: 1 }, confidence: 1 },
    ...openGate,
  })
  expect(await selectSkill(ask, { request: "build me a deck", skills: skillRoster, config: { rerank: false } })).toBeNull()
})

test("selectSkill reranks a large roster and honours the fits threshold", async () => {
  const { ask, calls } = stubAsk(
    {
      which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.6, "pptx-edit": 0.4 }, confidence: 0.9 },
      ...openGate,
    },
    {
      which: { type: "choice", choice: "pptx-edit", probabilities: { "pptx-author": 0.4, "pptx-edit": 0.6 }, confidence: 0.9 },
      "fits::pptx-author": { type: "noul", noul: 0.2 },
      "fits::pptx-edit": { type: "noul", noul: 0.8 },
    },
  )
  const decision = await selectSkill(ask, { request: "edit my deck", skills: skillRoster, config: { rerank: "auto", rerankAbove: 1 } })
  expect(calls.length).toBe(2)
  expect(decision).toEqual({ id: "pptx-edit" })
})

test("selectSkill fails open on transport errors", async () => {
  const { ask } = stubAsk(new Error("boom"))
  expect(await selectSkill(ask, { request: "anything", skills: skillRoster })).toBeNull()
})

test("applySkillDecision pushes once and dedupes", () => {
  const prompt: { skills?: Array<{ id: string }> } = {}
  expect(applySkillDecision(prompt, { id: "pptx-author" })).toBe(true)
  expect(applySkillDecision(prompt, { id: "pptx-author" })).toBe(false)
  expect(applySkillDecision(prompt, null)).toBe(false)
  expect(prompt.skills).toEqual([{ id: "pptx-author" }])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/decisions.test.ts`

Expected: FAIL — `Cannot find module './skills'`.

- [ ] **Step 3: Implement skill selection**

Create `src/skills.ts`:

```ts
import { type Ask, type Question, asChoice, asNoul } from "./jev"

export interface SkillLike {
  id: string
  name: string
  description?: string
  content: string
}

export interface SkillRoutingConfig {
  gateThreshold: number
  rerank: boolean | "auto"
  rerankAbove: number
  rerankBelowP: number
  shortlist: number
  fitsThreshold: number
  minConfidence: number
}

export const defaultSkillRouting: SkillRoutingConfig = {
  gateThreshold: 0.3,
  rerank: "auto",
  rerankAbove: 40,
  rerankBelowP: 0.5,
  shortlist: 3,
  fitsThreshold: 0.3,
  minConfidence: 0.3,
}

const RANK_INSTRUCTIONS = "Which of these skills, if any, is the right one to load to help with the user's latest request?"
const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name."
const GATE_ACTS = "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?"
const GATE_PROCEDURE =
  "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?"
const GATE_PROSE =
  "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?"

export async function selectSkill(
  ask: Ask,
  input: { request: string; skills: readonly SkillLike[]; config?: Partial<SkillRoutingConfig> },
): Promise<{ id: string } | null> {
  const config = { ...defaultSkillRouting, ...input.config }
  const skills = input.skills.filter((skill) => skill.id)
  if (skills.length === 0 || input.request.trim() === "") return null

  try {
    const state = { request: input.request }
    const roster = Object.fromEntries(
      skills.map((skill) => [skill.id, `${skill.name}${skill.description ? ` — ${skill.description}` : ""}`]),
    )
    const first = await ask({
      state,
      questions: {
        which: { type: "choice", instructions: RANK_INSTRUCTIONS, criteria: roster },
        "gate::acts": { type: "noul", instructions: GATE_ACTS },
        "gate::procedure": { type: "noul", instructions: GATE_PROCEDURE },
        "gate::prose": { type: "noul", instructions: GATE_PROSE },
      },
    })

    const gate = (["acts", "procedure", "prose"] as const)
      .map((key) => {
        const value = asNoul(first[`gate::${key}`])?.noul ?? 0
        return key === "prose" ? 1 - value : value
      })
      .reduce((sum, value) => sum + value, 0) / 3
    if (gate < config.gateThreshold) return null

    const choice = asChoice(first.which)
    if (!choice || !skills.some((skill) => skill.id === choice.choice)) return null
    if ((choice.confidence ?? 1) < config.minConfidence) return null

    let winner = choice.choice
    const topProbability = Object.values(choice.probabilities).sort((a, b) => b - a)[0] ?? 0
    const wantRerank =
      config.rerank === true ||
      (config.rerank === "auto" && (skills.length > config.rerankAbove || topProbability < config.rerankBelowP))

    if (wantRerank) {
      const byId = new Map(skills.map((skill) => [skill.id, skill]))
      const shortlist = Object.keys(choice.probabilities)
        .filter((id) => byId.has(id))
        .sort((a, b) => (choice.probabilities[b] ?? 0) - (choice.probabilities[a] ?? 0))
        .slice(0, Math.max(1, config.shortlist))

      if (shortlist.length > 1) {
        const criteria = Object.fromEntries(
          shortlist.map((id) => {
            const skill = byId.get(id)!
            return [id, `${skill.name}${skill.description ? ` — ${skill.description}` : ""} — ${skill.content.slice(0, 700)}`]
          }),
        )
        const questions: Record<string, Question> = {
          which: { type: "choice", instructions: RERANK_INSTRUCTIONS, criteria },
        }
        for (const id of shortlist) {
          questions[`fits::${id}`] = {
            type: "noul",
            instructions: `Does the skill '${byId.get(id)!.name}' do the specific thing the user's request asks for?`,
          }
        }
        const second = await ask({ state, questions })
        const fits = shortlist.map((id) => asNoul(second[`fits::${id}`])?.noul ?? 0)
        if (Math.max(...fits) < config.fitsThreshold) return null
        const reranked = asChoice(second.which)
        if (reranked && shortlist.includes(reranked.choice) && (reranked.confidence ?? 1) >= config.minConfidence) {
          winner = reranked.choice
        }
      }
    }

    return { id: winner }
  } catch {
    return null
  }
}

export function applySkillDecision(prompt: { skills?: Array<{ id: string }> }, decision: { id: string } | null): boolean {
  if (!decision) return false
  prompt.skills ??= []
  if (prompt.skills.some((skill) => skill.id === decision.id)) return false
  prompt.skills.push({ id: decision.id })
  return true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/decisions.test.ts`

Expected: 9 pass, 0 fail.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/skills.ts src/decisions.test.ts
git commit -m "feat: add Jev skill selection"
```

---

### Task 3: Tool routing

**Files:**
- Create: `src/tools.ts`
- Modify: `src/decisions.test.ts` (append tests)

**Interfaces:**
- Consumes: `Ask`, `asChoice`, `asNoul` from Task 1.
- Produces:
  - `interface ToolRoutingConfig { maxTools: number; minToolProbability: number; needsToolThreshold: number; minConfidence: number; alwaysVisible: string[]; stateBudget: number }`
  - `defaultToolRouting: ToolRoutingConfig`
  - `interface ToolDecision { tools: string[]; start?: string; needsTool: boolean; filtered: boolean; hint: string }`
  - `renderState(input: { agent: string; messages: readonly MessageLike[]; budget?: number }): string`
  - `routeTools(ask: Ask, input: { state: string; catalog: Record<string, { description: string }>; config?: Partial<ToolRoutingConfig> }): Promise<ToolDecision | null>`
  - `applyToolDecision(tools: Record<string, unknown>, system: Array<{ type: string; text: string }>, decision: ToolDecision): void`

- [ ] **Step 1: Append the failing tests**

Append to `src/decisions.test.ts`:

```ts
import { applyToolDecision, renderState, routeTools } from "./tools"

const toolCatalog = {
  read: { description: "Read a file" },
  grep: { description: "Search file contents" },
  edit: { description: "Edit a file" },
  browser_scrape: { description: "Load a web page" },
  browser_click: { description: "Click a page element" },
}

test("routeTools keeps the chosen tool and the alwaysVisible floor", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "grep", probabilities: { grep: 0.7, edit: 0.2, browser_scrape: 0.05, browser_click: 0.05 }, confidence: 0.9 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  const decision = await routeTools(ask, {
    state: "find X",
    catalog: toolCatalog,
    config: { maxTools: 1, alwaysVisible: ["read"] },
  })
  expect(decision?.tools).toEqual(["grep", "read"])
  expect(decision?.start).toBe("grep")
  expect(decision?.filtered).toBe(true)

  const tools: Record<string, unknown> = { ...toolCatalog }
  const system: Array<{ type: string; text: string }> = []
  applyToolDecision(tools, system, decision!)
  expect(Object.keys(tools).sort()).toEqual(["grep", "read"])
  expect(system[0].text).toContain("Start with: grep")
})

test("routeTools leaves the catalog alone when no tool is needed", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.05 },
  })
  const decision = await routeTools(ask, { state: "hi", catalog: toolCatalog })
  expect(decision?.filtered).toBe(false)
  expect(decision?.tools.length).toBe(Object.keys(toolCatalog).length)
  expect(decision?.hint).toContain("answer directly")
})

test("routeTools bails out on low confidence", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 0.4, edit: 0.3 }, confidence: 0.1 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  expect(await routeTools(ask, { state: "hi", catalog: toolCatalog })).toBeNull()
})

test("routeTools fails open when no ranked tool is in the catalog", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "ghost", probabilities: { ghost: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  expect(await routeTools(ask, { state: "hi", catalog: toolCatalog, config: { alwaysVisible: [] } })).toBeNull()
})

test("routeTools fails open on transport errors", async () => {
  const { ask } = stubAsk(new Error("timeout"))
  expect(await routeTools(ask, { state: "hi", catalog: toolCatalog })).toBeNull()
})

test("renderState keeps the tail within budget", () => {
  const rendered = renderState({
    agent: "build",
    messages: [
      { role: "user", content: [{ type: "text", text: "x".repeat(1000) }] },
      { role: "assistant", content: [{ type: "text", text: "latest instruction" }] },
    ],
    budget: 50,
  })
  expect(rendered.length).toBeLessThanOrEqual(50)
  expect(rendered).toContain("latest instruction")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/decisions.test.ts`

Expected: FAIL — `Cannot find module './tools'`.

- [ ] **Step 3: Implement tool routing**

Create `src/tools.ts`:

```ts
import { type Ask, asChoice, asNoul } from "./jev"

export interface ToolRoutingConfig {
  maxTools: number
  minToolProbability: number
  needsToolThreshold: number
  minConfidence: number
  alwaysVisible: string[]
  stateBudget: number
}

export const defaultToolRouting: ToolRoutingConfig = {
  maxTools: 12,
  minToolProbability: 0.05,
  needsToolThreshold: 0.3,
  minConfidence: 0.3,
  alwaysVisible: ["read", "write", "edit", "bash", "grep", "glob"],
  stateBudget: 6000,
}

export interface ToolDecision {
  tools: string[]
  start?: string
  needsTool: boolean
  filtered: boolean
  hint: string
}

export type MessageLike = { role: string; content?: readonly unknown[] }

const ROUTE_INSTRUCTIONS = "Which single tool is the best next step for the agent to make progress?"
const NEEDS_TOOL = "Does making progress on the last step require calling a tool?"
export const NO_TOOL_HINT = "<system_one_routing>\nNo tool is needed for this step; answer directly.\n</system_one_routing>"

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function renderState(input: { agent: string; messages: readonly MessageLike[]; budget?: number }): string {
  const budget = input.budget ?? defaultToolRouting.stateBudget
  const lines: string[] = [`agent: ${input.agent}`]
  for (const message of input.messages) {
    const parts: string[] = []
    for (const part of message.content ?? []) {
      const candidate = part as { type?: string; text?: string; name?: string; result?: unknown }
      if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text)
      else if (candidate.type === "tool-result") parts.push(`[tool ${candidate.name ?? "?"}] ${stringify(candidate.result)}`)
      else if (candidate.type === "tool-call") parts.push(`[called ${candidate.name ?? "?"}]`)
    }
    if (parts.length > 0) lines.push(`${message.role}: ${parts.join("\n")}`)
  }
  const text = lines.join("\n")
  return text.length > budget ? text.slice(text.length - budget) : text
}

export async function routeTools(
  ask: Ask,
  input: { state: string; catalog: Record<string, { description: string }>; config?: Partial<ToolRoutingConfig> },
): Promise<ToolDecision | null> {
  const config = { ...defaultToolRouting, ...input.config }
  const names = Object.keys(input.catalog)
  if (names.length === 0) return null

  try {
    const criteria = Object.fromEntries(
      names.map((name) => [name, (input.catalog[name]?.description ?? "").slice(0, 300) || name]),
    )
    const answers = await ask({
      state: input.state,
      questions: {
        next: { type: "choice", instructions: ROUTE_INSTRUCTIONS, criteria },
        needs_tool: { type: "noul", instructions: NEEDS_TOOL },
      },
    })

    const next = asChoice(answers.next)
    const needs = asNoul(answers.needs_tool)
    if (!next || !needs) return null
    if ((next.confidence ?? 1) < config.minConfidence) return null

    if (needs.noul < config.needsToolThreshold) {
      return { tools: names, needsTool: false, filtered: false, hint: NO_TOOL_HINT }
    }

    const ranked = Object.entries(next.probabilities)
      .filter(([name, probability]) => name in input.catalog && probability >= config.minToolProbability)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)

    const chosen: string[] = []
    for (const name of [...ranked.slice(0, Math.max(1, config.maxTools)), ...config.alwaysVisible]) {
      if (name in input.catalog && !chosen.includes(name)) chosen.push(name)
    }
    if (chosen.length === 0) return null

    const filtered = chosen.length < names.length
    const start = ranked[0]
    const lines = ["<system_one_routing>"]
    if (start) lines.push(`Start with: ${start}.`)
    lines.push(`Available now: ${chosen.join(", ")}.`)
    if (filtered) lines.push("The tool list is already narrowed for this step; do not deliberate about tool choice, act.")
    lines.push("If none of these fit, say what you need in your reply instead of guessing.")
    lines.push("</system_one_routing>")

    return { tools: chosen, start, needsTool: true, filtered, hint: lines.join("\n") }
  } catch {
    return null
  }
}

export function applyToolDecision(
  tools: Record<string, unknown>,
  system: Array<{ type: string; text: string }>,
  decision: ToolDecision,
): void {
  if (decision.filtered) {
    const keep = new Set(decision.tools)
    for (const name of Object.keys(tools)) {
      if (!keep.has(name)) delete tools[name]
    }
  }
  system.push({ type: "text", text: decision.hint })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/decisions.test.ts`

Expected: 15 pass, 0 fail.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/tools.ts src/decisions.test.ts
git commit -m "feat: add Jev tool routing"
```

---

### Task 4: Plugin wiring

**Files:**
- Modify: `index.ts`, `src/decisions.test.ts` (append tests)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `readOptions(raw: Record<string, unknown>): ResolvedOptions`
  - `createCache<T>(options?: { max?: number; ttlMs?: number; now?: () => number }): { get(key: string): T | undefined; set(key: string, value: T): void }`
  - `hashKey(text: string): string`
  - default export: `{ id: "system-one", setup }`

- [ ] **Step 1: Append the failing wiring tests**

Append to `src/decisions.test.ts`:

```ts
import { createCache, hashKey, readOptions } from "../index"

test("cache returns values, expires entries, and evicts the oldest", () => {
  let now = 0
  const cache = createCache<number>({ max: 2, ttlMs: 100, now: () => now })
  cache.set("a", 1)
  expect(cache.get("a")).toBe(1)
  now = 101
  expect(cache.get("a")).toBeUndefined()
  cache.set("b", 2)
  cache.set("c", 3)
  cache.set("d", 4)
  expect(cache.get("b")).toBeUndefined()
  expect(cache.get("d")).toBe(4)
})

test("hashKey is stable and distinct", () => {
  expect(hashKey("abc")).toBe(hashKey("abc"))
  expect(hashKey("abc")).not.toBe(hashKey("abd"))
})

test("readOptions applies defaults and accepts overrides", () => {
  const defaults = readOptions({})
  expect(defaults.model).toBe("jev-latest")
  expect(defaults.timeoutMs).toBe(1000)
  expect(defaults.tools.alwaysVisible).toContain("read")
  expect(defaults.skills.rerank).toBe("auto")

  const custom = readOptions({
    model: "jev-1.13.0",
    timeoutMs: 500,
    agents: ["build"],
    tools: { maxTools: 3 },
    skills: { rerank: false },
  })
  expect(custom.model).toBe("jev-1.13.0")
  expect(custom.timeoutMs).toBe(500)
  expect(custom.agents).toEqual(["build"])
  expect(custom.tools.maxTools).toBe(3)
  expect(custom.tools.alwaysVisible).toContain("read")
  expect(custom.skills.rerank).toBe(false)
})

test("setup is inert without an API key", async () => {
  const saved = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  try {
    const plugin = (await import("../index")).default
    let hooked = false
    const context = {
      options: {},
      session: {
        hook: () => {
          hooked = true
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    }
    const cleanup = await plugin.setup(context as never)
    expect(hooked).toBe(false)
    expect(cleanup).toBeUndefined()
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved
  }
})

test("setup registers the prompt and context hooks", async () => {
  const plugin = (await import("../index")).default
  const names: string[] = []
  const context = {
    options: { apiKey: "test" },
    session: {
      hook: (name: string) => {
        names.push(name)
        return Promise.resolve({ dispose: async () => {} })
      },
    },
  }
  const cleanup = await plugin.setup(context as never)
  expect(names).toEqual(["prompt", "context"])
  await cleanup?.()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/decisions.test.ts`

Expected: FAIL — `createCache` is not exported from `../index`.

- [ ] **Step 3: Implement the wiring**

Replace `index.ts` with:

```ts
import { Plugin } from "@opencode/plugin"
import { createJev } from "./src/jev"
import { applySkillDecision, defaultSkillRouting, selectSkill, type SkillRoutingConfig } from "./src/skills"
import {
  applyToolDecision,
  defaultToolRouting,
  renderState,
  routeTools,
  type ToolDecision,
  type ToolRoutingConfig,
} from "./src/tools"

export interface ResolvedSkills extends SkillRoutingConfig {
  enabled: boolean
}

export interface ResolvedTools extends ToolRoutingConfig {
  enabled: boolean
}

export interface ResolvedOptions {
  apiKey?: string
  model: string
  timeoutMs: number
  debug: boolean
  agents?: string[]
  skills: ResolvedSkills
  tools: ResolvedTools
}

export function readOptions(raw: Record<string, unknown>): ResolvedOptions {
  const tools = (raw.tools ?? {}) as Record<string, unknown>
  const skills = (raw.skills ?? {}) as Record<string, unknown>
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)
  const strings = (value: unknown, fallback: string[]) =>
    Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : fallback
  const agents = strings(raw.agents, [])

  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    model: typeof raw.model === "string" ? raw.model : "jev-latest",
    timeoutMs: number(raw.timeoutMs, 1000),
    debug: bool(raw.debug, false),
    agents: agents.length > 0 ? agents : undefined,
    skills: {
      enabled: bool(skills.enabled, true),
      gateThreshold: number(skills.gateThreshold, defaultSkillRouting.gateThreshold),
      rerank:
        skills.rerank === true || skills.rerank === false ? (skills.rerank as boolean) : defaultSkillRouting.rerank,
      rerankAbove: number(skills.rerankAbove, defaultSkillRouting.rerankAbove),
      rerankBelowP: number(skills.rerankBelowP, defaultSkillRouting.rerankBelowP),
      shortlist: number(skills.shortlist, defaultSkillRouting.shortlist),
      fitsThreshold: number(skills.fitsThreshold, defaultSkillRouting.fitsThreshold),
      minConfidence: number(skills.minConfidence, defaultSkillRouting.minConfidence),
    },
    tools: {
      enabled: bool(tools.enabled, true),
      maxTools: number(tools.maxTools, defaultToolRouting.maxTools),
      minToolProbability: number(tools.minToolProbability, defaultToolRouting.minToolProbability),
      needsToolThreshold: number(tools.needsToolThreshold, defaultToolRouting.needsToolThreshold),
      minConfidence: number(tools.minConfidence, defaultToolRouting.minConfidence),
      alwaysVisible: strings(tools.alwaysVisible, defaultToolRouting.alwaysVisible),
      stateBudget: number(tools.stateBudget, defaultToolRouting.stateBudget),
    },
  }
}

export function createCache<T>(options: { max?: number; ttlMs?: number; now?: () => number } = {}) {
  const max = options.max ?? 200
  const ttlMs = options.ttlMs ?? 600_000
  const now = options.now ?? Date.now
  const entries = new Map<string, { value: T; expires: number }>()

  return {
    get(key: string): T | undefined {
      const hit = entries.get(key)
      if (!hit) return undefined
      if (hit.expires <= now()) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, hit)
      return hit.value
    },
    set(key: string, value: T): void {
      entries.delete(key)
      entries.set(key, { value, expires: now() + ttlMs })
      while (entries.size > max) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}

export function hashKey(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

export default Plugin.define({
  id: "system-one",
  async setup(ctx) {
    const options = readOptions((ctx.options ?? {}) as Record<string, unknown>)
    const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY
    if (!apiKey) {
      console.warn("[system-one] disabled: set options.apiKey or TYPESAFE_API_KEY")
      return
    }

    const ask = createJev({ apiKey, model: options.model, timeoutMs: options.timeoutMs })
    const skillCache = createCache<{ id: string } | null>()
    const toolCache = createCache<ToolDecision | null>()
    const log = (...args: unknown[]) => {
      if (options.debug) console.log("[system-one]", ...args)
    }
    const agentEnabled = (agent: string) => !options.agents || options.agents.includes(agent)

    const registrations = [
      await ctx.session.hook("prompt", async (event) => {
        if (!options.skills.enabled) return
        try {
          const skills = (await ctx.skill.list()).data
          const key = `skills:${event.sessionID}:${hashKey(event.prompt.text)}`
          let decision = skillCache.get(key)
          if (decision === undefined) {
            decision = await selectSkill(ask, { request: event.prompt.text, skills, config: options.skills })
            skillCache.set(key, decision)
            log("skill decision", decision)
          }
          applySkillDecision(event.prompt as unknown as { skills?: Array<{ id: string }> }, decision)
        } catch (error) {
          log("skill routing failed", error)
        }
      }),
      await ctx.session.hook("context", async (event) => {
        if (!options.tools.enabled || !agentEnabled(event.agent)) return
        try {
          const state = renderState({ agent: event.agent, messages: event.messages, budget: options.tools.stateBudget })
          const catalog = Object.fromEntries(
            Object.entries(event.tools).map(([name, tool]) => [name, { description: tool.description }]),
          )
          const key = `tools:${event.sessionID}:${hashKey(`${event.agent}|${state}|${Object.keys(catalog).join(",")}`)}`
          let decision = toolCache.get(key)
          if (decision === undefined) {
            decision = await routeTools(ask, { state, catalog, config: options.tools })
            toolCache.set(key, decision)
            log("tool decision", decision && { start: decision.start, tools: decision.tools, needsTool: decision.needsTool })
          }
          if (decision) applyToolDecision(event.tools, event.system, decision)
        } catch (error) {
          log("tool routing failed", error)
        }
      }),
    ]

    return async () => {
      for (const registration of registrations) await registration.dispose()
    }
  },
})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/decisions.test.ts`

Expected: 20 pass, 0 fail.

- [ ] **Step 5: Typecheck and full test run**

```bash
bun run typecheck
bun test
```

Expected: both pass. If `tsc` complains about `event.prompt` or `event.tools` assignability, cast at that boundary only (`as unknown as`) — do not loosen types elsewhere.

- [ ] **Step 6: Commit**

```bash
git add index.ts src/decisions.test.ts
git commit -m "feat: wire system-one hooks and decision cache"
```

---

### Task 5: Live verification (requires a working key)

**Files:**
- Create: `opencode.json` (temporary, for this repo only; do not commit it)

**Interfaces:**
- Consumes: the whole plugin.
- Produces: evidence that routing works, or a clear statement of what blocked it.

- [ ] **Step 1: Confirm the transport**

Native: `TYPESAFE_API_KEY` set (from https://console.typesafe.ai/settings/keys).
OpenRouter (only if the slug works — verify first):

```bash
curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"~typesafe/jev-latest","messages":[{"role":"user","content":"say hi"}],"max_tokens":5}'
```

If it completes, `src/jev.ts` needs a second transport (OpenAI-compatible chat with JSON-schema output) — that is a new task, not a tweak. If neither works, stop here and report.

- [ ] **Step 2: Load the plugin with debug on**

Create `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": ".", "options": { "debug": true } }]
}
```

- [ ] **Step 3: Run one small session and observe**

Start OpenCode in this directory and ask for a change that touches tools (e.g. "find where the plugin id is defined and rename nothing — just read it"). Expected in the server logs:

- `[system-one] skill decision …` (or none when the gate is closed)
- `[system-one] tool decision { start, tools, needsTool }`
- the model request has fewer tools than the full catalog on routing turns

- [ ] **Step 4: Check the failure path**

Unset the key or set `timeoutMs: 1` and confirm the session behaves normally with a `[system-one]` warning — no stalled model calls, no errors.

- [ ] **Step 5: Record results**

Write findings (latency observed, tool counts, any wrong routing) into the spec's risks section or as a comment on the plan. Do not commit `opencode.json`.

---

### Task 6: OpenRouter transport via `@openrouter/sdk`

**Files:**
- Modify: `package.json`, `bun.lock`, `src/jev.ts`, `index.ts`, `src/decisions.test.ts`

**Interfaces:**
- Consumes: `Ask`, `Question`, `Answers`, `JevError`, `asChoice`, `asNoul` (keep the whole surface stable — nothing outside `src/jev.ts` changes its shape).
- Produces:
  - `createJev(options: { apiKey: string; model?: string; serverURL?: string; timeoutMs?: number }): Ask`
  - `readOptions` gains `serverURL?: string` and **drops** `fetch`; `ResolvedOptions.serverURL?: string`.
  - `setup` env fallback becomes `OPENROUTER_API_KEY` (drops `TYPESAFE_API_KEY`).

**SDK facts (verified against `@openrouter/sdk@1.3.0`; use verbatim):**
- `import { OpenRouter } from "@openrouter/sdk"`; `const client = new OpenRouter({ apiKey })`.
- `await client.alpha.decisions.create({ decisionsRequest: { model, state, questions } }, { timeoutMs, retries: { strategy: "none" }, ...(serverURL ? { serverURL } : {}) })`.
- The operation appends `/api/alpha/decisions` to the **per-request** `serverURL` (default `https://openrouter.ai`). Client-level `serverURL` is not reliably applied to this operation — always pass it per request.
- Response: `{ answers, model, usage: { inputTokens, outputTokens, cost? } }`.
- The SDK's default retry policy retries 5xx with backoff for up to 1 hour. `retries: { strategy: "none" }` is mandatory inside the hook path.
- SDK errors: wrap every throw as `JevError`, reading `(error as { statusCode?: number }).statusCode` when present.
- Default model: `~typesafe/jev-latest`.

- [ ] **Step 1: Add the dependency**

```bash
bun add @openrouter/sdk
```

- [ ] **Step 2: Rewrite the transport tests with a local mock server**

In `src/decisions.test.ts`, replace the three `createJev` tests (the ones injecting `fakeFetch`) with a `Bun.serve` mock and four tests. Add this helper near the top of the file (module scope):

```ts
type Canned = { status?: number; body: unknown; delayMs?: number }

function mockJevServer(handler: (request: Request) => Canned | Promise<Canned>) {
  const requests: Array<{ url: string; body: unknown; authorization: string | null }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined)
      requests.push({ url: request.url, body, authorization: request.headers.get("authorization") })
      const canned = await handler(request)
      if (canned.delayMs) await new Promise((resolve) => setTimeout(resolve, canned.delayMs))
      return new Response(JSON.stringify(canned.body), {
        status: canned.status ?? 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return { server, requests, serverURL: `http://localhost:${server.port}` }
}
```

Tests (teardown with `server.stop(true)` in `finally`):

```ts
test("createJev posts to the OpenRouter decisions endpoint", async () => {
  const mock = mockJevServer(() => ({
    body: {
      answers: { which: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 } },
      model: "~typesafe/jev-latest",
      usage: { inputTokens: 10, outputTokens: 4 },
    },
  }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL })
    const answers = await ask({
      state: { request: "hi" },
      questions: { which: { type: "choice", instructions: "pick", criteria: { read: "read a file" } } },
    })
    expect(asChoice(answers.which)?.choice).toBe("read")
    expect(mock.requests.length).toBe(1)
    expect(new URL(mock.requests[0].url).pathname).toBe("/api/alpha/decisions")
    expect(mock.requests[0].authorization).toBe("Bearer k")
    expect(mock.requests[0].body).toEqual({
      model: "~typesafe/jev-latest",
      state: { request: "hi" },
      questions: { which: { type: "choice", instructions: "pick", criteria: { read: "read a file" } } },
    })
  } finally {
    mock.server.stop(true)
  }
})

test("createJev throws JevError on non-2xx", async () => {
  const mock = mockJevServer(() => ({ status: 429, body: { error: { message: "slow down" } } }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL })
    await expect(ask({ state: {}, questions: {} })).rejects.toThrow(JevError)
  } finally {
    mock.server.stop(true)
  }
})

test("createJev throws JevError on a response without answers", async () => {
  const mock = mockJevServer(() => ({ body: { model: "x", usage: {} } }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL })
    await expect(ask({ state: {}, questions: {} })).rejects.toThrow(JevError)
  } finally {
    mock.server.stop(true)
  }
})

test("createJev honours timeoutMs", async () => {
  const mock = mockJevServer(() => ({ body: { answers: {} }, delayMs: 200 }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL, timeoutMs: 50 })
    await expect(ask({ state: {}, questions: {} })).rejects.toThrow()
  } finally {
    mock.server.stop(true)
  }
})
```

- [ ] **Step 3: Rewrite `src/jev.ts`**

```ts
import { OpenRouter } from "@openrouter/sdk"

export interface QuestionChoice {
  type: "choice"
  instructions: string
  criteria: Record<string, string>
}

export interface QuestionNoul {
  type: "noul"
  instructions: string
}

export type Question = QuestionChoice | QuestionNoul

export type Answers = Record<string, unknown>

export type Ask = (input: { state: unknown; questions: Record<string, Question> }) => Promise<Answers>

export interface JevOptions {
  apiKey: string
  model?: string
  serverURL?: string
  timeoutMs?: number
}

export class JevError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "JevError"
    this.status = status
  }
}

export function createJev(options: JevOptions): Ask {
  const model = options.model ?? "~typesafe/jev-latest"
  const client = new OpenRouter({ apiKey: options.apiKey })

  return async ({ state, questions }) => {
    let response: Awaited<ReturnType<typeof client.alpha.decisions.create>>
    try {
      response = await client.alpha.decisions.create(
        { decisionsRequest: { model, state, questions } },
        {
          timeoutMs: options.timeoutMs ?? 1000,
          retries: { strategy: "none" },
          ...(options.serverURL ? { serverURL: options.serverURL } : {}),
        },
      )
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      throw new JevError(
        `system-one request failed: ${error instanceof Error ? error.message : String(error)}`,
        typeof status === "number" ? status : undefined,
      )
    }
    const answers = response?.answers
    if (!answers || typeof answers !== "object") throw new JevError("system-one response missing answers")
    return answers as Answers
  }
}

export interface ChoiceAnswer {
  choice: string
  probabilities: Record<string, number>
  confidence?: number
}

export interface NoulAnswer {
  noul: number
}

export function asChoice(value: unknown): ChoiceAnswer | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown }
  if (candidate.type !== "choice" || typeof candidate.choice !== "string") return null
  const probabilities: Record<string, number> = {}
  if (candidate.probabilities && typeof candidate.probabilities === "object") {
    for (const [key, probability] of Object.entries(candidate.probabilities as Record<string, unknown>)) {
      if (typeof probability === "number" && Number.isFinite(probability)) probabilities[key] = probability
    }
  }
  return {
    choice: candidate.choice,
    probabilities,
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : undefined,
  }
}

export function asNoul(value: unknown): NoulAnswer | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { type?: unknown; noul?: unknown }
  if (candidate.type !== "noul" || typeof candidate.noul !== "number" || !Number.isFinite(candidate.noul)) return null
  return { noul: candidate.noul }
}
```

If TypeScript rejects passing our `Question` type to `decisionsRequest.questions` (the SDK's criteria accepts `string | object | array | null`, so `Record<string, string>` is assignable), cast that one property (`questions: questions as never`) rather than loosening the exported types.

- [ ] **Step 4: Update `index.ts`**

- In `ResolvedOptions`, replace `fetch?: typeof fetch` with `serverURL?: string`.
- In `readOptions`, replace the `fetch` parse with `serverURL: typeof raw.serverURL === "string" ? raw.serverURL : undefined`.
- In `setup`, change the key line to `const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY` and update both warning texts to mention `OPENROUTER_API_KEY`.
- Pass `serverURL: options.serverURL` into `createJev`.
- Leave the hooks, cache, `askFor`, `warnOnce`, and cleanup untouched.

- [ ] **Step 5: Adapt the two end-to-end hook tests**

The prompt-hook and context-hook tests currently pass `options.fetch: fakeFetch`. Replace that with a `mockJevServer` (Step 2 helper) whose handler returns the canned answers those tests already assert, and pass `options.serverURL: mock.serverURL`. Keep every existing assertion and add `server.stop(true)` teardown.

- [ ] **Step 6: Verify and commit**

```bash
bun test
bun run typecheck
```

Expected: all tests pass (was 25; the transport tests change count — report the actual number), typecheck clean. The tests must not touch the network (all mock servers are local).

```bash
git add package.json bun.lock src/jev.ts index.ts src/decisions.test.ts
git commit -m "feat: route Jev through the OpenRouter alpha decisions API"
```

---

### Task 7: Live probe script

**Files:**
- Create: `scripts/jev-probe.ts`

**Interfaces:**
- Consumes: `createJev` from `../src/jev`.
- Produces: a runnable live probe; not part of the published plugin (`package.json` `files` stays `["index.ts", "src"]`).

- [ ] **Step 1: Write the probe**

```ts
// Live Jev probe. Requires a working OpenRouter key.
//
//   OPENROUTER_API_KEY=... bun scripts/jev-probe.ts decisions
//   OPENROUTER_API_KEY=... bun scripts/jev-probe.ts catalog tools.json [task]
//
// `tools.json` maps tool names to { description }, e.g.
//   { "read": { "description": "Read a file" }, "grep": { "description": "Search files" } }
import { createJev } from "../src/jev"

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error("set OPENROUTER_API_KEY")
  process.exit(1)
}

const mode = process.argv[2] ?? "decisions"
const ask = createJev({ apiKey, timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? 5000) })
const started = performance.now()

if (mode === "decisions") {
  const answers = await ask({
    state: "Help! My payouts have been failing for 3 days.",
    questions: {
      is_urgent: { type: "noul", instructions: "Does this message convey urgency?" },
      department: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: {
          billing: "Payments, invoicing, refunds",
          technical: "Bugs, outages, integrations",
          sales: "Pricing, upgrades, new accounts",
        },
      },
    },
  })
  console.log(JSON.stringify(answers, null, 2))
} else if (mode === "catalog") {
  const path = process.argv[3]
  if (!path) {
    console.error("usage: jev-probe catalog <tools.json> [task]")
    process.exit(1)
  }
  const catalog = JSON.parse(await Bun.file(path).text()) as Record<string, { description?: string }>
  const names = Object.keys(catalog)
  const task = process.argv[4] ?? "make progress on the user's request"
  const answers = await ask({
    state: JSON.stringify({ task, tools: names }),
    questions: {
      next: {
        type: "choice",
        instructions: "Which single tool is the best next step?",
        criteria: Object.fromEntries(
          names.map((name) => [name, (catalog[name]?.description ?? "").slice(0, 300) || name]),
        ),
      },
      needs_tool: { type: "noul", instructions: "Does making progress require calling a tool?" },
    },
  })
  const next = (answers.next ?? {}) as { choice?: string; probabilities?: Record<string, number>; confidence?: number }
  const ranked = Object.entries(next.probabilities ?? {}).sort((a, b) => b[1] - a[1])
  const chars = (picked: string[]) =>
    picked.reduce((sum, name) => sum + name.length + (catalog[name]?.description ?? "").length, 0)
  console.log(
    JSON.stringify(
      {
        next: next.choice,
        confidence: next.confidence,
        needsTool: answers.needs_tool,
        ranked: ranked.slice(0, 8),
        estimatedTokens: { fullCatalog: Math.round(chars(names) / 4), top8: Math.round(chars(ranked.slice(0, 8).map(([name]) => name)) / 4) },
      },
      null,
      2,
    ),
  )
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(1)
}

console.log(`latency: ${Math.round(performance.now() - started)}ms`)
```

- [ ] **Step 2: Typecheck and commit**

```bash
bun run typecheck
git add scripts/jev-probe.ts
git commit -m "chore: add live Jev probe script"
```

---

## Plan Self-Review

- **Spec coverage:** transport (`src/jev.ts`) → Tasks 1/5; skill selection + native `prompt.skills` → Task 2 and Task 4 wiring; tool routing + floor + hint + fail-open → Tasks 3/4; cache → Task 4; options → Task 4; offline smoke → Task 4 tests; live verification → Task 5. The spec's "no recovery for hidden tools" escape hatch is the hint line, implemented in Task 3.
- **Placeholders:** none; every step has code or an exact command.
- **Type consistency:** `Ask`/`Question` defined once in `src/jev.ts` and imported; `SkillRoutingConfig`/`ToolRoutingConfig` defaults exported from `src/skills.ts`/`src/tools.ts` and reused by `readOptions`; `ToolDecision` used by `routeTools`, `applyToolDecision`, and the tool cache.
- **Known deviation from spec:** spec says `index.ts` owns the cache — it does. Tests import `index.ts`, which was verified safe under Bun (`bun -e 'import("./index.ts")'` works).
