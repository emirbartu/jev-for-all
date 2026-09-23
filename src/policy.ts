import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface SkillPolicy {
  gateThreshold: number
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
    fits: string
  }
  questions: {
    rank: string
    rerank: string
    gateActs: string
    gateProcedure: string
    gateProse: string
    fits: string
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
}

export interface CachePolicy {
  max: number
  ttlMs: number
}

export interface SpendPolicy {
  maxCallsPerSession: number
  warnAt: number
}

export interface Policy {
  skills: SkillPolicy
  tools: ToolPolicy
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
