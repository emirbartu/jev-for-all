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
