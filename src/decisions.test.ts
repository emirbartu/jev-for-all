import { expect, test } from "bun:test"
import { JevError, asChoice, asNoul, createJev } from "./jev"

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
    await expect(ask({ state: {}, questions: {} })).rejects.toThrow(JevError)
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
  const mock = mockJevServer(() => ({ body: { answers: {} }, delayMs: 200 }))
  try {
    const ask = createJev({ apiKey: "k", serverURL: mock.serverURL, timeoutMs: 50 })
    await expect(ask({ state: {}, questions: {} })).rejects.toThrow()
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
