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
  const content = text.slice(end + 4).replace(/^[\r\n]+/, "")
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

/** A null decision with zero billed input tokens is a transport failure, not a decision. */
export function classifyOutcome(
  expected: string | null,
  acceptable: readonly string[],
  decision: string | null,
  inputTokens: number,
): CaseResult["classification"] {
  if (decision === null && inputTokens === 0) return "skipped"
  return classify(expected, acceptable, decision)
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
  timeoutMs: number
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
    timeoutMs: value("--timeout-ms") === undefined ? 1000 : Number(value("--timeout-ms")),
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
      timeoutMs: args.timeoutMs,
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
      classification: classifyOutcome(item.expected, item.acceptable ?? [], decision?.id ?? null, inputTokens),
      latencyMs,
      model: meta.model,
      inputTokens,
      outputTokens: meta.outputTokens ?? 0,
      costUsd,
    }
    results.push(result)
    appendFileSync(args.out, JSON.stringify(result) + "\n")
    const tag = result.classification === "hit" ? "PASS" : result.classification === "skipped" ? "SKIP" : "FAIL"
    console.log(`${tag} ${item.id} -> ${result.decision ?? (result.classification === "skipped" ? "(transport)" : "(none)")} expected ${item.expected ?? "(none)"}`)
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
