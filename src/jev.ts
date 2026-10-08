import { OpenRouter } from "@openrouter/sdk"
import { loadConfig } from "./config"
export { type ChoiceAnswer, type NoulAnswer, asChoice, asNoul } from "./answers"

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
  onMeta?: (meta: { model?: string; inputTokens?: number; outputTokens?: number }) => void
}

export class JevError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "JevError"
    this.status = status
  }
}

// Self-hosted Laya speaks the same `POST /v1/systemone` wire protocol as TypeSafe's Jev, so a local
// server is a drop-in backend: set LAYA_BASE_URL (and LAYA_API_KEY if the server has one). It wins over
// OpenRouter when set, and never falls back to it: a down local server fails open instead of spending credits.
export function layaURL(): string | undefined {
  return (process.env.LAYA_BASE_URL || loadConfig().layaUrl)?.replace(/\/+$/, "") || undefined
}

// The key every host needs before it enables routing. Laya needs no OpenRouter key, so a placeholder stands in.
export function resolveKey(explicit?: string): string | undefined {
  return layaURL() ? (explicit ?? "laya") : (explicit ?? process.env.OPENROUTER_API_KEY ?? loadConfig().apiKey)
}

async function askLaya(base: string, options: JevOptions, state: unknown, questions: Record<string, Question>): Promise<Answers> {
  let response: Response
  try {
    response = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.LAYA_API_KEY ? { authorization: `Bearer ${process.env.LAYA_API_KEY}` } : {}),
      },
      // Never the Jev model id: Laya answers 422 to ids it does not know, like ~typesafe/jev-latest.
      // LAYA_MODEL (english, multilingual, typed-decisions) pins a checkpoint; unset lets Laya route.
      body: JSON.stringify({ ...(process.env.LAYA_MODEL ? { model: process.env.LAYA_MODEL } : {}), state, questions }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 1000),
    })
  } catch (error) {
    throw new JevError(`jev-for-all laya request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new JevError(`jev-for-all laya request failed: HTTP ${response.status}`, response.status)
  const body = (await response.json()) as { answers?: unknown; model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } }
  if (!body.answers || typeof body.answers !== "object") throw new JevError("jev-for-all laya response missing answers")
  options.onMeta?.({
    model: typeof body.model === "string" ? body.model : "laya",
    inputTokens: typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : undefined,
    outputTokens: typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : undefined,
  })
  return body.answers as Answers
}

export function createJev(options: JevOptions): Ask {
  const laya = layaURL()
  if (laya) return ({ state, questions }) => askLaya(laya, options, state, questions)
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
        `jev-for-all request failed: ${error instanceof Error ? error.message : String(error)}`,
        typeof status === "number" ? status : undefined,
      )
    }
    const answers = response?.answers
    if (!answers || typeof answers !== "object") throw new JevError("jev-for-all response missing answers")
    const resolved = (response as { model?: unknown }).model
    const usage = (response as { usage?: { inputTokens?: unknown; outputTokens?: unknown } }).usage
    options.onMeta?.({
      model: typeof resolved === "string" ? resolved : undefined,
      inputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined,
      outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : undefined,
    })
    return answers as Answers
  }
}
