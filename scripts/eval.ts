// Headless before/after eval. Runs each fixture task twice:
//   baseline = plugin loaded, skill + tool routing disabled, usage recorded
//   routed   = plugin defaults
// Usage comes from the plugin's own JSONL (observe.file), so both modes
// are measured by the same code path.
// Runs are config-isolated on purpose: each run gets its own empty
// XDG_CONFIG_HOME so no user-global opencode config can load this same
// plugin again (which would keep routing on and contaminate the baseline).
// XDG_DATA_HOME is left alone because provider auth lives there.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { formatReport, parseSamples, summarize, type UsageSample } from "../src/observe"

const repo = resolve(import.meta.dir, "..")
const root = process.env.EVAL_ROOT ?? "/tmp/opencode/eval"
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const model = process.env.EVAL_MODEL
const modes = ["baseline", "routed"] as const
const tasks = [
  { id: "read-lines", prompt: "Read facts.txt and reply with the exact number of lines it contains." },
  { id: "fix-typo", prompt: "Fix the typo colur in facts.txt to color using the edit tool." },
]

function options(dir: string, mode: (typeof modes)[number]) {
  const observe = { enabled: true, file: join(dir, "usage.jsonl") }
  return mode === "routed"
    ? { observe }
    : { skills: { enabled: false }, tools: { enabled: false }, observe }
}

function run(mode: (typeof modes)[number], task: (typeof tasks)[number]): UsageSample[] {
  const dir = join(root, stamp, mode, task.id)
  mkdirSync(dir, { recursive: true })
  cpSync(join(repo, "scripts/eval-fixtures/basic"), dir, { recursive: true })
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [{ package: repo, options: options(dir, mode) }] }, null, 2),
  )
  // Empty per-mode global config dir: exactly one plugin instance loads (the scratch project's).
  const configHome = join(root, stamp, mode, "config")
  mkdirSync(configHome, { recursive: true })
  const args = ["run", "--standalone", "--auto", ...(model ? ["--model", model] : []), task.prompt]
  // opencode resolves its project directory from PWD, not the process cwd, so PWD must match.
  const result = Bun.spawnSync(["opencode", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PWD: dir, XDG_CONFIG_HOME: configHome } })
  if (result.exitCode !== 0) {
    console.error(`[eval] ${mode}/${task.id} exited ${result.exitCode}: ${result.stderr.toString().slice(0, 400)}`)
  }
  const file = join(dir, "usage.jsonl")
  if (!existsSync(file)) {
    console.error(`[eval] no usage written for ${mode}/${task.id} (plugin not loaded?)`)
    return []
  }
  return parseSamples(readFileSync(file, "utf8"))
}

const rows = modes.map((mode) => ({
  label: mode,
  summary: summarize(tasks.flatMap((task) => run(mode, task))),
}))
console.log(formatReport(rows))
