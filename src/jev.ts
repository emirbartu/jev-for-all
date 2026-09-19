import { OpenRouter } from "@openrouter/sdk"

export interface QuestionChoice {
  type: "choice"
  instructions: string
  criteria: Record<string, string>
}

export interface QuestionNoul {
  type: "noul"
  instructions: string
}

export type Question = QuestionChoice | QuestionNoul

export type Answers = Record<string, unknown>

export type Ask = (input: { state: unknown; questions: Record<string, Question> }) => Promise<Answers>

export interface JevOptions {
  apiKey: string
  model?: string
  serverURL?: string
  timeoutMs?: number
}

export class JevError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "JevError"
    this.status = status
  }
}

export function createJev(options: JevOptions): Ask {
  const model = options.model ?? "~typesafe/jev-latest"
  const client = new OpenRouter({ apiKey: options.apiKey })

  return async ({ state, questions }) => {
    let response: Awaited<ReturnType<typeof client.alpha.decisions.create>>
    try {
      response = await client.alpha.decisions.create(
        { decisionsRequest: { model, state: state as never, questions } },
        {
          timeoutMs: options.timeoutMs ?? 1000,
          retries: { strategy: "none" },
          ...(options.serverURL ? { serverURL: options.serverURL } : {}),
        },
      )
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      throw new JevError(
        `system-one request failed: ${error instanceof Error ? error.message : String(error)}`,
        typeof status === "number" ? status : undefined,
      )
    }
    const answers = response?.answers
    if (!answers || typeof answers !== "object") throw new JevError("system-one response missing answers")
    return answers as Answers
  }
}

export interface ChoiceAnswer {
  choice: string
  probabilities: Record<string, number>
  confidence?: number
}

export interface NoulAnswer {
  noul: number
}

export function asChoice(value: unknown): ChoiceAnswer | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown }
  if (candidate.type !== "choice" || typeof candidate.choice !== "string") return null
  const probabilities: Record<string, number> = {}
  if (candidate.probabilities && typeof candidate.probabilities === "object") {
    for (const [key, probability] of Object.entries(candidate.probabilities as Record<string, unknown>)) {
      if (typeof probability === "number" && Number.isFinite(probability)) probabilities[key] = probability
    }
  }
  return {
    choice: candidate.choice,
    probabilities,
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : undefined,
  }
}

export function asNoul(value: unknown): NoulAnswer | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { type?: unknown; noul?: unknown }
  if (candidate.type !== "noul" || typeof candidate.noul !== "number" || !Number.isFinite(candidate.noul)) return null
  return { noul: candidate.noul }
}
