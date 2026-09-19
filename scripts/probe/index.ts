import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const file = process.env.PROBE_OUT ?? "/tmp/system-one-probe/events.jsonl"

function write(value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(value) + "\n")
  } catch {
    // probe must never break the session
  }
}

const clip = (text: string) => (text.length > 200 ? text.slice(0, 200) : text)

export default Plugin.define({
  id: "probe",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      write({ hook: "prompt", sessionID: event.sessionID, text: clip(event.prompt.text) })
    })

    await ctx.session.hook("context", (event) => {
      write({
        hook: "context",
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        system: event.system.map((part, index) => ({
          index,
          type: part.type,
          metadata: part.metadata,
          length: part.text.length,
          hasSkills: part.text.includes("<available_skills>"),
          prefix: clip(part.text),
        })),
        tools: Object.entries(event.tools).map(([name, tool]) => ({
          name,
          descriptionLength: tool.description.length,
          descriptionPrefix: clip(tool.description),
        })),
        messages: event.messages.map((message) => ({
          role: message.role,
          content: (message.content ?? []).map((part) => {
            const candidate = part as { type?: string; text?: string; name?: string }
            return { type: candidate.type, name: candidate.name, length: candidate.text?.length }
          }),
        })),
      })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.idle") continue
        try {
          const messages = await ctx.session.context({ sessionID: event.data.sessionID })
          write({
            hook: "idle",
            sessionID: event.data.sessionID,
            messageCount: messages.length,
            assistants: messages
              .filter((message) => (message as { type?: string }).type === "assistant")
              .map((message) => {
                const cast = message as { id?: unknown; tokens?: unknown; cost?: unknown; model?: unknown }
                return { id: cast.id, tokens: cast.tokens, cost: cast.cost, model: cast.model }
              }),
          })
        } catch (error) {
          write({ hook: "idle", error: String(error) })
        }
      }
    })().catch(() => {})

    return () => controller.abort()
  },
})
