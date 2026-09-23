import { formatTemplate, policy } from "./policy"
import { type Ask, type Question, asChoice, asNoul } from "./jev"

export interface SkillLike {
  id: string
  name: string
  description?: string
  content: string
}

export interface SkillRoutingConfig {
  gateThreshold: number
  rerank: boolean | "auto"
  rerankAbove: number
  rerankBelowP: number
  shortlist: number
  fitsThreshold: number
  minConfidence: number
}

export const defaultSkillRouting: SkillRoutingConfig = {
  gateThreshold: policy.skills.gateThreshold,
  rerank: policy.skills.rerank,
  rerankAbove: policy.skills.rerankAbove,
  rerankBelowP: policy.skills.rerankBelowP,
  shortlist: policy.skills.shortlist,
  fitsThreshold: policy.skills.fitsThreshold,
  minConfidence: policy.skills.minConfidence,
}

export async function selectSkill(
  ask: Ask,
  input: { request: string; skills: readonly SkillLike[]; config?: Partial<SkillRoutingConfig> },
): Promise<{ id: string } | null> {
  const config = { ...defaultSkillRouting, ...input.config }
  const skills = input.skills.filter((skill) => skill.id)
  if (skills.length === 0 || input.request.trim() === "") return null

  const ids = policy.skills.ids
  const questions = policy.skills.questions
  const criteria = policy.skills.criteria
  const label = (skill: SkillLike): string =>
    skill.description
      ? formatTemplate(criteria.withDescription, { name: skill.name, description: skill.description })
      : formatTemplate(criteria.withoutDescription, { name: skill.name })

  try {
    const state = { request: input.request }
    const roster = Object.fromEntries(skills.map((skill) => [skill.id, label(skill)]))
    const first = await ask({
      state,
      questions: {
        [ids.rank]: { type: "choice", instructions: questions.rank, criteria: roster },
        [ids.gateActs]: { type: "noul", instructions: questions.gateActs },
        [ids.gateProcedure]: { type: "noul", instructions: questions.gateProcedure },
        [ids.gateProse]: { type: "noul", instructions: questions.gateProse },
      },
    })

    const acts = asNoul(first[ids.gateActs])
    const procedure = asNoul(first[ids.gateProcedure])
    const prose = asNoul(first[ids.gateProse])
    if (!acts || !procedure || !prose) return null
    const gate = (acts.noul + procedure.noul + (1 - prose.noul)) / 3
    if (gate < config.gateThreshold) return null

    const choice = asChoice(first[ids.rank])
    if (!choice || !skills.some((skill) => skill.id === choice.choice)) return null
    if ((choice.confidence ?? 1) < config.minConfidence) return null

    let winner = choice.choice
    const topProbability = Object.values(choice.probabilities).sort((a, b) => b - a)[0] ?? 0
    const wantRerank =
      config.rerank === true ||
      (config.rerank === "auto" && (skills.length > config.rerankAbove || topProbability < config.rerankBelowP))

    if (wantRerank) {
      const byId = new Map(skills.map((skill) => [skill.id, skill]))
      const shortlist = Object.keys(choice.probabilities)
        .filter((id) => byId.has(id))
        .sort((a, b) => (choice.probabilities[b] ?? 0) - (choice.probabilities[a] ?? 0))
        .slice(0, Math.max(1, config.shortlist))

      if (shortlist.length > 1) {
        const rerankCriteria = Object.fromEntries(
          shortlist.map((id) => {
            const skill = byId.get(id)!
            return [id, label(skill) + formatTemplate(criteria.withContent, { content: skill.content.slice(0, criteria.contentChars) })]
          }),
        )
        const rerankQuestions: Record<string, Question> = {
          [ids.rerank]: { type: "choice", instructions: questions.rerank, criteria: rerankCriteria },
        }
        for (const id of shortlist) {
          rerankQuestions[formatTemplate(ids.fits, { id })] = {
            type: "noul",
            instructions: formatTemplate(questions.fits, { name: byId.get(id)!.name }),
          }
        }
        const second = await ask({ state, questions: rerankQuestions })
        const fits = shortlist.map((id) => asNoul(second[formatTemplate(ids.fits, { id })])?.noul ?? 0)
        if (Math.max(...fits) < config.fitsThreshold) return null
        const reranked = asChoice(second[ids.rerank])
        if (reranked && shortlist.includes(reranked.choice) && (reranked.confidence ?? 1) >= config.minConfidence) {
          winner = reranked.choice
        }
      }
    }

    return { id: winner }
  } catch {
    return null
  }
}

export function applySkillDecision(prompt: { skills?: Array<{ id: string }> }, decision: { id: string } | null): boolean {
  if (!decision) return false
  prompt.skills ??= []
  if (prompt.skills.some((skill) => skill.id === decision.id)) return false
  prompt.skills.push({ id: decision.id })
  return true
}
