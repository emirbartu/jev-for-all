// L1 eval for the model-tier decision. Reports accuracy plus the two error directions:
// under-routing (cheaper than labelled, quality risk) and over-routing (dearer than labelled, money wasted).
// Thresholds are tuned on even-indexed cases only; the odd-indexed half is the held-out score.
import { readFileSync } from "node:fs"
import { createJev } from "../src/jev"
import { pickTier } from "../src/models"
import type { Tier } from "../src/policy"

const rank: Record<Tier, number> = { light: 0, standard: 1, heavy: 2 }
const cases = readFileSync("fixtures/tier-eval/cases.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; request: string; expected: Tier })
const { policy } = await import("../src/policy")
const ask = createJev({ apiKey: process.env.OPENROUTER_API_KEY!, timeoutMs: 5000 })

const raw: Array<{ c: (typeof cases)[number]; p: Record<string, number> }> = []
for (const c of cases) {
  const a = (await ask({ state: { request: c.request }, questions: { tier: { type: "choice", instructions: policy.models.questions.tier, criteria: policy.models.criteria } } })) as any
  raw.push({ c, p: a.tier.probabilities })
}
const score = (subset: typeof raw) => {
  let ok = 0, under = 0, over = 0
  for (const { c, p } of subset) {
    const got = pickTier(p)
    if (got === c.expected) ok++
    else if (rank[got] < rank[c.expected]) under++
    else over++
  }
  return { n: subset.length, acc: +(ok / subset.length).toFixed(3), under, over }
}
console.log("tuning half", score(raw.filter((_, i) => i % 2 === 0)))
console.log("held-out half", score(raw.filter((_, i) => i % 2 === 1)))
console.log("all", score(raw))
for (const { c, p } of raw) if (pickTier(p) !== c.expected) console.log("MISS", c.expected, "->", pickTier(p), JSON.stringify(p), c.request.slice(0, 70))
