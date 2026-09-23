# Jev Decision Portfolio — Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the portfolio's measuring instruments — an L1 case-file eval for the shipped skill decision (run live against the real OpenCode roster) and a cross-harness decision report — without changing any plugin behavior.

**Architecture:** `scripts/skill-l1.ts` holds the eval: a folded-YAML roster loader, case loading/validation, the classification and metric math, and one thin CLI that runs the live `selectSkill` path through `src/skills.ts` with real Jev calls. `scripts/decision-report.ts` reads the three adapters' JSONL logs and prints one summary per harness. The 64-case corpus lives in `fixtures/skill-eval/agents-skills-cases.jsonl`, written from the real skills' own descriptions. Results are data under `.superpowers/`; only numbers go in the README.

**Tech Stack:** TypeScript (strict) on Bun, `bun:test`, `node:fs`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-jev-decision-portfolio-design.md`

## Global Constraints

- **Measurement only.** No plugin behavior changes, no threshold tuning, no L2, no new decisions. The only production files touched are new scripts and fixtures.
- **Cost bound:** hard cap `--max-usd` (default `0.10`); expected spend ≤ `$0.02` (64 cases × one call of ~2k input tokens ≈ $0.006; rerank can roughly double it). Input is billed at $0.042/Mtok; output is free.
- **Real rosters only.** The eval roster is `~/.agents/skills` (22 skills, the set this session's `available_skills` lists). The runner validates every `expected`/`acceptable` id against the live roster and fails loudly on unknown ids.
- **Raw results never committed.** Run output goes under `.superpowers/skill-l1/` (gitignored); the README gets the numbers and the exact command.
- **Nothing under `~/.hermes` is written.** The report may read `~/.hermes/plugins/system-one/decisions.jsonl`.
- **No interactive questions; no push.**
- **Commit style:** conventional, one concern per commit.

## Review focus

- **Task 1:** the folded-YAML parser handles `description: >` and `|`; `classify` matches the spec's label definitions exactly; `summarize` math is hand-checkable; tests never touch the network.
- **Task 2:** every case is grounded in a real skill description; the covered set covers all 22 roster skills; `acceptable` appears only where ambiguity is real and is documented; the validation gate passes.
- **Task 3:** the live run executed once, stayed under the cap, and the README carries exactly the command and the summary it produced.
- **Task 4:** the report tolerates missing files and non-`kind` lines; grouping and estimates match the log shapes; the real-log output is pasted in the report.
- **Task 5:** every gate command exits 0.

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `scripts/skill-l1.ts` | Create | Roster loader, case loading/validation, classify/summarize/format, live CLI |
| `scripts/skill-l1.test.ts` | Create | Offline tests for every pure function |
| `fixtures/skill-eval/agents-skills-cases.jsonl` | Create | 64-case corpus (44 covered, 20 no-skill) against the 22-skill roster |
| `scripts/decision-report.ts` | Create | Cross-harness JSONL report |
| `scripts/decision-report.test.ts` | Create | Offline tests for parsing and summarizing |
| `README.md` | Modify | L1 numbers + exact command |
| `docs/superpowers/specs/2026-09-23-jev-decision-portfolio-design.md` | Modify | Wave-1 findings appended |

---

### Task 1: L1 core and offline tests

**Files:**
- Create: `scripts/skill-l1.ts`
- Create: `scripts/skill-l1.test.ts`

**Interfaces:**
- Consumes: `selectSkill`, `SkillLike` (`src/skills.ts`), `createJev` (`src/jev.ts`).
- Produces:
  - `SkillEntry = { id, name, description?, content }`; `parseSkillFile(text, fallbackName)`; `loadSkillDirs(dirs)`
  - `EvalCase = { id, request, expected: string | null, acceptable?: string[] }`; `loadCases(jsonl)`; `validateCases(cases, rosterIds)`
  - `CaseResult`; `classify(expected, acceptable, decision)`
  - `L1Summary`; `summarize(results)`; `formatSummary(summary, { rosterSize, model })`; `costOf(inputTokens)`
  - CLI: `bun scripts/skill-l1.ts --roster <dir> --cases <file> [--limit N] [--max-usd 0.10] [--out <file>] [--model <slug>]`

- [ ] **Step 1: Write the failing tests**

Create `scripts/skill-l1.test.ts`:

```ts
import { expect, test } from "bun:test"
import {
  classify,
  costOf,
  formatSummary,
  loadCases,
  parseSkillFile,
  summarize,
  validateCases,
  type CaseResult,
} from "./skill-l1"

test("parseSkillFile reads single-line and folded descriptions", () => {
  const folded = parseSkillFile(
    '---\nname: ponytail\ndescription: >\n  Forces the laziest solution that works,\n  simplest and most minimal.\n---\n\nbody\n',
    "ponytail",
  )
  expect(folded.name).toBe("ponytail")
  expect(folded.description).toBe("Forces the laziest solution that works, simplest and most minimal.")
  expect(folded.content).toBe("body\n")

  const literal = parseSkillFile("---\nname: x\ndescription: |\n  line one\n  line two\n---\nbody", "x")
  expect(literal.description).toBe("line one\nline two")

  const plain = parseSkillFile("---\nname: y\ndescription: does y\n---\nbody", "y")
  expect(plain.description).toBe("does y")

  const none = parseSkillFile("no frontmatter", "z")
  expect(none.name).toBe("z")
  expect(none.description).toBeUndefined()
  expect(none.content).toBe("no frontmatter")
})

test("loadCases parses valid lines and rejects malformed ones", () => {
  const cases = loadCases(
    [
      JSON.stringify({ id: "a", request: "do a", expected: "brainstorming" }),
      JSON.stringify({ id: "b", request: "nothing", expected: null }),
      "",
    ].join("\n"),
  )
  expect(cases.length).toBe(2)
  expect(cases[1].expected).toBeNull()

  expect(() => loadCases("{not json}")).toThrow(/invalid JSON/)
  expect(() => loadCases(JSON.stringify({ id: "c", request: "x" }))).toThrow(/expected \{id, request/)
  expect(() => loadCases(JSON.stringify({ id: "c", request: "x", expected: 7 }))).toThrow(/expected \{id, request/)
})

test("validateCases fails on ids outside the roster", () => {
  const roster = ["brainstorming", "ponytail"]
  expect(() =>
    validateCases([{ id: "a", request: "x", expected: "brainstorming" }], roster),
  ).not.toThrow()
  expect(() =>
    validateCases([{ id: "a", request: "x", expected: "ghost" }], roster),
  ).toThrow(/ghost/)
  expect(() =>
    validateCases([{ id: "a", request: "x", expected: "brainstorming", acceptable: ["ghost", "spook"] }], roster),
  ).toThrow(/ghost/)
})

test("classify follows the spec's label definitions", () => {
  expect(classify(null, [], null)).toBe("hit")
  expect(classify(null, [], "ponytail")).toBe("spurious")
  expect(classify("ponytail", [], "ponytail")).toBe("hit")
  expect(classify("ponytail", [], null)).toBe("missed")
  expect(classify("ponytail", [], "brainstorming")).toBe("wrong-skill")
  expect(classify("ponytail", ["ponytail-help"], "ponytail-help")).toBe("hit")
})

test("summarize computes counts, rates, latency, tokens and cost", () => {
  const result = (
    classification: CaseResult["classification"],
    latencyMs: number,
    inputTokens: number,
  ): CaseResult => ({
    caseId: "x",
    request: "r",
    expected: null,
    acceptable: [],
    decision: null,
    classification,
    latencyMs,
    inputTokens,
    outputTokens: inputTokens / 10,
    costUsd: costOf(inputTokens),
  })
  const summary = summarize([
    result("hit", 100, 2000),
    result("hit", 300, 1000),
    result("wrong-skill", 200, 1000),
    result("spurious", 200, 1000),
    result("missed", 200, 1000),
    result("skipped", 0, 0),
  ])
  expect(summary.total).toBe(6)
  expect(summary.scored).toBe(5)
  expect(summary.skipped).toBe(1)
  expect(summary.hits).toBe(2)
  expect(summary.wrongSkillRate).toBeCloseTo(0.2)
  expect(summary.spuriousRate).toBeCloseTo(0.2)
  expect(summary.missedRate).toBeCloseTo(0.2)
  expect(summary.hitRate).toBeCloseTo(0.4)
  expect(summary.avgLatencyMs).toBe(200)
  expect(summary.maxLatencyMs).toBe(300)
  expect(summary.inputTokens).toBe(6000)
  expect(summary.costUsd).toBeCloseTo(costOf(6000))
  expect(costOf(1_000_000)).toBeCloseTo(0.042)
})

test("formatSummary reports the numbers and the reference bar", () => {
  const summary = summarize([])
  const text = formatSummary(summary, { rosterSize: 22, model: "~typesafe/jev-latest" })
  expect(text).toContain("roster 22")
  expect(text).toContain("wrong-skill")
  expect(text).toContain("7.3% / 4.0%")
})
```

Create `scripts/decision-report.test.ts`:

```ts
import { expect, test } from "bun:test"
import { formatReport, parseLog, readLogFile, summarizeHarness } from "./decision-report"

test("parseLog splits decision and usage records and skips junk", () => {
  const text = [
    JSON.stringify({ kind: "decision", harness: "hermes", chosen: "demo", inputTokens: 446, outputTokens: 80, latencyMs: 700, time: 100 }),
    JSON.stringify({ kind: "usage", sessionID: "s", input: 1000, output: 200, cost: 0.002, time: 200 }),
    JSON.stringify({ kind: "decision", harness: "claude-code", chosen: "none", inputTokens: 100, latencyMs: 50, time: 300 }),
    "{not json}",
    "",
  ].join("\n")
  const parsed = parseLog(text)
  expect(parsed.decisions.length).toBe(2)
  expect(parsed.usage.length).toBe(1)
})

test("summarizeHarness groups by harness and distributes chosen values", () => {
  const parsed = parseLog(
    [
      JSON.stringify({ kind: "decision", harness: "hermes", chosen: "demo", inputTokens: 400, outputTokens: 80, latencyMs: 700, time: 100 }),
      JSON.stringify({ kind: "decision", harness: "hermes", chosen: "demo", inputTokens: 200, outputTokens: 40, latencyMs: 300, time: 200 }),
      JSON.stringify({ kind: "decision", harness: "claude-code", chosen: "none", inputTokens: 100, outputTokens: 10, latencyMs: 50, time: 300 }),
      JSON.stringify({ kind: "usage", input: 1000, output: 200, cost: 0.002, time: 400 }),
    ].join("\n"),
  )
  const rows = summarizeHarness(parsed.decisions, parsed.usage)
  const hermes = rows.find((row) => row.harness === "hermes")!
  expect(hermes.decisions).toBe(2)
  expect(hermes.chosen).toEqual({ demo: 2 })
  expect(hermes.inputTokens).toBe(600)
  expect(hermes.avgLatencyMs).toBe(500)
  expect(hermes.maxLatencyMs).toBe(700)
  expect(hermes.from).toBe(100)
  expect(hermes.to).toBe(200)
  expect(hermes.costUsd).toBeCloseTo((600 / 1_000_000) * 0.042)

  const opencode = rows.find((row) => row.harness === "opencode")!
  expect(opencode.usageSamples).toBe(1)
  expect(opencode.costUsd).toBeCloseTo(0.002)
})

test("readLogFile tolerates a missing file", () => {
  expect(readLogFile("/nonexistent/system-one/nope.jsonl").missing).toBe(true)
  expect(readLogFile("/nonexistent/system-one/nope.jsonl").text).toBe("")
})

test("formatReport renders one block per harness", () => {
  const rows = summarizeHarness([], [])
  expect(formatReport(rows)).toContain("no records")
  const parsed = parseLog(JSON.stringify({ kind: "decision", harness: "hermes", chosen: "demo", inputTokens: 10, latencyMs: 5, time: 1 }))
  const text = formatReport(summarizeHarness(parsed.decisions, parsed.usage))
  expect(text).toContain("hermes")
  expect(text).toContain("demo:1")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test scripts/skill-l1.test.ts scripts/decision-report.test.ts`
Expected: FAIL — `Cannot find module './skill-l1'` and `'./decision-report'`.

- [ ] **Step 3: Implement `scripts/skill-l1.ts`**

```ts
// L1 eval for the shipped skill decision: real requests against the live Jev path.
// Pure functions are exported for offline tests; only the CLI touches the network.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { createJev } from "../src/jev"
import { selectSkill } from "../src/skills"

export const INPUT_USD_PER_MTOK = 0.042

export interface SkillEntry {
  id: string
  name: string
  description?: string
  content: string
}

export interface EvalCase {
  id: string
  request: string
  expected: string | null
  acceptable?: string[]
}

export interface CaseResult {
  caseId: string
  request: string
  expected: string | null
  acceptable: string[]
  decision: string | null
  classification: "hit" | "wrong-skill" | "spurious" | "missed" | "skipped"
  latencyMs: number
  model?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface L1Summary {
  total: number
  scored: number
  skipped: number
  hits: number
  wrongSkill: number
  spurious: number
  missed: number
  hitRate: number
  wrongSkillRate: number
  spuriousRate: number
  missedRate: number
  avgLatencyMs: number
  maxLatencyMs: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export function costOf(inputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK
}

export function parseSkillFile(text: string, fallbackName: string): { name: string; description?: string; content: string } {
  if (!text.startsWith("---")) return { name: fallbackName, content: text }
  const end = text.indexOf("\n---", 3)
  if (end === -1) return { name: fallbackName, content: text }
  const head = text.slice(3, end)
  const content = text.slice(end + 4).replace(/^\r?\n/, "")
  const fields: Record<string, string> = {}
  const lines = head.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([\w-]+):\s*(.*)$/.exec(lines[index])
    if (!match) continue
    const [, key, rawValue] = match
    let value = rawValue
    if (rawValue === ">" || rawValue === "|") {
      const block: string[] = []
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        block.push(lines[index + 1].trim())
        index += 1
      }
      value = rawValue === ">" ? block.join(" ") : block.join("\n")
    }
    fields[key] = value.replace(/^["']|["']$/g, "").trim()
  }
  return { name: fields.name ?? fallbackName, description: fields.description, content }
}

export function loadSkillDirs(dirs: readonly string[]): SkillEntry[] {
  const skills: SkillEntry[] = []
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        const parsed = parseSkillFile(readFileSync(join(dir, entry, "SKILL.md"), "utf8"), entry)
        skills.push({ id: entry, name: parsed.name, description: parsed.description, content: parsed.content })
      } catch {
        // not a skill directory
      }
    }
  }
  return skills
}

export function loadCases(jsonl: string): EvalCase[] {
  const cases: EvalCase[] = []
  for (const [index, raw] of jsonl.split("\n").entries()) {
    if (raw.trim() === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`case line ${index + 1}: invalid JSON (${String(error)})`)
    }
    const candidate = parsed as Partial<EvalCase>
    const acceptableOk =
      candidate.acceptable === undefined ||
      (Array.isArray(candidate.acceptable) && candidate.acceptable.every((id) => typeof id === "string"))
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.request !== "string" ||
      !(candidate.expected === null || typeof candidate.expected === "string") ||
      !acceptableOk
    ) {
      throw new Error(`case line ${index + 1}: expected {id, request, expected: id | null, acceptable?: [id]}`)
    }
    cases.push({
      id: candidate.id,
      request: candidate.request,
      expected: candidate.expected as string | null,
      acceptable: candidate.acceptable,
    })
  }
  return cases
}

export function validateCases(cases: readonly EvalCase[], rosterIds: readonly string[]): void {
  const known = new Set(rosterIds)
  const unknown: string[] = []
  for (const item of cases) {
    for (const id of [item.expected, ...(item.acceptable ?? [])]) {
      if (id !== null && !known.has(id)) unknown.push(`${item.id} -> ${id}`)
    }
  }
  if (unknown.length > 0) throw new Error(`cases reference skills outside the roster:\n  ${unknown.join("\n  ")}`)
}

export function classify(
  expected: string | null,
  acceptable: readonly string[],
  decision: string | null,
): CaseResult["classification"] {
  if (decision === null) return expected === null ? "hit" : "missed"
  if (expected === null) return "spurious"
  return [expected, ...acceptable].includes(decision) ? "hit" : "wrong-skill"
}

export function summarize(results: readonly CaseResult[]): L1Summary {
  const scored = results.filter((result) => result.classification !== "skipped")
  const count = (kind: CaseResult["classification"]) => scored.filter((result) => result.classification === kind).length
  const denominator = scored.length || 1
  const latencies = scored.map((result) => result.latencyMs)
  return {
    total: results.length,
    scored: scored.length,
    skipped: results.length - scored.length,
    hits: count("hit"),
    wrongSkill: count("wrong-skill"),
    spurious: count("spurious"),
    missed: count("missed"),
    hitRate: count("hit") / denominator,
    wrongSkillRate: count("wrong-skill") / denominator,
    spuriousRate: count("spurious") / denominator,
    missedRate: count("missed") / denominator,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
    inputTokens: scored.reduce((sum, result) => sum + result.inputTokens, 0),
    outputTokens: scored.reduce((sum, result) => sum + result.outputTokens, 0),
    costUsd: scored.reduce((sum, result) => sum + result.costUsd, 0),
  }
}

export function formatSummary(summary: L1Summary, meta: { rosterSize: number; model: string }): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`
  return [
    `cases: ${summary.total} scored ${summary.scored} skipped ${summary.skipped} | roster ${meta.rosterSize} | model ${meta.model}`,
    `hit ${summary.hits} (${pct(summary.hitRate)}) | wrong-skill ${summary.wrongSkill} (${pct(summary.wrongSkillRate)}) | spurious ${summary.spurious} (${pct(summary.spuriousRate)}) | missed ${summary.missed} (${pct(summary.missedRate)})`,
    `latency avg ${summary.avgLatencyMs} ms / max ${summary.maxLatencyMs} ms | tokens in ${summary.inputTokens} out ${summary.outputTokens} | est cost $${summary.costUsd.toFixed(4)}`,
    "reference bar (TypeSafe cookbook): agent-alone 16.8% wrong / 9.8% spurious; with suggestion 7.3% / 4.0%",
  ].join("\n")
}

export function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path
  if (path.startsWith("~/")) return process.env.HOME ? `${process.env.HOME}/${path.slice(2)}` : path.slice(2)
  return path
}

export function parseArgs(argv: readonly string[]): {
  roster: string
  cases: string
  limit?: number
  maxUsd: number
  out: string
  model?: string
} {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const limit = value("--limit")
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return {
    roster: value("--roster") ?? "~/.agents/skills",
    cases: value("--cases") ?? "fixtures/skill-eval/agents-skills-cases.jsonl",
    limit: limit === undefined ? undefined : Number(limit),
    maxUsd: value("--max-usd") === undefined ? 0.1 : Number(value("--max-usd")),
    out: value("--out") ?? `.superpowers/skill-l1/${stamp}.jsonl`,
    model: value("--model"),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for a live run")
  const roster = loadSkillDirs([expandHome(args.roster)])
  if (roster.length === 0) throw new Error(`no skills found under ${args.roster}`)
  const cases = loadCases(readFileSync(args.cases, "utf8"))
  validateCases(
    cases,
    roster.map((skill) => skill.id),
  )
  const selected = args.limit === undefined ? cases : cases.slice(0, args.limit)
  mkdirSync(dirname(args.out), { recursive: true })

  const results: CaseResult[] = []
  let spent = 0
  for (const item of selected) {
    if (spent >= args.maxUsd) {
      results.push({
        caseId: item.id,
        request: item.request,
        expected: item.expected,
        acceptable: item.acceptable ?? [],
        decision: null,
        classification: "skipped",
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      })
      continue
    }
    const meta: { model?: string; inputTokens?: number; outputTokens?: number } = {}
    const ask = createJev({
      apiKey,
      onMeta: (info) => Object.assign(meta, info),
      ...(args.model ? { model: args.model } : {}),
    })
    const started = performance.now()
    const decision = await selectSkill(ask, { request: item.request, skills: roster })
    const latencyMs = Math.round(performance.now() - started)
    const inputTokens = meta.inputTokens ?? 0
    const costUsd = costOf(inputTokens)
    spent += costUsd
    const result: CaseResult = {
      caseId: item.id,
      request: item.request,
      expected: item.expected,
      acceptable: item.acceptable ?? [],
      decision: decision?.id ?? null,
      classification: classify(item.expected, item.acceptable ?? [], decision?.id ?? null),
      latencyMs,
      model: meta.model,
      inputTokens,
      outputTokens: meta.outputTokens ?? 0,
      costUsd,
    }
    results.push(result)
    appendFileSync(args.out, JSON.stringify(result) + "\n")
    console.log(`${result.classification === "hit" ? "PASS" : "FAIL"} ${item.id} -> ${result.decision ?? "(none)"} expected ${item.expected ?? "(none)"}`)
  }
  console.log(formatSummary(summarize(results), { rosterSize: roster.length, model: args.model ?? "~typesafe/jev-latest" }))
  console.log(`raw results: ${args.out}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  })
}
```

- [ ] **Step 4: Implement `scripts/decision-report.ts`**

```ts
// Cross-harness decision report: reads adapter JSONL logs and prints one summary per harness.
import { readFileSync } from "node:fs"

const INPUT_USD_PER_MTOK = 0.042

export interface DecisionRecord {
  kind: "decision"
  harness?: string
  chosen?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  latencyMs?: number
  time?: number
}

export interface UsageRecord {
  kind: "usage"
  input?: number
  output?: number
  cost?: number
  time?: number
}

export interface HarnessSummary {
  harness: string
  decisions: number
  usageSamples: number
  chosen: Record<string, number>
  inputTokens: number
  outputTokens: number
  avgLatencyMs: number
  maxLatencyMs: number
  costUsd: number
  from?: number
  to?: number
}

export function readLogFile(path: string): { text: string; missing: boolean } {
  try {
    return { text: readFileSync(path, "utf8"), missing: false }
  } catch {
    return { text: "", missing: true }
  }
}

export function parseLog(text: string): { decisions: DecisionRecord[]; usage: UsageRecord[] } {
  const decisions: DecisionRecord[] = []
  const usage: UsageRecord[] = []
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object") continue
    const record = parsed as { kind?: unknown }
    if (record.kind === "decision") decisions.push(parsed as DecisionRecord)
    else if (record.kind === "usage") usage.push(parsed as UsageRecord)
  }
  return { decisions, usage }
}

export function summarizeHarness(decisions: readonly DecisionRecord[], usage: readonly UsageRecord[]): HarnessSummary[] {
  const rows = new Map<string, HarnessSummary>()
  const row = (harness: string): HarnessSummary => {
    const existing = rows.get(harness)
    if (existing) return existing
    const created: HarnessSummary = {
      harness,
      decisions: 0,
      usageSamples: 0,
      chosen: {},
      inputTokens: 0,
      outputTokens: 0,
      avgLatencyMs: 0,
      maxLatencyMs: 0,
      costUsd: 0,
    }
    rows.set(harness, created)
    return created
  }

  for (const decision of decisions) {
    const summary = row(decision.harness ?? "unknown")
    summary.decisions += 1
    const chosen = decision.chosen ?? "?"
    summary.chosen[chosen] = (summary.chosen[chosen] ?? 0) + 1
    summary.inputTokens += typeof decision.inputTokens === "number" ? decision.inputTokens : 0
    summary.outputTokens += typeof decision.outputTokens === "number" ? decision.outputTokens : 0
    summary.costUsd += (typeof decision.inputTokens === "number" ? decision.inputTokens : 0) / 1_000_000 * INPUT_USD_PER_MTOK
    const latency = typeof decision.latencyMs === "number" ? decision.latencyMs : 0
    summary.avgLatencyMs += latency
    summary.maxLatencyMs = Math.max(summary.maxLatencyMs, latency)
    if (typeof decision.time === "number") {
      summary.from = summary.from === undefined ? decision.time : Math.min(summary.from, decision.time)
      summary.to = summary.to === undefined ? decision.time : Math.max(summary.to, decision.time)
    }
  }

  for (const sample of usage) {
    const summary = row("opencode")
    summary.usageSamples += 1
    summary.inputTokens += typeof sample.input === "number" ? sample.input : 0
    summary.outputTokens += typeof sample.output === "number" ? sample.output : 0
    summary.costUsd += typeof sample.cost === "number" ? sample.cost : 0
    if (typeof sample.time === "number") {
      summary.from = summary.from === undefined ? sample.time : Math.min(summary.from, sample.time)
      summary.to = summary.to === undefined ? sample.time : Math.max(summary.to, sample.time)
    }
  }

  const list = [...rows.values()]
  for (const summary of list) {
    if (summary.decisions > 0) summary.avgLatencyMs = Math.round(summary.avgLatencyMs / summary.decisions)
  }
  return list.sort((a, b) => a.harness.localeCompare(b.harness))
}

export function formatReport(rows: readonly HarnessSummary[]): string {
  if (rows.length === 0) return "no records"
  const lines = ["harness        calls  usage  avg/max ms   tokens(in/out)      est cost  chosen"]
  for (const row of rows) {
    const chosen = Object.entries(row.chosen)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}:${count}`)
      .join(" ")
    lines.push(
      `${row.harness.padEnd(14)} ${String(row.decisions).padEnd(5)}  ${String(row.usageSamples).padEnd(5)}  ${String(row.avgLatencyMs).padStart(4)}/${String(row.maxLatencyMs).padEnd(4)} ms  ${String(row.inputTokens).padStart(8)}/${String(row.outputTokens).padEnd(8)}  $${row.costUsd.toFixed(4)}   ${chosen}`,
    )
  }
  return lines.join("\n")
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2)
  if (paths.length === 0) {
    console.error("usage: bun scripts/decision-report.ts <log.jsonl> [more.jsonl ...]")
    process.exitCode = 1
    return
  }
  const decisions: DecisionRecord[] = []
  const usage: UsageRecord[] = []
  for (const path of paths) {
    const { text, missing } = readLogFile(path)
    if (missing) {
      console.log(`skipped (missing): ${path}`)
      continue
    }
    const parsed = parseLog(text)
    decisions.push(...parsed.decisions)
    usage.push(...parsed.usage)
    console.log(`read ${parsed.decisions.length} decision + ${parsed.usage.length} usage lines: ${path}`)
  }
  console.log(formatReport(summarizeHarness(decisions, usage)))
}

if (import.meta.main) {
  void main()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test scripts/skill-l1.test.ts scripts/decision-report.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/skill-l1.ts scripts/skill-l1.test.ts scripts/decision-report.ts scripts/decision-report.test.ts
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "feat: add the l1 skill-decision eval core and the decision report"
```

**Gate:** both test files green, typecheck clean, `bun test` overall green.

---

### Task 2: the case corpus

**Files:**
- Create: `fixtures/skill-eval/agents-skills-cases.jsonl`

**Interfaces:**
- Consumes: the roster loader and `validateCases` from Task 1.
- Produces: 64 cases — 44 covered (every one of the 22 roster skills gets exactly two), 20 no-skill.

- [ ] **Step 1: Write the corpus**

Create `fixtures/skill-eval/agents-skills-cases.jsonl` with exactly these lines:

```jsonl
{"id":"brainstorm-habit-app","request":"I want to build a habit-tracking app — help me figure out what it should do.","expected":"brainstorming"}
{"id":"brainstorm-requirements","request":"Help me think through the requirements for a new CLI tool before we start coding.","expected":"brainstorming"}
{"id":"plan-from-spec","request":"Turn the approved spec into a step-by-step implementation plan.","expected":"writing-plans"}
{"id":"plan-before-code","request":"We have requirements for a multi-step migration; write the plan before touching code.","expected":"writing-plans"}
{"id":"execute-separate","request":"Execute the plan in docs/plans/foo.md in a separate session, pausing at review checkpoints.","expected":"executing-plans"}
{"id":"execute-task-by-task","request":"Work through this implementation plan task by task with review checkpoints.","expected":"executing-plans"}
{"id":"tdd-endpoint","request":"Implement this new endpoint using TDD.","expected":"test-driven-development"}
{"id":"tdd-bugfix","request":"Fix this bug, but write the failing test first.","expected":"test-driven-development"}
{"id":"debug-flaky","request":"A test fails randomly after my change — help me find the root cause.","expected":"systematic-debugging"}
{"id":"debug-wrong-values","request":"This function returns wrong values and I have no idea why; debug it.","expected":"systematic-debugging"}
{"id":"verify-before-done","request":"Before I say this is done, verify it.","expected":"verification-before-completion"}
{"id":"verify-passing","request":"Check that the tests really pass before I commit and claim it is fixed.","expected":"verification-before-completion"}
{"id":"review-before-merge","request":"Get my branch reviewed before I merge it.","expected":"requesting-code-review"}
{"id":"review-major-feature","request":"I just finished a major feature; review the work before I move on.","expected":"requesting-code-review"}
{"id":"feedback-pr","request":"Here is the review feedback on my PR — help me work through it carefully.","expected":"receiving-code-review"}
{"id":"feedback-questionable","request":"The reviewer's comment looks wrong; how should I handle this feedback?","expected":"receiving-code-review"}
{"id":"sdd-current-session","request":"Execute this plan with a fresh subagent per task and a review between tasks, in this session.","expected":"subagent-driven-development"}
{"id":"sdd-many-tasks","request":"Run the plan using subagents for each independent task in the current session.","expected":"subagent-driven-development"}
{"id":"parallel-refactors","request":"I have three independent refactors with no shared state; run them in parallel.","expected":"dispatching-parallel-agents"}
{"id":"parallel-tasks","request":"Two unrelated tasks that cannot affect each other — can they run at the same time?","expected":"dispatching-parallel-agents"}
{"id":"worktree-feature","request":"Set up an isolated worktree for this feature.","expected":"using-git-worktrees"}
{"id":"worktree-isolation","request":"Start this work in an isolated workspace so the main tree stays clean.","expected":"using-git-worktrees"}
{"id":"finish-branch","request":"Implementation is done and all tests pass — decide how to integrate the work.","expected":"finishing-a-development-branch"}
{"id":"merge-options","request":"The branch is finished; what are my options to merge it?","expected":"finishing-a-development-branch"}
{"id":"find-pdf","request":"Find a skill that can convert PDFs to text.","expected":"find-skills"}
{"id":"find-terraform","request":"Is there an installable skill for reviewing Terraform?","expected":"find-skills"}
{"id":"skills-how-to","request":"How do I find and use the skills available in this conversation?","expected":"using-superpowers","acceptable":["using-superpowers","find-skills"]}
{"id":"superpowers-setup","request":"Set up the superpowers workflow at the start of this conversation.","expected":"using-superpowers"}
{"id":"ui-accessibility","request":"Review my landing page UI for accessibility.","expected":"web-design-guidelines"}
{"id":"design-audit","request":"Audit this site's design against the Web Interface Guidelines.","expected":"web-design-guidelines"}
{"id":"new-skill","request":"Create a new skill for our deploy checklist.","expected":"writing-skills"}
{"id":"edit-skill","request":"Edit an existing skill and verify it works before deploying.","expected":"writing-skills"}
{"id":"lazy-refactor","request":"Keep this refactor minimal — the laziest solution that actually works.","expected":"ponytail"}
{"id":"delete-instead","request":"Do less: what can we delete instead of writing this new code?","expected":"ponytail"}
{"id":"audit-repo","request":"Audit this whole repo for over-engineering.","expected":"ponytail-audit"}
{"id":"delete-from-repo","request":"What can I delete from this codebase?","expected":"ponytail-audit"}
{"id":"debt-ledger","request":"Harvest every ponytail comment into a debt ledger.","expected":"ponytail-debt"}
{"id":"deferred-work","request":"What did ponytail defer in this project?","expected":"ponytail-debt"}
{"id":"gain-scoreboard","request":"Show ponytail's measured impact as a scoreboard.","expected":"ponytail-gain"}
{"id":"gain-what-saved","request":"What does ponytail save?","expected":"ponytail-gain"}
{"id":"help-commands","request":"What ponytail commands are there?","expected":"ponytail-help"}
{"id":"help-use","request":"How do I use ponytail?","expected":"ponytail-help"}
{"id":"review-overengineering","request":"Review this diff for over-engineering — what can I delete?","expected":"ponytail-review"}
{"id":"simplify-review","request":"Is this over-engineered? Simplify review.","expected":"ponytail-review"}
{"id":"noskill-greeting","request":"hey, how's it going?","expected":null}
{"id":"noskill-thanks","request":"thanks, that worked!","expected":null}
{"id":"noskill-capital","request":"What is the capital of Portugal?","expected":null}
{"id":"noskill-tcp","request":"Explain how TCP handshakes work.","expected":null}
{"id":"noskill-percent","request":"Convert 15% of 240 for me.","expected":null}
{"id":"noskill-429","request":"What does HTTP 429 mean?","expected":null}
{"id":"noskill-haiku","request":"Write a haiku about rain.","expected":null}
{"id":"noskill-translate","request":"Translate 'good morning' into Turkish.","expected":null}
{"id":"noskill-time","request":"What time is it in Tokyo right now?","expected":null}
{"id":"noskill-rename","request":"Rename the variable x to count in this function.","expected":null}
{"id":"noskill-version","request":"Bump the version to 1.2.0 in package.json.","expected":null}
{"id":"noskill-gitignore","request":"Add dist/ to .gitignore.","expected":null}
{"id":"noskill-browser-tool","request":"Call the browser_task tool to open example.com.","expected":null}
{"id":"noskill-read-file","request":"Read /tmp/notes.txt and print the first line.","expected":null}
{"id":"noskill-run-tests","request":"Run bun test and paste the output.","expected":null}
{"id":"noskill-grep","request":"Search the repo for TODO comments.","expected":null}
{"id":"noskill-let-const","request":"What is the difference between let and const in JavaScript?","expected":null}
{"id":"noskill-puppy","request":"Suggest a name for my new puppy.","expected":null}
{"id":"noskill-summary","request":"Summarize this paragraph: the quick brown fox jumps over the lazy dog.","expected":null}
{"id":"noskill-unused-import","request":"Delete the unused import on line 4.","expected":null}
```

`acceptable` policy: it exists only for a request that two skills' own descriptions claim
(`skills-how-to` names both the conversation-startup workflow and skill discovery). Covered
cases are written from the skills' own description text in `~/.agents/skills/*/SKILL.md`; the
no-skill set mixes smalltalk, plain Q&A, and tool-only asks.

- [ ] **Step 2: Validate the corpus against the live roster**

Run: `bun -e 'const { readFileSync } = await import("node:fs"); const { loadCases, validateCases, loadSkillDirs, expandHome } = await import("./scripts/skill-l1.ts"); const cases = loadCases(readFileSync("fixtures/skill-eval/agents-skills-cases.jsonl", "utf8")); const roster = loadSkillDirs([expandHome("~/.agents/skills")]); validateCases(cases, roster.map((s) => s.id)); const covered = new Set(cases.filter((c) => c.expected).map((c) => c.expected)); console.log("cases", cases.length, "roster", roster.length, "covered", covered.size)'`
Expected: `cases 64 roster 22 covered 22`, no error; both scripts tests already green.

- [ ] **Step 3: Commit**

```bash
git add fixtures/skill-eval/agents-skills-cases.jsonl
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "test: add the l1 skill-decision case corpus"
```

**Gate:** the validation command prints `cases 64 roster 22 covered 22` and exits 0.

---

### Task 3: the live L1 run and the README numbers

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the CLI from Task 1 and the corpus from Task 2.
- Produces: the recorded L1 summary in the README, plus raw results under `.superpowers/`.

- [ ] **Step 1: Run it once**

Run: `OPENROUTER_API_KEY=... bun scripts/skill-l1.ts --roster ~/.agents/skills --cases fixtures/skill-eval/agents-skills-cases.jsonl`
Expected: a `PASS`/`FAIL` line per case, then the 4-line summary; raw results under `.superpowers/skill-l1/<stamp>.jsonl`. Expected spend ≤ `$0.02`; the run stops at `$0.10`.

- [ ] **Step 2: Add the README section**

Add after the "Browser tasks" section:

```markdown
## Skill decision quality (L1)

The shipped skill decision is measured against real skills, not invented ones: 64 cases (44
covered across all 22 skills in `~/.agents/skills`, 20 no-skill requests) run live through
`selectSkill` and classified as hit / wrong-skill / spurious / missed.

```bash
OPENROUTER_API_KEY=... bun scripts/skill-l1.ts --roster ~/.agents/skills \
  --cases fixtures/skill-eval/agents-skills-cases.jsonl
```

<!-- L1-RESULTS:BEGIN — paste the summary block from the run here, replacing this comment -->
<!-- L1-RESULTS:END -->
```

Then paste the exact summary block the run printed between the two markers (the four lines
starting with `cases:`), and state the run date, model, roster size, and estimated cost.
Raw per-case results stay under `.superpowers/skill-l1/` and are never committed.

- [ ] **Step 3: Commit**

```bash
git add README.md
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "docs: record the l1 skill-decision numbers"
```

**Gate:** the README contains the real summary block and the exact command; the raw file exists under `.superpowers/`.

---

### Task 4: exercise the decision report on real logs

**Files:**
- None (uses Task 1's `scripts/decision-report.ts`).

- [ ] **Step 1: Run it against the real logs**

```bash
bun scripts/decision-report.ts ~/.hermes/plugins/system-one/decisions.jsonl /tmp/system-one-usage.jsonl
```

Expected: `read N decision + M usage lines` for the Hermes log; `skipped (missing)` for the
(nonexistent) OpenCode usage log; then the table. If a Claude Code log exists under
`/tmp/system-one-*`, add it as a third path. Paste the exact output in the final report.

- [ ] **Step 2: Note the Hermes roster gap**

Append to the spec's Confirmed facts (it already records the nested-roster finding) and mention
in the final report: the shipped Hermes adapter scans one level of `~/.hermes/skills`, so its
real roster is 2 skills while 76 exist nested under `category/skill/`. This is a portfolio
finding for a later wave, not a fix in wave 1.

- [ ] **Step 3: Commit (spec only, if anything changed)**

```bash
git add docs/superpowers/specs/2026-09-23-jev-decision-portfolio-design.md
git -c user.name="OpenCode Agent" -c user.email="agent@opencode.local" commit -m "docs: record the wave-1 roster finding"
```

**Gate:** the report command ran, its output is in the final report, and the finding is recorded.

---

### Task 5: phase gate

**Files:** none (verification only).

- [ ] **Step 1: Run every gate**

```bash
bun test
bun run typecheck
python3 -m unittest discover -s adapters/hermes/tests
git status --porcelain
```

Expected: all green; working tree clean except gitignored scratch.

- [ ] **Step 2: Record the result**

Report: files changed, commands and results, commit hashes, the L1 numbers, the report output, and anything red. Do not push.

**Gate:** all four commands exit 0.

---

## Out of scope (Wave 1)

- No L2 runs, no threshold tuning, no plugin behavior changes, no new decisions.
- No fixes to the Hermes nested-roster gap (reported only), no `~/.hermes` writes.
- No shared eval framework; one eval, one report.

## Self-review

- **Spec coverage:** the L1 method is Tasks 1–3 (loader/validation/metrics, corpus, live run); the cross-harness report is Task 4; the eligibility filter and gate live in the spec itself; the wave sequencing is the spec's.
- **Placeholder scan:** all code is complete; the only "paste" step is the live run's own output, with the exact command and the markers it goes between.
- **Type consistency:** `EvalCase`, `CaseResult`, `L1Summary`, `SkillEntry`, `DecisionRecord`, `UsageRecord`, and `HarnessSummary` are defined once in Task 1 and consumed unchanged in the tests and CLI.
- **Cost:** 64 cases ≈ $0.006 one-pass, ≤ $0.02 with rerank, hard cap $0.10 via `--max-usd`.
