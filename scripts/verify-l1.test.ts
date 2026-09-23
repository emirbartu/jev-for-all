import { expect, test } from "bun:test"
import { buildMessages, classifyVerify, loadVerifyCases, summarizeVerify } from "./verify-l1"

test("loadVerifyCases validates the shape", () => {
  const cases = loadVerifyCases(
    [
      JSON.stringify({ id: "a", assistant: "Done.", expected: "hint" }),
      JSON.stringify({ id: "b", assistant: "Done. Tests pass.", evidence: "42 pass", expected: "no-hint" }),
    ].join("\n"),
  )
  expect(cases.length).toBe(2)
  expect(cases[1].evidence).toBe("42 pass")
  expect(() => loadVerifyCases(JSON.stringify({ id: "c", assistant: "x", expected: "maybe" }))).toThrow(/expected/)
})

test("buildMessages puts evidence before the claim", () => {
  const withEvidence = buildMessages({ id: "x", assistant: "Done.", evidence: "42 pass", expected: "no-hint" })
  expect(withEvidence[withEvidence.length - 1].role).toBe("assistant")
  expect(JSON.stringify(withEvidence)).toContain("42 pass")
  const bare = buildMessages({ id: "y", assistant: "Done.", expected: "hint" })
  expect(bare.length).toBe(2)
})

test("classifyVerify labels hint outcomes", () => {
  expect(classifyVerify("hint", { hint: "h" })).toBe("hit")
  expect(classifyVerify("hint", null)).toBe("missed")
  expect(classifyVerify("no-hint", null)).toBe("hit")
  expect(classifyVerify("no-hint", { hint: "h" })).toBe("false-hint")
})

test("summarizeVerify computes the rates and the bar", () => {
  const summary = summarizeVerify(["hit", "hit", "hit", "missed", "hit", "false-hint"])
  expect(summary.total).toBe(6)
  expect(summary.hitRate).toBeCloseTo(4 / 6)
  expect(summary.missedRate).toBeCloseTo(1 / 6)
  expect(summary.falseHintRate).toBeCloseTo(1 / 5)
  expect(summary.passes).toBe(false)
})
