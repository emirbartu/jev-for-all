// Copies the canonical contract and conformance corpus into each adapter so the
// adapter directories stay installable on their own. Run with --check in the gate.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const repo = join(import.meta.dir, "..")
const assets = [
  { from: join(repo, "spec", "decisions.json"), to: join(repo, "adapters", "claude-code", "assets", "decisions.json") },
  { from: join(repo, "fixtures", "conformance.jsonl"), to: join(repo, "adapters", "claude-code", "assets", "conformance.jsonl") },
  { from: join(repo, "spec", "decisions.json"), to: join(repo, "adapters", "hermes", "system_one", "assets", "decisions.json") },
  { from: join(repo, "fixtures", "conformance.jsonl"), to: join(repo, "adapters", "hermes", "system_one", "assets", "conformance.jsonl") },
]

const check = process.argv.includes("--check")
let drifted = 0

for (const asset of assets) {
  if (check) {
    let same = false
    try {
      same = readFileSync(asset.from, "utf8") === readFileSync(asset.to, "utf8")
    } catch {
      same = false
    }
    if (!same) {
      console.error(`drift: ${asset.to}`)
      drifted += 1
    }
    continue
  }
  mkdirSync(dirname(asset.to), { recursive: true })
  copyFileSync(asset.from, asset.to)
  console.log(`synced ${asset.to}`)
}

if (check) {
  console.log(drifted === 0 ? "adapter assets: up to date" : `adapter assets: ${drifted} drifted`)
  process.exitCode = drifted === 0 ? 0 : 1
}
