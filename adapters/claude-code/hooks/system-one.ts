import { readFileSync } from "node:fs"
import { createJev, type Ask } from "../../../src/jev"
import { policy } from "../../../src/policy"
import { NONE_CONTEXT, decide, injectionFor } from "../lib/decide"
import { agentHint, selectAgent } from "../../../src/agents"
import { defaultAgentDirs, defaultSkillDirs, scanAgentDirs, scanSkillDirs } from "../lib/roster"
import { readState, writeState, type SessionState } from "../lib/state"
import { logDecision, logUsage } from "../lib/log"
import { decideVerification, verifyEnabled, verifyMessages } from "../lib/verify"

interface HookInput {
  hook_event_name?: string
  session_id?: string
  prompt?: string
  cwd?: string
  tool_name?: string
  agent_id?: string
  agent_type?: string
  transcript_path?: string
  last_assistant_message?: string
  stop_hook_active?: boolean
}

const CAP = policy.spend.maxCallsPerSession
const WARN_AT = policy.spend.warnAt

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n")
}

function skillDirs(input: HookInput): string[] {
  const override = process.env.SYSTEM_ONE_SKILL_DIRS
  if (override) return override.split(":").filter(Boolean)
  return defaultSkillDirs(input.cwd ?? process.cwd())
}

function agentName(input: HookInput): string {
  return input.agent_type ?? input.agent_id ?? "claude-code"
}

function newAsk(meta: { model?: string; inputTokens?: number; outputTokens?: number }): Ask | undefined {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return undefined
  return createJev({
    apiKey,
    onMeta: (info) => Object.assign(meta, info),
    ...(process.env.SYSTEM_ONE_SERVER_URL ? { serverURL: process.env.SYSTEM_ONE_SERVER_URL } : {}),
  })
}

async function userPromptSubmit(input: HookInput): Promise<void> {
  const sessionID = input.session_id ?? "unknown"
  const state = readState(sessionID) ?? { at: Date.now(), calls: 0 }
  const messages = (state.messages ?? 0) + 1
  const meta: { model?: string; inputTokens?: number; outputTokens?: number } = {}
  const logTurn = (calls: number) => {
    logUsage({
      sessionID,
      messageID: `${sessionID}-${messages}`,
      agent: agentName(input),
      model: meta.model ?? "unknown",
      input: meta.inputTokens ?? 0,
      output: meta.outputTokens ?? 0,
      promptChars: (input.prompt ?? "").length,
      calls,
      time: Date.now(),
    })
  }
  const skills = scanSkillDirs(skillDirs(input))
  if (skills.length === 0) {
    logTurn(state.calls)
    return
  }
  if (state.calls >= CAP) {
    logDecision({ sessionID, hook: "UserPromptSubmit", chosen: "no-change", event: "cap", calls: state.calls })
    logTurn(state.calls)
    return
  }
  if (state.calls + 1 === Math.floor(CAP * WARN_AT)) {
    logDecision({ sessionID, hook: "UserPromptSubmit", chosen: "no-change", event: "warn", calls: state.calls + 1 })
  }

  const ask = newAsk(meta)

  const started = Date.now()
  const agents = scanAgentDirs(defaultAgentDirs(input.cwd ?? process.cwd()))
  // Skill and subagent decisions are independent Jev calls, so they run in parallel.
  const [decision, agent] = await Promise.all([
    decide(ask, input.prompt ?? "", skills),
    ask ? selectAgent(ask, { request: input.prompt ?? "", agents }) : Promise.resolve(null),
  ])
  const calls = state.calls + (ask ? 2 : 1)
  const context: string[] = []

  if (decision.kind === "skill") {
    const skill = skills.find((candidate) => candidate.id === decision.id)
    writeState(sessionID, { decision: "skill", at: Date.now(), calls, messages })
    if (skill) context.push(injectionFor(skill))
  } else if (decision.kind === "none") {
    writeState(sessionID, { decision: "none", at: Date.now(), calls, messages })
    context.push(NONE_CONTEXT)
  } else {
    writeState(sessionID, { at: Date.now(), calls, messages })
  }
  if (agent) context.push(agentHint(agent))
  if (context.length > 0) {
    emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context.join("\n\n") } })
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

  logTurn(calls)
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

async function stop(input: HookInput): Promise<void> {
  if (!verifyEnabled()) return
  if (input.stop_hook_active) return

  const meta: { model?: string; inputTokens?: number; outputTokens?: number } = {}
  const ask = newAsk(meta)
  if (!ask) return

  const sessionID = input.session_id ?? "unknown"
  const state = readState(sessionID) ?? { at: Date.now(), calls: 0 }
  if (state.calls >= CAP) {
    logDecision({ sessionID, hook: "Stop", chosen: "no-change", event: "cap", calls: state.calls })
    return
  }

  const started = Date.now()
  const hint = await decideVerification(ask, { messages: verifyMessages(input) })
  const calls = state.calls + 1
  const next: SessionState = { at: Date.now(), calls }
  if (state.messages !== undefined) next.messages = state.messages
  if (state.decision !== undefined) next.decision = state.decision
  writeState(sessionID, next)

  logDecision({
    sessionID,
    hook: "Stop",
    chosen: hint ? "nudge" : "hold",
    model: meta.model,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    latencyMs: Date.now() - started,
    calls,
    time: Date.now(),
  })

  if (hint) emit({ decision: "block", reason: hint.hint })
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
  else if (input.hook_event_name === "Stop") await stop(input)
}

if (import.meta.main) {
  main().catch(() => {})
}
