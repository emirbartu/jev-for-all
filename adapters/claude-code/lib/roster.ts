import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface SkillFile {
  id: string
  name: string
  description?: string
  content: string
  path: string
}

function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  if (!text.startsWith("---")) return { body: text }
  const end = text.indexOf("\n---", 3)
  if (end === -1) return { body: text }
  const head = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, "")
  const fields: Record<string, string> = {}
  for (const line of head.split("\n")) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    fields[match[1]] = match[2].replace(/^["']|["']$/g, "").trim()
  }
  return { name: fields.name, description: fields.description, body }
}

export function scanSkillDirs(dirs: readonly string[]): SkillFile[] {
  const skills: SkillFile[] = []
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry, "SKILL.md")
      try {
        const parsed = parseFrontmatter(readFileSync(path, "utf8"))
        skills.push({
          id: entry,
          name: parsed.name ?? entry,
          description: parsed.description,
          content: parsed.body,
          path,
        })
      } catch {
        // not a skill directory
      }
    }
  }
  return skills
}

export function defaultSkillDirs(cwd: string): string[] {
  return [join(process.env.HOME ?? "", ".claude", "skills"), join(cwd, ".claude", "skills")]
}
