// Live L1 check for selectAgent: delegations on broad tasks, none on focused ones. Needs OPENROUTER_API_KEY.
import { createJev } from "../src/jev"
import { selectAgent } from "../src/agents"
import { policy } from "../src/policy"
const ask = createJev({ apiKey: process.env.OPENROUTER_API_KEY!, timeoutMs: 4000 })
const cases: [string, string | null][] = [
 ["Find every place in the codebase where we read the session state and tell me how it flows", "Explore"],
 ["Inspect the repo end to end and summarize the architecture", "Explore"],
 ["Design an implementation plan for adding OAuth, weighing trade-offs", "Plan"],
 ["Research how three competing libraries handle retries and compare them", "general-purpose"],
 ["Rename the variable x to count in this function", null],
 ["Bump the version to 1.2.0 in package.json", null],
 ["What does HTTP 429 mean?", null],
 ["hey, how's it going?", null],
 ["Delete the unused import on line 4", null],
 ["Run bun test and paste the output", null],
 ["Add dist/ to .gitignore", null],
 ["Fix the typo in the README title", null],
]
let ok = 0
for (const [r, want] of cases) {
  const got = (await selectAgent(ask, { request: r, agents: policy.agents.builtin }))?.id ?? null
  ok += got === want ? 1 : 0
  console.log(got === want ? "PASS" : "FAIL", r.slice(0, 60), "->", got, "want", want)
}
console.log(ok, "/", cases.length)
