#!/usr/bin/env node
// jev-for-all installer — zero-dependency ESM, runs under node and bun.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createInterface } from "node:readline"

const PLUGIN_NAME = "jev-for-all"

/** Strip `//` and `/* *\/` comments and trailing commas, without touching string contents. */
export function stripJsonc(text) {
  let out = ""
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
      i += 2
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === "}" || text[j] === "]") {
        i += 1
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

function skipString(text, start) {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2
      continue
    }
    if (text[i] === '"') return i + 1
    i += 1
  }
  return i
}

function skipComment(text, start) {
  if (text[start + 1] === "/") {
    let i = start
    while (i < text.length && text[i] !== "\n") i += 1
    return i
  }
  let i = start + 2
  while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
  return i + 2
}

/** Find the top-level "plugins" array: { open } when found, { open: -1 } when the key is not an array, null otherwise. */
function findPlugins(text) {
  let i = 0
  let depth = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      const end = skipString(text, i)
      const value = text.slice(i + 1, end - 1)
      i = end
      if (depth === 1 && value === "plugins") {
        let j = i
        while (j < text.length && /\s/.test(text[j])) j += 1
        if (text[j] === ":") {
          j += 1
          while (j < text.length && /\s/.test(text[j])) j += 1
          return text[j] === "[" ? { open: j } : { open: -1 }
        }
      }
      continue
    }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = skipComment(text, i)
      continue
    }
    if (ch === "{" || ch === "[") depth += 1
    else if (ch === "}" || ch === "]") depth -= 1
    i += 1
  }
  return null
}

function findRootBrace(text) {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      i = skipString(text, i)
      continue
    }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = skipComment(text, i)
      continue
    }
    if (ch === "{") return i
    i += 1
  }
  return -1
}

/** Insert `entry` first in the top-level "plugins" array; add the key (or a whole file) when missing. */
export function upsertPluginEntry(text, entry) {
  const compact = JSON.stringify(entry)
  if (!text.trim()) return `{\n  "plugins": [\n    ${compact}\n  ]\n}\n`

  const found = findPlugins(text)
  if (found && found.open >= 0) {
    let j = found.open + 1
    while (j < text.length && /\s/.test(text[j])) j += 1
    const empty = text[j] === "]"
    const insertion = empty ? `\n    ${compact}\n  ` : `\n    ${compact},`
    return text.slice(0, found.open + 1) + insertion + text.slice(found.open + 1)
  }
  if (found) throw new Error('"plugins" exists but is not an array; edit it by hand')

  const root = findRootBrace(text)
  if (root < 0) throw new Error("could not find the root object")
  let j = root + 1
  while (j < text.length && /\s/.test(text[j])) j += 1
  const emptyRoot = text[j] === "}"
  const insertion = emptyRoot ? `\n  "plugins": [\n    ${compact}\n  ]\n` : `\n  "plugins": [\n    ${compact}\n  ],`
  return text.slice(0, root + 1) + insertion + text.slice(root + 1)
}

export function hasPluginEntry(text, name = PLUGIN_NAME) {
  if (!text.trim()) return false
  let parsed
  try {
    parsed = JSON.parse(stripJsonc(text))
  } catch {
    return false
  }
  const plugins = parsed && Array.isArray(parsed.plugins) ? parsed.plugins : []
  return plugins.some(
    (plugin) =>
      plugin &&
      typeof plugin.package === "string" &&
      (plugin.package === name || plugin.package.endsWith(`/${name}`)),
  )
}

export function resolveConfigPath(flag) {
  if (flag) return resolve(flag)
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config")
  const primary = join(base, "opencode", "opencode.jsonc")
  if (existsSync(primary)) return primary
  const sibling = join(base, "opencode", "opencode.json")
  if (existsSync(sibling)) return sibling
  return primary
}

export async function install({ configPath, key, dryRun = false }) {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : ""
  if (text.trim()) {
    try {
      JSON.parse(stripJsonc(text))
    } catch (error) {
      return { status: "invalid", path: configPath, error: String(error), text }
    }
  }
  if (hasPluginEntry(text)) return { status: "already", path: configPath, text }
  const entry = key ? { package: PLUGIN_NAME, options: { apiKey: key } } : { package: PLUGIN_NAME }
  let updated
  try {
    updated = upsertPluginEntry(text, entry)
    JSON.parse(stripJsonc(updated))
  } catch (error) {
    return { status: "invalid", path: configPath, error: String(error), text }
  }
  if (!dryRun) {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, updated)
  }
  return { status: "installed", path: configPath, text: updated, dryRun }
}

const USAGE = `jev-for-all — OpenCode plugin installer

Usage:
  jev-for-all install [--config <path>] [--key <sk-or-...>] [--dry-run]
  jev-for-all help

install registers the plugin in your OpenCode config (idempotent).
Without --key the installer prompts on a TTY; export OPENROUTER_API_KEY instead if you prefer.
`

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help"
  const value = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  return { command, config: value("--config"), key: value("--key"), dryRun: argv.includes("--dry-run") }
}

async function promptKey() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise((resolve) => rl.question("OpenRouter API key (sk-or-..., empty to skip): ", resolve))
    return typeof answer === "string" ? answer.trim() : ""
  } finally {
    rl.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command !== "install") {
    console.log(USAGE)
    return
  }
  const configPath = resolveConfigPath(args.config)
  let key = args.key
  if (!key && process.stdin.isTTY && process.stdout.isTTY) key = await promptKey()
  const result = await install({ configPath, key: key || undefined, dryRun: args.dryRun })
  if (result.status === "already") {
    console.log(`already installed — nothing to do (${configPath})`)
    return
  }
  if (result.status === "invalid") {
    console.error(`error: ${result.error}`)
    process.exitCode = 1
    return
  }
  if (args.dryRun) {
    console.log(result.text)
    return
  }
  console.log(`Registered ${PLUGIN_NAME} in ${configPath}`)
  console.log("- Restart OpenCode to load the plugin.")
  if (!key) {
    console.log("- No key set: export OPENROUTER_API_KEY=sk-or-... or add options.apiKey to the entry.")
  }
  console.log('- Routing decisions log to the console with "debug": true; usage records go to observe.file when enabled.')
}

function isDirectRun() {
  if (!process.argv[1]) return false
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true
  // npx/bunx run the bin through a symlink shim; node resolves the real path for import.meta.url.
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(String(error && error.message ? error.message : error))
    process.exitCode = 1
  })
}
