import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Ask } from "../../src/jev"
import { decide } from "./lib/decide"

interface FixtureCall {
  answers?: Record<string, unknown>
  throw?: boolean
}

interface Fixture {
  id: string
  decision: string
  task: string
  roster: Array<{ id: string; name?: string; description?: string; content?: string }>
  calls: FixtureCall[]
  expected: { skill: string | null }
}

function replayAsk(calls: readonly FixtureCall[], made: { count: number }): Ask {
  return async () => {
    const call = calls[made.count]
    made.count += 1
    if (!call) throw new Error("conformance: fixture provided no answer for this call")
    if (call.throw) throw new Error("conformance: fixture transport error")
    return call.answers ?? {}
  }
}

export async function runConformance(jsonl: string): Promise<{ total: number; passed: number; failures: string[] }> {
  const fixtures: Fixture[] = []
  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue
    fixtures.push(JSON.parse(raw) as Fixture)
  }
  const failures: string[] = []
  let passed = 0
  for (const fixture of fixtures) {
    if (fixture.decision !== "skills") {
      failures.push(`${fixture.id}: unsupported decision ${fixture.decision}`)
      continue
    }
    const roster = fixture.roster.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      description: entry.description,
      content: entry.content ?? "",
    }))
    const made = { count: 0 }
    const decision = await decide(replayAsk(fixture.calls, made), fixture.task, roster)
    const actual = decision.kind === "skill" ? decision.id : null
    if (actual !== fixture.expected.skill) {
      failures.push(`${fixture.id}: expected ${JSON.stringify(fixture.expected.skill)}, got ${JSON.stringify(actual)}`)
      continue
    }
    if (made.count !== fixture.calls.length) {
      failures.push(`${fixture.id}: expected ${fixture.calls.length} ask call(s), made ${made.count}`)
      continue
    }
    passed += 1
  }
  return { total: fixtures.length, passed, failures }
}

if (import.meta.main) {
  const path = join(import.meta.dir, "assets", "conformance.jsonl")
  const result = await runConformance(readFileSync(path, "utf8"))
  for (const failure of result.failures) console.error(`FAIL ${failure}`)
  console.log(`conformance: ${result.passed}/${result.total} passed`)
  process.exitCode = result.failures.length > 0 ? 1 : 0
}
