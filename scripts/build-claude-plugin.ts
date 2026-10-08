// Builds the Claude Code plugin into a self-contained directory. Claude Code copies a plugin into its cache,
// and the copy has no ../../../src, ../spec or ../browser-mcp, so everything the plugin runs is bundled or
// copied in here and committed. Run after any change under src/, spec/, adapters/claude-code or adapters/browser-mcp.
import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const repo = join(import.meta.dir, "..")
const plugin = join(repo, "adapters", "claude-code")

const result = await Bun.build({
  entrypoints: [join(plugin, "hooks", "system-one.ts"), join(plugin, "mcp", "delegate.ts")],
  outdir: join(plugin, "dist"),
  target: "bun",
  naming: "[name].js",
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const output of result.outputs) console.log(`built ${output.path} (${(output.size / 1024).toFixed(0)} KB)`)

// The browser_task MCP server is plain Python; it only needs to sit inside the plugin directory.
const target = join(plugin, "browser-mcp")
mkdirSync(target, { recursive: true })
for (const file of ["server.py", "browser_mcp.py"]) {
  copyFileSync(join(repo, "adapters", "browser-mcp", file), join(target, file))
  console.log(`copied browser-mcp/${file}`)
}
