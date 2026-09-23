import { asNoul, type Ask } from "./jev"
import { policy } from "./policy"

export const CLAIM_PATTERN = /\b(done|complete|completed|finished|fixed|all tests pass|it works|ready to merge)\b/i

export interface VerifyMessage {
  role: string
  content?: readonly unknown[]
}

export function looksLikeClaim(text: string): boolean {
  return CLAIM_PATTERN.test(text)
}

export function latestAssistantText(messages: readonly VerifyMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const parts: string[] = []
    for (const part of message.content ?? []) {
      const candidate = part as { type?: string; text?: string }
      if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text)
    }
    if (parts.length > 0) return parts.join("\n")
  }
  return ""
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function renderVerifyState(messages: readonly VerifyMessage[], budget = 2000): string {
  const lines: string[] = []
  for (const message of messages) {
    const parts: string[] = []
    for (const part of message.content ?? []) {
      const candidate = part as { type?: string; text?: string; name?: string; result?: unknown }
      if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text)
      else if (candidate.type === "tool-call") parts.push(`[called ${candidate.name ?? "?"}]`)
      else if (candidate.type === "tool-result") parts.push(`[tool ${candidate.name ?? "?"}] ${stringify(candidate.result)}`)
    }
    if (parts.length > 0) lines.push(`${message.role}: ${parts.join("\n")}`)
  }
  const text = lines.join("\n")
  return text.length > budget ? text.slice(text.length - budget) : text
}

export async function decideVerification(
  ask: Ask,
  input: { messages: readonly VerifyMessage[]; config?: { claimMin?: number; ranMin?: number; passMin?: number } },
): Promise<{ hint: string } | null> {
  const claimMin = input.config?.claimMin ?? policy.control.claimMin
  const ranMin = input.config?.ranMin ?? policy.control.ranMin
  const passMin = input.config?.passMin ?? policy.control.passMin
  if (!looksLikeClaim(latestAssistantText(input.messages))) return null
  try {
    const answers = await ask({
      state: { tail: renderVerifyState(input.messages) },
      questions: {
        "control::claim": { type: "noul", instructions: policy.control.questions.claim },
        "control::ran": { type: "noul", instructions: policy.control.questions.checkRan },
        "control::passed": { type: "noul", instructions: policy.control.questions.checkPassed },
      },
    })
    const claim = asNoul(answers["control::claim"])
    const ran = asNoul(answers["control::ran"])
    const passed = asNoul(answers["control::passed"])
    if (!claim || !ran || !passed) return null
    if (claim.noul < claimMin) return null
    if (ran.noul >= ranMin && passed.noul >= passMin) return null
    return { hint: policy.control.hint }
  } catch {
    return null
  }
}
