import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type Ask, asChoice, asNoul } from "./jev"
import { type Tier, policy } from "./policy"

export interface TierDecision {
  tier: Tier
  probabilities: Record<string, number>
  // Jev's probability that the request needs an external service; undefined if it did not answer.
  external?: number
  // True when Jev's answer was used as is; false when the safe fallback was applied.
  confident: boolean
}

// One Jev choice over the three tiers. Asymmetric on purpose: running a hard task on a weak model
// costs quality, running an easy one on a strong model only costs money, so "light" and "heavy"
// need a higher probability than "standard" and anything unclear falls back to "standard".
export async function selectTier(ask: Ask, request: string): Promise<TierDecision | null> {
  const config = policy.models
  if (request.trim() === "") return null
  try {
    const answers = await ask({
      state: { request },
      questions: {
        [config.ids.tier]: { type: "choice", instructions: config.questions.tier, criteria: config.criteria },
        [config.ids.external]: { type: "noul", instructions: config.questions.external },
      },
    })
    const choice = asChoice(answers[config.ids.tier])
    if (!choice || !config.tiers.includes(choice.choice as Tier)) return null
    return { tier: pickTier(choice.probabilities), probabilities: choice.probabilities, external: asNoul(answers[config.ids.external])?.noul, confident: true }
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

// User overrides live in ~/.config/jev-for-all/models.json: { "claude": { "light": "haiku", ... }, ... }
export function loadCatalog(path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jev-for-all", "models.json")) {
  const catalog = structuredClone(policy.models.catalog)
  try {
    if (existsSync(path)) {
      const user = JSON.parse(readFileSync(path, "utf8")) as Record<string, Partial<Record<Tier, string>>>
      for (const [harness, tiers] of Object.entries(user)) catalog[harness] = { ...catalog[harness], ...tiers } as Record<Tier, string>
    }
  } catch {}
  return catalog
}

export function modelFor(harness: string, tier: Tier): string | undefined {
  return loadCatalog()[harness]?.[tier]
}

// A lean session drops skill listings and MCP servers, which were ~40% of the input tokens of a trivial
// edit in our measurement. Only worth it, and only safe, for a light task Jev is sure needs nothing external.
export function isLean(decision: TierDecision | null): boolean {
  return decision?.tier === "light" && decision.external !== undefined && decision.external <= policy.models.lean.externalMax
}
