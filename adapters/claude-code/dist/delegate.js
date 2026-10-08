#!/usr/bin/env bun
// @bun

// adapters/claude-code/mcp/delegate.ts
import { spawn, spawnSync } from "child_process";
import { createInterface } from "readline";

// src/models.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";

// src/config.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
// spec/decisions.json
var decisions_default = {
  skills: {
    gateThreshold: 0.3,
    rerank: "auto",
    rerankAbove: 40,
    rerankBelowP: 0.5,
    shortlist: 3,
    fitsThreshold: 0.3,
    minConfidence: 0.3,
    advisoryThreshold: 0.5,
    mechanicalVeto: 0.5,
    ids: {
      rank: "which",
      rerank: "which",
      gateActs: "gate::acts",
      gateProcedure: "gate::procedure",
      gateProse: "gate::prose",
      advisory: "gate::advisory",
      gateMechanical: "gate::mechanical",
      fits: "fits::{{id}}"
    },
    questions: {
      rank: "Which of these skills, if any, is the right one to load to help with the user's latest request?",
      rerank: "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
      gateActs: "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
      gateProcedure: "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
      gateProse: "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
      advisory: "Does this request ask for creative or advisory work on the user's software project \u2014 designing, planning, brainstorming, reviewing, or dispatching development work \u2014 where a documented process should guide the assistant, rather than a specific mechanical change?",
      gateMechanical: "Is this a small, self-contained mechanical step, such as renaming, editing a line, bumping a value, reading a file, running one command, or calling one named tool, that needs no documented process or workflow?",
      fits: "Does the skill '{{name}}' do the specific thing the user's request asks for?"
    },
    criteria: {
      withDescription: "{{name}} \u2014 {{description}}",
      withoutDescription: "{{name}}",
      withContent: " \u2014 {{content}}",
      contentChars: 700
    },
    injection: {
      chars: 8000
    }
  },
  agents: {
    delegateThreshold: 0.6,
    minConfidence: 0.4,
    ids: {
      pick: "agent",
      delegate: "delegate"
    },
    none: "none",
    questions: {
      delegate: "Would this request be better handed to a subagent, because it needs broad searching or reading across many files, several independent parallel tasks, or an independent review, rather than a focused change the main agent can make directly?",
      pick: "Which subagent is the right one to hand this request to, or none if the main agent should handle it directly?"
    },
    noneLabel: "none \u2014 the main agent handles this directly",
    builtin: [
      {
        id: "Explore",
        description: "Read-only search across many files or directories; returns conclusions, not file dumps"
      },
      {
        id: "Plan",
        description: "Designs an implementation plan and weighs architecture trade-offs"
      },
      {
        id: "general-purpose",
        description: "Researches open questions and runs multi-step tasks independently"
      }
    ],
    hint: `<system_one_agents>
Delegate this request to the {{id}} subagent via the Agent tool with model: "{{model}}" instead of working it in the main conversation.
</system_one_agents>`,
    hintDefault: `<system_one_agents>
Delegate this request to the {{id}} subagent via the Agent tool, with no model override, instead of working it in the main conversation.
</system_one_agents>`,
    hintLight: `<system_one_agents>
This is cheap, mechanical work. Hand it to the jev_delegate_light tool (it runs on a low-cost model with maximum thinking) instead of doing it yourself, then check its result.
</system_one_agents>`
  },
  models: {
    tiers: ["light", "standard", "heavy"],
    fallback: "standard",
    lightMin: 0.6,
    heavyMin: 0.5,
    ids: { tier: "tier", external: "external", effort: "effort" },
    lean: { externalMax: 0.2 },
    effort: { levels: ["low", "medium", "high", "xhigh"], fallback: "medium", minProbability: 0.5 },
    questions: {
      tier: "How demanding is this coding request for the AI model that has to carry it out?",
      external: "Does this request need an external service, a browser, a database, or a third-party API, beyond the project's own files and the shell?",
      effort: "How much careful step-by-step reasoning does this coding request need before the AI model acts?"
    },
    criteria: {
      light: "light: low-stakes work where spending many tokens does not matter and deep reasoning is not needed, at any size: mechanical or repetitive changes such as fixing lint or type errors, renames, formatting, comments or boilerplate across a whole codebase, simple lookups, and short factual questions",
      standard: "standard: ordinary coding work with a clear goal, such as implementing a small feature, fixing a bug in one place, writing tests, or explaining how some code works",
      heavy: "heavy: hard work where mistakes are costly and deep reasoning is needed, such as designing an architecture, hunting a subtle or cross-cutting bug, a large refactor, security-sensitive changes, or vague requirements that need judgment"
    },
    effortCriteria: {
      low: "low: a quick answer or an obvious edit that needs almost no reasoning",
      medium: "medium: ordinary work where a little planning helps",
      high: "high: tricky logic, several interacting parts, or edge cases that must be thought through",
      xhigh: "xhigh: a very hard problem that needs long, careful reasoning"
    },
    tierConfig: {
      light: { harness: "claude", model: "haiku", effort: "max" },
      standard: { harness: "claude", model: "sonnet", effort: "auto" },
      heavy: { harness: "claude", model: "sonnet", effort: "auto", minEffort: "high" }
    },
    leanArgs: {
      claude: ["--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
    }
  },
  control: {
    verify: false,
    claimMin: 0.5,
    ranMin: 0.5,
    passMin: 0.5,
    questions: {
      claim: "Does the latest assistant message assert that the work is complete, done, or finished?",
      checkRan: "Has an automated check (tests, build, lint, or a re-read of the changed artifact) been run against this change in this session?",
      checkPassed: "Did that check pass? Count failing, incomplete, or stale pre-change runs as not passed."
    },
    hint: `<system_one_control>
Before finishing: run the relevant check for this change, or state explicitly that no check exists. Do not claim completion without evidence.
</system_one_control>`
  },
  tools: {
    maxTools: 12,
    minToolProbability: 0.05,
    needsToolThreshold: 0.3,
    minConfidence: 0.3,
    alwaysVisible: ["read", "write", "edit", "bash", "grep", "glob"],
    stateBudget: 6000,
    ids: { next: "next", needsTool: "needs_tool" },
    questions: {
      next: "Which single tool is the best next step for the agent to make progress?",
      needsTool: "Does making progress on the last step require calling a tool?"
    },
    hints: {
      open: "<system_one_routing>",
      close: "</system_one_routing>",
      noTool: "No tool is needed for this step; answer directly.",
      start: "Start with: {{start}}.",
      available: "Available now: {{tools}}.",
      narrowed: "The tool list is already narrowed for this step; do not deliberate about tool choice, act.",
      fallback: "If none of these fit, say what you need in your reply instead of guessing."
    },
    criteria: {
      descriptionChars: 300,
      emptyDescription: "{{name}}"
    }
  },
  cache: { max: 200, ttlMs: 600000 },
  spend: { maxCallsPerSession: 500, warnAt: 0.8 }
};

// src/policy.ts
var policy = decisions_default;
function formatTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
}

// src/config.ts
function configDir() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jev-for-all");
}
function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));
    return { apiKey: raw.apiKey?.trim() || undefined, layaUrl: raw.layaUrl?.trim() || undefined, hints: raw.hints === true };
  } catch {
    return {};
  }
}
var MODELS_HELP = "Each tier is { harness: claude|opencode, model, effort }. effort is low|medium|high|xhigh|max, or auto to let Jev choose. " + "Edit freely; delete this file to get the shipped defaults again. Tiers you remove here fall back to the defaults.";
function ensureConfig(options = {}) {
  const created = [];
  try {
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    const write = (name, body, mode) => {
      const path = join(dir, name);
      if (existsSync(path))
        return;
      writeFileSync(path, JSON.stringify(body, null, 2) + `
`);
      if (mode)
        chmodSync(path, mode);
      created.push(path);
    };
    write("models.json", { _help: MODELS_HELP, ...policy.models.tierConfig });
    write("config.json", { apiKey: options.apiKey ?? "", layaUrl: options.layaUrl ?? "", hints: false }, 384);
  } catch {}
  return created;
}

// src/answers.ts
function asChoice(value) {
  if (!value || typeof value !== "object")
    return null;
  const candidate = value;
  if (candidate.type !== "choice" || typeof candidate.choice !== "string")
    return null;
  const probabilities = {};
  if (candidate.probabilities && typeof candidate.probabilities === "object") {
    for (const [key, probability] of Object.entries(candidate.probabilities)) {
      if (typeof probability === "number" && Number.isFinite(probability))
        probabilities[key] = probability;
    }
  }
  return {
    choice: candidate.choice,
    probabilities,
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : undefined
  };
}
function asNoul(value) {
  if (!value || typeof value !== "object")
    return null;
  const candidate = value;
  if (candidate.type !== "noul" || typeof candidate.noul !== "number" || !Number.isFinite(candidate.noul))
    return null;
  return { noul: candidate.noul };
}

// src/models.ts
async function selectTier(ask, request) {
  const config = policy.models;
  if (request.trim() === "")
    return null;
  try {
    const answers = await ask({
      state: { request },
      questions: {
        [config.ids.tier]: { type: "choice", instructions: config.questions.tier, criteria: config.criteria },
        [config.ids.external]: { type: "noul", instructions: config.questions.external },
        [config.ids.effort]: { type: "choice", instructions: config.questions.effort, criteria: config.effortCriteria }
      }
    });
    const choice = asChoice(answers[config.ids.tier]);
    if (!choice || !config.tiers.includes(choice.choice))
      return null;
    return {
      tier: pickTier(choice.probabilities),
      probabilities: choice.probabilities,
      external: asNoul(answers[config.ids.external])?.noul,
      effort: pickEffort(asChoice(answers[config.ids.effort])?.probabilities)
    };
  } catch {
    return null;
  }
}
function pickTier(probabilities) {
  const config = policy.models;
  if ((probabilities.light ?? 0) >= config.lightMin)
    return "light";
  if ((probabilities.heavy ?? 0) >= config.heavyMin)
    return "heavy";
  return config.fallback;
}
function pickEffort(probabilities) {
  const config = policy.models.effort;
  const [top, p] = Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [];
  return top && (p ?? 0) >= config.minProbability && config.levels.includes(top) ? top : config.fallback;
}
var order = ["low", "medium", "high", "xhigh", "max"];
function resolvePlan(decision) {
  const tier = decision?.tier ?? policy.models.fallback;
  const config = loadTiers()[tier];
  let effort = config.effort === "auto" ? decision?.effort ?? policy.models.effort.fallback : config.effort;
  if (config.minEffort && order.indexOf(effort) < order.indexOf(config.minEffort))
    effort = config.minEffort;
  return { ...config, tier, effort, lean: isLean(decision) && config.harness === "claude" };
}
function loadTiers(path = join2(configDir(), "models.json")) {
  const tiers = structuredClone(policy.models.tierConfig);
  try {
    if (existsSync2(path)) {
      const user = JSON.parse(readFileSync2(path, "utf8"));
      for (const tier of policy.models.tiers)
        if (user[tier])
          tiers[tier] = { ...tiers[tier], ...user[tier] };
    }
  } catch {}
  return tiers;
}
function isLean(decision) {
  return decision?.tier === "light" && decision.external !== undefined && decision.external <= policy.models.lean.externalMax;
}

// adapters/claude-code/mcp/delegate.ts
var TIMEOUT_MS = 20 * 60 * 1000;
var MAX_CHARS = 12000;
var DESCRIPTION = "Run cheap, mechanical coding work on a low-cost model with maximum thinking, in the project directory: fixing lint or type errors across the codebase, renames, formatting, boilerplate, bulk edits. Give a complete, self-contained task; the worker has no memory of this conversation. Returns its report plus `git status`, so verify the changes.";
function lightCommand(task) {
  const light = loadTiers().light;
  return ["opencode", "run", "--standalone", "--auto", "--model", `${light.model}#${light.effort}`, task];
}
async function runLight(task, cwd = process.cwd()) {
  if (loadTiers().light.harness !== "opencode")
    return "jev_delegate_light: the light tier is not configured to run on opencode.";
  const [bin, ...args] = lightCommand(task);
  const output = await new Promise((resolve) => {
    let out = "";
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => out += chunk);
    child.stderr.on("data", (chunk) => out += chunk);
    child.on("error", (error) => resolve(`could not start opencode: ${error.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      const credential = /Invalid credential/.test(out) ? "\nHint: your OpenCode Go credential was rejected; run `opencode auth login`." : "";
      resolve((code === 0 ? out : `opencode exited with ${code}\\n${out}`) + credential);
    });
  });
  const tail = output.length > MAX_CHARS ? "\u2026" + output.slice(-MAX_CHARS) : output;
  const git = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
  const changed = git.status === 0 ? git.stdout.trim() || "(no changes)" : "(not a git repository)";
  return `${tail.trim()}

--- git status ---
${changed}`;
}
var allTools = [
  {
    name: "jev_delegate_light",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complete, self-contained instructions for the worker." },
        cwd: { type: "string", description: "Directory to work in. Defaults to the project directory." }
      },
      required: ["task"]
    }
  }
];
async function handle(message) {
  const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "jev-delegate", version: "0.1.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: loadTiers().light.harness === "opencode" ? allTools : [] });
    case "tools/call": {
      const args = message.params?.arguments ?? {};
      if (message.params?.name !== "jev_delegate_light" || typeof args.task !== "string") {
        return reply({ isError: true, content: [{ type: "text", text: "jev_delegate_light needs a `task` string." }] });
      }
      return reply({ content: [{ type: "text", text: await runLight(args.task, typeof args.cwd === "string" ? args.cwd : undefined) }] });
    }
    default:
      return message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } };
  }
}
if (import.meta.main) {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    try {
      const response = await handle(JSON.parse(line));
      if (response)
        process.stdout.write(JSON.stringify(response) + `
`);
    } catch {}
  });
}
export {
  DESCRIPTION,
  lightCommand,
  runLight
};
