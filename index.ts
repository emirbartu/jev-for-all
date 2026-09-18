import { Plugin } from "@opencode/plugin"
import { createJev } from "./src/jev"
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
  agents?: string[]
  skills: ResolvedSkills
  tools: ResolvedTools
}

export function readOptions(raw: Record<string, unknown>): ResolvedOptions {
  const tools = (raw.tools ?? {}) as Record<string, unknown>
  const skills = (raw.skills ?? {}) as Record<string, unknown>
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)
  const strings = (value: unknown, fallback: string[]) =>
    Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : fallback
  const agents = strings(raw.agents, [])

  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    model: typeof raw.model === "string" ? raw.model : "jev-latest",
    timeoutMs: number(raw.timeoutMs, 1000),
    debug: bool(raw.debug, false),
    agents: agents.length > 0 ? agents : undefined,
    skills: {
      enabled: bool(skills.enabled, true),
      gateThreshold: number(skills.gateThreshold, defaultSkillRouting.gateThreshold),
      rerank:
        skills.rerank === true || skills.rerank === false ? (skills.rerank as boolean) : defaultSkillRouting.rerank,
      rerankAbove: number(skills.rerankAbove, defaultSkillRouting.rerankAbove),
      rerankBelowP: number(skills.rerankBelowP, defaultSkillRouting.rerankBelowP),
      shortlist: number(skills.shortlist, defaultSkillRouting.shortlist),
      fitsThreshold: number(skills.fitsThreshold, defaultSkillRouting.fitsThreshold),
      minConfidence: number(skills.minConfidence, defaultSkillRouting.minConfidence),
    },
    tools: {
      enabled: bool(tools.enabled, true),
      maxTools: number(tools.maxTools, defaultToolRouting.maxTools),
      minToolProbability: number(tools.minToolProbability, defaultToolRouting.minToolProbability),
      needsToolThreshold: number(tools.needsToolThreshold, defaultToolRouting.needsToolThreshold),
      minConfidence: number(tools.minConfidence, defaultToolRouting.minConfidence),
      alwaysVisible: strings(tools.alwaysVisible, defaultToolRouting.alwaysVisible),
      stateBudget: number(tools.stateBudget, defaultToolRouting.stateBudget),
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
    const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY
    if (!apiKey) {
      console.warn("[system-one] disabled: set options.apiKey or TYPESAFE_API_KEY")
      return
    }

    const ask = createJev({ apiKey, model: options.model, timeoutMs: options.timeoutMs })
    const skillCache = createCache<{ id: string } | null>()
    const toolCache = createCache<ToolDecision | null>()
    const log = (...args: unknown[]) => {
      if (options.debug) console.log("[system-one]", ...args)
    }
    const warnOnce = createWarnOnce()
    const agentEnabled = (agent: string) => !options.agents || options.agents.includes(agent)

    const registrations = [
      await ctx.session.hook("prompt", async (event) => {
        if (!options.skills.enabled) return
        try {
          const skills = (await ctx.skill.list()).data
          const key = `skills:${event.sessionID}:${hashKey(event.prompt.text)}`
          let decision = skillCache.get(key)
          if (decision === undefined) {
            decision = await selectSkill(ask, { request: event.prompt.text, skills, config: options.skills })
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
            decision = await routeTools(ask, { state, catalog, config: options.tools })
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
      for (const registration of registrations) await registration.dispose()
    }
  },
})
