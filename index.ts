import { Plugin } from "@opencode/plugin"
import { createJev, type Ask } from "./src/jev"
import { applySkillDecision, defaultSkillRouting, selectSkill, type SkillRoutingConfig } from "./src/skills"
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

export interface ResolvedOptions {
  apiKey?: string
  model: string
  timeoutMs: number
  debug: boolean
  serverURL?: string
  agents?: string[]
  skills: ResolvedSkills
  tools: ResolvedTools
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
    if (!apiKey) {
      console.warn("[system-one] disabled: set options.apiKey or OPENROUTER_API_KEY")
      return
    }

    const ask = createJev({ apiKey, model: options.model, timeoutMs: options.timeoutMs, serverURL: options.serverURL })
    const skillCache = createCache<{ id: string } | null>()
    const toolCache = createCache<ToolDecision | null>()
    const log = (...args: unknown[]) => {
      if (options.debug) console.log("[system-one]", ...args)
    }
    const warnOnce = createWarnOnce()
    const askFor = (sessionID: string): Ask => async (input) => {
      try {
        return await ask(input)
      } catch (error) {
        warnOnce(sessionID, "jev request failed", error)
        throw error
      }
    }
    const agentEnabled = (agent: string) => !options.agents || options.agents.includes(agent)

    const registrations = [
      await ctx.session.hook("prompt", async (event) => {
        if (!options.skills.enabled) return
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

    return async () => {
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    }
  },
})
