import { readFileSync } from "node:fs"
import { createJev, type Ask } from "../../../src/jev"
import { NONE_CONTEXT, decide, injectionFor } from "../lib/decide"
import { defaultSkillDirs, scanSkillDirs } from "../lib/roster"
import { readState, writeState } from "../lib/state"
import { logDecision } from "../lib/log"

interface HookInput {
  hook_event_name?: string
  session_id?: string
  prompt?: string
  cwd?: string
  tool_name?: string
}

const CAP = 500
const WARN_AT = 0.8

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n")
}

function skillDirs(input: HookInput): string[] {
  const override = process.env.SYSTEM_ONE_SKILL_DIRS
  if (override) return override.split(":").filter(Boolean)
  return defaultSkillDirs(input.cwd ?? process.cwd())
}

async function userPromptSubmit(input: HookInput): Promise<void> {
  const sessionID = input.session_id ?? "unknown"
  const skills = scanSkillDirs(skillDirs(input))
  if (skills.length === 0) return

  const state = readState(sessionID) ?? { at: Date.now(), calls: 0 }
  if (state.calls >= CAP) {
    logDecision({ sessionID, hook: "UserPromptSubmit", chosen: "no-change", event: "cap", calls: state.calls })
    return
  }
  if (state.calls + 1 === Math.floor(CAP * WARN_AT)) {
    logDecision({ sessionID, hook: "UserPromptSubmit", chosen: "no-change", event: "warn", calls: state.calls + 1 })
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  const meta: { model?: string; inputTokens?: number; outputTokens?: number } = {}
  const ask: Ask | undefined = apiKey
    ? createJev({
        apiKey,
        onMeta: (info) => Object.assign(meta, info),
        ...(process.env.SYSTEM_ONE_SERVER_URL ? { serverURL: process.env.SYSTEM_ONE_SERVER_URL } : {}),
      })
    : undefined

  const started = Date.now()
  const decision = await decide(ask, input.prompt ?? "", skills)
  const calls = state.calls + 1

  if (decision.kind === "skill") {
    const skill = skills.find((candidate) => candidate.id === decision.id)
    writeState(sessionID, { decision: "skill", at: Date.now(), calls })
    if (skill) emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: injectionFor(skill) } })
  } else if (decision.kind === "none") {
    writeState(sessionID, { decision: "none", at: Date.now(), calls })
    emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NONE_CONTEXT } })
  } else {
    writeState(sessionID, { at: Date.now(), calls })
  }

  logDecision({
    sessionID,
    hook: "UserPromptSubmit",
    chosen: decision.kind === "skill" ? decision.id : decision.kind,
    model: meta.model,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    latencyMs: Date.now() - started,
    calls,
    time: Date.now(),
  })
}

function preToolUse(input: HookInput): void {
  if (input.tool_name !== "Skill") return
  const state = readState(input.session_id ?? "unknown")
  if (state?.decision === "none") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: NONE_CONTEXT,
      },
    })
  }
}

async function main(): Promise<void> {
  let input: HookInput = {}
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput
  } catch {
    return
  }
  if (input.hook_event_name === "UserPromptSubmit") await userPromptSubmit(input)
  else if (input.hook_event_name === "PreToolUse") preToolUse(input)
}

if (import.meta.main) {
  main().catch(() => {})
}
