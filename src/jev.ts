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
  baseURL?: string
  timeoutMs?: number
  fetch?: typeof fetch
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
  const model = options.model ?? "jev-latest"
  const baseURL = (options.baseURL ?? "https://api.typesafe.ai").replace(/\/$/, "")
  const timeoutMs = options.timeoutMs ?? 1000
  const doFetch = options.fetch ?? fetch

  return async ({ state, questions }) => {
    let response: Response
    try {
      response = await doFetch(`${baseURL}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ state, model, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new JevError(`system-one request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new JevError(`system-one request failed: ${response.status}`, response.status)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new JevError("system-one returned invalid JSON")
    }
    const answers = (body as { answers?: unknown } | null)?.answers
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
