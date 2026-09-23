import { expect, test } from "bun:test"
import { formatReport, parseLog, readLogFile, summarizeHarness } from "./decision-report"

test("parseLog splits decision and usage records and skips junk", () => {
  const text = [
    JSON.stringify({ kind: "decision", harness: "hermes", chosen: "demo", inputTokens: 446, outputTokens: 80, latencyMs: 700, time: 100 }),
    JSON.stringify({ kind: "usage", sessionID: "s", input: 1000, output: 200, cost: 0.002, time: 200 }),
    JSON.stringify({ kind: "decision", harness: "claude-code", chosen: "none", inputTokens: 100, latencyMs: 50, time: 300 }),
    "{not json}",
    "",
  ].join("\n")
  const parsed = parseLog(text)
  expect(parsed.decisions.length).toBe(2)
  expect(parsed.usage.length).toBe(1)
})

test("summarizeHarness groups by harness and distributes chosen values", () => {
  const parsed = parseLog(
    [
      JSON.stringify({ kind: "decision", harness: "hermes", chosen: "demo", inputTokens: 400, outputTokens: 80, latencyMs: 700, time: 100 }),
      JSON.stringify({ kind: "decision", harness: "hermes", chosen: "demo", inputTokens: 200, outputTokens: 40, latencyMs: 300, time: 200 }),
      JSON.stringify({ kind: "decision", harness: "claude-code", chosen: "none", inputTokens: 100, outputTokens: 10, latencyMs: 50, time: 300 }),
      JSON.stringify({ kind: "usage", input: 1000, output: 200, cost: 0.002, time: 400 }),
    ].join("\n"),
  )
  const rows = summarizeHarness(parsed.decisions, parsed.usage)
  const hermes = rows.find((row) => row.harness === "hermes")!
  expect(hermes.decisions).toBe(2)
  expect(hermes.chosen).toEqual({ demo: 2 })
  expect(hermes.inputTokens).toBe(600)
  expect(hermes.avgLatencyMs).toBe(500)
  expect(hermes.maxLatencyMs).toBe(700)
  expect(hermes.from).toBe(100)
  expect(hermes.to).toBe(200)
  expect(hermes.costUsd).toBeCloseTo((600 / 1_000_000) * 0.042)

  const opencode = rows.find((row) => row.harness === "opencode")!
  expect(opencode.usageSamples).toBe(1)
  expect(opencode.costUsd).toBeCloseTo(0.002)
})

test("readLogFile tolerates a missing file", () => {
  expect(readLogFile("/nonexistent/system-one/nope.jsonl").missing).toBe(true)
  expect(readLogFile("/nonexistent/system-one/nope.jsonl").text).toBe("")
})

test("formatReport renders one block per harness", () => {
  const rows = summarizeHarness([], [])
  expect(formatReport(rows)).toContain("no records")
  const parsed = parseLog(JSON.stringify({ kind: "decision", harness: "hermes", chosen: "demo", inputTokens: 10, latencyMs: 5, time: 1 }))
  const text = formatReport(summarizeHarness(parsed.decisions, parsed.usage))
  expect(text).toContain("hermes")
  expect(text).toContain("demo:1")
})
