import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Ask } from "../../src/jev"
import { defaultSkillDirs, scanSkillDirs } from "./lib/roster"
import { NONE_CONTEXT, decide, injectionFor } from "./lib/decide"

function skillDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "system-one-skills-"))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, "SKILL.md"), text)
  }
  return dir
}

function stubAsk(...responses: Array<Record<string, unknown> | Error>) {
  const calls: unknown[] = []
  const ask: Ask = async (input) => {
    calls.push(input)
    const response = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (response instanceof Error) throw response
    return response
  }
  return { ask, calls }
}

const openGate = {
  "gate::acts": { type: "noul", noul: 0.9 },
  "gate::procedure": { type: "noul", noul: 0.8 },
  "gate::prose": { type: "noul", noul: 0.2 },
}

test("scanSkillDirs parses frontmatter and skips non-skill dirs", () => {
  const dir = skillDir({
    alpha: "---\nname: Alpha\ndescription: Does alpha things\n---\n\nAlpha body\n",
    beta: "---\nname: Beta\n---\n\nBeta body\n",
    broken: "no frontmatter here",
  })
  const skills = scanSkillDirs([dir])
  const alpha = skills.find((skill) => skill.id === "alpha")
  expect(alpha?.name).toBe("Alpha")
  expect(alpha?.description).toBe("Does alpha things")
  expect(alpha?.content.trim()).toBe("Alpha body")
  expect(alpha?.path.endsWith("alpha/SKILL.md")).toBe(true)
  const beta = skills.find((skill) => skill.id === "beta")
  expect(beta?.name).toBe("Beta")
  expect(beta?.description).toBeUndefined()
  const broken = skills.find((skill) => skill.id === "broken")
  expect(broken?.name).toBe("broken")
  expect(broken?.content).toBe("no frontmatter here")
})

test("defaultSkillDirs includes the user and project skills directories", () => {
  const dirs = defaultSkillDirs("/work/project")
  expect(dirs).toEqual([join(process.env.HOME ?? "", ".claude", "skills"), "/work/project/.claude/skills"])
})

test("decide returns the skill when Jev picks one", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
    ...openGate,
  })
  const decision = await decide(ask, "build me a deck", [
    { id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" },
  ])
  expect(decision).toEqual({ kind: "skill", id: "pptx-author" })
})

test("decide returns none when Jev answers but picks no skill", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
    "gate::acts": { type: "noul", noul: 0.1 },
    "gate::procedure": { type: "noul", noul: 0.1 },
    "gate::prose": { type: "noul", noul: 0.9 },
  })
  const decision = await decide(ask, "explain monads", [
    { id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" },
  ])
  expect(decision).toEqual({ kind: "none" })
})

test("decide returns no-change on transport errors and low confidence", async () => {
  const roster = [{ id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" }]
  const transport = await decide(stubAsk(new Error("boom")).ask, "build me a deck", roster)
  expect(transport).toEqual({ kind: "no-change" })

  const low = await decide(
    stubAsk({
      which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.5 }, confidence: 0.1 },
      ...openGate,
    }).ask,
    "build me a deck",
    roster,
  )
  expect(low).toEqual({ kind: "no-change" })
})

test("decide returns no-change without an ask or a roster", async () => {
  const roster = [{ id: "pptx-author", name: "pptx-author", content: "x" }]
  expect(await decide(undefined, "build me a deck", roster)).toEqual({ kind: "no-change" })
  expect(await decide(stubAsk({}).ask, "build me a deck", [])).toEqual({ kind: "no-change" })
})

test("injectionFor caps the body and points at the path past the cap", () => {
  const short = injectionFor({ id: "a", name: "Alpha", description: "Does alpha", content: "body", path: "/s/a/SKILL.md" })
  expect(short).toContain("Alpha (a)")
  expect(short).toContain("body")

  const long = injectionFor({
    id: "b",
    name: "Beta",
    description: "Does beta",
    content: "x".repeat(8001),
    path: "/s/b/SKILL.md",
  })
  expect(long).toContain("/s/b/SKILL.md")
  expect(long).not.toContain("x".repeat(8001))

  expect(NONE_CONTEXT).toContain("routed externally")
})
