import { formatTemplate, policy } from "./policy"
import { type Ask, asChoice, asNoul } from "./jev"

export interface AgentLike {
  id: string
  description?: string
}

// One Jev call: a `delegate` gate plus a choice over the roster with an explicit "none" option,
// so the model is never forced to name a subagent. Returns the subagent id or null (do it directly).
export async function selectAgent(
  ask: Ask,
  input: { request: string; agents: readonly AgentLike[] },
): Promise<{ id: string } | null> {
  const config = policy.agents
  const agents = input.agents.filter((agent) => agent.id)
  if (agents.length === 0 || input.request.trim() === "") return null
  try {
    const criteria: Record<string, string> = Object.fromEntries(
      agents.map((agent) => [agent.id, agent.description ? `${agent.id} — ${agent.description}` : agent.id]),
    )
    criteria[config.none] = config.noneLabel
    const answers = await ask({
      state: { request: input.request },
      questions: {
        [config.ids.delegate]: { type: "noul", instructions: config.questions.delegate },
        [config.ids.pick]: { type: "choice", instructions: config.questions.pick, criteria },
      },
    })
    const delegate = asNoul(answers[config.ids.delegate])
    const choice = asChoice(answers[config.ids.pick])
    if (!delegate || !choice || delegate.noul < config.delegateThreshold) return null
    if (choice.choice === config.none || !agents.some((agent) => agent.id === choice.choice)) return null
    if ((choice.confidence ?? 1) < config.minConfidence) return null
    return { id: choice.choice }
  } catch {
    return null
  }
}

export function agentHint(decision: { id: string }): string {
  return formatTemplate(policy.agents.hint, { id: decision.id })
}
