#!/usr/bin/env node
// jev-for-all installer: zero-dependency ESM, runs under node and bun.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
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

const USAGE = `jev-for-all: pick the right model, thinking level and skill for each coding task

Usage:
  jev-for-all init [--key sk-or-...] [--laya <url>] [--no-claude] [--no-opencode] [--dry-run]
  jev-for-all doctor [--deep]
  jev-for-all start "<first prompt>"      choose harness, model and thinking level once, then launch it
  jev-for-all pick "<first prompt>"       print that decision without launching
  jev-for-all opencode-agents             print the cheap-worker subagent for opencode.json
  jev-for-all install                     OpenCode only (init does this too)
  jev-for-all --version

init is safe to re-run. It creates ~/.config/jev-for-all/{config,models}.json if missing, registers the
OpenCode plugin, and installs the Claude Code plugin. doctor checks that everything works.
`

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help"
  const value = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  return {
    command,
    config: value("--config"),
    key: value("--key"),
    laya: value("--laya"),
    claudeSource: value("--claude-source"),
    dryRun: argv.includes("--dry-run"),
    deep: argv.includes("--deep"),
    noClaude: argv.includes("--no-claude"),
    noOpencode: argv.includes("--no-opencode"),
  }
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

// ---- shared config (mirrors src/config.ts; this file must stay free of TypeScript so node can run it) ----

export function configDir() {
  const base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config")
  return join(base, "jev-for-all")
}

const MODELS_HELP =
  "Each tier is { harness: claude|opencode, model, effort }. effort is low|medium|high|xhigh|max, or auto to let Jev choose. " +
  "Edit freely; delete this file to get the shipped defaults again. Tiers you remove here fall back to the defaults."

/** Create config.json (0600) and models.json when missing; fill an empty apiKey/layaUrl. Never overwrites a value. */
export function ensureConfigFiles({ key, laya, dryRun = false } = {}) {
  const dir = configDir()
  const spec = JSON.parse(readFileSync(new URL("../spec/decisions.json", import.meta.url), "utf8"))
  const result = { created: [], updated: [] }
  const modelsPath = join(dir, "models.json")
  const configPath = join(dir, "config.json")
  if (!dryRun) mkdirSync(dir, { recursive: true })
  if (!existsSync(modelsPath)) {
    if (!dryRun) writeFileSync(modelsPath, JSON.stringify({ _help: MODELS_HELP, ...spec.models.tierConfig }, null, 2) + "\n")
    result.created.push(modelsPath)
  }
  if (!existsSync(configPath)) {
    if (!dryRun) writeFileSync(configPath, JSON.stringify({ apiKey: key ?? "", layaUrl: laya ?? "", hints: false }, null, 2) + "\n", { mode: 0o600 })
    result.created.push(configPath)
  } else if (key || laya) {
    try {
      const current = JSON.parse(readFileSync(configPath, "utf8"))
      let changed = false
      if (key && !current.apiKey) ((current.apiKey = key), (changed = true))
      if (laya && !current.layaUrl) ((current.layaUrl = laya), (changed = true))
      if (changed) {
        if (!dryRun) writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 })
        result.updated.push(configPath)
      }
    } catch {}
  }
  return result
}

// ---- helpers for init / doctor ----

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 60000, ...options })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), missing: r.error && r.error.code === "ENOENT" }
}

const ok = (text) => console.log(`  ✓ ${text}`)
const warn = (text) => console.log(`  ! ${text}`)
const bad = (text) => console.log(`  ✗ ${text}`)

function bunVersion() {
  const r = run("bun", ["--version"], { timeout: 10000 })
  return r.ok ? r.out : null
}

function claudePluginInstalled() {
  const r = run("claude", ["plugin", "list"], { timeout: 30000 })
  return r.ok && /system-one/.test(r.out)
}

async function init(args) {
  console.log("jev-for-all init\n")

  // 1. bun runs the Claude Code hook, the MCP tool and the launcher.
  const bun = bunVersion()
  bun ? ok(`bun ${bun}`) : bad("bun not found. The Claude Code hook and `jev-for-all start` need it: https://bun.sh")

  // 2. Shared config directory.
  // An exported OPENROUTER_API_KEY is used as is; it is never copied into config.json.
  let key = args.key || ""
  const existing = (() => {
    try {
      return JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"))
    } catch {
      return {}
    }
  })()
  if (!args.key && !args.laya && !existing.apiKey && !existing.layaUrl && !process.env.OPENROUTER_API_KEY && !process.env.LAYA_BASE_URL && process.stdin.isTTY && process.stdout.isTTY) key = await promptKey()
  const files = ensureConfigFiles({ key: args.key || key || undefined, laya: args.laya, dryRun: args.dryRun })
  for (const path of files.created) ok(`created ${path}`)
  for (const path of files.updated) ok(`updated ${path}`)
  if (files.created.length === 0 && files.updated.length === 0) ok(`config already in ${configDir()}`)
  const merged = (() => {
    try {
      return JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"))
    } catch {
      return {}
    }
  })()
  if (!merged.apiKey && !merged.layaUrl && !process.env.OPENROUTER_API_KEY && !process.env.LAYA_BASE_URL) {
    warn(`no backend yet: add your OpenRouter key to ${join(configDir(), "config.json")} (or export OPENROUTER_API_KEY), or use --laya <url>`)
  }

  // 3. OpenCode plugin. The key lives in config.json, so the entry carries no secret.
  if (!args.noOpencode) {
    const configPath = resolveConfigPath(args.config)
    const hasOpencode = !run("opencode", ["--version"], { timeout: 10000 }).missing
    if (!hasOpencode && !existsSync(configPath)) {
      warn("OpenCode not found, skipped (use --no-opencode to silence)")
    } else {
      const result = await install({ configPath, dryRun: args.dryRun })
      if (result.status === "installed") ok(`registered the OpenCode plugin in ${configPath}`)
      else if (result.status === "already") ok("OpenCode plugin already registered")
      else bad(`OpenCode config not changed: ${result.error}`)
      if (hasOpencode && !/OpenCode Go/.test(run("opencode", ["auth", "list"], { timeout: 20000 }).out)) {
        warn("no OpenCode Go login: run `opencode auth login` so the light tier can use DeepSeek")
      }
    }
  }

  // 4. Claude Code plugin, from the GitHub marketplace unless --claude-source points at a local checkout.
  if (!args.noClaude) {
    const hasClaude = !run("claude", ["--version"], { timeout: 10000 }).missing
    if (!hasClaude) {
      warn("Claude Code not found, skipped (use --no-claude to silence)")
    } else if (claudePluginInstalled()) {
      ok("Claude Code plugin already installed")
    } else if (args.dryRun) {
      ok("would install the Claude Code plugin")
    } else {
      const source = args.claudeSource ? resolve(args.claudeSource) : "emirbartu/jev-for-all"
      const added = run("claude", ["plugin", "marketplace", "add", source])
      const installed = added.ok || /already/i.test(added.out) ? run("claude", ["plugin", "install", "system-one@jev-for-all"]) : added
      if (installed.ok) ok("installed the Claude Code plugin (system-one@jev-for-all); restart Claude Code")
      else {
        bad(`could not install the Claude Code plugin: ${installed.out.split("\n")[0]}`)
        console.log("    do it by hand inside Claude Code:\n      /plugin marketplace add emirbartu/jev-for-all\n      /plugin install system-one@jev-for-all")
      }
    }
  }

  console.log('\nNext: `jev-for-all doctor` to verify, then `jev-for-all start "your task"`.')
}

function doctor(args) {
  console.log("jev-for-all doctor\n")
  let problems = 0
  const check = (pass, good, fix) => (pass ? ok(good) : (problems++, bad(`${good.split(":")[0]} — ${fix}`)))

  const bun = bunVersion()
  check(Boolean(bun), `bun ${bun}`, "install bun (https://bun.sh); hooks, the MCP tool and `start` need it")

  let config = {}
  let configOk = false
  try {
    config = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"))
    configOk = true
  } catch {}
  check(configOk, `config ${join(configDir(), "config.json")}`, "run `jev-for-all init`")
  let tiersOk = false
  try {
    JSON.parse(readFileSync(join(configDir(), "models.json"), "utf8"))
    tiersOk = true
  } catch {}
  check(tiersOk, `tiers ${join(configDir(), "models.json")}`, "run `jev-for-all init` (or fix the JSON)")

  const backend = process.env.LAYA_BASE_URL || config.layaUrl ? "Laya" : process.env.OPENROUTER_API_KEY || config.apiKey ? "OpenRouter" : null
  check(Boolean(backend), `backend: ${backend}`, "no key: set apiKey in config.json, export OPENROUTER_API_KEY, or set layaUrl")

  if (bun && backend) {
    const r = run("bun", [join(dirname(fileURLToPath(import.meta.url)), "pick.ts"), "pick", "rename x to count"], { timeout: 20000 })
    let decided = false
    try {
      decided = JSON.parse(r.out.split("\n").pop()).decided === true
    } catch {}
    check(decided, `live decision from ${backend}`, `no answer (${r.out.slice(0, 80) || "timeout"}); check the key, URL and network`)
  }

  const claude = !run("claude", ["--version"], { timeout: 10000 }).missing
  if (claude) check(claudePluginInstalled(), "Claude Code plugin installed", "run `jev-for-all init`")
  else warn("Claude Code not found (fine if you only use OpenCode)")

  const opencode = !run("opencode", ["--version"], { timeout: 10000 }).missing
  if (opencode) {
    const listed = /OpenCode Go/.test(run("opencode", ["auth", "list"], { timeout: 20000 }).out)
    check(listed, "OpenCode Go login present", "run `opencode auth login`")
    if (listed && args.deep) {
      const r = run("opencode", ["run", "--standalone", "--auto", "--model", "opencode-go/deepseek-v4.1-flash#max", "Reply with exactly: ok"], { timeout: 120000 })
      check(r.ok && !/Invalid credential/.test(r.out), "DeepSeek light tier answers", /Invalid credential/.test(r.out) ? "credential rejected: run `opencode auth login`" : r.out.slice(0, 100))
    } else if (listed) warn("run `jev-for-all doctor --deep` to test the DeepSeek credential for real (uses a few tokens)")
  } else warn("OpenCode not found (fine if you only use Claude Code)")

  console.log(problems === 0 ? "\nAll good." : `\n${problems} problem${problems === 1 ? "" : "s"} to fix.`)
  process.exitCode = problems === 0 ? 0 : 1
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (["pick", "start", "opencode-agents"].includes(args.command)) {
    // Needs bun for the TypeScript core; the installer above stays dependency-free.
    const result = spawnSync("bun", [join(dirname(fileURLToPath(import.meta.url)), "pick.ts"), ...process.argv.slice(2)], { stdio: "inherit" })
    process.exitCode = result.status ?? 1
    return
  }
  if (args.command === "init") return init(args)
  if (args.command === "doctor") return doctor(args)
  if (args.command === "version" || process.argv.includes("--version")) {
    console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version)
    return
  }
  if (args.command === "help") {
    console.log(USAGE)
    return
  }
  if (args.command !== "install") {
    // bunx and npx cache the first version they download; an old copy does not know newer commands.
    console.error(`jev-for-all: unknown command "${args.command}".\nIf you ran this through bunx or npx you may have an old cached copy: use \`bunx jev-for-all@latest ${args.command}\`.\n`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  const configPath = resolveConfigPath(args.config)
  let key = args.key
  if (!key && process.stdin.isTTY && process.stdout.isTTY) key = await promptKey()
  const result = await install({ configPath, key: key || undefined, dryRun: args.dryRun })
  if (result.status === "already") {
    console.log(`already installed, nothing to do (${configPath})`)
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
    console.log("- No key set: run `jev-for-all init`, export OPENROUTER_API_KEY, or add options.apiKey to the entry.")
  }
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
