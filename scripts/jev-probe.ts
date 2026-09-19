// Live Jev probe. Requires a working OpenRouter key.
//
//   OPENROUTER_API_KEY=... bun scripts/jev-probe.ts decisions
//   OPENROUTER_API_KEY=... bun scripts/jev-probe.ts catalog tools.json [task]
//
// `tools.json` maps tool names to { description }, e.g.
//   { "read": { "description": "Read a file" }, "grep": { "description": "Search files" } }
import { createJev } from "../src/jev"

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error("set OPENROUTER_API_KEY")
  process.exit(1)
}

const mode = process.argv[2] ?? "decisions"
const ask = createJev({ apiKey, timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? 5000) })
const started = performance.now()

if (mode === "decisions") {
  const answers = await ask({
    state: "Help! My payouts have been failing for 3 days.",
    questions: {
      is_urgent: { type: "noul", instructions: "Does this message convey urgency?" },
      department: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: {
          billing: "Payments, invoicing, refunds",
          technical: "Bugs, outages, integrations",
          sales: "Pricing, upgrades, new accounts",
        },
      },
    },
  })
  console.log(JSON.stringify(answers, null, 2))
} else if (mode === "catalog") {
  const path = process.argv[3]
  if (!path) {
    console.error("usage: jev-probe catalog <tools.json> [task]")
    process.exit(1)
  }
  const catalog = JSON.parse(await Bun.file(path).text()) as Record<string, { description?: string }>
  const names = Object.keys(catalog)
  const task = process.argv[4] ?? "make progress on the user's request"
  const answers = await ask({
    state: JSON.stringify({ task, tools: names }),
    questions: {
      next: {
        type: "choice",
        instructions: "Which single tool is the best next step?",
        criteria: Object.fromEntries(
          names.map((name) => [name, (catalog[name]?.description ?? "").slice(0, 300) || name]),
        ),
      },
      needs_tool: { type: "noul", instructions: "Does making progress require calling a tool?" },
    },
  })
  const next = (answers.next ?? {}) as { choice?: string; probabilities?: Record<string, number>; confidence?: number }
  const ranked = Object.entries(next.probabilities ?? {}).sort((a, b) => b[1] - a[1])
  const chars = (picked: string[]) =>
    picked.reduce((sum, name) => sum + name.length + (catalog[name]?.description ?? "").length, 0)
  console.log(
    JSON.stringify(
      {
        next: next.choice,
        confidence: next.confidence,
        needsTool: answers.needs_tool,
        ranked: ranked.slice(0, 8),
        estimatedTokens: { fullCatalog: Math.round(chars(names) / 4), top8: Math.round(chars(ranked.slice(0, 8).map(([name]) => name)) / 4) },
      },
      null,
      2,
    ),
  )
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(1)
}

console.log(`latency: ${Math.round(performance.now() - started)}ms`)
