import { readFileSync } from "node:fs"
import { join } from "node:path"
import { selectSkill, type SkillLike } from "../src/skills"
import type { Ask } from "../src/jev"

export interface ConformanceFailure {
  id: string
  expected: string | null
  actual: string | null
  message: string
}

export interface ConformanceResult {
  total: number
  passed: number
  failures: ConformanceFailure[]
}

interface FixtureRosterEntry {
  id: string
  name?: string
  description?: string
  content?: string
}

interface FixtureCall {
  answers?: Record<string, unknown>
  throw?: boolean
}

interface Fixture {
  id: string
  decision: string
  task: string
  roster: FixtureRosterEntry[]
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

export async function runConformance(jsonl: string): Promise<ConformanceResult> {
  const fixtures: Fixture[] = []
  for (const [index, raw] of jsonl.split("\n").entries()) {
    if (raw.trim() === "") continue
    try {
      fixtures.push(JSON.parse(raw) as Fixture)
    } catch (error) {
      return {
        total: fixtures.length + 1,
        passed: 0,
        failures: [
          { id: `line-${index + 1}`, expected: null, actual: null, message: `invalid fixture JSON: ${String(error)}` },
        ],
      }
    }
  }

  const failures: ConformanceFailure[] = []
  let passed = 0
  for (const fixture of fixtures) {
    if (fixture.decision !== "skills") {
      failures.push({
        id: fixture.id,
        expected: fixture.expected.skill,
        actual: null,
        message: `unsupported decision: ${fixture.decision}`,
      })
      continue
    }
    const roster: SkillLike[] = fixture.roster.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      description: entry.description,
      content: entry.content ?? "",
    }))
    const made = { count: 0 }
    let actual: string | null = null
    try {
      const decision = await selectSkill(replayAsk(fixture.calls, made), { request: fixture.task, skills: roster })
      actual = decision?.id ?? null
    } catch (error) {
      failures.push({
        id: fixture.id,
        expected: fixture.expected.skill,
        actual: null,
        message: `decision threw: ${String(error)}`,
      })
      continue
    }
    if (actual !== fixture.expected.skill) {
      failures.push({ id: fixture.id, expected: fixture.expected.skill, actual, message: "decision mismatch" })
      continue
    }
    if (made.count !== fixture.calls.length) {
      failures.push({
        id: fixture.id,
        expected: fixture.expected.skill,
        actual,
        message: `expected ${fixture.calls.length} ask call(s), made ${made.count}`,
      })
      continue
    }
    passed += 1
  }
  return { total: fixtures.length, passed, failures }
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "fixtures", "conformance.jsonl")
  const result = await runConformance(readFileSync(path, "utf8"))
  for (const failure of result.failures) {
    console.error(
      `FAIL ${failure.id}: expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)} (${failure.message})`,
    )
  }
  console.log(`conformance: ${result.passed}/${result.total} passed`)
  process.exitCode = result.failures.length > 0 ? 1 : 0
}
