import { readFileSync } from "node:fs"
import { policy } from "../../../src/policy"
import {
  CLAIM_PATTERN,
  decideVerification,
  latestAssistantText,
  looksLikeClaim,
  renderVerifyState,
  type VerifyMessage,
} from "../../../src/verify"

export { CLAIM_PATTERN, decideVerification, latestAssistantText, looksLikeClaim, renderVerifyState }
export type { VerifyMessage }

export function verifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SYSTEM_ONE_VERIFY ?? "").trim().toLowerCase()
  if (raw === "") return policy.control.verify
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}

function fromTranscriptLine(line: unknown): VerifyMessage | null {
  if (!line || typeof line !== "object") return null
  const entry = line as { type?: unknown; message?: unknown }
  const message = (entry.message ?? line) as { role?: unknown; content?: unknown }
  const role = typeof message.role === "string" ? message.role : typeof entry.type === "string" ? entry.type : ""
  if (role !== "user" && role !== "assistant") return null
  if (typeof message.content === "string") return { role, content: [{ type: "text", text: message.content }] }
  if (!Array.isArray(message.content)) return null
  return { role, content: message.content as VerifyMessage["content"] }
}

/**
 * The transcript is not guaranteed to exist or be readable at Stop time, and the final
 * assistant message may not be in it yet, so both paths are independent and both optional.
 */
export function readTranscript(path: string | undefined, limit = 200): VerifyMessage[] {
  if (!path) return []
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const messages: VerifyMessage[] = []
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const message = fromTranscriptLine(parsed)
    if (message) messages.push(message)
  }
  return messages.slice(-limit)
}

/**
 * `last_assistant_message` is appended last on purpose: the gate reads the newest assistant
 * turn, and the transcript tail is not guaranteed to contain the final message yet.
 */
export function verifyMessages(input: {
  transcript_path?: string
  last_assistant_message?: string
}): VerifyMessage[] {
  const messages = readTranscript(input.transcript_path)
  const final = input.last_assistant_message
  if (typeof final === "string" && final.trim() !== "") {
    messages.push({ role: "assistant", content: [{ type: "text", text: final }] })
  }
  return messages
}
