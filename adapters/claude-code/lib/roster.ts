import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { policy } from "../../../src/policy"
import type { AgentLike } from "../../../src/agents"

export interface SkillFile {
  id: string
  name: string
  description?: string
  content: string
  path: string
}

// Port of _parse_frontmatter in adapters/hermes/system_one/decision.py; the two must stay in sync.
export function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  if (!text.startsWith("---")) return { body: text }
  const end = text.indexOf("\n---", 3)
  if (end === -1) return { body: text }
  const head = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^[\r\n]+/, "")
  const fields: Record<string, string> = {}
  // Python's str.splitlines() terminator set, so CRLF frontmatter parses like the reference.
  const lines = head.split(/[\r\n\v\f\u001c-\u001e\u0085\u2028\u2029]/)
  let index = 0
  while (index < lines.length) {
    const match = /^([\w-]+):\s*(.*)$/.exec(lines[index]!)
    if (match) {
      let value = match[2]!.trim()
      if (value === ">" || value === "|") {
        const block: string[] = []
        while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) {
          block.push(lines[index + 1]!.trim())
          index += 1
        }
        value = value === ">" ? block.join(" ") : block.join("\n")
      }
      fields[match[1]!] = value.replace(/^["']+|["']+$/g, "")
    }
    index += 1
  }
  return { name: fields.name, description: fields.description, body }
}

// Port of scan_skills in adapters/hermes/system_one/decision.py; the two must stay in sync.
export function scanSkillDirs(dirs: readonly string[]): SkillFile[] {
  const skills: SkillFile[] = []
  const seen = new Set<string>()

  const add = (path: string, leaf: string): void => {
    if (seen.has(leaf)) return
    let parsed: { name?: string; description?: string; body: string }
    try {
      parsed = parseFrontmatter(readFileSync(path, "utf8"))
    } catch {
      return
    }
    seen.add(leaf)
    skills.push({ id: leaf, name: parsed.name || leaf, description: parsed.description, content: parsed.body, path })
  }

  const entries = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .filter((entry) => !entry.startsWith("."))
        .sort()
    } catch {
      return []
    }
  }

  for (const dir of dirs) {
    for (const entry of entries(dir)) {
      add(join(dir, entry, "SKILL.md"), entry)
    }
    for (const entry of entries(dir)) {
      for (const child of entries(join(dir, entry))) {
        add(join(dir, entry, child, "SKILL.md"), child)
      }
    }
  }
  return skills
}

export function defaultSkillDirs(cwd: string): string[] {
  return [join(process.env.HOME ?? "", ".claude", "skills"), join(cwd, ".claude/skills")]
}

// Subagents: the built-ins from the spec plus any `<dir>/*.md` custom agent (frontmatter name/description).
export function scanAgentDirs(dirs: readonly string[]): AgentLike[] {
  const agents = new Map<string, AgentLike>(policy.agents.builtin.map((agent) => [agent.id, agent]))
  for (const dir of dirs) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir).filter((entry) => entry.endsWith(".md") && !entry.startsWith(".")).sort()
    } catch {}
    for (const entry of entries) {
      try {
        const parsed = parseFrontmatter(readFileSync(join(dir, entry), "utf8"))
        const id = parsed.name || entry.slice(0, -3)
        agents.set(id, { id, description: parsed.description })
      } catch {}
    }
  }
  return [...agents.values()]
}

export function defaultAgentDirs(cwd: string): string[] {
  return [join(process.env.HOME ?? "", ".claude", "agents"), join(cwd, ".claude/agents")]
}
