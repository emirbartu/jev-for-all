import { expect, test } from "bun:test"
import {
  classify,
  costOf,
  formatSummary,
  loadCases,
  parseSkillFile,
  summarize,
  validateCases,
  type CaseResult,
} from "./skill-l1"

test("parseSkillFile reads single-line and folded descriptions", () => {
  const folded = parseSkillFile(
    '---\nname: ponytail\ndescription: >\n  Forces the laziest solution that works,\n  simplest and most minimal.\n---\n\nbody\n',
    "ponytail",
  )
  expect(folded.name).toBe("ponytail")
  expect(folded.description).toBe("Forces the laziest solution that works, simplest and most minimal.")
  expect(folded.content).toBe("body\n")

  const literal = parseSkillFile("---\nname: x\ndescription: |\n  line one\n  line two\n---\nbody", "x")
  expect(literal.description).toBe("line one\nline two")

  const plain = parseSkillFile("---\nname: y\ndescription: does y\n---\nbody", "y")
  expect(plain.description).toBe("does y")

  const none = parseSkillFile("no frontmatter", "z")
  expect(none.name).toBe("z")
  expect(none.description).toBeUndefined()
  expect(none.content).toBe("no frontmatter")
})

test("loadCases parses valid lines and rejects malformed ones", () => {
  const cases = loadCases(
    [
      JSON.stringify({ id: "a", request: "do a", expected: "brainstorming" }),
      JSON.stringify({ id: "b", request: "nothing", expected: null }),
      "",
    ].join("\n"),
  )
  expect(cases.length).toBe(2)
  expect(cases[1].expected).toBeNull()

  expect(() => loadCases("{not json}")).toThrow(/invalid JSON/)
  expect(() => loadCases(JSON.stringify({ id: "c", request: "x" }))).toThrow(/expected \{id, request/)
  expect(() => loadCases(JSON.stringify({ id: "c", request: "x", expected: 7 }))).toThrow(/expected \{id, request/)
})

test("validateCases fails on ids outside the roster", () => {
  const roster = ["brainstorming", "ponytail"]
  expect(() =>
    validateCases([{ id: "a", request: "x", expected: "brainstorming" }], roster),
  ).not.toThrow()
  expect(() =>
    validateCases([{ id: "a", request: "x", expected: "ghost" }], roster),
  ).toThrow(/ghost/)
  expect(() =>
    validateCases([{ id: "a", request: "x", expected: "brainstorming", acceptable: ["ghost", "spook"] }], roster),
  ).toThrow(/ghost/)
})

test("classify follows the spec's label definitions", () => {
  expect(classify(null, [], null)).toBe("hit")
  expect(classify(null, [], "ponytail")).toBe("spurious")
  expect(classify("ponytail", [], "ponytail")).toBe("hit")
  expect(classify("ponytail", [], null)).toBe("missed")
  expect(classify("ponytail", [], "brainstorming")).toBe("wrong-skill")
  expect(classify("ponytail", ["ponytail-help"], "ponytail-help")).toBe("hit")
})

test("summarize computes counts, rates, latency, tokens and cost", () => {
  const result = (
    classification: CaseResult["classification"],
    latencyMs: number,
    inputTokens: number,
  ): CaseResult => ({
    caseId: "x",
    request: "r",
    expected: null,
    acceptable: [],
    decision: null,
    classification,
    latencyMs,
    inputTokens,
    outputTokens: inputTokens / 10,
    costUsd: costOf(inputTokens),
  })
  const summary = summarize([
    result("hit", 100, 2000),
    result("hit", 300, 1000),
    result("wrong-skill", 200, 1000),
    result("spurious", 200, 1000),
    result("missed", 200, 1000),
    result("skipped", 0, 0),
  ])
  expect(summary.total).toBe(6)
  expect(summary.scored).toBe(5)
  expect(summary.skipped).toBe(1)
  expect(summary.hits).toBe(2)
  expect(summary.wrongSkillRate).toBeCloseTo(0.2)
  expect(summary.spuriousRate).toBeCloseTo(0.2)
  expect(summary.missedRate).toBeCloseTo(0.2)
  expect(summary.hitRate).toBeCloseTo(0.4)
  expect(summary.avgLatencyMs).toBe(200)
  expect(summary.maxLatencyMs).toBe(300)
  expect(summary.inputTokens).toBe(6000)
  expect(summary.costUsd).toBeCloseTo(costOf(6000))
  expect(costOf(1_000_000)).toBeCloseTo(0.042)
})

test("formatSummary reports the numbers and the reference bar", () => {
  const summary = summarize([])
  const text = formatSummary(summary, { rosterSize: 22, model: "~typesafe/jev-latest" })
  expect(text).toContain("roster 22")
  expect(text).toContain("wrong-skill")
  expect(text).toContain("7.3% / 4.0%")
})
