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
  "gate::advisory": { type: "noul", noul: 0.1 },
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
    "gate::advisory": { type: "noul", noul: 0.1 },
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

test("decide returns no-change when the first answer is unparseable", async () => {
  const roster = [{ id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" }]
  expect(await decide(stubAsk({}).ask, "build me a deck", roster)).toEqual({ kind: "no-change" })
  expect(
    await decide(stubAsk({ which: { type: "choice", choice: 7 }, ...openGate }).ask, "build me a deck", roster),
  ).toEqual({ kind: "no-change" })
  expect(
    await decide(
      stubAsk({
        which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
        "gate::acts": { type: "noul" },
        "gate::procedure": { type: "noul", noul: 0.8 },
        "gate::prose": { type: "noul", noul: 0.2 },
      }).ask,
      "build me a deck",
      roster,
    ),
  ).toEqual({ kind: "no-change" })
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

import { readState, writeState } from "./lib/state"
import { startMockJev } from "./mock-jev"

test("session state round-trips, counts calls, and expires", () => {
  const dir = mkdtempSync(join(tmpdir(), "system-one-state-"))
  process.env.SYSTEM_ONE_STATE_DIR = dir
  writeState("s1", { decision: "none", at: Date.now(), calls: 3 })
  const state = readState("s1")
  expect(state?.decision).toBe("none")
  expect(state?.calls).toBe(3)
  writeState("s2", { at: Date.now() - 3 * 60 * 60 * 1000, calls: 1 })
  expect(readState("s2")).toBeUndefined()
  delete process.env.SYSTEM_ONE_STATE_DIR
})

test("the hook injects a routed skill and writes state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "system-one-hook-"))
  process.env.SYSTEM_ONE_STATE_DIR = stateDir
  const skills = mkdtempSync(join(tmpdir(), "system-one-hook-skills-"))
  mkdirSync(join(skills, "pptx-author"), { recursive: true })
  writeFileSync(
    join(skills, "pptx-author", "SKILL.md"),
    "---\nname: pptx-author\ndescription: Author decks\n---\n\nUse python-pptx\n",
  )
  const { serverURL, server } = startMockJev()
  try {
    // async spawn: Bun.spawnSync blocks this process's event loop, so the in-process mock could not answer.
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "hooks", "system-one.ts")], {
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-1",
          prompt: "build me a deck",
          cwd: process.cwd(),
        }),
      ]),
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "test",
        SYSTEM_ONE_STATE_DIR: stateDir,
        SYSTEM_ONE_SKILL_DIRS: skills,
        SYSTEM_ONE_SERVER_URL: serverURL,
      },
      stdout: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.hookSpecificOutput.additionalContext).toContain("pptx-author")
    expect(readState("sess-1")?.decision).toBe("skill")
  } finally {
    server.stop(true)
    delete process.env.SYSTEM_ONE_STATE_DIR
  }
})

test("the PreToolUse hook denies the Skill tool only after a none decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "system-one-deny-"))
  process.env.SYSTEM_ONE_STATE_DIR = dir
  try {
    writeState("sess-deny", { decision: "none", at: Date.now(), calls: 1 })
    const denied = Bun.spawnSync(["bun", "run", join(import.meta.dir, "hooks", "system-one.ts")], {
      stdin: new Blob([JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sess-deny", tool_name: "Skill" })]),
      env: { ...process.env },
      stdout: "pipe",
    })
    const output = JSON.parse(denied.stdout.toString())
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny")

    writeState("sess-allow", { decision: "skill", at: Date.now(), calls: 1 })
    const allowed = Bun.spawnSync(["bun", "run", join(import.meta.dir, "hooks", "system-one.ts")], {
      stdin: new Blob([JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sess-allow", tool_name: "Skill" })]),
      env: { ...process.env },
      stdout: "pipe",
    })
    expect(allowed.stdout.toString().trim()).toBe("")
  } finally {
    delete process.env.SYSTEM_ONE_STATE_DIR
  }
})

test("the hook is silent and exits 0 without an API key", () => {
  const dir = mkdtempSync(join(tmpdir(), "system-one-nokey-"))
  const skills = mkdtempSync(join(tmpdir(), "system-one-nokey-skills-"))
  mkdirSync(join(skills, "pptx-author"), { recursive: true })
  writeFileSync(join(skills, "pptx-author", "SKILL.md"), "---\nname: pptx-author\n---\n\nbody\n")
  const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "hooks", "system-one.ts")], {
    stdin: new Blob([JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "hi" })]),
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "",
      SYSTEM_ONE_STATE_DIR: dir,
      SYSTEM_ONE_SKILL_DIRS: skills,
      SYSTEM_ONE_SERVER_URL: "",
    },
    stdout: "pipe",
  })
  expect(proc.exitCode).toBe(0)
  expect(proc.stdout.toString().trim()).toBe("")
})
