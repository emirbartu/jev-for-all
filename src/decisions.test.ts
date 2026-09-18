import { expect, test } from "bun:test"
import { JevError, asChoice, asNoul, createJev } from "./jev"

test("createJev posts state and questions and returns answers", async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(
      JSON.stringify({
        answers: { which: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 } },
      }),
      { status: 200 },
    )
  }) as typeof fetch
  const ask = createJev({ apiKey: "k", fetch: fakeFetch })
  const answers = await ask({
    state: { request: "hi" },
    questions: { which: { type: "choice", instructions: "pick", criteria: { read: "read a file" } } },
  })

  expect(calls.length).toBe(1)
  expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone")
  expect(calls[0].body).toEqual({
    state: { request: "hi" },
    model: "jev-latest",
    questions: { which: { type: "choice", instructions: "pick", criteria: { read: "read a file" } } },
  })
  expect(asChoice(answers.which)?.choice).toBe("read")
})

test("createJev throws JevError on non-2xx", async () => {
  const ask = createJev({
    apiKey: "k",
    fetch: (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch,
  })
  await expect(ask({ state: {}, questions: {} })).rejects.toThrow(JevError)
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
