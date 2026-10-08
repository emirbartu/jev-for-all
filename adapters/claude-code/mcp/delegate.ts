#!/usr/bin/env bun
// MCP server with one tool, jev_delegate_light: the orchestrator (Claude Code on Sonnet) hands cheap,
// mechanical work to the light tier's model by running `opencode run` headless, and gets the result back.
// Hand-rolled newline-delimited JSON-RPC over stdio, so it needs no SDK and no install step.
import { spawn, spawnSync } from "node:child_process"
import { createInterface } from "node:readline"
import { loadTiers } from "../../../src/models"

const TIMEOUT_MS = 20 * 60 * 1000
const MAX_CHARS = 12_000

export const DESCRIPTION =
  "Run cheap, mechanical coding work on a low-cost model with maximum thinking, in the project directory: fixing lint or type errors across the codebase, renames, formatting, boilerplate, bulk edits. Give a complete, self-contained task; the worker has no memory of this conversation. Returns its report plus `git status`, so verify the changes."

export function lightCommand(task: string): string[] {
  const light = loadTiers().light
  return ["opencode", "run", "--standalone", "--auto", "--model", `${light.model}#${light.effort}`, task]
}

export async function runLight(task: string, cwd = process.cwd()): Promise<string> {
  if (loadTiers().light.harness !== "opencode") return "jev_delegate_light: the light tier is not configured to run on opencode."
  const [bin, ...args] = lightCommand(task)
  const output = await new Promise<string>((resolve) => {
    let out = ""
    const child = spawn(bin!, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    child.on("error", (error) => resolve(`could not start opencode: ${error.message}`))
    child.on("close", (code) => {
      clearTimeout(timer)
      const credential = /Invalid credential/.test(out) ? "\nHint: your OpenCode Go credential was rejected; run `opencode auth login`." : ""
      resolve((code === 0 ? out : `opencode exited with ${code}\\n${out}`) + credential)
    })
  })
  const tail = output.length > MAX_CHARS ? "…" + output.slice(-MAX_CHARS) : output
  const git = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" })
  const changed = git.status === 0 ? git.stdout.trim() || "(no changes)" : "(not a git repository)"
  return `${tail.trim()}\n\n--- git status ---\n${changed}`
}

const tools = [
  {
    name: "jev_delegate_light",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complete, self-contained instructions for the worker." },
        cwd: { type: "string", description: "Directory to work in. Defaults to the project directory." },
      },
      required: ["task"],
    },
  },
]

async function handle(message: { id?: number | string; method?: string; params?: any }): Promise<unknown | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result })
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "jev-delegate", version: "0.1.0" } })
    case "ping":
      return reply({})
    case "tools/list":
      return reply({ tools })
    case "tools/call": {
      const args = message.params?.arguments ?? {}
      if (message.params?.name !== "jev_delegate_light" || typeof args.task !== "string") {
        return reply({ isError: true, content: [{ type: "text", text: "jev_delegate_light needs a `task` string." }] })
      }
      return reply({ content: [{ type: "text", text: await runLight(args.task, typeof args.cwd === "string" ? args.cwd : undefined) }] })
    }
    default:
      return message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } }
  }
}

if (import.meta.main) {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    try {
      const response = await handle(JSON.parse(line))
      if (response) process.stdout.write(JSON.stringify(response) + "\n")
    } catch {}
  })
}
