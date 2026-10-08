import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { policy } from "./policy"

// Everything user-editable lives in one directory, shared by every harness:
//   config.json  { "apiKey": "sk-or-...", "layaUrl": "http://127.0.0.1:8000", "hints": false }   backend and hint switch
//   models.json  per-tier harness / model / effort overrides                      what runs
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jev-for-all")
}

export interface UserConfig {
  apiKey?: string
  layaUrl?: string
  // Per-prompt skill and subagent hints in the Claude Code hook. Off unless true (or SYSTEM_ONE_HINTS=1).
  hints?: boolean
}

export function loadConfig(): UserConfig {
  try {
    const raw = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8")) as UserConfig
    return { apiKey: raw.apiKey?.trim() || undefined, layaUrl: raw.layaUrl?.trim() || undefined, hints: raw.hints === true }
  } catch {
    return {}
  }
}

export const MODELS_HELP =
  "Each tier is { harness: claude|opencode, model, effort }. effort is low|medium|high|xhigh|max, or auto to let Jev choose. " +
  "Edit freely; delete this file to get the shipped defaults again. Tiers you remove here fall back to the defaults."

// Creates the config directory and the two example files if they are missing. Never overwrites, never throws:
// it runs from the installer and from hooks. Returns the paths it created.
export function ensureConfig(options: { apiKey?: string; layaUrl?: string } = {}): string[] {
  const created: string[] = []
  try {
    const dir = configDir()
    mkdirSync(dir, { recursive: true })
    const write = (name: string, body: unknown, mode?: number) => {
      const path = join(dir, name)
      if (existsSync(path)) return
      writeFileSync(path, JSON.stringify(body, null, 2) + "\n")
      if (mode) chmodSync(path, mode)
      created.push(path)
    }
    write("models.json", { _help: MODELS_HELP, ...policy.models.tierConfig })
    // 0600: it may hold an API key.
    write("config.json", { apiKey: options.apiKey ?? "", layaUrl: options.layaUrl ?? "", hints: false }, 0o600)
  } catch {}
  return created
}
