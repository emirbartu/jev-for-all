#!/usr/bin/env bun
// Session-start launcher. Reads the first prompt, asks Jev for the tier and thinking effort, then starts the
// harness that tier maps to (see `tierConfig` in spec/decisions.json, overridable in
// ~/.config/jev-for-all/models.json). The choice is made once and never changed mid-session: a model switch
// throws away the prompt cache and the agent's context. Fails open: no key, timeout or unclear answer means
// the standard tier, and a missing backend means your own default harness.
//   jev-for-all start "<prompt>"       decide, then launch (claude or opencode, per tier)
//   jev-for-all pick "<prompt>"        print the decision and the command as JSON, launch nothing
//   jev-for-all opencode-agents        print an `agent` block for opencode.json
import { spawnSync } from "node:child_process"
import { createJev, resolveKey } from "../src/jev"
import { loadTiers, resolvePlan, selectTier, type Plan } from "../src/models"
import { policy } from "../src/policy"

const [command, ...rest] = process.argv.slice(2)

// The command line a plan runs. Claude takes --effort, OpenCode takes the variant after `#` in the model id.
export function launchArgs(plan: Plan, prompt: string): string[] {
  if (plan.harness === "opencode") return ["opencode", "--model", `${plan.model}#${plan.effort}`, "--prompt", prompt]
  const lean = plan.lean ? (policy.models.leanArgs.claude ?? []) : []
  return ["claude", "--model", plan.model, "--effort", plan.effort, ...lean, prompt]
}

if (import.meta.main) {
  if (command === "opencode-agents") {
    // One OpenCode subagent per tier that runs on OpenCode, pinned to its model and variant, so an OpenCode
    // main agent hands cheap work to the cheap model.
    const tiers = loadTiers()
    console.log(JSON.stringify({ agent: {
      "jev-light": { mode: "subagent", model: tiers.light.model, variant: tiers.light.effort === "auto" ? undefined : tiers.light.effort,
        description: "Cheap worker for bulk or mechanical work where token use does not matter: fixing lint errors across a codebase, renames, formatting, boilerplate, simple lookups." },
    } }, null, 2))
    process.exit(0)
  }

  const prompt = rest.join(" ").trim()
  if ((command !== "start" && command !== "pick") || !prompt) {
    console.error('usage: jev-for-all <start|pick> "<first prompt>"  |  jev-for-all opencode-agents')
    process.exit(2)
  }

  const apiKey = resolveKey()
  const decision = apiKey ? await selectTier(createJev({ apiKey, timeoutMs: 3000 }), prompt) : null
  const plan = resolvePlan(decision)
  const argv = launchArgs(plan, prompt)

  if (command === "pick") {
    console.log(JSON.stringify({ decided: Boolean(decision), plan, command: argv.slice(0, -1).join(" ") + ' "<prompt>"', probabilities: decision?.probabilities ?? null }))
    process.exit(0)
  }
  console.error(`jev-for-all: ${plan.tier} -> ${plan.harness} ${plan.model} (effort ${plan.effort}${plan.lean ? ", lean: no skills/MCP" : ""}), fixed for this session${decision ? "" : " [no decision, standard]"}`)
  process.exit(spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" }).status ?? 1)
}
