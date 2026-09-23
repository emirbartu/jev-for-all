import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface SessionState {
  decision?: "skill" | "none"
  at: number
  calls: number
}

const TTL_MS = 2 * 60 * 60 * 1000

function stateDir(): string {
  return process.env.SYSTEM_ONE_STATE_DIR ?? join(process.env.CLAUDE_PLUGIN_DATA ?? process.env.TMPDIR ?? "/tmp", "system-one-cc")
}

export function writeState(sessionID: string, state: SessionState): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(join(stateDir(), `${sessionID}.json`), JSON.stringify(state))
  } catch {
    // state is an optimization; never fail the hook
  }
}

export function readState(sessionID: string): SessionState | undefined {
  try {
    const state = JSON.parse(readFileSync(join(stateDir(), `${sessionID}.json`), "utf8")) as SessionState
    if (typeof state.at !== "number" || Date.now() - state.at > TTL_MS) return undefined
    return state
  } catch {
    return undefined
  }
}
