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
