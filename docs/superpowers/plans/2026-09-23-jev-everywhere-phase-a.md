# Jev Everywhere Phase A — Shared Decision Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the shipped skill/tool decision values into `spec/decisions.json`, load them through a new `src/policy.ts`, switch `src/skills.ts` and `src/tools.ts` to the loaded values, and add a fixture-driven conformance runner — with zero behavior change.

**Architecture:** `spec/decisions.json` becomes the single source for question ids, question text, criteria templates, thresholds, hint copy, and cache/spend policy. `src/policy.ts` reads it at module load and exports a typed `policy` plus a `{{placeholder}}` formatter. `src/skills.ts` / `src/tools.ts` keep their exported names and shapes, but every literal moves to the policy. `fixtures/conformance.jsonl` replays recorded Jev answer envelopes through `selectSkill`; `scripts/conformance.ts` is both the CLI and the test-callable runner, so the Python port in Phase B can be held to the same file.

**Tech Stack:** TypeScript (strict) on Bun, `bun:test`, `node:fs`, `node:path`. No new dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-09-23-jev-everywhere-design.md`

## Global Constraints

- **Behavior must match today exactly.** Every value in `spec/decisions.json` is copied verbatim from the current source (listed in Task 1); nothing is re-tuned, renamed, or reordered.
- **The contract is the only source.** After this phase, `src/skills.ts` and `src/tools.ts` must not contain thresholds, question text, question ids, or hint copy as literals.
- **No new dependencies, no build step, no `package.json` change.** The spec file is read at runtime with `import.meta.dir` (the pattern `scripts/eval.ts` already uses); a static JSON import is deliberately avoided so no `resolveJsonModule`/interop change to `tsconfig.json` is needed.
- **`readOptions` in `index.ts` is untouched** this phase. `defaultSkillRouting` and `defaultToolRouting` remain exported from their modules with identical values, because `index.ts` and the tests read them.
- **Tests live in `src/decisions.test.ts`** (repo convention: one test file). `bun test` and `bun run typecheck` are the test commands.
- **Do not stage or commit pre-existing WIP:** `README.md`, `index.ts`, `AGENTS.md`, `src/browser.ts`, `src/jev-runner.py`, and the browser-test region of `src/decisions.test.ts` (uncommitted). Never run `git add src/decisions.test.ts` wholesale — use `git add -p` (Task 5) or leave the file uncommitted and report it.
- **Do not push.** `main` has commits ahead of origin that are not the executor's to publish.
- **Commit identity:** `git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "..."`.
- **Phase gate:** `bun test` green, `bun run typecheck` clean, `bun scripts/conformance.ts` exits 0 with 9/9.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `spec/decisions.json` | Create | The contract: ids, question text, thresholds, hint copy, cache/spend policy |
| `src/policy.ts` | Create | Loads the contract; exports typed `policy` and `formatTemplate` |
| `src/skills.ts` | Modify | Skill decision reads ids/questions/thresholds from `policy` |
| `src/tools.ts` | Modify | Tool decision + hint assembly read from `policy` |
| `fixtures/conformance.jsonl` | Create | Golden cases: task, roster, recorded answers, expected decision |
| `scripts/conformance.ts` | Create | Replays fixtures through `selectSkill`; exportable `runConformance` + CLI |
| `src/decisions.test.ts` | Modify | Policy, wiring, hint-format, template, and conformance tests (WIP-safe staging) |

---

### Task 1: Contract file and policy loader

**Files:**
- Create: `spec/decisions.json`
- Create: `src/policy.ts`
- Test: `src/decisions.test.ts` (append at end)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `policy: Policy` where
    `Policy = { skills: SkillPolicy; tools: ToolPolicy; cache: CachePolicy; spend: SpendPolicy }`
    - `SkillPolicy`: `gateThreshold`, `rerank: boolean | "auto"`, `rerankAbove`, `rerankBelowP`, `shortlist`, `fitsThreshold`, `minConfidence`, `ids: { rank, rerank, gateActs, gateProcedure, gateProse, fits }`, `questions: { rank, rerank, gateActs, gateProcedure, gateProse, fits }`
    - `ToolPolicy`: `maxTools`, `minToolProbability`, `needsToolThreshold`, `minConfidence`, `alwaysVisible: string[]`, `stateBudget`, `ids: { next, needsTool }`, `questions: { next, needsTool }`, `hints: { open, close, noTool, start, available, narrowed, fallback }`
    - `CachePolicy`: `max`, `ttlMs`; `SpendPolicy`: `maxCallsPerSession`, `warnAt`
  - `formatTemplate(template: string, values: Record<string, string>): string` — replaces every `{{key}}` with `values[key]`; unknown keys are left verbatim.

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/decisions.test.ts`:

```ts
import { formatTemplate, policy } from "./policy"

test("policy carries the shipped defaults verbatim", () => {
  expect(policy.skills).toMatchObject({
    gateThreshold: 0.3,
    rerank: "auto",
    rerankAbove: 40,
    rerankBelowP: 0.5,
    shortlist: 3,
    fitsThreshold: 0.3,
    minConfidence: 0.3,
    ids: {
      rank: "which",
      rerank: "which",
      gateActs: "gate::acts",
      gateProcedure: "gate::procedure",
      gateProse: "gate::prose",
      fits: "fits::{{id}}",
    },
  })
  expect(policy.tools).toMatchObject({
    maxTools: 12,
    minToolProbability: 0.05,
    needsToolThreshold: 0.3,
    minConfidence: 0.3,
    alwaysVisible: ["read", "write", "edit", "bash", "grep", "glob"],
    stateBudget: 6000,
    ids: { next: "next", needsTool: "needs_tool" },
  })
  expect(policy.cache).toEqual({ max: 200, ttlMs: 600000 })
  expect(policy.spend).toEqual({ maxCallsPerSession: 500, warnAt: 0.8 })
})

test("formatTemplate substitutes named placeholders", () => {
  expect(formatTemplate("Skill '{{name}}' fits", { name: "pptx-author" })).toBe("Skill 'pptx-author' fits")
  expect(formatTemplate("fits::{{id}}", { id: "pptx-edit" })).toBe("fits::pptx-edit")
  expect(formatTemplate("no placeholders", {})).toBe("no placeholders")
  expect(formatTemplate("keep {{unknown}} as-is", {})).toBe("keep {{unknown}} as-is")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/decisions.test.ts`
Expected: FAIL — `Cannot find module './policy'`.

- [ ] **Step 3: Create `spec/decisions.json`**

Every value is copied verbatim from `src/skills.ts`, `src/tools.ts`, and `index.ts` (`createCache` defaults: `max ?? 200`, `ttlMs ?? 600_000`); the spend values come from the spec's resolved decision 5.

```json
{
  "skills": {
    "gateThreshold": 0.3,
    "rerank": "auto",
    "rerankAbove": 40,
    "rerankBelowP": 0.5,
    "shortlist": 3,
    "fitsThreshold": 0.3,
    "minConfidence": 0.3,
    "ids": {
      "rank": "which",
      "rerank": "which",
      "gateActs": "gate::acts",
      "gateProcedure": "gate::procedure",
      "gateProse": "gate::prose",
      "fits": "fits::{{id}}"
    },
    "questions": {
      "rank": "Which of these skills, if any, is the right one to load to help with the user's latest request?",
      "rerank": "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
      "gateActs": "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
      "gateProcedure": "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
      "gateProse": "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
      "fits": "Does the skill '{{name}}' do the specific thing the user's request asks for?"
    }
  },
  "tools": {
    "maxTools": 12,
    "minToolProbability": 0.05,
    "needsToolThreshold": 0.3,
    "minConfidence": 0.3,
    "alwaysVisible": ["read", "write", "edit", "bash", "grep", "glob"],
    "stateBudget": 6000,
    "ids": { "next": "next", "needsTool": "needs_tool" },
    "questions": {
      "next": "Which single tool is the best next step for the agent to make progress?",
      "needsTool": "Does making progress on the last step require calling a tool?"
    },
    "hints": {
      "open": "<system_one_routing>",
      "close": "</system_one_routing>",
      "noTool": "No tool is needed for this step; answer directly.",
      "start": "Start with: {{start}}.",
      "available": "Available now: {{tools}}.",
      "narrowed": "The tool list is already narrowed for this step; do not deliberate about tool choice, act.",
      "fallback": "If none of these fit, say what you need in your reply instead of guessing."
    }
  },
  "cache": { "max": 200, "ttlMs": 600000 },
  "spend": { "maxCallsPerSession": 500, "warnAt": 0.8 }
}
```

- [ ] **Step 4: Create `src/policy.ts`**

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface SkillPolicy {
  gateThreshold: number
  rerank: boolean | "auto"
  rerankAbove: number
  rerankBelowP: number
  shortlist: number
  fitsThreshold: number
  minConfidence: number
  ids: {
    rank: string
    rerank: string
    gateActs: string
    gateProcedure: string
    gateProse: string
    fits: string
  }
  questions: {
    rank: string
    rerank: string
    gateActs: string
    gateProcedure: string
    gateProse: string
    fits: string
  }
}

export interface ToolPolicy {
  maxTools: number
  minToolProbability: number
  needsToolThreshold: number
  minConfidence: number
  alwaysVisible: string[]
  stateBudget: number
  ids: {
    next: string
    needsTool: string
  }
  questions: {
    next: string
    needsTool: string
  }
  hints: {
    open: string
    close: string
    noTool: string
    start: string
    available: string
    narrowed: string
    fallback: string
  }
}

export interface CachePolicy {
  max: number
  ttlMs: number
}

export interface SpendPolicy {
  maxCallsPerSession: number
  warnAt: number
}

export interface Policy {
  skills: SkillPolicy
  tools: ToolPolicy
  cache: CachePolicy
  spend: SpendPolicy
}

// Read at module load, next to this file. The plugin is installed as a directory,
// so `spec/` travels with it; a missing contract is a broken install and should fail loudly.
const specPath = join(import.meta.dir, "..", "spec", "decisions.json")

export const policy: Policy = JSON.parse(readFileSync(specPath, "utf8"))

export function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/decisions.test.ts`
Expected: PASS, including the two new tests; no existing test changes.

- [ ] **Step 6: Smoke-check the loader and typecheck**

Run: `bun -e 'const { policy } = await import("./src/policy.ts"); console.log(policy.skills.gateThreshold, policy.tools.stateBudget, policy.spend.maxCallsPerSession)'`
Expected: `0.3 6000 500`

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add spec/decisions.json src/policy.ts
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add the shared decision contract and policy loader"
```

Test additions stay uncommitted until Task 5 (the test file carries pre-existing WIP).

**Done when:** the policy module loads the contract from disk, the two new tests pass, typecheck is clean, and no consumer has changed yet.

---

### Task 2: Switch `src/skills.ts` to the policy

**Files:**
- Modify: `src/skills.ts` (whole file, 124 lines)
- Test: `src/decisions.test.ts` (append at end)

**Interfaces:**
- Consumes: `policy.skills`, `formatTemplate` (Task 1).
- Produces: unchanged exports `SkillLike`, `SkillRoutingConfig`, `defaultSkillRouting`, `selectSkill(ask, input)`, `applySkillDecision(prompt, decision)` with identical values and behavior.

This is a behavior-preserving refactor: the new tests are characterization tests. They must pass **before** and **after** the change. A failure after the change means the refactor altered behavior — fix the refactor, not the test.

- [ ] **Step 1: Write the characterization tests**

Append to the end of `src/decisions.test.ts` (after the Task 1 tests). The file already imports `./observe` twice, so a separate import line from a module is the established pattern here — keeping all test changes in the appended region makes the WIP-safe staging in Task 5 clean:

```ts
import { defaultSkillRouting } from "./skills"

test("skill routing defaults are the policy values", () => {
  expect(defaultSkillRouting).toEqual({
    gateThreshold: 0.3,
    rerank: "auto",
    rerankAbove: 40,
    rerankBelowP: 0.5,
    shortlist: 3,
    fitsThreshold: 0.3,
    minConfidence: 0.3,
  })
})

test("skill questions use the policy ids and text", async () => {
  const { ask, calls } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9, "pptx-edit": 0.1 }, confidence: 0.9 },
    ...openGate,
  })
  await selectSkill(ask, { request: "build me a deck", skills: skillRoster, config: { rerank: false } })
  const questions = (calls[0] as { questions: Record<string, { instructions: string }> }).questions
  expect(questions[policy.skills.ids.rank].instructions).toBe(policy.skills.questions.rank)
  expect(questions[policy.skills.ids.gateActs].instructions).toBe(policy.skills.questions.gateActs)
  expect(questions[policy.skills.ids.gateProcedure].instructions).toBe(policy.skills.questions.gateProcedure)
  expect(questions[policy.skills.ids.gateProse].instructions).toBe(policy.skills.questions.gateProse)
})

test("rerank fits questions use the policy template", async () => {
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
  await selectSkill(ask, { request: "edit my deck", skills: skillRoster, config: { rerank: "auto", rerankAbove: 1 } })
  const second = calls[1] as { questions: Record<string, { instructions: string }> }
  expect(second.questions[formatTemplate(policy.skills.ids.fits, { id: "pptx-edit" })].instructions).toBe(
    formatTemplate(policy.skills.questions.fits, { name: "pptx-edit" }),
  )
})
```

- [ ] **Step 2: Run the tests — they must pass against the current code**

Run: `bun test src/decisions.test.ts`
Expected: PASS. `defaultSkillRouting` already holds these values; the literal question text matches the policy. This locks the behavior before the refactor.

- [ ] **Step 3: Rewrite `src/skills.ts`**

Replace the whole file with:

```ts
import { formatTemplate, policy } from "./policy"
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
  gateThreshold: policy.skills.gateThreshold,
  rerank: policy.skills.rerank,
  rerankAbove: policy.skills.rerankAbove,
  rerankBelowP: policy.skills.rerankBelowP,
  shortlist: policy.skills.shortlist,
  fitsThreshold: policy.skills.fitsThreshold,
  minConfidence: policy.skills.minConfidence,
}

export async function selectSkill(
  ask: Ask,
  input: { request: string; skills: readonly SkillLike[]; config?: Partial<SkillRoutingConfig> },
): Promise<{ id: string } | null> {
  const config = { ...defaultSkillRouting, ...input.config }
  const skills = input.skills.filter((skill) => skill.id)
  if (skills.length === 0 || input.request.trim() === "") return null

  const ids = policy.skills.ids
  const questions = policy.skills.questions

  try {
    const state = { request: input.request }
    const roster = Object.fromEntries(
      skills.map((skill) => [skill.id, `${skill.name}${skill.description ? ` — ${skill.description}` : ""}`]),
    )
    const first = await ask({
      state,
      questions: {
        [ids.rank]: { type: "choice", instructions: questions.rank, criteria: roster },
        [ids.gateActs]: { type: "noul", instructions: questions.gateActs },
        [ids.gateProcedure]: { type: "noul", instructions: questions.gateProcedure },
        [ids.gateProse]: { type: "noul", instructions: questions.gateProse },
      },
    })

    const acts = asNoul(first[ids.gateActs])
    const procedure = asNoul(first[ids.gateProcedure])
    const prose = asNoul(first[ids.gateProse])
    if (!acts || !procedure || !prose) return null
    const gate = (acts.noul + procedure.noul + (1 - prose.noul)) / 3
    if (gate < config.gateThreshold) return null

    const choice = asChoice(first[ids.rank])
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
        const rerankQuestions: Record<string, Question> = {
          [ids.rerank]: { type: "choice", instructions: questions.rerank, criteria },
        }
        for (const id of shortlist) {
          rerankQuestions[formatTemplate(ids.fits, { id })] = {
            type: "noul",
            instructions: formatTemplate(questions.fits, { name: byId.get(id)!.name }),
          }
        }
        const second = await ask({ state, questions: rerankQuestions })
        const fits = shortlist.map((id) => asNoul(second[formatTemplate(ids.fits, { id })])?.noul ?? 0)
        if (Math.max(...fits) < config.fitsThreshold) return null
        const reranked = asChoice(second[ids.rerank])
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

Behavior notes the executor must preserve:
- `ids.rank === ids.rerank === "which"`, so the second request overwrites nothing; the first request's gate answers are read by exact id.
- The gate null-check order is unchanged: all three nouls must parse before the gate math.
- `Math.max(...fits)` on an empty fits array would be `-Infinity`; it cannot happen because `shortlist.length > 1` is required, but keep the `if (shortlist.length > 1)` guard.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/decisions.test.ts`
Expected: PASS, all pre-existing skill tests unchanged plus the three new ones.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "refactor: read skill decision values from the shared contract"
```

**Done when:** all skill tests (old and new) pass, typecheck is clean, and `src/skills.ts` contains no threshold, question-text, or question-id literals.

---

### Task 3: Switch `src/tools.ts` to the policy

**Files:**
- Modify: `src/tools.ts` (whole file, 128 lines)
- Test: `src/decisions.test.ts` (append at end)

**Interfaces:**
- Consumes: `policy.tools`, `formatTemplate` (Task 1).
- Produces: unchanged exports `ToolRoutingConfig`, `defaultToolRouting`, `ToolDecision`, `MessageLike`, `NO_TOOL_HINT`, `renderState`, `routeTools`, `applyToolDecision` with identical values and behavior.

Same refactor rule as Task 2: the new tests are characterization tests, green before and after.

- [ ] **Step 1: Write the characterization tests**

Append to the end of `src/decisions.test.ts`:

```ts
import { defaultToolRouting } from "./tools"

test("tool routing defaults are the policy values", () => {
  expect(defaultToolRouting).toEqual({
    maxTools: 12,
    minToolProbability: 0.05,
    needsToolThreshold: 0.3,
    minConfidence: 0.3,
    alwaysVisible: ["read", "write", "edit", "bash", "grep", "glob"],
    stateBudget: 6000,
  })
})

test("tool questions use the policy ids and text", async () => {
  const { ask, calls } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  await routeTools(ask, { state: "hi", catalog: { read: { description: "Read" } }, config: { alwaysVisible: [] } })
  const questions = (calls[0] as { questions: Record<string, { instructions: string }> }).questions
  expect(questions[policy.tools.ids.next].instructions).toBe(policy.tools.questions.next)
  expect(questions[policy.tools.ids.needsTool].instructions).toBe(policy.tools.questions.needsTool)
})

test("routing hint strings come from the policy", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "grep", probabilities: { grep: 0.7, edit: 0.2 }, confidence: 0.9 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  const decision = await routeTools(ask, {
    state: "hi",
    catalog: { read: { description: "Read" }, grep: { description: "Search" }, edit: { description: "Edit" } },
    config: { maxTools: 1, alwaysVisible: ["read"] },
  })
  expect(decision?.hint).toBe(
    [
      policy.tools.hints.open,
      formatTemplate(policy.tools.hints.start, { start: "grep" }),
      formatTemplate(policy.tools.hints.available, { tools: "grep, read" }),
      policy.tools.hints.narrowed,
      policy.tools.hints.fallback,
      policy.tools.hints.close,
    ].join("\n"),
  )
})

test("no-tool hint comes from the policy", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.05 },
  })
  const decision = await routeTools(ask, { state: "hi", catalog: { read: { description: "Read" } } })
  expect(decision?.hint).toBe(
    [policy.tools.hints.open, policy.tools.hints.noTool, policy.tools.hints.close].join("\n"),
  )
})
```

- [ ] **Step 2: Run the tests — they must pass against the current code**

Run: `bun test src/decisions.test.ts`
Expected: PASS.

- [ ] **Step 3: Rewrite `src/tools.ts`**

Replace the whole file with:

```ts
import { formatTemplate, policy } from "./policy"
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
  maxTools: policy.tools.maxTools,
  minToolProbability: policy.tools.minToolProbability,
  needsToolThreshold: policy.tools.needsToolThreshold,
  minConfidence: policy.tools.minConfidence,
  alwaysVisible: [...policy.tools.alwaysVisible],
  stateBudget: policy.tools.stateBudget,
}

export interface ToolDecision {
  tools: string[]
  start?: string
  needsTool: boolean
  filtered: boolean
  hint: string
}

export type MessageLike = { role: string; content?: readonly unknown[] }

const HINTS = policy.tools.hints
const IDS = policy.tools.ids

export const NO_TOOL_HINT = [HINTS.open, HINTS.noTool, HINTS.close].join("\n")

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
        [IDS.next]: { type: "choice", instructions: policy.tools.questions.next, criteria },
        [IDS.needsTool]: { type: "noul", instructions: policy.tools.questions.needsTool },
      },
    })

    const next = asChoice(answers[IDS.next])
    const needs = asNoul(answers[IDS.needsTool])
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
    const lines = [HINTS.open]
    if (start) lines.push(formatTemplate(HINTS.start, { start }))
    lines.push(formatTemplate(HINTS.available, { tools: chosen.join(", ") }))
    if (filtered) lines.push(HINTS.narrowed)
    lines.push(HINTS.fallback)
    lines.push(HINTS.close)

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

Behavior notes the executor must preserve:
- `alwaysVisible` is copied (spread) so consumers cannot mutate the contract's array.
- The hint's line order and conditionals (`start` only when ranked is non-empty, `narrowed` only when filtered) are unchanged.
- `NO_TOOL_HINT` is the same three-line string as before.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/decisions.test.ts`
Expected: PASS, all pre-existing tool tests plus the four new ones.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "refactor: read tool decision values from the shared contract"
```

**Done when:** all tool tests (old and new) pass, typecheck is clean, and `src/tools.ts` contains no threshold or hint-copy literals.

---

### Task 4: Conformance fixtures and runner

**Files:**
- Create: `fixtures/conformance.jsonl`
- Create: `scripts/conformance.ts`
- Test: `src/decisions.test.ts` (append at end)

**Interfaces:**
- Consumes: `selectSkill`, `SkillLike` (Task 2).
- Produces:
  - `runConformance(jsonl: string): Promise<ConformanceResult>` with
    `ConformanceResult = { total: number; passed: number; failures: ConformanceFailure[] }` and
    `ConformanceFailure = { id: string; expected: string | null; actual: string | null; message: string }`.
  - A CLI entry (`bun scripts/conformance.ts`) that prints one `FAIL` line per failure and `conformance: N/N passed`, exit code 1 on any failure.

Fixture line shape (JSONL, one case per line):

```json
{"id":"...","decision":"skills","task":"...","roster":[{"id":"...","name":"...","description":"...","content":"..."}],"calls":[{"answers":{...}},{"throw":true}],"expected":{"skill":"...|null"}}
```

`roster` entries default `name` to `id` and `content` to `""` when omitted. `calls` are the recorded Jev answer envelopes, in order: one entry per `ask` call the decision is expected to make. A call with `"throw": true` simulates a transport error. `expected.skill` is a skill id or `null`.

- [ ] **Step 1: Create `fixtures/conformance.jsonl`**

```jsonl
{"id":"screenshot-brainstorming","decision":"skills","task":"App strategy for $1M annual revenue","roster":[{"id":"brainstorming","name":"brainstorming","description":"Explore intent and requirements before implementation"},{"id":"writing-plans","name":"writing-plans","description":"Turn a spec into a step-by-step plan"},{"id":"requesting-code-review","name":"requesting-code-review","description":"Review a change before merging"}],"calls":[{"answers":{"which":{"type":"choice","choice":"brainstorming","probabilities":{"brainstorming":0.7,"writing-plans":0.2,"requesting-code-review":0.1},"confidence":0.8},"gate::acts":{"type":"noul","noul":0.9},"gate::procedure":{"type":"noul","noul":0.8},"gate::prose":{"type":"noul","noul":0.2}}}],"expected":{"skill":"brainstorming"}}
{"id":"rerank-low-top-probability","decision":"skills","task":"edit my slide deck","roster":[{"id":"slides-a","name":"slides-author","description":"Build decks"},{"id":"slides-b","name":"slides-edit","description":"Edit decks"},{"id":"slides-c","name":"pptx-polish","description":"Polish slides"}],"calls":[{"answers":{"which":{"type":"choice","choice":"slides-a","probabilities":{"slides-a":0.45,"slides-b":0.35,"slides-c":0.2},"confidence":0.6},"gate::acts":{"type":"noul","noul":0.9},"gate::procedure":{"type":"noul","noul":0.8},"gate::prose":{"type":"noul","noul":0.2}}},{"answers":{"which":{"type":"choice","choice":"slides-c","probabilities":{"slides-a":0.2,"slides-b":0.2,"slides-c":0.6},"confidence":0.7},"fits::slides-a":{"type":"noul","noul":0.1},"fits::slides-b":{"type":"noul","noul":0.2},"fits::slides-c":{"type":"noul","noul":0.9}}}],"expected":{"skill":"slides-c"}}
{"id":"rerank-fits-below-threshold","decision":"skills","task":"edit my slide deck","roster":[{"id":"slides-a","name":"slides-author","description":"Build decks"},{"id":"slides-b","name":"slides-edit","description":"Edit decks"},{"id":"slides-c","name":"pptx-polish","description":"Polish slides"}],"calls":[{"answers":{"which":{"type":"choice","choice":"slides-a","probabilities":{"slides-a":0.45,"slides-b":0.35,"slides-c":0.2},"confidence":0.6},"gate::acts":{"type":"noul","noul":0.9},"gate::procedure":{"type":"noul","noul":0.8},"gate::prose":{"type":"noul","noul":0.2}}},{"answers":{"which":{"type":"choice","choice":"slides-c","probabilities":{"slides-a":0.2,"slides-b":0.2,"slides-c":0.6},"confidence":0.7},"fits::slides-a":{"type":"noul","noul":0.1},"fits::slides-b":{"type":"noul","noul":0.2},"fits::slides-c":{"type":"noul","noul":0.2}}}],"expected":{"skill":null}}
{"id":"large-roster-rerank-by-size","decision":"skills","task":"update the release notes","roster":[{"id":"g01"},{"id":"g02"},{"id":"g03"},{"id":"g04"},{"id":"g05"},{"id":"g06"},{"id":"g07"},{"id":"g08"},{"id":"g09"},{"id":"g10"},{"id":"g11"},{"id":"g12"},{"id":"g13"},{"id":"g14"},{"id":"g15"},{"id":"g16"},{"id":"g17"},{"id":"g18"},{"id":"g19"},{"id":"g20"},{"id":"g21"},{"id":"g22"},{"id":"g23"},{"id":"g24"},{"id":"g25"},{"id":"g26"},{"id":"g27"},{"id":"g28"},{"id":"g29"},{"id":"g30"},{"id":"g31"},{"id":"g32"},{"id":"g33"},{"id":"g34"},{"id":"g35"},{"id":"g36"},{"id":"g37"},{"id":"g38"},{"id":"g39"},{"id":"g40"},{"id":"g41"}],"calls":[{"answers":{"which":{"type":"choice","choice":"g01","probabilities":{"g01":0.9,"g02":0.05,"g03":0.05},"confidence":0.9},"gate::acts":{"type":"noul","noul":0.9},"gate::procedure":{"type":"noul","noul":0.8},"gate::prose":{"type":"noul","noul":0.2}}},{"answers":{"which":{"type":"choice","choice":"g01","probabilities":{"g01":0.6,"g02":0.2,"g03":0.2},"confidence":0.6},"fits::g01":{"type":"noul","noul":0.9},"fits::g02":{"type":"noul","noul":0.1},"fits::g03":{"type":"noul","noul":0.1}}}],"expected":{"skill":"g01"}}
{"id":"empty-roster","decision":"skills","task":"build me a deck","roster":[],"calls":[],"expected":{"skill":null}}
{"id":"gate-closed","decision":"skills","task":"explain monads","roster":[{"id":"brainstorming","name":"brainstorming","description":"Explore intent and requirements before implementation"}],"calls":[{"answers":{"which":{"type":"choice","choice":"brainstorming","probabilities":{"brainstorming":0.9},"confidence":0.9},"gate::acts":{"type":"noul","noul":0.1},"gate::procedure":{"type":"noul","noul":0.1},"gate::prose":{"type":"noul","noul":0.9}}}],"expected":{"skill":null}}
{"id":"low-confidence","decision":"skills","task":"build me a deck","roster":[{"id":"brainstorming","name":"brainstorming","description":"Explore intent and requirements before implementation"}],"calls":[{"answers":{"which":{"type":"choice","choice":"brainstorming","probabilities":{"brainstorming":0.5},"confidence":0.1},"gate::acts":{"type":"noul","noul":0.9},"gate::procedure":{"type":"noul","noul":0.8},"gate::prose":{"type":"noul","noul":0.2}}}],"expected":{"skill":null}}
{"id":"unknown-winner","decision":"skills","task":"build me a deck","roster":[{"id":"brainstorming","name":"brainstorming","description":"Explore intent and requirements before implementation"}],"calls":[{"answers":{"which":{"type":"choice","choice":"ghost","probabilities":{"ghost":1},"confidence":1},"gate::acts":{"type":"noul","noul":0.9},"gate::procedure":{"type":"noul","noul":0.8},"gate::prose":{"type":"noul","noul":0.2}}}],"expected":{"skill":null}}
{"id":"transport-error","decision":"skills","task":"build me a deck","roster":[{"id":"brainstorming","name":"brainstorming","description":"Explore intent and requirements before implementation"}],"calls":[{"throw":true}],"expected":{"skill":null}}
```

Case math (for the reviewer): gate closed = `(0.1+0.1+(1-0.9))/3 = 0.1 < 0.3`; open gates use `(0.9+0.8+(1-0.2))/3 = 0.833`; `rerank-low-top-probability` reranks because top probability `0.45 < rerankBelowP 0.5`; `large-roster-rerank-by-size` reranks because `41 > rerankAbove 40`.

- [ ] **Step 2: Write the failing test**

Append to the end of `src/decisions.test.ts`:

```ts
import { runConformance } from "../scripts/conformance"

test("conformance fixtures pass against the TS core", async () => {
  const result = await runConformance(
    readFileSync(new URL("../fixtures/conformance.jsonl", import.meta.url), "utf8"),
  )
  expect(result.failures).toEqual([])
  expect(result.total).toBe(9)
  expect(result.passed).toBe(9)
})
```

(`readFileSync` is already imported at module scope later in the file; if the appended block lands before that import in execution order, TypeScript hoists imports — no change needed.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/decisions.test.ts`
Expected: FAIL — `Cannot find module '../scripts/conformance'`.

- [ ] **Step 4: Create `scripts/conformance.ts`**

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { selectSkill, type SkillLike } from "../src/skills"
import type { Ask } from "../src/jev"

export interface ConformanceFailure {
  id: string
  expected: string | null
  actual: string | null
  message: string
}

export interface ConformanceResult {
  total: number
  passed: number
  failures: ConformanceFailure[]
}

interface FixtureRosterEntry {
  id: string
  name?: string
  description?: string
  content?: string
}

interface FixtureCall {
  answers?: Record<string, unknown>
  throw?: boolean
}

interface Fixture {
  id: string
  decision: string
  task: string
  roster: FixtureRosterEntry[]
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

export async function runConformance(jsonl: string): Promise<ConformanceResult> {
  const fixtures: Fixture[] = []
  for (const [index, raw] of jsonl.split("\n").entries()) {
    if (raw.trim() === "") continue
    try {
      fixtures.push(JSON.parse(raw) as Fixture)
    } catch (error) {
      return {
        total: fixtures.length + 1,
        passed: 0,
        failures: [
          { id: `line-${index + 1}`, expected: null, actual: null, message: `invalid fixture JSON: ${String(error)}` },
        ],
      }
    }
  }

  const failures: ConformanceFailure[] = []
  let passed = 0
  for (const fixture of fixtures) {
    if (fixture.decision !== "skills") {
      failures.push({
        id: fixture.id,
        expected: fixture.expected.skill,
        actual: null,
        message: `unsupported decision: ${fixture.decision}`,
      })
      continue
    }
    const roster: SkillLike[] = fixture.roster.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      description: entry.description,
      content: entry.content ?? "",
    }))
    const made = { count: 0 }
    let actual: string | null = null
    try {
      const decision = await selectSkill(replayAsk(fixture.calls, made), { request: fixture.task, skills: roster })
      actual = decision?.id ?? null
    } catch (error) {
      failures.push({
        id: fixture.id,
        expected: fixture.expected.skill,
        actual: null,
        message: `decision threw: ${String(error)}`,
      })
      continue
    }
    if (actual !== fixture.expected.skill) {
      failures.push({ id: fixture.id, expected: fixture.expected.skill, actual, message: "decision mismatch" })
      continue
    }
    if (made.count !== fixture.calls.length) {
      failures.push({
        id: fixture.id,
        expected: fixture.expected.skill,
        actual,
        message: `expected ${fixture.calls.length} ask call(s), made ${made.count}`,
      })
      continue
    }
    passed += 1
  }
  return { total: fixtures.length, passed, failures }
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "fixtures", "conformance.jsonl")
  const result = await runConformance(readFileSync(path, "utf8"))
  for (const failure of result.failures) {
    console.error(
      `FAIL ${failure.id}: expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)} (${failure.message})`,
    )
  }
  console.log(`conformance: ${result.passed}/${result.total} passed`)
  process.exitCode = result.failures.length > 0 ? 1 : 0
}
```

- [ ] **Step 5: Run the runner and the test suite**

Run: `bun scripts/conformance.ts`
Expected: `conformance: 9/9 passed`, exit code 0.

Run: `bun test src/decisions.test.ts`
Expected: PASS.

If a case fails, the code is the spec for today's behavior: the fixture's numbers or expectations are wrong, not the thresholds. Fix the fixture and re-run; do not change `spec/decisions.json` or the decision logic in this task.

- [ ] **Step 6: Commit**

```bash
git add fixtures/conformance.jsonl scripts/conformance.ts
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add fixture-driven conformance for the skill decision"
```

**Done when:** the CLI prints 9/9, the bun test wrapper passes, and the runner exports `runConformance` for the Phase B Python port to mirror.

---

### Task 5: Phase gate

**Files:**
- No production files. Test file staging only.

- [ ] **Step 1: Run the full gate**

Run: `bun test`
Expected: all tests pass (pre-existing suite, browser WIP tests, and the Task 1–4 additions).

Run: `bun run typecheck`
Expected: clean.

Run: `bun scripts/conformance.ts`
Expected: `conformance: 9/9 passed`.

- [ ] **Step 2: Verify the WIP is untouched**

Run: `git status --porcelain`
Expected: `README.md`, `index.ts`, `AGENTS.md`, `src/browser.ts`, `src/jev-runner.py` still show as modified/untracked exactly as before this phase; `spec/`, `src/policy.ts`, `fixtures/`, `scripts/conformance.ts` and the two refactored files are committed; `src/decisions.test.ts` still shows as modified.

- [ ] **Step 3: Stage only the appended test hunks**

Run: `git add -p src/decisions.test.ts`
Answer `n` to every hunk that touches the browser tests (`parseRunnerOutput`, `buildRunnerCommand`, `runBrowserTask`, `browserTool`, `readOptions parses browser options`, `setup registers the browser tool only when enabled`) or any other pre-existing WIP; answer `y` only to the appended policy/conformance tests.

Run: `git diff --cached src/decisions.test.ts`
Expected: the staged diff contains only the new imports (`./policy`, `./skills`, `./tools`, `../scripts/conformance`) and the appended tests — no browser-test hunks.

If the interactive picker is unavailable, skip staging and report the uncommitted test additions explicitly instead.

- [ ] **Step 4: Commit the test additions (only if Step 3 staged clean hunks)**

```bash
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "test: lock the decision contract and conformance fixtures"
```

- [ ] **Step 5: Report the phase gate**

Record: `bun test` summary, `bun run typecheck` result, `conformance: 9/9 passed`, and whether the test additions were committed or left uncommitted because of the WIP. Do not push.

**Done when:** the three gate commands are green and the WIP files are byte-identical to their pre-phase state.

---

## Self-Review

- **Spec coverage (Phase A):** `spec/decisions.json` → Task 1. `src/policy.ts` → Task 1. `src/skills.ts` / `src/tools.ts` switched to loaded constants → Tasks 2–3. `fixtures/conformance.jsonl` + `scripts/conformance.ts` → Task 4. `src/decisions.test.ts` additions → Tasks 1–4, staged in Task 5. Phase gate → Task 5.
- **Deliberate substitution:** the spec's "Hermes-scale roster" case is realized as `large-roster-rerank-by-size` (41 entries) in Task 4; it exercises the `rerankAbove` branch without a real Hermes roster. A captured real roster belongs to Phase B, when the Python port consumes the same file.
- **Deliberate design choice:** conformance replays recorded answer envelopes rather than calling live Jev. `selectSkill` is deterministic given answers; live model behavior is measured by the eval lane, not here. This keeps conformance free, offline, and stable across Jev versions.
- **Deliberate omission:** `policy.cache` and `policy.spend` are loaded and pinned by tests but not yet consumed — `index.ts` keeps its current literals until Phase D wires the cache and the spend guard. One source of truth is established before its first consumer, with the test locking both sides to the same values.
- **Placeholder scan:** none. Every step has exact paths, commands, code, and expected outcomes.
- **Type consistency:** `policy`/`formatTemplate` (Task 1) are used with identical field names in Tasks 2–4; `runConformance`/`ConformanceResult`/`ConformanceFailure` signatures are consumed identically in Task 4's test and CLI.
