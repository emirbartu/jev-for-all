/**
 * The browser surface: one goal-driven tool, backed by the Jev Ultrafast loop.
 *
 * The plugin never drives the browser itself and never asks the coding agent to pick
 * selectors. It spawns one process in the jev checkout; there a hosted Jev policy model
 * chooses every operation and target (see that repo's FORK.md), so a task costs roughly
 * $0.00003 per decision and output tokens are free. Only `TYPE_TEXT` ever reaches a
 * second model.
 *
 * The registry side lives in index.ts: this module returns a plain tool object, which the
 * plugin adds through `ctx.tool.transform`. Registered tools land in `event.tools`, so the
 * existing `context` hook makes this one Jev-routable with no extra wiring.
 */

import { fileURLToPath } from "node:url"

export interface BrowserConfig {
  enabled: boolean
  jevDir: string
  envFile: string
  uvPath: string
  timeoutMs: number
  maxSteps: number
}

export const defaultBrowser: BrowserConfig = {
  enabled: false,
  jevDir: "~/jev-ultrafast",
  envFile: ".env",
  uvPath: "uv",
  timeoutMs: 180_000,
  maxSteps: 12,
}

export const BROWSER_TASK = "browser_task"
export const RESULT_PREFIX = "JEV_RESULT "
export const STEP_CEILING = 60

export const browserTaskInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: {
      type: "string",
      description:
        "One natural-language goal, including how to tell it succeeded. Example: 'On Wikipedia, open the article about Gödel's incompleteness theorems.'",
    },
    url: { type: "string", description: "Page to start from. Defaults to a blank tab." },
    max_steps: {
      type: "integer",
      minimum: 1,
      maximum: STEP_CEILING,
      description: `Action budget for this task (default ${defaultBrowser.maxSteps}). Each step is one cheap Jev decision.`,
    },
  },
  required: ["goal"],
}

export const BROWSER_TASK_DESCRIPTION =
  "Run one natural-language goal in a real browser. A Jev policy model — not you — chooses every click, " +
  "field value and target, so state the goal and its acceptance criteria instead of scripting steps. " +
  "Return the final URL, the page title and the action trace. The trace is a report, not proof: verify the " +
  "outcome before reporting success, and do not retry a browser mutation blindly."

export interface BrowserStep {
  step: number
  operation: string
  action: string
  url: string
  text: string | null
}

export interface BrowserRun {
  ok: boolean
  status: string
  url: string
  title: string
  steps: BrowserStep[]
  decisions: number
  costUsd: number
  elapsedMs: number
  error?: string
}

export function failedRun(reason: string, extra: Partial<BrowserRun> = {}): BrowserRun {
  return {
    ok: false,
    status: "error",
    url: "",
    title: "",
    steps: [],
    decisions: 0,
    costUsd: 0,
    elapsedMs: 0,
    error: reason,
    ...extra,
  }
}

export function expandHome(path: string, home = process.env.HOME ?? ""): string {
  if (path === "~") return home || path
  if (path.startsWith("~/")) return home ? `${home}/${path.slice(2)}` : path.slice(2)
  return path
}

/** uv resolves `--env-file` against its own cwd, so relative paths are pinned to the checkout. */
export function resolveAgainst(dir: string, path: string): string {
  const expanded = expandHome(path)
  return expanded.startsWith("/") ? expanded : `${dir.replace(/\/+$/, "")}/${expanded}`
}

export function runnerScript(): string {
  return fileURLToPath(new URL("./jev-runner.py", import.meta.url))
}

export function buildRunnerCommand(config: BrowserConfig, script = runnerScript()): string[] {
  const dir = expandHome(config.jevDir)
  return [
    config.uvPath,
    "run",
    "--directory",
    dir,
    "--env-file",
    resolveAgainst(dir, config.envFile),
    "--quiet",
    "python",
    script,
  ]
}

export function parseRunnerOutput(stdout: string): BrowserRun | null {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(RESULT_PREFIX))
  if (!line) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(RESULT_PREFIX.length))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const raw = parsed as Record<string, unknown>
  if (typeof raw.ok !== "boolean" || typeof raw.status !== "string") return null
  return {
    ok: raw.ok,
    status: raw.status,
    url: typeof raw.url === "string" ? raw.url : "",
    title: typeof raw.title === "string" ? raw.title : "",
    steps: Array.isArray(raw.steps) ? (raw.steps as BrowserStep[]) : [],
    decisions: typeof raw.decisions === "number" ? raw.decisions : 0,
    costUsd: typeof raw.cost_usd === "number" ? raw.cost_usd : 0,
    elapsedMs: typeof raw.elapsed_ms === "number" ? raw.elapsed_ms : 0,
    error: typeof raw.error === "string" && raw.error ? raw.error : undefined,
  }
}

export function formatRun(run: BrowserRun, goal: string): string {
  const lines = [`browser_task ${run.ok ? "reported done" : "did not finish"} — ${run.status}`]
  if (run.error) lines.push(`error: ${run.error}`)
  if (goal) lines.push(`goal: ${goal}`)
  lines.push(`final url: ${run.url || "(unchanged)"}`)
  if (run.title) lines.push(`title: ${run.title}`)
  lines.push(
    `steps: ${run.steps.length} — ${run.decisions} Jev decisions, $${run.costUsd.toFixed(6)}, ${run.elapsedMs} ms`,
  )
  for (const step of run.steps) {
    const typed = step.text ? ` = ${JSON.stringify(step.text)}` : ""
    lines.push(`  ${step.step}. ${step.operation} "${step.action}"${typed} -> ${step.url}`)
  }
  if (!run.ok) {
    lines.push("Not confirmed by the caller: check the page or the outcome before reporting success.")
  }
  return lines.join("\n")
}

export interface SpawnOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type Spawn = (command: string[], env: Record<string, string>, timeoutMs: number) => Promise<SpawnOutcome>

export const spawnProcess: Spawn = async (command, env, timeoutMs) => {
  const proc = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const kill = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code: await proc.exited, stdout, stderr, timedOut }
  } finally {
    clearTimeout(kill)
  }
}

export function stderrTail(stderr: string, limit = 300): string {
  const text = stderr
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-3)
    .join(" | ")
  return text.length > limit ? text.slice(-limit) : text
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, Math.round(value)))
}

export interface BrowserTaskInput {
  goal?: unknown
  url?: unknown
  max_steps?: unknown
}

export interface BrowserTaskOutcome {
  run: BrowserRun
  command: string[]
}

export async function runBrowserTask(
  input: BrowserTaskInput,
  config: BrowserConfig,
  spawn: Spawn = spawnProcess,
): Promise<BrowserTaskOutcome> {
  const goal = typeof input.goal === "string" ? input.goal.trim() : ""
  const command = buildRunnerCommand(config)
  if (!goal) return { run: failedRun("browser_task needs a goal."), command }
  const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : "about:blank"
  const maxSteps = clamp(typeof input.max_steps === "number" ? input.max_steps : config.maxSteps, 1, STEP_CEILING)

  let outcome: SpawnOutcome
  try {
    outcome = await spawn(
      command,
      { JEV_TASK_GOAL: goal, JEV_TASK_URL: url, JEV_TASK_MAX_STEPS: String(maxSteps) },
      config.timeoutMs,
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { run: failedRun(`browser_task could not start ${config.uvPath}: ${reason}`), command }
  }

  if (outcome.timedOut) {
    return { run: failedRun(`browser_task timed out after ${config.timeoutMs} ms.`), command }
  }
  const run = parseRunnerOutput(outcome.stdout)
  if (!run) {
    const tail = stderrTail(outcome.stderr)
    return {
      run: failedRun(`browser_task produced no result (exit ${outcome.code ?? "?"}).${tail ? ` ${tail}` : ""}`),
      command,
    }
  }
  if (!run.ok && !run.error && outcome.stderr.trim()) run.error = stderrTail(outcome.stderr)
  return { run, command }
}

export interface BrowserToolDeps {
  config: BrowserConfig
  spawn?: Spawn
  log?: (...args: unknown[]) => void
}

/** A plain tool object, added through `ctx.tool.transform`. */
export function browserTool(deps: BrowserToolDeps) {
  return {
    name: BROWSER_TASK,
    description: BROWSER_TASK_DESCRIPTION,
    input: browserTaskInput,
    execute: async (input: BrowserTaskInput) => {
      const { run, command } = await runBrowserTask(input ?? {}, deps.config, deps.spawn ?? spawnProcess)
      deps.log?.("browser task", { ok: run.ok, status: run.status, steps: run.steps.length, cost: run.costUsd })
      return {
        content: formatRun(run, typeof input?.goal === "string" ? input.goal : ""),
        metadata: {
          ok: run.ok,
          status: run.status,
          url: run.url,
          title: run.title,
          steps: run.steps.length,
          decisions: run.decisions,
          costUsd: run.costUsd,
          elapsedMs: run.elapsedMs,
          command: command.join(" "),
        },
      }
    },
  }
}
