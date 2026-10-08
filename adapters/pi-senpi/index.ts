// Jev (TypeSafe System One) routing for the pi / senpi harness.
//
// The decision logic is not reimplemented here: skill routing comes from
// adapters/claude-code/lib/decide.ts, tool routing and the verification gate from
// src/tools.ts and src/verify.ts, the cache helpers from the OpenCode plugin's
// index.ts, and every threshold from spec/decisions.json through src/policy.ts.
//
// Contract, identical to the OpenCode plugin and the Claude Code adapter:
// FAIL OPEN. No key, timeout, non-2xx, malformed answer, low confidence, unknown id
// or an exhausted spend cap leaves the request untouched and never throws.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createCache, createWarnOnce, hashKey } from "../../index"
import { createJev, resolveKey, type Ask } from "../../src/jev"
import { createRecorder, summarize, type Recorder, type UsageSample } from "../../src/observe"
import { defaultToolRouting, applyToolDecision, renderState, routeTools, type ToolDecision } from "../../src/tools"
import { decideVerification } from "../../src/verify"
import { NONE_CONTEXT, decide, injectionFor, type Decision } from "../claude-code/lib/decide"
import { scanSkillDirs, type SkillFile } from "../claude-code/lib/roster"

export const HARNESS = "pi"

/** Structural subset of the pi `ExtensionAPI` this adapter uses. */
export interface PiToolInfo {
  name: string
  description?: string
}

export interface PiExtensionAPI {
  readonly cwd: string
  on(event: string, handler: (event: any, ctx: any) => any, options?: unknown): void
  getAllTools(): PiToolInfo[]
  setActiveTools(toolNames: string[]): void
  getFlag?(name: string): boolean | string | undefined
}

export interface PiContext {
  agentDir: string
  cwd: string
  sessionManager?: { getSessionId?(): string | undefined }
  model?: { id?: string }
}

export interface PiSkillRouting {
  enabled: boolean
}

export interface PiOptions {
  apiKey?: string
  model: string
  serverURL?: string
  timeoutMs: number
  debug: boolean
  skills: PiSkillRouting
  tools: typeof defaultToolRouting & { enabled: boolean }
  control: { verify: boolean }
  observe: { enabled: boolean; file?: string }
  spend: { maxCallsPerSession: number; warnAt: number }
  skillDirs?: string[]
  decisionsFile?: string
  sessionID?: string
}

const ENV = process.env

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function dirList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((dir): dir is string => typeof dir === "string" && dir !== "")
  const single = text(value)
  return single ? single.split(":").filter(Boolean) : undefined
}

/** Reads `<agentDir>/settings.json`'s `systemOne` block; a broken file is inert. */
export function readPiSettings(agentDir: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object") return {}
  const block = (parsed as Record<string, unknown>).systemOne
  return block && typeof block === "object" ? (block as Record<string, unknown>) : {}
}

/** Settings first, environment second, contract defaults last. */
export function readPiOptions(raw: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = ENV): PiOptions {
  const skills = (raw.skills ?? {}) as Record<string, unknown>
  const tools = (raw.tools ?? {}) as Record<string, unknown>
  const control = (raw.control ?? {}) as Record<string, unknown>
  const observe = (raw.observe ?? {}) as Record<string, unknown>
  const spend = (raw.spend ?? {}) as Record<string, unknown>

  const options: PiOptions = {
    apiKey: text(raw.apiKey) ?? text(env.SYSTEM_ONE_API_KEY),
    model: text(raw.model) ?? env.SYSTEM_ONE_MODEL ?? "~typesafe/jev-latest",
    serverURL: text(raw.serverURL) ?? text(env.SYSTEM_ONE_SERVER_URL),
    timeoutMs: num(raw.timeoutMs ?? env.SYSTEM_ONE_TIMEOUT_MS, 1000),
    debug: bool(raw.debug ?? env.SYSTEM_ONE_DEBUG, false),
    skills: { enabled: bool(skills.enabled, true) },
    tools: {
      ...defaultToolRouting,
      enabled: bool(tools.enabled, true),
      maxTools: num(tools.maxTools, defaultToolRouting.maxTools),
      minToolProbability: num(tools.minToolProbability, defaultToolRouting.minToolProbability),
      needsToolThreshold: num(tools.needsToolThreshold, defaultToolRouting.needsToolThreshold),
      minConfidence: num(tools.minConfidence, defaultToolRouting.minConfidence),
      alwaysVisible: Array.isArray(tools.alwaysVisible)
        ? tools.alwaysVisible.filter((name): name is string => typeof name === "string")
        : defaultToolRouting.alwaysVisible,
      stateBudget: num(tools.stateBudget, defaultToolRouting.stateBudget),
    },
    control: { verify: bool(control.verify, false) },
    observe: { enabled: bool(observe.enabled, false), file: text(observe.file) },
    spend: {
      maxCallsPerSession: num(spend.maxCallsPerSession, 500),
      warnAt: num(spend.warnAt, 0.8),
    },
    skillDirs: dirList(raw.skillDirs) ?? dirList(env.SYSTEM_ONE_SKILL_DIRS),
    decisionsFile: text(raw.decisionsFile) ?? text(env.SYSTEM_ONE_DECISIONS_FILE),
    sessionID: text(raw.sessionID),
  }
  return options
}

/** pi keeps skills in `<agentDir>/skills` and the shared `~/.agents/skills`. */
export function defaultPiSkillDirs(agentDir: string, cwd: string): string[] {
  return [join(agentDir, "skills"), join(envHome(), ".agents", "skills"), join(cwd, ".agents", "skills")]
}

function envHome(): string {
  return ENV.HOME ?? ""
}

export type DecisionLogger = (record: Record<string, unknown>) => void

/** One JSON object per Jev decision, tagged with the harness. Never throws. */
export function createDecisionLog(file: string): DecisionLogger {
  return (record) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify({ kind: "decision", harness: HARNESS, time: Date.now(), ...record }) + "\n")
    } catch {
      // observability must never break a turn
    }
  }
}

/** Counts Jev calls for one session and refuses them past the contract cap. */
export function createSpendGuard(options: { max: number; warnAt: number; log?: DecisionLogger; sessionID: string }) {
  let calls = 0
  return {
    get calls(): number {
      return calls
    },
    take(): boolean {
      if (calls >= options.max) {
        options.log?.({ sessionID: options.sessionID, event: "capped", calls })
        return false
      }
      calls += 1
      if (calls === Math.max(1, Math.floor(options.max * options.warnAt))) {
        options.log?.({ sessionID: options.sessionID, event: "spend-warning", calls, cap: options.max })
      }
      return true
    },
  }
}

const HINT_PREFIX = "<system_one_"

function isHintMessage(message: unknown): boolean {
  const candidate = message as { role?: unknown; content?: unknown } | null
  if (!candidate || candidate.role !== "user" || !Array.isArray(candidate.content)) return false
  const [part] = candidate.content as Array<{ type?: unknown; text?: unknown }>
  return part?.type === "text" && typeof part.text === "string" && part.text.startsWith(HINT_PREFIX)
}

/**
 * Replaces any system-one hint this extension appended earlier with the current
 * hints, so a hint never accumulates across dispatches. Returns undefined when
 * the request would be unchanged, which is the fail-open path.
 */
export function injectHints<T>(messages: readonly T[], hints: readonly string[]): { messages: T[] } | undefined {
  const kept = [...messages]
  while (kept.length > 0 && isHintMessage(kept[kept.length - 1])) kept.pop()
  if (hints.length === 0) return kept.length === messages.length ? undefined : { messages: kept }
  kept.push({ role: "user", content: [{ type: "text", text: hints.join("\n\n") }] } as unknown as T)
  return { messages: kept }
}

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

/**
 * pi and OpenCode disagree on message shape, so this maps pi's assistant message
 * onto the shared `UsageSample` the recorder already writes and summarizes.
 */
export function piUsageSample(message: unknown, sessionID: string): UsageSample | null {
  if (!message || typeof message !== "object") return null
  const candidate = message as {
    role?: unknown
    id?: unknown
    model?: { id?: unknown; provider?: unknown }
    usage?: Record<string, unknown>
    cost?: { total?: unknown }
    time?: { created?: unknown }
  }
  if (candidate.role !== "assistant" || typeof candidate.id !== "string") return null
  const usage = candidate.usage
  if (!usage || typeof usage !== "object") return null
  return {
    sessionID,
    messageID: candidate.id,
    agent: typeof candidate.model?.provider === "string" ? candidate.model.provider : "?",
    model: `${typeof candidate.model?.provider === "string" ? candidate.model.provider : "?"}/${typeof candidate.model?.id === "string" ? candidate.model.id : "?"}`,
    input: finite(usage.input),
    output: finite(usage.output),
    reasoning: finite(usage.reasoning),
    cacheRead: finite(usage.cacheRead),
    cacheWrite: finite(usage.cacheWrite),
    cost: finite(candidate.cost?.total) || undefined,
    time: finite(candidate.time?.created),
  }
}

export default function jevForPi(pi: PiExtensionAPI): void {
  let options: PiOptions | undefined
  let ask: Ask | undefined
  let warnOnce: (sessionID: string, ...args: unknown[]) => void
  let log: DecisionLogger = () => {}
  let sessionID = "pi"
  let agentDir = ""
  let spend: ReturnType<typeof createSpendGuard>
  const skillCache = createCache<Decision>()
  const toolCache = createCache<ToolDecision | null>()
  const verifyCache = createCache<{ hint: string } | null>()
  let pendingSkill: string | undefined
  const seenSample = new Set<string>()
  let recorder: Recorder = createRecorder()
  const recorded: UsageSample[] = []

  const setup = (ctx: PiContext): PiOptions => {
    if (options) return options
    agentDir = ctx.agentDir
    sessionID = ctx.sessionManager?.getSessionId?.() ?? "pi"
    options = readPiOptions(readPiSettings(agentDir))
    if (options.sessionID) sessionID = options.sessionID
    warnOnce = createWarnOnce("[system-one]")
    const apiKey = resolveKey(options.apiKey ?? ENV.OPENROUTER_API_KEY)
    const routing = options.skills.enabled || options.tools.enabled
    if (apiKey) {
      ask = createJev({
        apiKey,
        model: options.model,
        timeoutMs: options.timeoutMs,
        ...(options.serverURL ? { serverURL: options.serverURL } : {}),
      })
    } else if (routing) {
      console.warn("[system-one] pi routing inert: set settings.json systemOne.apiKey or OPENROUTER_API_KEY")
    }
    log = createDecisionLog(
      options.decisionsFile ?? join(agentDir || ENV.TMPDIR || "/tmp", "system-one", "decisions.jsonl"),
    )
    spend = createSpendGuard({ max: options.spend.maxCallsPerSession, warnAt: options.spend.warnAt, log, sessionID })
    recorder = createRecorder({ ...(options.observe.file ? { file: options.observe.file } : {}) })
    return options
  }

  const askFor = (): Ask => async (input) => {
    if (!ask) throw new Error("system-one: no API key configured")
    try {
      return await ask(input)
    } catch (error) {
      warnOnce(sessionID, "jev request failed", error)
      throw error
    }
  }

  const logDecision = (hook: string, record: Record<string, unknown>): void => {
    log({ sessionID, hook, ...record })
    if (options?.debug) console.log("[system-one]", hook, record)
  }

  const roster = (): SkillFile[] => {
    const dirs = options?.skillDirs?.length ? options.skillDirs : defaultPiSkillDirs(agentDir, pi.cwd)
    return scanSkillDirs(dirs)
  }

  pi.on("input", async (event: { inputId: string; text: string }, ctx: PiContext) => {
    const current = setup(ctx)
    if (!current.skills.enabled || !ask) return
    try {
      const skills = roster()
      if (skills.length === 0) return
      const key = `skills:${event.inputId}:${hashKey(`${event.text}|${skills.map((skill) => skill.id).join(",")}`)}`
      let decision = skillCache.get(key)
      if (decision === undefined) {
        if (!spend.take()) {
          logDecision("input", { chosen: "no-change", event: "cap", calls: spend.calls })
          return
        }
        decision = await decide(askFor(), event.text, skills)
        skillCache.set(key, decision)
        logDecision("input", {
          chosen: decision.kind,
          ...(decision.kind === "skill" ? { id: decision.id } : {}),
          calls: spend.calls,
        })
      }
      if (decision.kind === "no-change") return
      if (decision.kind === "none") {
        pendingSkill = NONE_CONTEXT
        return
      }
      const skill = skills.find((candidate) => candidate.id === decision.id)
      if (skill) pendingSkill = injectionFor(skill)
    } catch (error) {
      warnOnce(sessionID, "skill routing failed", error)
    }
  })

  pi.on("before_agent_start", async (event: { systemPrompt: string; preview?: boolean }, ctx: PiContext) => {
    setup(ctx)
    if (event.preview) return
    const injection = pendingSkill
    if (!injection) return
    pendingSkill = undefined
    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` }
  })

  pi.on("context", async (event: { messages: readonly unknown[] }, ctx: PiContext) => {
    const current = setup(ctx)
    if (!ask) return
    const hints: string[] = []
    const agent = ctx.model?.id ?? "pi"
    try {
      if (current.tools.enabled) {
        const catalog = Object.fromEntries(pi.getAllTools().map((tool) => [tool.name, { description: tool.description ?? "" }]))
        const state = renderState({ agent, messages: event.messages as never, budget: current.tools.stateBudget })
        const key = `tools:${hashKey(`${agent}|${state}|${Object.keys(catalog).join(",")}`)}`
        let decision = toolCache.get(key)
        if (decision === undefined) {
          if (spend.take()) {
            decision = await routeTools(askFor(), { state, catalog, config: current.tools })
            toolCache.set(key, decision)
            logDecision("context", {
              chosen: decision ? (decision.start ?? "none") : "no-change",
              tools: decision?.tools,
              needsTool: decision?.needsTool,
              filtered: decision?.filtered,
              calls: spend.calls,
            })
          } else {
            logDecision("context", { chosen: "no-change", event: "cap", calls: spend.calls })
          }
        }
        if (decision) {
          const tools: Record<string, unknown> = {}
          for (const name of Object.keys(catalog)) tools[name] = catalog[name]
          const system: Array<{ type: string; text: string }> = []
          applyToolDecision(tools, system, decision)
          pi.setActiveTools(Object.keys(tools))
          hints.push(...system.map((entry) => entry.text))
        }
      }

      if (current.control.verify) {
        const key = `verify:${hashKey(JSON.stringify(event.messages))}`
        let verification = verifyCache.get(key)
        if (verification === undefined) {
          if (spend.take()) {
            verification = await decideVerification(askFor(), { messages: event.messages as never })
            verifyCache.set(key, verification)
            logDecision("context", { chosen: verification ? "verify-hint" : "verify-skip", calls: spend.calls })
          }
        }
        if (verification) hints.push(verification.hint)
      }
    } catch (error) {
      warnOnce(sessionID, "context routing failed", error)
    }
    return injectHints(event.messages, hints)
  })

  pi.on("message_end", async (event: { message: unknown }, ctx: PiContext) => {
    const current = setup(ctx)
    if (!current.observe.enabled) return
    try {
      const sample = piUsageSample(event.message, sessionID)
      if (!sample || seenSample.has(sample.messageID)) return
      seenSample.add(sample.messageID)
      recorded.push(sample)
      if (recorded.length >= 5) {
        recorder.flush(recorded.splice(0))
        logDecision("observe", { event: "usage", summary: summarize(recorded) })
      }
    } catch (error) {
      warnOnce(sessionID, "usage recording failed", error)
    }
  })

  pi.on("session_shutdown", async (_event: unknown, ctx: PiContext) => {
    setup(ctx)
    try {
      if (recorded.length > 0) recorder.flush(recorded.splice(0))
    } catch {
      // shutdown must not throw
    }
  })
}
