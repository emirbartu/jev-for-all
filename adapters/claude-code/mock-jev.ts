const SKILL_ANSWERS: Record<string, unknown> = {
  which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
  "gate::acts": { type: "noul", noul: 0.9 },
  "gate::procedure": { type: "noul", noul: 0.8 },
  "gate::prose": { type: "noul", noul: 0.2 },
  "gate::advisory": { type: "noul", noul: 0.5 },
}

export function startMockJev(overrides: Record<string, unknown> = {}) {
  const answers = { ...SKILL_ANSWERS, ...overrides }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json().catch(() => ({}))) as { questions?: Record<string, unknown> }
      const asked = body.questions ?? {}
      const picked: Record<string, unknown> = {}
      for (const id of Object.keys(asked)) {
        if (id in answers) picked[id] = answers[id]
      }
      return new Response(
        JSON.stringify({
          answers: picked,
          model: "~typesafe/jev-1.13.0",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  return { server, serverURL: `http://localhost:${server.port}` }
}
