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

import { readFileSync } from "node:fs"
import { decideVerification, verifyEnabled, verifyMessages } from "./lib/verify"
import { parseSamples, summarize } from "../../src/observe"
import { policy } from "../../src/policy"

const HOOK = join(import.meta.dir, "hooks", "system-one.ts")

function hookEnv(extra: Record<string, string>): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...extra }
}

const unverified = {
  "control::claim": { type: "noul", noul: 0.9 },
  "control::ran": { type: "noul", noul: 0.1 },
  "control::passed": { type: "noul", noul: 0.1 },
}

const verified = {
  "control::claim": { type: "noul", noul: 0.9 },
  "control::ran": { type: "noul", noul: 0.9 },
  "control::passed": { type: "noul", noul: 0.9 },
}

test("verifyEnabled is off by default and reads the contract default", () => {
  expect(verifyEnabled({})).toBe(policy.control.verify)
  expect(verifyEnabled({})).toBe(false)
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    expect(verifyEnabled({ SYSTEM_ONE_VERIFY: value })).toBe(true)
  }
  for (const value of ["0", "false", "no", "off", "", "maybe"]) {
    expect(verifyEnabled({ SYSTEM_ONE_VERIFY: value })).toBe(false)
  }
})

test("decideVerification nudges a completion claim with no passing check and stays quiet otherwise", async () => {
  const claim = [{ role: "assistant", content: [{ type: "text", text: "All tests pass, the fix is complete." }] }]
  const hint = await decideVerification(stubAsk(unverified).ask, { messages: claim })
  expect(hint).toEqual({ hint: policy.control.hint })

  const checked = await decideVerification(stubAsk(verified).ask, { messages: claim })
  expect(checked).toBeNull()

  const noClaim = [{ role: "assistant", content: [{ type: "text", text: "Here is the function you asked about." }] }]
  expect(await decideVerification(stubAsk(unverified).ask, { messages: noClaim })).toBeNull()
})

test("decideVerification fails open on transport errors and malformed answers", async () => {
  const claim = [{ role: "assistant", content: [{ type: "text", text: "done" }] }]
  expect(await decideVerification(stubAsk(new Error("boom")).ask, { messages: claim })).toBeNull()
  expect(await decideVerification(stubAsk({}).ask, { messages: claim })).toBeNull()
  expect(
    await decideVerification(
      stubAsk({ "control::claim": { type: "noul", noul: 0.9 }, "control::ran": { type: "noul", noul: 0.9 } }).ask,
      { messages: claim },
    ),
  ).toBeNull()

  const belowThreshold = {
    "control::claim": { type: "noul", noul: policy.control.claimMin - 0.1 },
    "control::ran": { type: "noul", noul: 0.1 },
    "control::passed": { type: "noul", noul: 0.1 },
  }
  expect(await decideVerification(stubAsk(belowThreshold).ask, { messages: claim })).toBeNull()
})

test("verifyMessages appends the final assistant message and skips unreadable transcripts", () => {
  const transcript = join(tmpdir(), `system-one-transcript-${process.pid}.jsonl`)
  writeFileSync(
    transcript,
    [
      "not json at all",
      JSON.stringify({ type: "user", message: { role: "user", content: "fix the bug" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } }),
      JSON.stringify({ type: "summary", summary: "ignored" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
    ].join("\n"),
  )
  const messages = verifyMessages({ transcript_path: transcript, last_assistant_message: "It is done." })
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"])
  expect(messages.at(-1)?.content).toEqual([{ type: "text", text: "It is done." }])

  expect(verifyMessages({ transcript_path: join(tmpdir(), "does-not-exist-xyz.jsonl") })).toEqual([])
  expect(verifyMessages({})).toEqual([])
})

test("the Stop hook blocks a completion claim when verify is on and the check is missing", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "system-one-stop-"))
  const { serverURL, server } = startMockJev(unverified)
  try {
    const proc = Bun.spawn(["bun", "run", HOOK], {
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "sess-stop",
          last_assistant_message: "All tests pass, the migration is complete.",
          stop_hook_active: false,
        }),
      ]),
      env: hookEnv({
        OPENROUTER_API_KEY: "test",
        SYSTEM_ONE_STATE_DIR: stateDir,
        SYSTEM_ONE_SERVER_URL: serverURL,
        SYSTEM_ONE_VERIFY: "1",
      }),
      stdout: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.decision).toBe("block")
    expect(output.reason).toBe(policy.control.hint)
  } finally {
    server.stop(true)
  }
})

test("the Stop hook stays silent when a check ran and passed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "system-one-stop-ok-"))
  const { serverURL, server } = startMockJev(verified)
  try {
    const proc = Bun.spawnSync(["bun", "run", HOOK], {
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "sess-stop-ok",
          last_assistant_message: "All tests pass, the migration is complete.",
        }),
      ]),
      env: hookEnv({
        OPENROUTER_API_KEY: "test",
        SYSTEM_ONE_STATE_DIR: stateDir,
        SYSTEM_ONE_SERVER_URL: serverURL,
        SYSTEM_ONE_VERIFY: "1",
      }),
      stdout: "pipe",
    })
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString().trim()).toBe("")
    const lines = readFileSync(join(stateDir, "decisions.jsonl"), "utf8").trim().split("\n")
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "decision", hook: "Stop", chosen: "hold" })
  } finally {
    server.stop(true)
  }
})

test("the Stop hook is inert by default, while active, or without an API key", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "system-one-stop-off-"))
  const payload = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "sess-off",
    last_assistant_message: "All tests pass, the migration is complete.",
  })
  const run = (env: Record<string, string>) =>
    Bun.spawnSync(["bun", "run", HOOK], {
      stdin: new Blob([payload]),
      env: hookEnv({ SYSTEM_ONE_STATE_DIR: stateDir, OPENROUTER_API_KEY: "test", SYSTEM_ONE_SERVER_URL: "", ...env }),
      stdout: "pipe",
    })

  const off = run({})
  expect(off.exitCode).toBe(0)
  expect(off.stdout.toString().trim()).toBe("")

  const noKey = run({ SYSTEM_ONE_VERIFY: "1", OPENROUTER_API_KEY: "" })
  expect(noKey.exitCode).toBe(0)
  expect(noKey.stdout.toString().trim()).toBe("")

  const unreachable = run({ SYSTEM_ONE_VERIFY: "1", SYSTEM_ONE_SERVER_URL: "http://127.0.0.1:1" })
  expect(unreachable.exitCode).toBe(0)
  expect(unreachable.stdout.toString().trim()).toBe("")
})

test("the Stop hook never blocks twice for one turn", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "system-one-stop-loop-"))
  const { serverURL, server } = startMockJev(unverified)
  try {
    const proc = Bun.spawn(["bun", "run", HOOK], {
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "sess-loop",
          last_assistant_message: "All tests pass.",
          stop_hook_active: true,
        }),
      ]),
      env: hookEnv({
        OPENROUTER_API_KEY: "test",
        SYSTEM_ONE_STATE_DIR: stateDir,
        SYSTEM_ONE_SERVER_URL: serverURL,
        SYSTEM_ONE_VERIFY: "1",
      }),
      stdout: "pipe",
    })
    expect(await new Response(proc.stdout).text()).toBe("")
    expect(await proc.exited).toBe(0)
  } finally {
    server.stop(true)
  }
})

test("hooks.json wires the Stop event to the same hook command", () => {
  const hooks = JSON.parse(readFileSync(join(import.meta.dir, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
  }
  expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toContain("hooks/system-one.ts")
  expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toContain("hooks/system-one.ts")
  expect(hooks.hooks.PreToolUse?.[0]?.matcher).toBe("Skill")
})

test("every user message appends one usage line beside the decision lines", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "system-one-usage-"))
  const skills = mkdtempSync(join(tmpdir(), "system-one-usage-skills-"))
  mkdirSync(join(skills, "pptx-author"), { recursive: true })
  writeFileSync(join(skills, "pptx-author", "SKILL.md"), "---\nname: pptx-author\n---\n\nbody\n")
  const { serverURL, server } = startMockJev()
  try {
    for (const prompt of ["build me a deck", "now write the notes"]) {
      const proc = Bun.spawn(["bun", "run", HOOK], {
        stdin: new Blob([
          JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-usage", prompt, cwd: process.cwd() }),
        ]),
        env: hookEnv({
          OPENROUTER_API_KEY: "test",
          SYSTEM_ONE_STATE_DIR: stateDir,
          SYSTEM_ONE_SKILL_DIRS: skills,
          SYSTEM_ONE_SERVER_URL: serverURL,
        }),
        stdout: "pipe",
      })
      await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
    }
  } finally {
    server.stop(true)
  }

  const lines = readFileSync(join(stateDir, "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const usage = lines.filter((line) => line.kind === "usage")
  expect(usage).toHaveLength(2)
  expect(usage.map((line) => line.messageID)).toEqual(["sess-usage-1", "sess-usage-2"])
  expect(usage[0]).toMatchObject({ harness: "claude-code", sessionID: "sess-usage", agent: "claude-code", model: "~typesafe/jev-1.13.0" })

  const samples = parseSamples(readFileSync(join(stateDir, "decisions.jsonl"), "utf8"))
  expect(samples).toHaveLength(2)
  const summary = summarize(samples)
  expect(summary.messages).toBe(2)
  expect(summary.input).toBe(20)
  expect(summary.output).toBe(4)
})

test("a usage line is written even when no decision is taken", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "system-one-usage-nokey-"))
  const skills = mkdtempSync(join(tmpdir(), "system-one-usage-nokey-skills-"))
  mkdirSync(join(skills, "pptx-author"), { recursive: true })
  writeFileSync(join(skills, "pptx-author", "SKILL.md"), "---\nname: pptx-author\n---\n\nbody\n")
  const proc = Bun.spawnSync(["bun", "run", HOOK], {
    stdin: new Blob([
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-nokey", prompt: "hi", agent_type: "reviewer" }),
    ]),
    env: hookEnv({
      OPENROUTER_API_KEY: "",
      SYSTEM_ONE_STATE_DIR: stateDir,
      SYSTEM_ONE_SKILL_DIRS: skills,
      SYSTEM_ONE_SERVER_URL: "",
    }),
    stdout: "pipe",
  })
  expect(proc.exitCode).toBe(0)
  expect(proc.stdout.toString().trim()).toBe("")
  const lines = readFileSync(join(stateDir, "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  expect(lines.filter((line) => line.kind === "usage")).toHaveLength(1)
  const usage = lines.find((line) => line.kind === "usage")!
  expect(usage).toMatchObject({ sessionID: "sess-nokey", messageID: "sess-nokey-1", agent: "reviewer" })
  expect(usage.promptChars).toBe(2)
})

test("the marketplace manifest resolves the plugin from this local path", async () => {
  const root = import.meta.dir
  const manifestPath = join(root, "marketplace", ".claude-plugin", "marketplace.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name: string
    plugins: Array<{ name: string; source: string; description: string; version: string }>
  }
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { name: string; version: string }
  const entry = manifest.plugins[0]!
  expect(entry.name).toBe(plugin.name)
  expect(entry.version).toBe(plugin.version)
  expect(entry.source).not.toContain("..")
  expect(entry.description.length).toBeGreaterThan(0)

  const proc = Bun.spawnSync(["claude", "plugin", "validate", root], { stdout: "pipe", stderr: "pipe" })
  expect(`${proc.stdout.toString()}${proc.stderr.toString()}`).toContain("Validation passed")
  expect(proc.exitCode).toBe(0)

  const marketplace = Bun.spawnSync(["claude", "plugin", "validate", join(root, "marketplace")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(`${marketplace.stdout.toString()}${marketplace.stderr.toString()}`).toContain("Validation passed")
})
