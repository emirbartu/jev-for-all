import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export function logDecision(record: Record<string, unknown>): void {
  try {
    const base = process.env.SYSTEM_ONE_STATE_DIR ?? join(process.env.CLAUDE_PLUGIN_DATA ?? process.env.TMPDIR ?? "/tmp", "system-one-cc")
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, "decisions.jsonl"), JSON.stringify({ kind: "decision", harness: "claude-code", ...record }) + "\n")
  } catch {
    // logging never fails the hook
  }
}
