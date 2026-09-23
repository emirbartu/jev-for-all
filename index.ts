import { Plugin } from "@opencode/plugin"
import { createJev, type Ask } from "./src/jev"
import { applySkillDecision, defaultSkillRouting, selectSkill, type SkillRoutingConfig } from "./src/skills"
import { createRecorder, summarize, type UsageSample } from "./src/observe"
import { browserTool, defaultBrowser, type BrowserConfig } from "./src/browser"
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
  browser: BrowserConfig
}

export function readOptions(raw: Record<string, unknown>): ResolvedOptions {
  const tools = (raw.tools ?? {}) as Record<string, unknown>
  const skills = (raw.skills ?? {}) as Record<string, unknown>
  const warn = (key: string, fallback: unknown) =>
    console.warn(`[system-one] invalid option ${key}; using ${fallback}`)
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
    timeoutMs: number("timeoutMs", raw.timeoutMs, 1000),
    debug: bool("debug", raw.debug, false),
    serverURL: typeof raw.serverURL === "string" ? raw.serverURL : undefined,
    agents: agents.length > 0 ? agents : undefined,
    skills: {
      enabled: bool("skills.enabled", skills.enabled, true),
      gateThreshold: number("skills.gateThreshold", skills.gateThreshold, defaultSkillRouting.gateThreshold),
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
  const max = options.max ?? 200
  const ttlMs = options.ttlMs ?? 600_000
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

export function hashKey(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

export function createWarnOnce() {
  const warned = new Set<string>()
  return (sessionID: string, ...args: unknown[]) => {
    if (warned.has(sessionID)) return
    warned.add(sessionID)
    console.warn("[system-one]", ...args)
  }
}

export default Plugin.define({
  id: "system-one",
  async setup(ctx) {
    const options = readOptions((ctx.options ?? {}) as Record<string, unknown>)
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY
    const routing = options.skills.enabled || options.tools.enabled
    if (!apiKey) {
      if (routing) console.warn("[system-one] routing disabled: set options.apiKey or OPENROUTER_API_KEY")
      // browser_task spawns its own process and reads its own credentials, so it survives a missing key.
      if (!options.observe.enabled && !options.browser.enabled) return
    }
    const ask = apiKey
      ? createJev({ apiKey, model: options.model, timeoutMs: options.timeoutMs, serverURL: options.serverURL })
      : undefined
    const skillCache = createCache<{ id: string } | null>()
    const toolCache = createCache<ToolDecision | null>()
    const log = (...args: unknown[]) => {
      if (options.debug) console.log("[system-one]", ...args)
    }
    const warnOnce = createWarnOnce()
    const askFor = (sessionID: string): Ask => async (input) => {
      if (!ask) throw new Error("system-one: no API key configured")
      try {
        return await ask(input)
      } catch (error) {
        warnOnce(sessionID, "jev request failed", error)
        throw error
      }
    }
    const agentEnabled = (agent: string) => !options.agents || options.agents.includes(agent)

    const recorder = createRecorder({ file: options.observe.file, maxSessions: options.observe.retain })
    const observeAbort = new AbortController()

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
        if (!ask) return
        try {
          const skills = (await ctx.skill.list()).data
          const key = `skills:${event.sessionID}:${hashKey(event.prompt.text + "|" + skills.map((skill) => skill.id).join(","))}`
          let decision = skillCache.get(key)
          if (decision === undefined) {
            decision = await selectSkill(askFor(event.sessionID), {
              request: event.prompt.text,
              skills,
              config: options.skills,
            })
            skillCache.set(key, decision)
            log("skill decision", decision)
          }
          applySkillDecision(event.prompt as unknown as { skills?: Array<{ id: string }> }, decision)
        } catch (error) {
          warnOnce(event.sessionID, "skill routing failed", error)
        }
      }),
      await ctx.session.hook("context", async (event) => {
        if (!options.tools.enabled || !agentEnabled(event.agent)) return
        if (!ask) return
        try {
          const state = renderState({ agent: event.agent, messages: event.messages, budget: options.tools.stateBudget })
          const catalog = Object.fromEntries(
            Object.entries(event.tools).map(([name, tool]) => [name, { description: tool.description }]),
          )
          const key = `tools:${event.sessionID}:${hashKey(`${event.agent}|${state}|${Object.keys(catalog).join(",")}`)}`
          let decision = toolCache.get(key)
          if (decision === undefined) {
            decision = await routeTools(askFor(event.sessionID), { state, catalog, config: options.tools })
            toolCache.set(key, decision)
            log("tool decision", decision && { start: decision.start, tools: decision.tools, needsTool: decision.needsTool })
          }
          if (decision) applyToolDecision(event.tools, event.system, decision)
        } catch (error) {
          warnOnce(event.sessionID, "tool routing failed", error)
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
