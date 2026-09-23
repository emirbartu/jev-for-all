import { expect, test } from "bun:test"
import { JevError, asChoice, asNoul, createJev } from "./jev"
import { formatReport, parseSamples, summarize, usageFromMessages } from "./observe"

type Canned = { status?: number; body: unknown; delayMs?: number }

function mockJevServer(handler: (request: Request) => Canned | Promise<Canned>) {
  const requests: Array<{ url: string; body: unknown; authorization: string | null }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined)
      requests.push({ url: request.url, body, authorization: request.headers.get("authorization") })
      const canned = await handler(request)
      if (canned.delayMs) await new Promise((resolve) => setTimeout(resolve, canned.delayMs))
      return new Response(JSON.stringify(canned.body), {
        status: canned.status ?? 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return { server, requests, serverURL: `http://localhost:${server.port}` }
}

test("createJev posts to the OpenRouter decisions endpoint", async () => {
  const mock = mockJevServer(() => ({
    body: {
      answers: { which: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 } },
      model: "~typesafe/jev-latest",
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL })
    const answers = await ask({
      state: { request: "hi" },
      questions: { which: { type: "choice", instructions: "pick", criteria: { read: "read a file" } } },
    })
    expect(asChoice(answers.which)?.choice).toBe("read")
    expect(mock.requests.length).toBe(1)
    expect(new URL(mock.requests[0].url).pathname).toBe("/api/alpha/decisions")
    expect(mock.requests[0].authorization).toBe("Bearer k")
    expect(mock.requests[0].body).toEqual({
      model: "~typesafe/jev-latest",
      state: { request: "hi" },
      questions: { which: { type: "choice", instructions: "pick", criteria: { read: "read a file" } } },
    })
  } finally {
    mock.server.stop(true)
  }
})

test("createJev throws JevError on non-2xx", async () => {
  const mock = mockJevServer(() => ({ status: 429, body: { error: { message: "slow down" } } }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL })
    await expect(ask({ state: {}, questions: {} })).rejects.toMatchObject({ status: 429 })
    expect(mock.requests.length).toBe(1)
  } finally {
    mock.server.stop(true)
  }
})

test("createJev throws JevError on a response without answers", async () => {
  const mock = mockJevServer(() => ({ body: { model: "x", usage: {} } }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL })
    await expect(ask({ state: {}, questions: {} })).rejects.toThrow(JevError)
  } finally {
    mock.server.stop(true)
  }
})

test("createJev honours timeoutMs", async () => {
  const mock = mockJevServer(() => ({
    body: {
      answers: { which: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 } },
      model: "~typesafe/jev-latest",
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    delayMs: 200,
  }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL, timeoutMs: 50 })
    let error: unknown
    const started = performance.now()
    try {
      await ask({ state: {}, questions: {} })
    } catch (caught) {
      error = caught
    }
    const elapsed = performance.now() - started
    expect(error).toBeInstanceOf(JevError)
    expect(elapsed).toBeLessThan(150)
    expect((error as Error).message).toMatch(/timed out/i)
  } finally {
    mock.server.stop(true)
  }
})

test("answer guards reject malformed payloads", () => {
  expect(asChoice({ type: "choice" })).toBeNull()
  expect(asChoice(null)).toBeNull()
  expect(asNoul({ type: "noul", noul: "high" })).toBeNull()
  expect(asNoul({ type: "noul", noul: 0.7 })?.noul).toBe(0.7)
})

import { applySkillDecision, selectSkill } from "./skills"
import type { Ask } from "./jev"

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

const skillRoster = [
  { id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" },
  { id: "pptx-edit", name: "pptx-edit", description: "Edit decks", content: "Use the editor" },
]

const openGate = { "gate::acts": { type: "noul", noul: 0.9 }, "gate::procedure": { type: "noul", noul: 0.8 }, "gate::prose": { type: "noul", noul: 0.2 } }
const closedGate = { "gate::acts": { type: "noul", noul: 0.1 }, "gate::procedure": { type: "noul", noul: 0.1 }, "gate::prose": { type: "noul", noul: 0.9 } }

test("selectSkill returns null when the gate is closed", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9, "pptx-edit": 0.1 }, confidence: 0.9 },
    ...closedGate,
  })
  expect(await selectSkill(ask, { request: "explain monads", skills: skillRoster, config: { rerank: false } })).toBeNull()
})

test("selectSkill returns the ranked winner", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.8, "pptx-edit": 0.2 }, confidence: 0.9 },
    ...openGate,
  })
  expect(await selectSkill(ask, { request: "build me a deck", skills: skillRoster, config: { rerank: false } })).toEqual({
    id: "pptx-author",
  })
})

test("selectSkill rejects a winner that is not in the roster", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "nope", probabilities: { nope: 1 }, confidence: 1 },
    ...openGate,
  })
  expect(await selectSkill(ask, { request: "build me a deck", skills: skillRoster, config: { rerank: false } })).toBeNull()
})

test("selectSkill reranks a large roster and honours the fits threshold", async () => {
  const { ask, calls } = stubAsk(
    {
      which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.6, "pptx-edit": 0.4 }, confidence: 0.9 },
      ...openGate,
    },
    {
      which: { type: "choice", choice: "pptx-edit", probabilities: { "pptx-author": 0.4, "pptx-edit": 0.6 }, confidence: 0.9 },
      "fits::pptx-author": { type: "noul", noul: 0.2 },
      "fits::pptx-edit": { type: "noul", noul: 0.8 },
    },
  )
  const decision = await selectSkill(ask, { request: "edit my deck", skills: skillRoster, config: { rerank: "auto", rerankAbove: 1 } })
  expect(calls.length).toBe(2)
  expect(decision).toEqual({ id: "pptx-edit" })
})

test("selectSkill fails open on transport errors", async () => {
  const { ask } = stubAsk(new Error("boom"))
  expect(await selectSkill(ask, { request: "anything", skills: skillRoster })).toBeNull()
})

test("selectSkill fails open when gate answers are malformed", async () => {
  const { ask } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9, "pptx-edit": 0.1 }, confidence: 0.9 },
    "gate::acts": { type: "noul", noul: 0.9 },
    "gate::procedure": { type: "noul", noul: "high" },
  })
  expect(await selectSkill(ask, { request: "build me a deck", skills: skillRoster, config: { rerank: false } })).toBeNull()
})

test("applySkillDecision pushes once and dedupes", () => {
  const prompt: { skills?: Array<{ id: string }> } = {}
  expect(applySkillDecision(prompt, { id: "pptx-author" })).toBe(true)
  expect(applySkillDecision(prompt, { id: "pptx-author" })).toBe(false)
  expect(applySkillDecision(prompt, null)).toBe(false)
  expect(prompt.skills).toEqual([{ id: "pptx-author" }])
})

import { applyToolDecision, renderState, routeTools } from "./tools"

const toolCatalog = {
  read: { description: "Read a file" },
  grep: { description: "Search file contents" },
  edit: { description: "Edit a file" },
  browser_scrape: { description: "Load a web page" },
  browser_click: { description: "Click a page element" },
}

test("routeTools keeps the chosen tool and the alwaysVisible floor", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "grep", probabilities: { grep: 0.7, edit: 0.2, browser_scrape: 0.05, browser_click: 0.05 }, confidence: 0.9 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  const decision = await routeTools(ask, {
    state: "find X",
    catalog: toolCatalog,
    config: { maxTools: 1, alwaysVisible: ["read"] },
  })
  expect(decision?.tools).toEqual(["grep", "read"])
  expect(decision?.start).toBe("grep")
  expect(decision?.filtered).toBe(true)

  const tools: Record<string, unknown> = { ...toolCatalog }
  const system: Array<{ type: string; text: string }> = []
  applyToolDecision(tools, system, decision!)
  expect(Object.keys(tools).sort()).toEqual(["grep", "read"])
  expect(system[0].text).toContain("Start with: grep")
})

test("routeTools leaves the catalog alone when no tool is needed", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.05 },
  })
  const decision = await routeTools(ask, { state: "hi", catalog: toolCatalog })
  expect(decision?.filtered).toBe(false)
  expect(decision?.tools.length).toBe(Object.keys(toolCatalog).length)
  expect(decision?.hint).toContain("answer directly")
})

test("routeTools bails out on low confidence", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 0.4, edit: 0.3 }, confidence: 0.1 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  expect(await routeTools(ask, { state: "hi", catalog: toolCatalog })).toBeNull()
})

test("routeTools fails open when no ranked tool is in the catalog", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "ghost", probabilities: { ghost: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  expect(await routeTools(ask, { state: "hi", catalog: toolCatalog, config: { alwaysVisible: [] } })).toBeNull()
})

test("routeTools fails open on transport errors", async () => {
  const { ask } = stubAsk(new Error("timeout"))
  expect(await routeTools(ask, { state: "hi", catalog: toolCatalog })).toBeNull()
})

test("renderState keeps the tail within budget", () => {
  const rendered = renderState({
    agent: "build",
    messages: [
      { role: "user", content: [{ type: "text", text: "x".repeat(1000) }] },
      { role: "assistant", content: [{ type: "text", text: "latest instruction" }] },
    ],
    budget: 50,
  })
  expect(rendered.length).toBeLessThanOrEqual(50)
  expect(rendered).toContain("latest instruction")
})

import { createCache, createWarnOnce, hashKey, readOptions } from "../index"

test("cache returns values, expires entries, and evicts the oldest", () => {
  let now = 0
  const cache = createCache<number>({ max: 2, ttlMs: 100, now: () => now })
  cache.set("a", 1)
  expect(cache.get("a")).toBe(1)
  now = 101
  expect(cache.get("a")).toBeUndefined()
  cache.set("b", 2)
  cache.set("c", 3)
  cache.set("d", 4)
  expect(cache.get("b")).toBeUndefined()
  expect(cache.get("d")).toBe(4)
})

test("hashKey is stable and distinct", () => {
  expect(hashKey("abc")).toBe(hashKey("abc"))
  expect(hashKey("abc")).not.toBe(hashKey("abd"))
})

test("readOptions applies defaults and accepts overrides", () => {
  const defaults = readOptions({})
  expect(defaults.model).toBe("~typesafe/jev-latest")
  expect(defaults.timeoutMs).toBe(1000)
  expect(defaults.tools.alwaysVisible).toContain("read")
  expect(defaults.skills.rerank).toBe("auto")

  const custom = readOptions({
    model: "jev-1.13.0",
    timeoutMs: 500,
    agents: ["build"],
    tools: { maxTools: 3 },
    skills: { rerank: false },
  })
  expect(custom.model).toBe("jev-1.13.0")
  expect(custom.timeoutMs).toBe(500)
  expect(custom.agents).toEqual(["build"])
  expect(custom.tools.maxTools).toBe(3)
  expect(custom.tools.alwaysVisible).toContain("read")
  expect(custom.skills.rerank).toBe(false)
})

test("setup is inert without an API key", async () => {
  const saved = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    const plugin = (await import("../index")).default
    let hooked = false
    const context = {
      options: {},
      session: {
        hook: () => {
          hooked = true
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    }
    const cleanup = await plugin.setup(context as never)
    expect(hooked).toBe(false)
    expect(cleanup).toBeUndefined()
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved
  }
})

test("setup registers the prompt and context hooks", async () => {
  const plugin = (await import("../index")).default
  const names: string[] = []
  const context = {
    options: { apiKey: "test" },
    session: {
      hook: (name: string) => {
        names.push(name)
        return Promise.resolve({ dispose: async () => {} })
      },
    },
  }
  const cleanup = await plugin.setup(context as never)
  expect(names).toEqual(["prompt", "context"])
  await cleanup?.()
})

test("createWarnOnce warns once per session", () => {
  const original = console.warn
  const calls: unknown[][] = []
  console.warn = (...args: unknown[]) => {
    calls.push(args)
  }
  try {
    const warnOnce = createWarnOnce()
    warnOnce("session-a", "skill routing failed")
    warnOnce("session-a", "skill routing failed")
    warnOnce("session-b", "tool routing failed")
    expect(calls.length).toBe(2)
  } finally {
    console.warn = original
  }
})

test("readOptions warns on invalid values and falls back", () => {
  const original = console.warn
  const calls: unknown[][] = []
  console.warn = (...args: unknown[]) => {
    calls.push(args)
  }
  try {
    const options = readOptions({ timeoutMs: "fast" })
    expect(options.timeoutMs).toBe(1000)
    expect(calls.some((args) => String(args[0]).includes("timeoutMs"))).toBe(true)
  } finally {
    console.warn = original
  }
})

test("prompt hook routes skills end to end", async () => {
  const mock = mockJevServer(() => ({
    body: {
      answers: {
        which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
        "gate::acts": { type: "noul", noul: 0.9 },
        "gate::procedure": { type: "noul", noul: 0.8 },
        "gate::prose": { type: "noul", noul: 0.2 },
      },
      model: "~typesafe/jev-latest",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }))
  try {
    let promptHook: ((event: unknown) => Promise<void> | void) | undefined
    const plugin = (await import("../index")).default
    await plugin.setup({
      options: { apiKey: "test", serverURL: mock.serverURL },
      skill: {
        list: async () => ({
          data: [{ id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" }],
        }),
      },
      session: {
        hook: (name: string, callback: (event: unknown) => Promise<void> | void) => {
          if (name === "prompt") promptHook = callback
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as never)

    const prompt: { text: string; skills?: Array<{ id: string }> } = { text: "build me a deck" }
    await promptHook!({ sessionID: "s1", prompt })
    expect(prompt.skills).toEqual([{ id: "pptx-author" }])
  } finally {
    mock.server.stop(true)
  }
})

test("context hook routes tools end to end", async () => {
  const mock = mockJevServer(() => ({
    body: {
      answers: {
        next: { type: "choice", choice: "grep", probabilities: { grep: 0.7, edit: 0.2 }, confidence: 0.9 },
        needs_tool: { type: "noul", noul: 0.9 },
      },
      model: "~typesafe/jev-latest",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }))
  try {
    let contextHook: ((event: unknown) => Promise<void> | void) | undefined
    const plugin = (await import("../index")).default
    await plugin.setup({
      options: { apiKey: "test", serverURL: mock.serverURL },
      session: {
        hook: (name: string, callback: (event: unknown) => Promise<void> | void) => {
          if (name === "context") contextHook = callback
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as never)

    const tools: Record<string, unknown> = {
      read: { description: "Read" },
      grep: { description: "Search" },
      edit: { description: "Edit" },
      browser: { description: "Browse" },
    }
    const system: Array<{ type: string; text: string }> = []
    await contextHook!({ sessionID: "s1", agent: "build", messages: [], tools, system })
    expect(Object.keys(tools).sort()).toEqual(["edit", "grep", "read"])
    expect(system[0].text).toContain("Start with: grep")
  } finally {
    mock.server.stop(true)
  }
})

const assistantMessage = {
  id: "msg_1",
  type: "assistant",
  agent: "build",
  model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
  time: { created: 1000 },
  cost: 0.002,
  tokens: { input: 1200, output: 340, reasoning: 12, cache: { read: 900, write: 100 } },
}

test("usageFromMessages maps assistant token usage and skips seen ids", () => {
  const messages = [
    { id: "msg_0", type: "user" },
    assistantMessage,
    { id: "msg_2", type: "assistant" }, // no tokens yet
    { id: "msg_1", type: "assistant", tokens: { input: 1, output: 1 } }, // duplicate id
  ]
  const first = usageFromMessages("ses_1", messages)
  expect(first).toEqual([
    {
      sessionID: "ses_1",
      messageID: "msg_1",
      agent: "build",
      model: "opencode-go/deepseek-v4.1-flash",
      input: 1200,
      output: 340,
      reasoning: 12,
      cacheRead: 900,
      cacheWrite: 100,
      cost: 0.002,
      time: 1000,
    },
  ])

  const seen = new Set(["msg_1"])
  expect(usageFromMessages("ses_1", messages, seen)).toEqual([])
})

test("summarize and formatReport aggregate samples", () => {
  const summary = summarize(usageFromMessages("ses_1", [assistantMessage]))
  expect(summary).toEqual({
    messages: 1,
    input: 1200,
    output: 340,
    reasoning: 12,
    cacheRead: 900,
    cacheWrite: 100,
    cost: 0.002,
  })
  const report = formatReport([
    { label: "baseline", summary },
    { label: "routed", summary: summarize([]) },
  ])
  expect(report).toContain("baseline")
  expect(report).toContain("routed")
  expect(report.split("\n").length).toBe(3)
})

test("parseSamples reads usage lines and ignores other kinds", () => {
  const jsonl = [
    JSON.stringify({ kind: "usage", ...usageFromMessages("s", [assistantMessage])[0] }),
    JSON.stringify({ kind: "decision", hook: "skills" }),
    "",
  ].join("\n")
  expect(parseSamples(jsonl).length).toBe(1)
})

import { createRecorder } from "./observe"
import { readFileSync, rmSync } from "node:fs"

test("createRecorder dedupes by message and writes usage JSONL", () => {
  const file = `/tmp/opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  const recorder = createRecorder({ file })
  recorder.flush(recorder.take("ses_1", [assistantMessage]))
  expect(recorder.take("ses_1", [assistantMessage]).length).toBe(0)
  recorder.flush(
    recorder.take("ses_1", [{ id: "msg_9", type: "assistant", tokens: { input: 5, output: 1 } }]),
  )

  const written = parseSamples(readFileSync(file, "utf8"))
  expect(written.length).toBe(2)
  expect(written[1].messageID).toBe("msg_9")
  rmSync(file, { force: true })
})

test("readOptions parses observe options", () => {
  const defaults = readOptions({})
  expect(defaults.observe).toEqual({ enabled: false, file: undefined, retain: 20 })

  const custom = readOptions({ observe: { enabled: true, file: "/tmp/u.jsonl", retain: 3 } })
  expect(custom.observe).toEqual({ enabled: true, file: "/tmp/u.jsonl", retain: 3 })
})

import {
  browserTool,
  buildRunnerCommand,
  defaultBrowser,
  parseRunnerOutput,
  runBrowserTask,
  STEP_CEILING,
  type Spawn,
} from "./browser"

const HOME = process.env.HOME ?? ""

function runLine(payload: Record<string, unknown>): string {
  return `noise on stdout\nJEV_RESULT ${JSON.stringify(payload)}\n`
}

const doneLine = (extra: Record<string, unknown> = {}) =>
  runLine({
    ok: true,
    status: "done",
    url: "https://example.test/a",
    title: "A",
    steps: [{ step: 1, operation: "CLICK", action: "Go", url: "https://example.test/a", text: null }],
    decisions: 2,
    cost_usd: 0.000031,
    elapsed_ms: 1200,
    error: null,
    ...extra,
  })

test("parseRunnerOutput reads the sentinel line and rejects junk", () => {
  const run = parseRunnerOutput(doneLine())
  expect(run?.ok).toBe(true)
  expect(run?.url).toBe("https://example.test/a")
  expect(run?.steps.length).toBe(1)
  expect(run?.costUsd).toBe(0.000031)
  expect(run?.elapsedMs).toBe(1200)
  expect(run?.error).toBeUndefined()

  expect(parseRunnerOutput("nothing to see")).toBeNull()
  expect(parseRunnerOutput("JEV_RESULT {not json}")).toBeNull()
  expect(parseRunnerOutput(`JEV_RESULT ${JSON.stringify({ status: "done" })}`)).toBeNull()
})

test("buildRunnerCommand pins uv at the jev checkout", () => {
  const command = buildRunnerCommand({ ...defaultBrowser, jevDir: "~/jev-ultrafast" }, "/plugin/src/jev-runner.py")
  expect(command).toEqual([
    "uv",
    "run",
    "--directory",
    `${HOME}/jev-ultrafast`,
    "--env-file",
    `${HOME}/jev-ultrafast/.env`,
    "--quiet",
    "python",
    "/plugin/src/jev-runner.py",
  ])

  const absolute = buildRunnerCommand({ ...defaultBrowser, jevDir: "/opt/jev", envFile: "/etc/jev.env" }, "/r.py")
  expect(absolute).toContain("/etc/jev.env")
  expect(absolute).toContain("/opt/jev")
})

test("runBrowserTask passes the goal over env and reports the run", async () => {
  const calls: Array<{ env: Record<string, string>; timeoutMs: number }> = []
  const spawn: Spawn = async (_command, env, timeoutMs) => {
    calls.push({ env, timeoutMs })
    return { code: 0, stdout: doneLine(), stderr: "", timedOut: false }
  }
  const config = { ...defaultBrowser, timeoutMs: 5000 }
  const { run } = await runBrowserTask({ goal: "  Find stays in Lisbon  ", max_steps: 999 }, config, spawn)
  expect(calls[0].env.JEV_TASK_GOAL).toBe("Find stays in Lisbon")
  expect(calls[0].env.JEV_TASK_URL).toBe("about:blank")
  expect(calls[0].env.JEV_TASK_MAX_STEPS).toBe(String(STEP_CEILING))
  expect(calls[0].timeoutMs).toBe(5000)
  expect(run.ok).toBe(true)
  expect(run.decisions).toBe(2)

  const explicit: Array<Record<string, string>> = []
  await runBrowserTask({ goal: "x", url: " https://a.test/ ", max_steps: 3 }, config, async (_c, env) => {
    explicit.push(env)
    return { code: 0, stdout: doneLine(), stderr: "", timedOut: false }
  })
  expect(explicit[0].JEV_TASK_URL).toBe("https://a.test/")
  expect(explicit[0].JEV_TASK_MAX_STEPS).toBe("3")
})

test("runBrowserTask fails open on no result, timeout, spawn failure and no goal", async () => {
  const noResult = await runBrowserTask(
    { goal: "x" },
    defaultBrowser,
    async () => ({ code: 1, stdout: "", stderr: "daemon default didn't come up\n", timedOut: false }),
  )
  expect(noResult.run.ok).toBe(false)
  expect(noResult.run.error).toContain("no result")
  expect(noResult.run.error).toContain("daemon default")

  const hung = await runBrowserTask({ goal: "x" }, defaultBrowser, async () => ({
    code: null,
    stdout: "",
    stderr: "",
    timedOut: true,
  }))
  expect(hung.run.error).toContain("timed out")

  const threw = await runBrowserTask({ goal: "x" }, defaultBrowser, async () => {
    throw new Error("ENOENT uv")
  })
  expect(threw.run.error).toContain("could not start")

  const homeless = await runBrowserTask({}, defaultBrowser, async () => ({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  }))
  expect(homeless.run.error).toContain("needs a goal")
})

test("browserTool is goal-driven and formats its report", async () => {
  const tool = browserTool({
    config: { ...defaultBrowser, enabled: true },
    spawn: async () => ({
      code: 0,
      stdout: runLine({
        ok: false,
        status: "blocked",
        url: "https://example.test/list",
        title: "Stays",
        steps: [{ step: 1, operation: "CLICK", action: "View Casa Flora", url: "u", text: "Lisbon" }],
        decisions: 5,
        cost_usd: 0.0002,
        elapsed_ms: 2600,
        error: null,
      }),
      stderr: "",
      timedOut: false,
    }),
  })
  expect(tool.name).toBe("browser_task")
  expect(tool.description).toContain("Jev")
  expect((tool.input as { required: string[] }).required).toEqual(["goal"])

  const result = await tool.execute({ goal: "Find a stay in Lisbon" })
  expect(result.content).toContain("did not finish")
  expect(result.content).toContain(`1. CLICK "View Casa Flora" = "Lisbon"`)
  expect(result.content).toContain("$0.000200")
  expect(result.metadata.status).toBe("blocked")
  expect(result.metadata.steps).toBe(1)
  expect(result.metadata.costUsd).toBe(0.0002)
})

test("readOptions parses browser options", () => {
  const defaults = readOptions({})
  expect(defaults.browser.enabled).toBe(false)
  expect(defaults.browser.jevDir).toBe("~/jev-ultrafast")

  const custom = readOptions({ browser: { enabled: true, jevDir: "/opt/jev", maxSteps: 4, timeoutMs: 9000 } })
  expect(custom.browser).toEqual({
    enabled: true,
    jevDir: "/opt/jev",
    envFile: ".env",
    uvPath: "uv",
    timeoutMs: 9000,
    maxSteps: 4,
  })
})

test("setup registers the browser tool only when enabled", async () => {
  const plugin = (await import("../index")).default
  const added: Array<{ name: string }> = []
  let disposed = false
  const cleanup = await plugin.setup({
    options: { apiKey: "k", browser: { enabled: true, jevDir: "/tmp/jev" } },
    session: { hook: () => Promise.resolve({ dispose: async () => {} }) },
    tool: {
      transform: async (callback: (editor: { add: (tool: { name: string }) => void }) => void) => {
        callback({ add: (tool) => added.push(tool) })
        return { dispose: async () => void (disposed = true) }
      },
    },
  } as never)
  expect(added.map((tool) => tool.name)).toEqual(["browser_task"])
  await cleanup?.()
  expect(disposed).toBe(true)

  let transforms = 0
  await plugin.setup({
    options: { apiKey: "k" },
    session: { hook: () => Promise.resolve({ dispose: async () => {} }) },
    tool: {
      transform: async () => {
        transforms += 1
        return { dispose: async () => {} }
      },
    },
  } as never)
  expect(transforms).toBe(0)
})

import { formatTemplate, policy } from "./policy"

test("policy carries the shipped defaults verbatim", () => {
  expect(policy.skills).toMatchObject({
    gateThreshold: 0.3,
    rerank: "auto",
    rerankAbove: 40,
    rerankBelowP: 0.5,
    shortlist: 3,
    fitsThreshold: 0.3,
    minConfidence: 0.3,
    ids: {
      rank: "which",
      rerank: "which",
      gateActs: "gate::acts",
      gateProcedure: "gate::procedure",
      gateProse: "gate::prose",
      fits: "fits::{{id}}",
    },
  })
  expect(policy.tools).toMatchObject({
    maxTools: 12,
    minToolProbability: 0.05,
    needsToolThreshold: 0.3,
    minConfidence: 0.3,
    alwaysVisible: ["read", "write", "edit", "bash", "grep", "glob"],
    stateBudget: 6000,
    ids: { next: "next", needsTool: "needs_tool" },
  })
  expect(policy.cache).toEqual({ max: 200, ttlMs: 600000 })
  expect(policy.spend).toEqual({ maxCallsPerSession: 500, warnAt: 0.8 })
  expect(policy.skills.questions).toEqual({
    rank: "Which of these skills, if any, is the right one to load to help with the user's latest request?",
    rerank: "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
    gateActs: "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
    gateProcedure: "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
    gateProse: "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
    fits: "Does the skill '{{name}}' do the specific thing the user's request asks for?",
  })
  expect(policy.tools.questions).toEqual({
    next: "Which single tool is the best next step for the agent to make progress?",
    needsTool: "Does making progress on the last step require calling a tool?",
  })
  expect(policy.tools.hints).toEqual({
    open: "<system_one_routing>",
    close: "</system_one_routing>",
    noTool: "No tool is needed for this step; answer directly.",
    start: "Start with: {{start}}.",
    available: "Available now: {{tools}}.",
    narrowed: "The tool list is already narrowed for this step; do not deliberate about tool choice, act.",
    fallback: "If none of these fit, say what you need in your reply instead of guessing.",
  })
})

test("formatTemplate substitutes named placeholders", () => {
  expect(formatTemplate("Skill '{{name}}' fits", { name: "pptx-author" })).toBe("Skill 'pptx-author' fits")
  expect(formatTemplate("fits::{{id}}", { id: "pptx-edit" })).toBe("fits::pptx-edit")
  expect(formatTemplate("no placeholders", {})).toBe("no placeholders")
  expect(formatTemplate("keep {{unknown}} as-is", {})).toBe("keep {{unknown}} as-is")
})

import { defaultSkillRouting } from "./skills"

test("skill routing defaults are the policy values", () => {
  expect(defaultSkillRouting).toEqual({
    gateThreshold: 0.3,
    rerank: "auto",
    rerankAbove: 40,
    rerankBelowP: 0.5,
    shortlist: 3,
    fitsThreshold: 0.3,
    minConfidence: 0.3,
  })
})

test("skill questions use the policy ids and text", async () => {
  const { ask, calls } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9, "pptx-edit": 0.1 }, confidence: 0.9 },
    ...openGate,
  })
  await selectSkill(ask, { request: "build me a deck", skills: skillRoster, config: { rerank: false } })
  const questions = (calls[0] as { questions: Record<string, { instructions: string }> }).questions
  expect(questions[policy.skills.ids.rank].instructions).toBe(policy.skills.questions.rank)
  expect(questions[policy.skills.ids.gateActs].instructions).toBe(policy.skills.questions.gateActs)
  expect(questions[policy.skills.ids.gateProcedure].instructions).toBe(policy.skills.questions.gateProcedure)
  expect(questions[policy.skills.ids.gateProse].instructions).toBe(policy.skills.questions.gateProse)
})

test("rerank fits questions use the policy template", async () => {
  const { ask, calls } = stubAsk(
    {
      which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.6, "pptx-edit": 0.4 }, confidence: 0.9 },
      ...openGate,
    },
    {
      which: { type: "choice", choice: "pptx-edit", probabilities: { "pptx-author": 0.4, "pptx-edit": 0.6 }, confidence: 0.9 },
      "fits::pptx-author": { type: "noul", noul: 0.2 },
      "fits::pptx-edit": { type: "noul", noul: 0.8 },
    },
  )
  await selectSkill(ask, { request: "edit my deck", skills: skillRoster, config: { rerank: "auto", rerankAbove: 1 } })
  const second = calls[1] as { questions: Record<string, { instructions: string }> }
  expect(second.questions[formatTemplate(policy.skills.ids.fits, { id: "pptx-edit" })].instructions).toBe(
    formatTemplate(policy.skills.questions.fits, { name: "pptx-edit" }),
  )
})

import { defaultToolRouting } from "./tools"

test("tool routing defaults are the policy values", () => {
  expect(defaultToolRouting).toEqual({
    maxTools: 12,
    minToolProbability: 0.05,
    needsToolThreshold: 0.3,
    minConfidence: 0.3,
    alwaysVisible: ["read", "write", "edit", "bash", "grep", "glob"],
    stateBudget: 6000,
  })
})

test("tool questions use the policy ids and text", async () => {
  const { ask, calls } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  await routeTools(ask, { state: "hi", catalog: { read: { description: "Read" } }, config: { alwaysVisible: [] } })
  const questions = (calls[0] as { questions: Record<string, { instructions: string }> }).questions
  expect(questions[policy.tools.ids.next].instructions).toBe(policy.tools.questions.next)
  expect(questions[policy.tools.ids.needsTool].instructions).toBe(policy.tools.questions.needsTool)
})

test("routing hint strings come from the policy", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "grep", probabilities: { grep: 0.7, edit: 0.2 }, confidence: 0.9 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  const decision = await routeTools(ask, {
    state: "hi",
    catalog: { read: { description: "Read" }, grep: { description: "Search" }, edit: { description: "Edit" } },
    config: { maxTools: 1, alwaysVisible: ["read"] },
  })
  expect(decision?.hint).toBe(
    [
      policy.tools.hints.open,
      formatTemplate(policy.tools.hints.start, { start: "grep" }),
      formatTemplate(policy.tools.hints.available, { tools: "grep, read" }),
      policy.tools.hints.narrowed,
      policy.tools.hints.fallback,
      policy.tools.hints.close,
    ].join("\n"),
  )
})

test("no-tool hint comes from the policy", async () => {
  const { ask } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.05 },
  })
  const decision = await routeTools(ask, { state: "hi", catalog: { read: { description: "Read" } } })
  expect(decision?.hint).toBe(
    [policy.tools.hints.open, policy.tools.hints.noTool, policy.tools.hints.close].join("\n"),
  )
})

import { runConformance } from "../scripts/conformance"

test("conformance fixtures pass against the TS core", async () => {
  const result = await runConformance(
    readFileSync(new URL("../fixtures/conformance.jsonl", import.meta.url), "utf8"),
  )
  expect(result.failures).toEqual([])
  expect(result.total).toBe(9)
  expect(result.passed).toBe(9)
})

test("skill rank criteria use the contract wording", async () => {
  const roster = [
    { id: "pptx-author", name: "pptx-author", description: "Author decks", content: "Use python-pptx" },
    { id: "bare-skill", name: "bare-skill", content: "" },
  ]
  const { ask, calls } = stubAsk({
    which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9, "bare-skill": 0.1 }, confidence: 0.9 },
    ...openGate,
  })
  await selectSkill(ask, { request: "build me a deck", skills: roster, config: { rerank: false } })
  const questions = (calls[0] as { questions: Record<string, { criteria: Record<string, string> }> }).questions
  expect(questions[policy.skills.ids.rank].criteria).toEqual({
    "pptx-author": "pptx-author — Author decks",
    "bare-skill": "bare-skill",
  })
})

test("skill rerank criteria append the content suffix", async () => {
  const roster = [
    { id: "pptx-author", name: "pptx-author", description: "Author decks", content: "x".repeat(750) },
    { id: "pptx-edit", name: "pptx-edit", description: "Edit decks", content: "Use the editor" },
  ]
  const { ask, calls } = stubAsk(
    {
      which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.6, "pptx-edit": 0.4 }, confidence: 0.9 },
      ...openGate,
    },
    {
      which: { type: "choice", choice: "pptx-edit", probabilities: { "pptx-author": 0.4, "pptx-edit": 0.6 }, confidence: 0.9 },
      "fits::pptx-author": { type: "noul", noul: 0.2 },
      "fits::pptx-edit": { type: "noul", noul: 0.8 },
    },
  )
  await selectSkill(ask, { request: "edit my deck", skills: roster, config: { rerank: "auto", rerankAbove: 1 } })
  const second = calls[1] as { questions: Record<string, { criteria: Record<string, string> }> }
  expect(second.questions[policy.skills.ids.rerank].criteria).toEqual({
    "pptx-author": `pptx-author — Author decks — ${"x".repeat(700)}`,
    "pptx-edit": "pptx-edit — Edit decks — Use the editor",
  })
})

test("tool criteria use the contract wording and fallback", async () => {
  const { ask, calls } = stubAsk({
    next: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 },
    needs_tool: { type: "noul", noul: 0.9 },
  })
  await routeTools(ask, {
    state: "hi",
    catalog: {
      read: { description: "Read a file" },
      empty: { description: "" },
      long: { description: "d".repeat(350) },
    },
    config: { alwaysVisible: [] },
  })
  const questions = (calls[0] as { questions: Record<string, { criteria: Record<string, string> }> }).questions
  expect(questions[policy.tools.ids.next].criteria).toEqual({
    read: "Read a file",
    empty: "empty",
    long: "d".repeat(300),
  })
})

test("createJev reports the resolved model and usage through onMeta", async () => {
  const mock = mockJevServer(() => ({
    body: {
      answers: { which: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 } },
      model: "~typesafe/jev-1.13.0",
      usage: { input_tokens: 123, output_tokens: 7 },
    },
  }))
  try {
    const seen: Array<{ model?: string; inputTokens?: number; outputTokens?: number }> = []
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL, onMeta: (meta) => seen.push(meta) })
    await ask({ state: { request: "hi" }, questions: {} })
    expect(seen).toEqual([{ model: "~typesafe/jev-1.13.0", inputTokens: 123, outputTokens: 7 }])
  } finally {
    mock.server.stop(true)
  }
})

test("createJev does not call onMeta on a failed request", async () => {
  const mock = mockJevServer(() => ({ status: 500, body: { error: { message: "boom" } } }))
  try {
    let called = 0
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL, onMeta: () => (called += 1) })
    await expect(ask({ state: {}, questions: {} })).rejects.toThrow()
    expect(called).toBe(0)
  } finally {
    mock.server.stop(true)
  }
})

import { decideVerification, latestAssistantText, looksLikeClaim } from "./verify"

const claimMessages = (text: string, evidence?: string) => [
  { role: "user", content: [{ type: "text", text: "implement the feature" }] },
  ...(evidence
    ? [
        { role: "assistant", content: [{ type: "tool-call", name: "bash" }] },
        { role: "tool", content: [{ type: "tool-result", name: "bash", result: { type: "text", value: evidence } }] },
      ]
    : []),
  { role: "assistant", content: [{ type: "text", text }] },
]

test("looksLikeClaim only matches completion language", () => {
  expect(looksLikeClaim("Done — everything works.")).toBe(true)
  expect(looksLikeClaim("All tests pass now.")).toBe(true)
  expect(looksLikeClaim("Implementing now; next I will run the tests.")).toBe(false)
  expect(looksLikeClaim("Should I also update the docs?")).toBe(false)
})

test("latestAssistantText returns the newest assistant text", () => {
  expect(latestAssistantText(claimMessages("Done."))).toBe("Done.")
  expect(latestAssistantText([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe("")
})

test("decideVerification hints only on an unverified claim", async () => {
  const claimed = stubAsk({
    "control::claim": { type: "noul", noul: 0.9 },
    "control::check": { type: "noul", noul: 0.1 },
  })
  const hint = await decideVerification(claimed.ask, { messages: claimMessages("Done — everything works.") })
  expect(hint?.hint).toBe(policy.control.hint)

  const verified = stubAsk({
    "control::claim": { type: "noul", noul: 0.9 },
    "control::check": { type: "noul", noul: 0.9 },
  })
  expect(
    await decideVerification(verified.ask, { messages: claimMessages("Done. Tests pass.", "42 pass, 0 fail") }),
  ).toBeNull()

  const notClaimed = stubAsk({
    "control::claim": { type: "noul", noul: 0.1 },
    "control::check": { type: "noul", noul: 0.1 },
  })
  expect(await decideVerification(notClaimed.ask, { messages: claimMessages("Working on it.") })).toBeNull()

  const noPattern = stubAsk({})
  expect(await decideVerification(noPattern.ask, { messages: claimMessages("Implementing now.") })).toBeNull()
  expect(noPattern.calls.length).toBe(0)
})

test("decideVerification fails open on transport errors", async () => {
  const broken = stubAsk(new Error("boom"))
  expect(await decideVerification(broken.ask, { messages: claimMessages("Done.") })).toBeNull()
})

test("readOptions parses control options", () => {
  expect(readOptions({}).control).toEqual({ verify: false })
  expect(readOptions({ control: { verify: true } }).control).toEqual({ verify: true })
})

test("the verification hook appends the hint only for an unverified claim", async () => {
  const mock = mockJevServer(() => ({
    body: {
      answers: {
        "control::claim": { type: "noul", noul: 0.9 },
        "control::check": { type: "noul", noul: 0.1 },
      },
      model: "~typesafe/jev-latest",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }))
  try {
    const hooks: Array<(event: unknown) => Promise<void> | void> = []
    const plugin = (await import("../index")).default
    await plugin.setup({
      options: { apiKey: "test", serverURL: mock.serverURL, control: { verify: true }, tools: { enabled: false } },
      session: {
        hook: (name: string, callback: (event: unknown) => Promise<void> | void) => {
          if (name === "context") hooks.push(callback)
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as never)
    expect(hooks.length).toBe(2)

    const system: Array<{ type: string; text: string }> = []
    for (const hook of hooks) {
      await hook({
        sessionID: "s1",
        agent: "build",
        system,
        tools: { read: { description: "Read" } },
        messages: claimMessages("Done — everything works."),
      })
    }
    expect(system.some((part) => part.text === policy.control.hint)).toBe(true)

    const other = mockJevServer(() => ({
      body: {
        answers: {
          "control::claim": { type: "noul", noul: 0.9 },
          "control::check": { type: "noul", noul: 0.9 },
        },
        model: "~typesafe/jev-latest",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }))
    try {
      const verifiedHooks: Array<(event: unknown) => Promise<void> | void> = []
      await plugin.setup({
        options: { apiKey: "test", serverURL: other.serverURL, control: { verify: true }, tools: { enabled: false } },
        session: {
          hook: (name: string, callback: (event: unknown) => Promise<void> | void) => {
            if (name === "context") verifiedHooks.push(callback)
            return Promise.resolve({ dispose: async () => {} })
          },
        },
      } as never)
      const quiet: Array<{ type: string; text: string }> = []
      for (const hook of verifiedHooks) {
        await hook({
          sessionID: "s2",
          agent: "build",
          system: quiet,
          tools: { read: { description: "Read" } },
          messages: claimMessages("Done. Tests pass.", "42 pass, 0 fail"),
        })
      }
      expect(quiet.some((part) => part.text === policy.control.hint)).toBe(false)
    } finally {
      other.server.stop(true)
    }

    const off: Array<{ type: string; text: string }> = []
    const disabledHooks: Array<(event: unknown) => Promise<void> | void> = []
    await plugin.setup({
      options: { apiKey: "test", serverURL: mock.serverURL, tools: { enabled: false } },
      session: {
        hook: (name: string, callback: (event: unknown) => Promise<void> | void) => {
          if (name === "context") disabledHooks.push(callback)
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as never)
    for (const hook of disabledHooks) {
      await hook({
        sessionID: "s3",
        agent: "build",
        system: off,
        tools: { read: { description: "Read" } },
        messages: claimMessages("Done — everything works."),
      })
    }
    expect(off.some((part) => part.text === policy.control.hint)).toBe(false)
  } finally {
    mock.server.stop(true)
  }
})
