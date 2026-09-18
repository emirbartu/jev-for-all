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
  gateThreshold: 0.3,
  rerank: "auto",
  rerankAbove: 40,
  rerankBelowP: 0.5,
  shortlist: 3,
  fitsThreshold: 0.3,
  minConfidence: 0.3,
}

const RANK_INSTRUCTIONS = "Which of these skills, if any, is the right one to load to help with the user's latest request?"
const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name."
const GATE_ACTS = "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?"
const GATE_PROCEDURE =
  "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?"
const GATE_PROSE =
  "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?"

export async function selectSkill(
  ask: Ask,
  input: { request: string; skills: readonly SkillLike[]; config?: Partial<SkillRoutingConfig> },
): Promise<{ id: string } | null> {
  const config = { ...defaultSkillRouting, ...input.config }
  const skills = input.skills.filter((skill) => skill.id)
  if (skills.length === 0 || input.request.trim() === "") return null

  try {
    const state = { request: input.request }
    const roster = Object.fromEntries(
      skills.map((skill) => [skill.id, `${skill.name}${skill.description ? ` — ${skill.description}` : ""}`]),
    )
    const first = await ask({
      state,
      questions: {
        which: { type: "choice", instructions: RANK_INSTRUCTIONS, criteria: roster },
        "gate::acts": { type: "noul", instructions: GATE_ACTS },
        "gate::procedure": { type: "noul", instructions: GATE_PROCEDURE },
        "gate::prose": { type: "noul", instructions: GATE_PROSE },
      },
    })

    const [acts, procedure, prose] = (["acts", "procedure", "prose"] as const).map((key) =>
      asNoul(first[`gate::${key}`]),
    )
    if (!acts || !procedure || !prose) return null
    const gate = (acts.noul + procedure.noul + (1 - prose.noul)) / 3
    if (gate < config.gateThreshold) return null

    const choice = asChoice(first.which)
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
        const criteria = Object.fromEntries(
          shortlist.map((id) => {
            const skill = byId.get(id)!
            return [id, `${skill.name}${skill.description ? ` — ${skill.description}` : ""} — ${skill.content.slice(0, 700)}`]
          }),
        )
        const questions: Record<string, Question> = {
          which: { type: "choice", instructions: RERANK_INSTRUCTIONS, criteria },
        }
        for (const id of shortlist) {
          questions[`fits::${id}`] = {
            type: "noul",
            instructions: `Does the skill '${byId.get(id)!.name}' do the specific thing the user's request asks for?`,
          }
        }
        const second = await ask({ state, questions })
        const fits = shortlist.map((id) => asNoul(second[`fits::${id}`])?.noul ?? 0)
        if (Math.max(...fits) < config.fitsThreshold) return null
        const reranked = asChoice(second.which)
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
