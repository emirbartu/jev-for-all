import spec from "../spec/decisions.json"

export interface SkillPolicy {
  gateThreshold: number
  advisoryThreshold: number
  mechanicalVeto: number
  rerank: boolean | "auto"
  rerankAbove: number
  rerankBelowP: number
  shortlist: number
  fitsThreshold: number
  minConfidence: number
  ids: {
    rank: string
    rerank: string
    gateActs: string
    gateProcedure: string
    gateProse: string
    advisory: string
    gateMechanical: string
    fits: string
  }
  questions: {
    rank: string
    rerank: string
    gateActs: string
    gateProcedure: string
    gateProse: string
    advisory: string
    gateMechanical: string
    fits: string
  }
  criteria: {
    withDescription: string
    withoutDescription: string
    withContent: string
    contentChars: number
  }
  injection: {
    chars: number
  }
}

export interface ToolPolicy {
  maxTools: number
  minToolProbability: number
  needsToolThreshold: number
  minConfidence: number
  alwaysVisible: string[]
  stateBudget: number
  ids: {
    next: string
    needsTool: string
  }
  questions: {
    next: string
    needsTool: string
  }
  hints: {
    open: string
    close: string
    noTool: string
    start: string
    available: string
    narrowed: string
    fallback: string
  }
  criteria: {
    descriptionChars: number
    emptyDescription: string
  }
}

export interface ControlPolicy {
  verify: boolean
  claimMin: number
  ranMin: number
  passMin: number
  questions: {
    claim: string
    checkRan: string
    checkPassed: string
  }
  hint: string
}

export interface CachePolicy {
  max: number
  ttlMs: number
}

export interface SpendPolicy {
  maxCallsPerSession: number
  warnAt: number
}

export interface AgentPolicy {
  delegateThreshold: number
  minConfidence: number
  ids: { pick: string; delegate: string }
  none: string
  noneLabel: string
  questions: { delegate: string; pick: string }
  builtin: Array<{ id: string; description: string }>
  hint: string
  hintDefault: string
  hintLight: string
}

export type Tier = "light" | "standard" | "heavy"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

// One tier = which harness runs it, which model, and how hard it thinks. effort "auto" means Jev picks.
export interface TierConfig {
  harness: "claude" | "opencode"
  model: string
  effort: Effort | "auto"
  minEffort?: Effort
}

export interface ModelPolicy {
  tiers: Tier[]
  fallback: Tier
  lightMin: number
  heavyMin: number
  ids: { tier: string; external: string; effort: string }
  lean: { externalMax: number }
  effort: { levels: Effort[]; fallback: Effort; minProbability: number }
  questions: { tier: string; external: string; effort: string }
  criteria: Record<Tier, string>
  effortCriteria: Record<string, string>
  tierConfig: Record<Tier, TierConfig>
  leanArgs: Record<string, string[]>
}

export interface Policy {
  models: ModelPolicy
  skills: SkillPolicy
  agents: AgentPolicy
  tools: ToolPolicy
  control: ControlPolicy
  cache: CachePolicy
  spend: SpendPolicy
}

// Imported, not read from disk, so the code can be bundled into a self-contained plugin file.
export const policy = spec as unknown as Policy

export function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}
