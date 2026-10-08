import { readFileSync } from "node:fs"
import { join } from "node:path"

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
  builtin: Array<{ id: string; description: string; maxTier?: Tier }>
  subagentMaxTier: Tier
  hint: string
}

export type Tier = "light" | "standard" | "heavy"

export interface ModelPolicy {
  tiers: Tier[]
  fallback: Tier
  lightMin: number
  heavyMin: number
  ids: { tier: string; external: string }
  lean: { externalMax: number }
  questions: { tier: string; external: string }
  leanArgs: Record<string, string[]>
  criteria: Record<Tier, string>
  catalog: Record<string, Record<Tier, string>>
  launch: Record<string, string[]>
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

// Read at module load, next to this file. The plugin is installed as a directory,
// so `spec/` travels with it; a missing contract is a broken install and should fail loudly.
const specPath = join(import.meta.dir, "..", "spec", "decisions.json")

export const policy: Policy = JSON.parse(readFileSync(specPath, "utf8"))

export function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}
