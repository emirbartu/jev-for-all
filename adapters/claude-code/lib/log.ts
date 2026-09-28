import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const HARNESS = "claude-code"

function append(record: Record<string, unknown>): void {
  try {
    const base = process.env.SYSTEM_ONE_STATE_DIR ?? join(process.env.CLAUDE_PLUGIN_DATA ?? process.env.TMPDIR ?? "/tmp", "system-one-cc")
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, "decisions.jsonl"), JSON.stringify({ harness: HARNESS, ...record }) + "\n")
  } catch {
    // logging never fails the hook
  }
}

export function logDecision(record: Record<string, unknown>): void {
  append({ kind: "decision", ...record })
}

export interface UsageRecord {
  sessionID: string
  messageID: string
  agent: string
  model: string
  input: number
  output: number
  promptChars: number
  calls: number
  time: number
  cost?: number
}

export function logUsage(record: UsageRecord): void {
  append({ kind: "usage", ...record })
}
