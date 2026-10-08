import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { configDir } from "./config"
import { asChoice, asNoul } from "./answers"
import type { Ask } from "./jev"
import { type Effort, type Tier, type TierConfig, policy } from "./policy"

export interface TierDecision {
  tier: Tier
  probabilities: Record<string, number>
  // Jev's probability that the request needs an external service; undefined if it did not answer.
  external?: number
  // Effort Jev chose for this request ("medium" when it was unsure); the tier's own setting may override it.
  effort: Effort
}

// One Jev call, three questions. The tier choice is asymmetric on purpose: running a hard task on a weak
// model costs quality, an easy one on a strong model only costs money, so "light" and "heavy" need a higher
// probability than "standard" and anything unclear falls back to "standard".
export async function selectTier(ask: Ask, request: string): Promise<TierDecision | null> {
  const config = policy.models
  if (request.trim() === "") return null
  try {
    const answers = await ask({
      state: { request },
      questions: {
        [config.ids.tier]: { type: "choice", instructions: config.questions.tier, criteria: config.criteria },
        [config.ids.external]: { type: "noul", instructions: config.questions.external },
        [config.ids.effort]: { type: "choice", instructions: config.questions.effort, criteria: config.effortCriteria },
      },
    })
    const choice = asChoice(answers[config.ids.tier])
    if (!choice || !config.tiers.includes(choice.choice as Tier)) return null
    return {
      tier: pickTier(choice.probabilities),
      probabilities: choice.probabilities,
      external: asNoul(answers[config.ids.external])?.noul,
      effort: pickEffort(asChoice(answers[config.ids.effort])?.probabilities),
    }
  } catch {
    return null
  }
}

export function pickTier(probabilities: Record<string, number>): Tier {
  const config = policy.models
  if ((probabilities.light ?? 0) >= config.lightMin) return "light"
  if ((probabilities.heavy ?? 0) >= config.heavyMin) return "heavy"
  return config.fallback
}

// The top effort level wins only when Jev is clearly behind it; otherwise "medium".
export function pickEffort(probabilities?: Record<string, number>): Effort {
  const config = policy.models.effort
  const [top, p] = Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1])[0] ?? []
  return top && (p ?? 0) >= config.minProbability && config.levels.includes(top as Effort) ? (top as Effort) : config.fallback
}

const order: Effort[] = ["low", "medium", "high", "xhigh", "max"]

// What to actually run for a decision: the tier's harness and model, with the effort it asks for
// ("auto" = what Jev chose, never below the tier's minEffort).
export interface Plan extends TierConfig {
  tier: Tier
  effort: Effort
  lean: boolean
}

export function resolvePlan(decision: TierDecision | null): Plan {
  const tier = decision?.tier ?? policy.models.fallback
  const config = loadTiers()[tier]
  let effort: Effort = config.effort === "auto" ? (decision?.effort ?? policy.models.effort.fallback) : config.effort
  if (config.minEffort && order.indexOf(effort) < order.indexOf(config.minEffort)) effort = config.minEffort
  return { ...config, tier, effort, lean: isLean(decision) && config.harness === "claude" }
}

// User overrides live in ~/.config/jev-for-all/models.json (created at install), per tier:
//   { "light": { "model": "opencode-go/glm-5.3" }, "standard": { "model": "haiku", "effort": "low" } }
export function loadTiers(path = join(configDir(), "models.json")): Record<Tier, TierConfig> {
  const tiers = structuredClone(policy.models.tierConfig)
  try {
    if (existsSync(path)) {
      const user = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<Tier, Partial<TierConfig>>>
      for (const tier of policy.models.tiers) if (user[tier]) tiers[tier] = { ...tiers[tier], ...user[tier] }
    }
  } catch {}
  return tiers
}

// A lean session drops skill listings and MCP servers, which were ~40% of the input tokens of a trivial
// edit in our measurement. Only worth it, and only safe, for a light task Jev is sure needs nothing external.
export function isLean(decision: TierDecision | null): boolean {
  return decision?.tier === "light" && decision.external !== undefined && decision.external <= policy.models.lean.externalMax
}
