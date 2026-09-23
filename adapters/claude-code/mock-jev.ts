export function startMockJev() {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(
        JSON.stringify({
          answers: {
            which: { type: "choice", choice: "pptx-author", probabilities: { "pptx-author": 0.9 }, confidence: 0.9 },
            "gate::acts": { type: "noul", noul: 0.9 },
            "gate::procedure": { type: "noul", noul: 0.8 },
            "gate::prose": { type: "noul", noul: 0.2 },
          },
          model: "~typesafe/jev-1.13.0",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  return { server, serverURL: `http://localhost:${server.port}` }
}
