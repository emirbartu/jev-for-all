import { Plugin } from "@opencode/plugin"
import { createJev, type Ask } from "./src/jev"
import { applySkillDecision, defaultSkillRouting, selectSkill, type SkillRoutingConfig } from "./src/skills"
import { createRecorder, summarize, type UsageSample } from "./src/observe"
import { policy } from "./src/policy"
import { browserTool, defaultBrowser, type BrowserConfig } from "./src/browser"
import { decideVerification, renderVerifyState } from "./src/verify"
import {
  applyToolDecision,
  defaultToolRouting,
  renderState,
  routeTools,
  type ToolDecision,
  type ToolRoutingConfig,
} from "./src/tools"

export interface ResolvedSkills extends SkillRoutingConfig {
  enabled: boolean
}

export interface ResolvedTools extends ToolRoutingConfig {
  enabled: boolean
}

export interface ResolvedObserve {
  enabled: boolean
  file?: string
  retain: number
}

export interface ResolvedOptions {
  apiKey?: string
  model: string
  timeoutMs: number
  debug: boolean
  serverURL?: string
  agents?: string[]
  skills: ResolvedSkills
  tools: ResolvedTools
  observe: ResolvedObserve
  control: { verify: boolean }
  browser: BrowserConfig
}

export function readOptions(raw: Record<string, unknown>): ResolvedOptions {
  const tools = (raw.tools ?? {}) as Record<string, unknown>
  const skills = (raw.skills ?? {}) as Record<string, unknown>
  const warn = (key: string, fallback: unknown) =>
    console.warn(`[jev-for-all] invalid option ${key}; using ${fallback}`)
  const number = (key: string, value: unknown, fallback: number) => {
    if (value === undefined) return fallback
    if (typeof value === "number" && Number.isFinite(value)) return value
    warn(key, fallback)
    return fallback
  }
  const bool = (key: string, value: unknown, fallback: boolean) => {
    if (value === undefined) return fallback
    if (typeof value === "boolean") return value
    warn(key, fallback)
    return fallback
  }
  const strings = (key: string, value: unknown, fallback: string[]) => {
    if (value === undefined) return fallback
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[]
    warn(key, fallback)
    return fallback
  }
  const rerank = (value: unknown): boolean | "auto" => {
    if (value === undefined) return defaultSkillRouting.rerank
    if (value === true || value === false) return value
    warn("skills.rerank", defaultSkillRouting.rerank)
    return defaultSkillRouting.rerank
  }
  const agents = strings("agents", raw.agents, [])
  const observe = (raw.observe ?? {}) as Record<string, unknown>
  const control = (raw.control ?? {}) as Record<string, unknown>
  const browser = (raw.browser ?? {}) as Record<string, unknown>
  const text = (key: string, value: unknown, fallback: string) => {
    if (value === undefined) return fallback
    if (typeof value === "string" && value.trim()) return value
    warn(key, fallback)
    return fallback
  }

  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    model: typeof raw.model === "string" ? raw.model : "~typesafe/jev-latest",
    timeoutMs: number("timeoutMs", raw.timeoutMs, 2500),
    debug: bool("debug", raw.debug, false),
    serverURL: typeof raw.serverURL === "string" ? raw.serverURL : undefined,
    agents: agents.length > 0 ? agents : undefined,
    skills: {
      enabled: bool("skills.enabled", skills.enabled, true),
      gateThreshold: number("skills.gateThreshold", skills.gateThreshold, defaultSkillRouting.gateThreshold),
      advisoryThreshold: number(
        "skills.advisoryThreshold",
        skills.advisoryThreshold,
        defaultSkillRouting.advisoryThreshold,
      ),
      mechanicalVeto: number(
        "skills.mechanicalVeto",
        skills.mechanicalVeto,
        defaultSkillRouting.mechanicalVeto,
      ),
      rerank: rerank(skills.rerank),
      rerankAbove: number("skills.rerankAbove", skills.rerankAbove, defaultSkillRouting.rerankAbove),
      rerankBelowP: number("skills.rerankBelowP", skills.rerankBelowP, defaultSkillRouting.rerankBelowP),
      shortlist: number("skills.shortlist", skills.shortlist, defaultSkillRouting.shortlist),
      fitsThreshold: number("skills.fitsThreshold", skills.fitsThreshold, defaultSkillRouting.fitsThreshold),
      minConfidence: number("skills.minConfidence", skills.minConfidence, defaultSkillRouting.minConfidence),
    },
    tools: {
      enabled: bool("tools.enabled", tools.enabled, true),
      maxTools: number("tools.maxTools", tools.maxTools, defaultToolRouting.maxTools),
      minToolProbability: number(
        "tools.minToolProbability",
        tools.minToolProbability,
        defaultToolRouting.minToolProbability,
      ),
      needsToolThreshold: number(
        "tools.needsToolThreshold",
        tools.needsToolThreshold,
        defaultToolRouting.needsToolThreshold,
      ),
      minConfidence: number("tools.minConfidence", tools.minConfidence, defaultToolRouting.minConfidence),
      alwaysVisible: strings("tools.alwaysVisible", tools.alwaysVisible, defaultToolRouting.alwaysVisible),
      stateBudget: number("tools.stateBudget", tools.stateBudget, defaultToolRouting.stateBudget),
    },
    observe: {
      enabled: bool("observe.enabled", observe.enabled, false),
      file: typeof observe.file === "string" ? observe.file : undefined,
      retain: number("observe.retain", observe.retain, 20),
    },
    control: {
      verify: bool("control.verify", control.verify, false),
    },
    browser: {
      enabled: bool("browser.enabled", browser.enabled, defaultBrowser.enabled),
      jevDir: text("browser.jevDir", browser.jevDir, defaultBrowser.jevDir),
      envFile: text("browser.envFile", browser.envFile, defaultBrowser.envFile),
      uvPath: text("browser.uvPath", browser.uvPath, defaultBrowser.uvPath),
      timeoutMs: number("browser.timeoutMs", browser.timeoutMs, defaultBrowser.timeoutMs),
      maxSteps: number("browser.maxSteps", browser.maxSteps, defaultBrowser.maxSteps),
    },
  }
}

export function createCache<T>(options: { max?: number; ttlMs?: number; now?: () => number } = {}) {
  const max = options.max ?? policy.cache.max
  const ttlMs = options.ttlMs ?? policy.cache.ttlMs
  const now = options.now ?? Date.now
  const entries = new Map<string, { value: T; expires: number }>()

  return {
    get(key: string): T | undefined {
      const hit = entries.get(key)
      if (!hit) return undefined
      if (hit.expires <= now()) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, hit)
      return hit.value
    },
    set(key: string, value: T): void {
      entries.delete(key)
      entries.set(key, { value, expires: now() + ttlMs })
      while (entries.size > max) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}

export function createSpendGuard(
  options: { cap?: number; warnAt?: number; warn?: (sessionID: string, calls: number, cap: number) => void } = {},
) {
  const cap = options.cap ?? policy.spend.maxCallsPerSession
  const warnAt = options.warnAt ?? policy.spend.warnAt
  const calls = new Map<string, number>()
  const warned = new Set<string>()

  return {
    cap,
    calls: (sessionID: string): number => calls.get(sessionID) ?? 0,
    /** Counts one Jev call for the session; false means the contract cap is spent and the call must not go out. */
    take(sessionID: string): boolean {
      const used = calls.get(sessionID) ?? 0
      if (used >= cap) return false
      const next = used + 1
      calls.set(sessionID, next)
      if (next >= Math.floor(cap * warnAt) && !warned.has(sessionID)) {
        warned.add(sessionID)
        options.warn?.(sessionID, next, cap)
      }
      return true
    },
  }
}

/** Wraps an Ask so callers can tell a transport failure from Jev's own "no decision" answer. */
export function createAskTracker(ask: Ask): { ask: Ask; failed: () => boolean } {
  let failed = false
  return {
    ask: async (input) => {
      try {
        return await ask(input)
      } catch (error) {
        failed = true
        throw error
      }
    },
    failed: () => failed,
  }
}

export function hashKey(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

export function createWarnOnce(prefix = "[jev-for-all]") {
  const warned = new Set<string>()
  return (sessionID: string, ...args: unknown[]) => {
    if (warned.has(sessionID)) return
    warned.add(sessionID)
    console.warn(prefix, ...args)
  }
}

export default Plugin.define({
  id: "jev-for-all",
  async setup(ctx) {
    const options = readOptions((ctx.options ?? {}) as Record<string, unknown>)
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY
    const routing = options.skills.enabled || options.tools.enabled
    if (!apiKey) {
      if (routing) console.warn("[jev-for-all] routing disabled: set options.apiKey or OPENROUTER_API_KEY")
      // browser_task spawns its own process and reads its own credentials, so it survives a missing key.
      if (!options.observe.enabled && !options.browser.enabled) return
    }
    const skillCache = createCache<{ id: string } | null>()
    const toolCache = createCache<ToolDecision | null>()
    const verifyCache = createCache<{ hint: string } | null>()
    const log = (...args: unknown[]) => {
      if (options.debug) console.log("[jev-for-all]", ...args)
    }
    const warnOnce = createWarnOnce()
    const recorder = createRecorder({ file: options.observe.file, maxSessions: options.observe.retain })
    const observeAbort = new AbortController()
    const spend = createSpendGuard({
      warn: (sessionID, calls, cap) => warnOnce(sessionID, `jev spend warning: call ${calls} of ${cap} this session`),
    })
    let jevRecords = 0
    const recordJev = (sessionID: string, meta: { model?: string; inputTokens?: number; outputTokens?: number }) => {
      if (!options.observe.enabled) return
      jevRecords += 1
      recorder.flush([
        {
          sessionID,
          messageID: `jev:${jevRecords}`,
          agent: "jev",
          model: meta.model ?? options.model,
          input: meta.inputTokens ?? 0,
          output: meta.outputTokens ?? 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          time: Date.now(),
        },
      ])
    }
    // One transport per session, so onMeta knows which session the tokens belong to. The cache bounds it.
    const transports = createCache<Ask>()
    const askFor = (sessionID: string): Ask => {
      const cached = transports.get(sessionID)
      if (cached) return cached
      if (!apiKey) return () => Promise.reject(new Error("jev-for-all: no API key configured"))
      const ask = createJev({
        apiKey,
        model: options.model,
        timeoutMs: options.timeoutMs,
        serverURL: options.serverURL,
        onMeta: (meta) => recordJev(sessionID, meta),
      })
      const guarded: Ask = async (input) => {
        if (!spend.take(sessionID)) {
          log("jev call skipped: spend cap reached", sessionID)
          return {}
        }
        try {
          return await ask(input)
        } catch (error) {
          warnOnce(sessionID, "jev request failed", error)
          throw error
        }
      }
      transports.set(sessionID, guarded)
      return guarded
    }
    const agentEnabled = (agent: string) => !options.agents || options.agents.includes(agent)

    if (options.observe.enabled) {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: observeAbort.signal })) {
            if (
              event.type !== "session.idle" &&
              event.type !== "session.execution.succeeded" &&
              event.type !== "session.execution.failed" &&
              event.type !== "session.execution.interrupted"
            ) {
              continue
            }
            const sessionID = event.data.sessionID
            try {
              const messages = await ctx.session.context({ sessionID })
              const samples = recorder.take(sessionID, messages)
              if (samples.length === 0) continue
              recorder.flush(samples)
              const key = `observe/usage/${sessionID}`
              const previous = ((await ctx.storage.get(key)) as UsageSample[] | undefined) ?? []
              const stored = [...previous, ...samples].slice(-500) as unknown as Parameters<typeof ctx.storage.set>[1]
              await ctx.storage.set(key, stored)
              log("usage", summarize(samples))
            } catch (error) {
              warnOnce(sessionID, "usage recording failed", error)
            }
          }
        } catch {
          // subscription ended
        }
      })()
    }

    const registrations = [
      await ctx.session.hook("prompt", async (event) => {
        if (!options.skills.enabled) return
        if (!apiKey) return
        try {
          const skills = (await ctx.skill.list()).data
          const key = `skills:${event.sessionID}:${hashKey(event.prompt.text + "|" + skills.map((skill) => skill.id).join(","))}`
          let decision = skillCache.get(key)
          if (decision === undefined) {
            const tracker = createAskTracker(askFor(event.sessionID))
            decision = await selectSkill(tracker.ask, {
              request: event.prompt.text,
              skills,
              config: options.skills,
            })
            // A timed-out or errored call is not a "no skill" answer; caching it would pin the
            // wrong decision for this prompt for the whole TTL.
            if (tracker.failed()) log("skill decision not cached: Jev unavailable")
            else skillCache.set(key, decision)
            log("skill decision", decision)
          }
          applySkillDecision(event.prompt as unknown as { skills?: Array<{ id: string }> }, decision)
        } catch (error) {
          warnOnce(event.sessionID, "skill routing failed", error)
        }
      }),
      await ctx.session.hook("context", async (event) => {
        if (!options.tools.enabled || !agentEnabled(event.agent)) return
        if (!apiKey) return
        try {
          const state = renderState({ agent: event.agent, messages: event.messages, budget: options.tools.stateBudget })
          const catalog = Object.fromEntries(
            Object.entries(event.tools).map(([name, tool]) => [name, { description: tool.description }]),
          )
          const key = `tools:${event.sessionID}:${hashKey(`${event.agent}|${state}|${Object.keys(catalog).join(",")}`)}`
          let decision = toolCache.get(key)
          if (decision === undefined) {
            const tracker = createAskTracker(askFor(event.sessionID))
            decision = await routeTools(tracker.ask, { state, catalog, config: options.tools })
            if (tracker.failed()) log("tool decision not cached: Jev unavailable")
            else toolCache.set(key, decision)
            log("tool decision", decision && { start: decision.start, tools: decision.tools, needsTool: decision.needsTool })
          }
          if (decision) applyToolDecision(event.tools, event.system, decision)
        } catch (error) {
          warnOnce(event.sessionID, "tool routing failed", error)
        }
      }),
      await ctx.session.hook("context", async (event) => {
        if (!options.control.verify || !agentEnabled(event.agent)) return
        if (!apiKey) return
        try {
          const state = renderVerifyState(event.messages as never)
          const key = `verify:${event.sessionID}:${hashKey(state)}`
          let decision = verifyCache.get(key)
          if (decision === undefined) {
            const tracker = createAskTracker(askFor(event.sessionID))
            decision = await decideVerification(tracker.ask, { messages: event.messages as never })
            if (tracker.failed()) log("verify decision not cached: Jev unavailable")
            else verifyCache.set(key, decision)
            log("verify decision", decision ? "hint" : "skip")
          }
          if (decision) event.system.push({ type: "text", text: decision.hint })
        } catch (error) {
          warnOnce(event.sessionID, "verification gate failed", error)
        }
      }),
    ]

    if (options.browser.enabled) {
      registrations.push(
        await ctx.tool.transform((editor) => {
          // The tool's input is a plain JSON Schema; importing effect's Tool.ValueSchema for it is not worth it.
          editor.add(browserTool({ config: options.browser, log }) as never)
        }),
      )
      log("browser tool registered", options.browser.jevDir)
    }

    return async () => {
      observeAbort.abort()
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    }
  },
})
