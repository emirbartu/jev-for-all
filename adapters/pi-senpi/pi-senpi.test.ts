import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import jevForPi, {
  HARNESS,
  createSpendGuard,
  defaultPiSkillDirs,
  injectHints,
  piUsageSample,
  readPiOptions,
  readPiSettings,
  type PiContext,
  type PiExtensionAPI,
  type PiToolInfo,
} from "./index"

type Canned = { status?: number; body: unknown }
type Handler = (event: any, ctx: any) => any

function mockJevServer(handler: (questions: Record<string, unknown>) => Canned) {
  const requests: Array<{ url: string; body: any; authorization: string | null }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.clone().json().catch(() => undefined)
      requests.push({ url: request.url, body, authorization: request.headers.get("authorization") })
      const canned = handler((body?.questions ?? {}) as Record<string, unknown>)
      return new Response(JSON.stringify(canned.body), {
        status: canned.status ?? 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return { server, requests, serverURL: `http://localhost:${server.port}` }
}

const SKILL_ANSWER = {
  which: { type: "choice", choice: "alpha", probabilities: { alpha: 0.9 }, confidence: 0.9 },
  "gate::acts": { type: "noul", noul: 0.9 },
  "gate::procedure": { type: "noul", noul: 0.8 },
  "gate::prose": { type: "noul", noul: 0.2 },
  "gate::advisory": { type: "noul", noul: 0.1 },
}
const TOOL_ANSWER = {
  next: { type: "choice", choice: "deploy", probabilities: { deploy: 0.8 }, confidence: 0.9 },
  needs_tool: { type: "noul", noul: 0.9 },
}
const VERIFY_ANSWER = {
  "control::claim": { type: "noul", noul: 0.9 },
  "control::ran": { type: "noul", noul: 0.1 },
  "control::passed": { type: "noul", noul: 0.1 },
}

function answering() {
  return mockJevServer((questions) => {
    if ("next" in questions) return { body: { answers: TOOL_ANSWER, model: "jev-1.13.0", usage: USAGE } }
    if ("control::claim" in questions) return { body: { answers: VERIFY_ANSWER, model: "jev-1.13.0", usage: USAGE } }
    return { body: { answers: SKILL_ANSWER, model: "jev-1.13.0", usage: USAGE } }
  })
}

const USAGE = { input_tokens: 10, output_tokens: 4 }

function workspace(
  serverURL: string,
  settings: (paths: { skillsDir: string; decisionsFile: string; usageFile: string; serverURL: string }) => Record<string, unknown>,
) {
  const root = mkdtempSync(join(tmpdir(), "system-one-pi-"))
  const agentDir = join(root, "agent")
  const skillsDir = join(root, "skills")
  const paths = {
    skillsDir,
    decisionsFile: join(root, "decisions.jsonl"),
    usageFile: join(root, "usage.jsonl"),
    serverURL,
  }
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(skillsDir, "alpha"), { recursive: true })
  writeFileSync(
    join(skillsDir, "alpha", "SKILL.md"),
    "---\nname: Alpha\ndescription: Does alpha things\n---\n\nUse the alpha procedure.\n",
  )
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ systemOne: settings(paths) }, null, 2))
  return { root, agentDir, ...paths }
}

function harness(agentDir: string, tools: PiToolInfo[] = []) {
  const handlers = new Map<string, Handler[]>()
  const calls: { setActiveTools: string[][] } = { setActiveTools: [] }
  const pi: PiExtensionAPI = {
    cwd: agentDir,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    getAllTools: () => tools,
    setActiveTools(names) {
      calls.setActiveTools.push(names)
    },
  }
  const ctx: PiContext = {
    agentDir,
    cwd: agentDir,
    sessionManager: { getSessionId: () => "sess-1" },
    model: { id: "test/model" },
  }
  jevForPi(pi)
  return {
    pi,
    ctx,
    calls,
    async emit(event: string, payload: unknown): Promise<any[]> {
      const results: any[] = []
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx))
      return results
    },
  }
}

const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const assistantMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

const servers: Array<ReturnType<typeof mockJevServer>> = []
function track<T extends ReturnType<typeof mockJevServer>>(mock: T): T {
  servers.push(mock)
  return mock
}

afterEach(() => {
  for (const mock of servers.splice(0)) mock.server.stop(true)
})

const savedKey = process.env.OPENROUTER_API_KEY
afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = savedKey
})

test("skill routing asks Jev once per user message and injects the skill", async () => {
  const mock = track(answering())
  const space = workspace(mock.serverURL, ({ skillsDir, decisionsFile }) => ({
    apiKey: "k",
    serverURL: mock.serverURL,
    decisionsFile,
    skillDirs: [skillsDir],
  }))
  const h = harness(space.agentDir)

  const [input] = await h.emit("input", { inputId: "in-1", text: "do the alpha thing" })
  expect(input).toBeUndefined()

  const [start] = await h.emit("before_agent_start", { systemPrompt: "BASE", trigger: "prompt" })
  expect(start.systemPrompt).toContain("BASE")
  expect(start.systemPrompt).toContain("Use the alpha procedure.")
  expect(start.systemPrompt).toContain("alpha")

  expect(mock.requests.length).toBe(1)
  expect(new URL(mock.requests[0].url).pathname).toBe("/api/alpha/decisions")
  expect(mock.requests[0].authorization).toBe("Bearer k")
  expect(mock.requests[0].body.model).toBe("~typesafe/jev-latest")
  expect(mock.requests[0].body.state).toEqual({ request: "do the alpha thing" })
  expect(Object.keys(mock.requests[0].body.questions).sort()).toEqual([
    "gate::acts",
    "gate::advisory",
    "gate::procedure",
    "gate::prose",
    "which",
  ])
  expect(mock.requests[0].body.questions.which.criteria.alpha).toBe("Alpha — Does alpha things")
})

test("a repeated input id reuses the cached skill decision", async () => {
  const mock = track(answering())
  const space = workspace(mock.serverURL, ({ serverURL, skillsDir }) => ({ apiKey: "k", serverURL, skillDirs: [skillsDir] }))
  const h = harness(space.agentDir)
  await h.emit("input", { inputId: "in-1", text: "do the alpha thing" })
  await h.emit("input", { inputId: "in-1", text: "do the alpha thing" })
  expect(mock.requests.length).toBe(1)
})

test("tool routing narrows the active tools and appends the routing hint", async () => {
  const mock = track(answering())
  const space = workspace(mock.serverURL, ({ serverURL }) => ({ apiKey: "k", serverURL }))
  const h = harness(space.agentDir, [
    { name: "read", description: "read a file" },
    { name: "write", description: "write a file" },
    { name: "edit", description: "edit a file" },
    { name: "bash", description: "run a command" },
    { name: "deploy", description: "ship the app" },
  ])

  const [result] = await h.emit("context", { messages: [userMessage("ship it")] })
  expect(result.messages.length).toBe(2)
  const hint = result.messages[1].content[0].text
  expect(hint).toContain("<system_one_routing>")
  expect(hint).toContain("deploy")
  expect(h.calls.setActiveTools.at(-1)).toEqual(["read", "write", "edit", "bash", "deploy"])

  const request = mock.requests[0]
  expect(new URL(request.url).pathname).toBe("/api/alpha/decisions")
  expect(request.body.state).toContain("ship it")
  expect(request.body.state).toContain("agent: test/model")
  expect(Object.keys(request.body.questions).sort()).toEqual(["needs_tool", "next"])
  expect(request.body.questions.next.criteria.deploy).toBe("ship the app")
})

test("the routing hint is replaced, never accumulated, across dispatches", async () => {
  const mock = track(answering())
  const space = workspace(mock.serverURL, ({ serverURL }) => ({ apiKey: "k", serverURL }))
  const h = harness(space.agentDir, [{ name: "deploy", description: "ship the app" }])

  const [first] = await h.emit("context", { messages: [userMessage("ship it")] })
  const [second] = await h.emit("context", { messages: first.messages })
  expect(second.messages.length).toBe(first.messages.length)
  expect(second.messages.filter((m: any) => m.content?.[0]?.text?.startsWith("<system_one_")).length).toBe(1)
  expect(mock.requests.length).toBeGreaterThanOrEqual(1)
})

test("the verification gate blocks an unverified completion claim", async () => {
  const mock = track(answering())
  const space = workspace(mock.serverURL, ({ serverURL }) => ({ apiKey: "k", serverURL, control: { verify: true } }))
  const h = harness(space.agentDir, [{ name: "read", description: "read a file" }])

  const [result] = await h.emit("context", {
    messages: [userMessage("fix it"), assistantMessage("All tests pass, done.")],
  })
  const injected = result.messages.filter((m: any) => m.content?.[0]?.text?.includes("<system_one_control>"))
  expect(injected.length).toBe(1)
  expect(mock.requests.some((request) => "control::claim" in request.body.questions)).toBe(true)
})

test("no API key leaves the request untouched and throws nothing", async () => {
  delete process.env.OPENROUTER_API_KEY
  const mock = track(answering())
  const space = workspace(mock.serverURL, ({ serverURL }) => ({ serverURL }))
  const h = harness(space.agentDir, [{ name: "deploy", description: "ship the app" }])
  const original = console.warn
  console.warn = () => {}
  try {
    expect(await h.emit("input", { inputId: "in-1", text: "ship it" })).toEqual([undefined])
    expect(await h.emit("before_agent_start", { systemPrompt: "BASE", trigger: "prompt" })).toEqual([undefined])
    expect(await h.emit("context", { messages: [userMessage("ship it")] })).toEqual([undefined])
  } finally {
    console.warn = original
  }
  expect(h.calls.setActiveTools).toEqual([])
  expect(mock.requests.length).toBe(0)
})

test("a non-2xx answer fails open and warns once per session", async () => {
  const mock = track(mockJevServer(() => ({ status: 500, body: { error: "boom" } })))
  const space = workspace(mock.serverURL, ({ serverURL, decisionsFile }) => ({ apiKey: "k", serverURL, decisionsFile }))
  const h = harness(space.agentDir, [{ name: "deploy", description: "ship the app" }])

  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }
  try {
    expect(await h.emit("input", { inputId: "in-1", text: "ship it" })).toEqual([undefined])
    expect(await h.emit("input", { inputId: "in-2", text: "ship it again" })).toEqual([undefined])
    expect(await h.emit("context", { messages: [userMessage("ship it")] })).toEqual([undefined])
  } finally {
    console.warn = original
  }

  expect(mock.requests.length).toBe(3)
  expect(h.calls.setActiveTools).toEqual([])
  expect(warnings.length).toBe(1)
  expect(String(warnings[0]?.[0])).toContain("system-one")
})

test("the spend cap stops further Jev calls in a session", async () => {
  const mock = track(answering())
  const space = workspace(mock.serverURL, ({ serverURL, decisionsFile, skillsDir }) => ({
    apiKey: "k",
    serverURL,
    decisionsFile,
    skillDirs: [skillsDir],
    spend: { maxCallsPerSession: 1 },
  }))
  const h = harness(space.agentDir, [{ name: "deploy", description: "ship the app" }])

  await h.emit("input", { inputId: "in-1", text: "do the alpha thing" })
  await h.emit("input", { inputId: "in-2", text: "do the alpha thing" })
  expect(mock.requests.length).toBe(1)
  expect(h.calls.setActiveTools).toEqual([])
})

test("every decision is logged as JSONL tagged with the harness", async () => {
  const mock = track(answering())
  const space = workspace(mock.serverURL, ({ serverURL, decisionsFile, skillsDir, usageFile }) => ({
    apiKey: "k",
    serverURL,
    decisionsFile,
    skillDirs: [skillsDir],
    observe: { enabled: true, file: usageFile },
  }))
  const h = harness(space.agentDir, [{ name: "deploy", description: "ship the app" }])

  await h.emit("input", { inputId: "in-1", text: "do the alpha thing" })
  await h.emit("context", { messages: [userMessage("ship it")] })
  await h.emit("message_end", {
    message: {
      role: "assistant",
      id: "msg-1",
      model: { provider: "openai", id: "gpt" },
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, reasoning: 1 },
      cost: { total: 0.01 },
      time: { created: 5 },
    },
  })
  await h.emit("message_end", {
    message: {
      role: "assistant",
      id: "msg-1",
      model: { provider: "openai", id: "gpt" },
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0 },
      cost: { total: 0.01 },
    },
  })
  await h.emit("session_shutdown", { type: "session_shutdown" })

  const lines = readFileSync(space.decisionsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  expect(lines.length).toBeGreaterThanOrEqual(2)
  expect(lines.every((line) => line.harness === HARNESS)).toBe(true)
  expect(lines.map((line) => line.hook)).toContain("input")
  expect(lines.map((line) => line.hook)).toContain("context")

  const usage = readFileSync(space.usageFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  expect(usage.length).toBe(1)
  expect(usage[0]).toMatchObject({ kind: "usage", sessionID: "sess-1", messageID: "msg-1", input: 10, output: 4 })
})

test("helpers: options, settings, skill dirs, hint injection, samples and the guard", () => {
  const root = mkdtempSync(join(tmpdir(), "system-one-pi-helpers-"))
  mkdirSync(join(root, "agent"), { recursive: true })
  writeFileSync(join(root, "agent", "settings.json"), "not json")
  expect(readPiSettings(join(root, "agent"))).toEqual({})
  writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ systemOne: { model: "x" }, other: 1 }))
  expect(readPiSettings(join(root, "agent"))).toEqual({ model: "x" })

  const options = readPiOptions({ tools: { maxTools: 3 }, skillDirs: `${root}:/more` }, {})
  expect(options.tools.maxTools).toBe(3)
  expect(options.tools.enabled).toBe(true)
  expect(options.skillDirs).toEqual([root, "/more"])
  expect(readPiOptions({}, {}).model).toBe("~typesafe/jev-latest")

  expect(defaultPiSkillDirs("/agent", "/work")).toEqual([
    "/agent/skills",
    join(process.env.HOME ?? "", ".agents", "skills"),
    "/work/.agents/skills",
  ])

  const hint = { role: "user", content: [{ type: "text", text: "<system_one_routing>old</system_one_routing>" }] }
  expect(injectHints([userMessage("hi")], [])).toBeUndefined()
  expect(injectHints([userMessage("hi") as any, hint as any], ["<system_one_routing>new</system_one_routing>"]))
    .toEqual({ messages: [userMessage("hi"), { role: "user", content: [{ type: "text", text: "<system_one_routing>new</system_one_routing>" }] }] })

  expect(piUsageSample({ role: "assistant", id: "m" }, "s")).toBeNull()
  expect(piUsageSample({ role: "user", id: "m", usage: {} }, "s")).toBeNull()
  expect(piUsageSample({ role: "assistant", id: "m", model: { provider: "p", id: "i" }, usage: { input: 3 } }, "s"))
    .toMatchObject({ sessionID: "s", messageID: "m", agent: "p", model: "p/i", input: 3 })

  const events: Array<Record<string, unknown>> = []
  const guard = createSpendGuard({ max: 2, warnAt: 0.5, log: (record) => events.push(record), sessionID: "s" })
  expect(guard.take()).toBe(true)
  expect(guard.take()).toBe(true)
  expect(guard.take()).toBe(false)
  expect(guard.calls).toBe(2)
  expect(events).toEqual([
    { sessionID: "s", event: "spend-warning", calls: 1, cap: 2 },
    { sessionID: "s", event: "capped", calls: 2 },
  ])
  expect(existsSync(join(root, "nope"))).toBe(false)
})
