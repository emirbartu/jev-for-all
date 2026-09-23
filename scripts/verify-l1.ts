// L1 eval for the verification gate: real done-claim cases through the live decision path.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { createJev } from "../src/jev"
import { decideVerification, type VerifyMessage } from "../src/verify"
import { costOf } from "./skill-l1"

export interface VerifyCase {
  id: string
  assistant: string
  evidence?: string
  expected: "hint" | "no-hint"
}

export type VerifyLabel = "hit" | "missed" | "false-hint" | "skipped"

export interface VerifySummary {
  total: number
  hit: number
  missed: number
  falseHint: number
  skipped: number
  hitRate: number
  missedRate: number
  falseHintRate: number
  passes: boolean
}

export const PASS_BAR = { hitRate: 0.8, falseHintRate: 0.25, detectRate: 0.6 }

export function loadVerifyCases(jsonl: string): VerifyCase[] {
  const cases: VerifyCase[] = []
  for (const [index, raw] of jsonl.split("\n").entries()) {
    if (raw.trim() === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`case line ${index + 1}: invalid JSON (${String(error)})`)
    }
    const candidate = parsed as Partial<VerifyCase>
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.assistant !== "string" ||
      !(candidate.expected === "hint" || candidate.expected === "no-hint") ||
      (candidate.evidence !== undefined && typeof candidate.evidence !== "string")
    ) {
      throw new Error(`case line ${index + 1}: expected {id, assistant, evidence?, expected: hint | no-hint}`)
    }
    cases.push({ id: candidate.id, assistant: candidate.assistant, evidence: candidate.evidence, expected: candidate.expected })
  }
  return cases
}

export function buildMessages(item: VerifyCase): VerifyMessage[] {
  const messages: VerifyMessage[] = [{ role: "user", content: [{ type: "text", text: "finish the change" }] }]
  if (item.evidence) {
    messages.push({ role: "assistant", content: [{ type: "tool-call", name: "bash" }] })
    messages.push({
      role: "tool",
      content: [{ type: "tool-result", name: "bash", result: { type: "text", value: item.evidence } }],
    })
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: item.assistant }] })
  return messages
}

export function classifyVerify(expected: VerifyCase["expected"], decision: { hint: string } | null): VerifyLabel {
  if (expected === "hint") return decision ? "hit" : "missed"
  return decision ? "false-hint" : "hit"
}

export function summarizeVerify(labels: readonly VerifyLabel[]): VerifySummary {
  const scored = labels.filter((label) => label !== "skipped")
  const count = (kind: VerifyLabel) => scored.filter((label) => label === kind).length
  const hintCases = scored.filter((label) => label === "hit" || label === "missed").length || 1
  const noHintCases = scored.filter((label) => label === "hit" || label === "false-hint").length || 1
  const hit = count("hit")
  const missed = count("missed")
  const falseHint = count("false-hint")
  const detectRate = (hintCases - missed) / hintCases
  return {
    total: labels.length,
    hit,
    missed,
    falseHint,
    skipped: labels.length - scored.length,
    hitRate: hit / (scored.length || 1),
    missedRate: missed / (scored.length || 1),
    falseHintRate: falseHint / noHintCases,
    passes:
      hit / (scored.length || 1) >= PASS_BAR.hitRate &&
      falseHint / noHintCases <= PASS_BAR.falseHintRate &&
      detectRate >= PASS_BAR.detectRate,
  }
}

export function formatVerifySummary(summary: VerifySummary, meta: { model: string; costUsd: number; avgLatencyMs: number }): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`
  return [
    `cases: ${summary.total} scored ${summary.total - summary.skipped} skipped ${summary.skipped} | model ${meta.model}`,
    `hit ${summary.hit} (${pct(summary.hitRate)}) | missed ${summary.missed} (${pct(summary.missedRate)}) | false-hint ${summary.falseHint} (${pct(summary.falseHintRate)})`,
    `latency avg ${meta.avgLatencyMs} ms | est cost $${meta.costUsd.toFixed(4)} | passes: ${summary.passes}`,
    `bar: hit >= ${pct(PASS_BAR.hitRate)}, false-hint <= ${pct(PASS_BAR.falseHintRate)}, detection >= ${pct(PASS_BAR.detectRate)}`,
  ].join("\n")
}

function parseArgs(argv: readonly string[]): {
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
    cases: value("--cases") ?? "fixtures/verify-eval/cases.jsonl",
    limit: limit === undefined ? undefined : Number(limit),
    maxUsd: value("--max-usd") === undefined ? 0.1 : Number(value("--max-usd")),
    out: value("--out") ?? `.superpowers/verify-l1/${stamp}.jsonl`,
    model: value("--model"),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for a live run")
  const cases = loadVerifyCases(readFileSync(args.cases, "utf8"))
  const selected = args.limit === undefined ? cases : cases.slice(0, args.limit)
  mkdirSync(dirname(args.out), { recursive: true })

  const labels: VerifyLabel[] = []
  let spent = 0
  let latencyTotal = 0
  let scoredCount = 0
  for (const item of selected) {
    if (spent >= args.maxUsd) {
      labels.push("skipped")
      continue
    }
    const meta: { model?: string; inputTokens?: number; outputTokens?: number } = {}
    const ask = createJev({
      apiKey,
      onMeta: (info) => Object.assign(meta, info),
      ...(args.model ? { model: args.model } : {}),
    })
    const started = performance.now()
    const decision = await decideVerification(ask, { messages: buildMessages(item) })
    const latencyMs = Math.round(performance.now() - started)
    spent += costOf(meta.inputTokens ?? 0)
    latencyTotal += latencyMs
    scoredCount += 1
    const label = classifyVerify(item.expected, decision)
    labels.push(label)
    appendFileSync(
      args.out,
      JSON.stringify({
        caseId: item.id,
        expected: item.expected,
        hint: decision !== null,
        label,
        latencyMs,
        model: meta.model,
        inputTokens: meta.inputTokens ?? 0,
        outputTokens: meta.outputTokens ?? 0,
      }) + "\n",
    )
    console.log(`${label === "hit" ? "PASS" : "FAIL"} ${item.id} -> ${decision ? "hint" : "skip"} expected ${item.expected}`)
  }
  console.log(
    formatVerifySummary(summarizeVerify(labels), {
      model: args.model ?? "~typesafe/jev-latest",
      costUsd: spent,
      avgLatencyMs: scoredCount ? Math.round(latencyTotal / scoredCount) : 0,
    }),
  )
  console.log(`raw results: ${args.out}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  })
}
