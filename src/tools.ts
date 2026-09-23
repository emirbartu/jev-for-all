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
      names.map((name) => {
        const description = (input.catalog[name]?.description ?? "").slice(0, policy.tools.criteria.descriptionChars)
        return [name, description === "" ? formatTemplate(policy.tools.criteria.emptyDescription, { name }) : description]
      }),
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
