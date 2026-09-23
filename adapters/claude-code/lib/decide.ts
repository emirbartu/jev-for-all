import { asChoice, asNoul, type Ask } from "../../../src/jev"
import { policy } from "../../../src/policy"
import { selectSkill, type SkillLike } from "../../../src/skills"
import type { SkillFile } from "./roster"

export type Decision = { kind: "skill"; id: string } | { kind: "none" } | { kind: "no-change" }

export const NONE_CONTEXT = "Skills are routed externally for this session; do not call the Skill tool."

export function injectionFor(skill: SkillFile): string {
  const header = `A routed skill is loaded for this turn: ${skill.name} (${skill.id}).`
  if (skill.content.length <= policy.skills.injection.chars) return `${header}\n\n${skill.content}`
  const summary = skill.description ?? skill.name
  return `${header} ${summary} Read the full skill at ${skill.path}.`
}

export async function decide(ask: Ask | undefined, request: string, skills: readonly SkillLike[]): Promise<Decision> {
  if (!ask || skills.length === 0 || request.trim() === "") return { kind: "no-change" }
  let sawFirst = false
  let confidentNone = false
  const tracked: Ask = async (input) => {
    const answers = await ask(input)
    if (!sawFirst) {
      sawFirst = true
      const choice = asChoice(answers[policy.skills.ids.rank])
      const gateIds = [policy.skills.ids.gateActs, policy.skills.ids.gateProcedure, policy.skills.ids.gateProse]
      const gateOk = gateIds.every((id) => asNoul(answers[id]) !== null)
      confidentNone = choice !== null && gateOk && (choice.confidence ?? 1) >= policy.skills.minConfidence
    }
    return answers
  }
  try {
    const decision = await selectSkill(tracked, { request, skills })
    if (decision) return { kind: "skill", id: decision.id }
    return confidentNone ? { kind: "none" } : { kind: "no-change" }
  } catch {
    return { kind: "no-change" }
  }
}
