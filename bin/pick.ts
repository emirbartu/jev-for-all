#!/usr/bin/env bun
// Session-start model picker. Chooses ONE model for the whole session from the first prompt, then launches the
// harness with it. Never switches mid-session: a model change throws away the prompt cache and the agent's
// accumulated context, which costs more than it saves. Fails open: no key, timeout or unclear answer means the
// harness starts with your own default model.
//   jev-for-all pick   "<prompt>" [--harness claude|opencode]   print the decision as JSON
//   jev-for-all claude   "<prompt>"                            pick, then run `claude --model <m> "<prompt>"`
//   jev-for-all opencode "<prompt>"                            pick, then run `opencode --model <m> --prompt "<prompt>"`
import { spawnSync } from "node:child_process"
import { createJev, resolveKey } from "../src/jev"
import { isLean, loadCatalog, modelFor, selectTier } from "../src/models"
import { policy } from "../src/policy"

const [command, ...rest] = process.argv.slice(2)

// `opencode-agents` prints an `agent` block for opencode.json: one subagent per tier, each pinned to the model
// from your catalog, so OpenCode's main agent picks the cheapest adequate one from the descriptions.
if (command === "opencode-agents") {
  const m = loadCatalog().opencode!
  const agent = (model: string, description: string) => ({ mode: "subagent", model, description })
  console.log(JSON.stringify({ agent: {
    "jev-scout": agent(m.light, "Cheap read-only helper: finds files, greps, reads code and reports short findings. Use for any search or lookup before reasoning."),
    "jev-worker": agent(m.standard, "Implements a well-specified change, writes tests, fixes a localized bug. Use for routine coding subtasks."),
    "jev-deep": agent(m.heavy, "Expensive. Only for architecture decisions, subtle cross-cutting bugs and security review where cheaper agents failed."),
  } }, null, 2))
  process.exit(0)
}
const flag = rest.indexOf("--harness")
const harness = flag === -1 ? (command === "pick" ? "claude" : command!) : rest[flag + 1]!
const prompt = rest.filter((_, i) => flag === -1 || (i !== flag && i !== flag + 1)).join(" ").trim()

if (!command || !prompt) {
  console.error('usage: jev-for-all <pick|claude|opencode> "<first prompt>" [--harness claude|opencode]')
  process.exit(2)
}

const apiKey = resolveKey()
const decision = apiKey ? await selectTier(createJev({ apiKey, timeoutMs: 3000 }), prompt) : null
const model = decision ? modelFor(harness, decision.tier) : undefined

if (command === "pick") {
  console.log(JSON.stringify({ harness, tier: decision?.tier ?? null, model: model ?? null, probabilities: decision?.probabilities ?? null, lean: isLean(decision) }))
  process.exit(0)
}

const template = policy.models.launch[harness]
if (!template) {
  console.error(`unknown harness "${harness}"`)
  process.exit(2)
}
// No decision: drop the --model pair so the harness keeps your default instead of guessing.
const argv = template.flatMap((part, i) => {
  if (!model && (part === "--model" || template[i - 1] === "--model")) return []
  return [part.replace("{model}", model ?? "").replace("{prompt}", prompt)]
})
const lean = isLean(decision) && model ? (policy.models.leanArgs[harness] ?? []) : []
argv.push(...lean)
if (harness === "claude") argv.push(prompt)
console.error(model ? `jev-for-all: ${decision!.tier} -> ${model}${lean.length ? ", lean (no skills/MCP; restart without it if you need them)" : ""} (fixed for this session)` : "jev-for-all: no decision, using your default model")
process.exit(spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" }).status ?? 1)
