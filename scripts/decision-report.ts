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
    const inputTokens = typeof decision.inputTokens === "number" ? decision.inputTokens : 0
    summary.inputTokens += inputTokens
    summary.outputTokens += typeof decision.outputTokens === "number" ? decision.outputTokens : 0
    summary.costUsd += (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK
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
