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
