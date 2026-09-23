import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { install, stripJsonc, upsertPluginEntry } from "./jev-for-all.js"

const ENTRY = { package: "jev-for-all", options: { apiKey: "sk-or-test" } }

const parse = (text: string): Record<string, unknown> => JSON.parse(stripJsonc(text))

test("stripJsonc removes comments and trailing commas but keeps strings", () => {
  const text = `{
  // "plugins" here is a comment
  "a": "http://x//y, }",
  /* block "plugins": [] */
  "b": [1, 2,],
}`
  const parsed = parse(text)
  expect(parsed.a).toBe("http://x//y, }")
  expect(parsed.b).toEqual([1, 2])
})

test("upsertPluginEntry creates a file from nothing", () => {
  const text = upsertPluginEntry("", ENTRY)
  const parsed = parse(text)
  expect((parsed.plugins as unknown[])[0]).toEqual(ENTRY)
})

test("upsertPluginEntry adds a plugins key to an empty object", () => {
  const text = upsertPluginEntry("{}", ENTRY)
  const parsed = parse(text)
  expect(parsed.plugins).toHaveLength(1)
  expect((parsed.plugins as Array<{ package: string }>)[0].package).toBe("jev-for-all")
})

test("upsertPluginEntry inserts first in a JSONC file with comments and a trailing comma", () => {
  const text = `{
  // existing setup
  "plugins": [
    { "package": "/home/me/jev-for-all", "options": { "apiKey": "old" } },
  ],
  "model": "x",
}`
  const parsed = parse(upsertPluginEntry(text, ENTRY))
  const plugins = parsed.plugins as Array<{ package: string }>
  expect(plugins).toHaveLength(2)
  expect(plugins[0]).toEqual(ENTRY)
  expect(plugins[1].package).toBe("/home/me/jev-for-all")
  expect(parsed.model).toBe("x")
})

test("upsertPluginEntry handles an empty plugins array", () => {
  const parsed = parse(upsertPluginEntry('{ "plugins": [] }', ENTRY))
  expect((parsed.plugins as unknown[])[0]).toEqual(ENTRY)
})

test("a comment containing plugins is not matched", () => {
  const parsed = parse(upsertPluginEntry('{\n  // "plugins": []\n  "model": "x"\n}', ENTRY))
  expect(parsed.plugins).toHaveLength(1)
  expect(parsed.model).toBe("x")
})

test("install creates the config, then is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-install-"))
  const config = join(dir, "opencode.jsonc")
  const first = await install({ configPath: config, key: "sk-or-test" })
  expect(first.status).toBe("installed")
  expect(existsSync(config)).toBe(true)
  const before = readFileSync(config, "utf8")
  const second = await install({ configPath: config, key: "sk-or-other" })
  expect(second.status).toBe("already")
  expect(readFileSync(config, "utf8")).toBe(before)
})

test("install inserts into an existing JSONC config and stays parseable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-install-"))
  const config = join(dir, "opencode.jsonc")
  writeFileSync(
    config,
    `{
  // my opencode config
  "plugins": [
    { "package": "/home/me/some-other-plugin" },
  ],
  "model": "opencode-go/deepseek-v4.1-flash",
}`,
  )
  const result = await install({ configPath: config, key: "sk-or-test" })
  expect(result.status).toBe("installed")
  const parsed = parse(readFileSync(config, "utf8"))
  const plugins = parsed.plugins as Array<{ package: string }>
  expect(plugins[0]).toEqual(ENTRY)
  expect(plugins[1].package).toBe("/home/me/some-other-plugin")
  expect(parsed.model).toBe("opencode-go/deepseek-v4.1-flash")
})

test("install treats an existing local clone path as already installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-install-"))
  const config = join(dir, "opencode.jsonc")
  const original = '{ "plugins": [{ "package": "/home/me/jev-for-all" }] }'
  writeFileSync(config, original)
  const result = await install({ configPath: config, key: "sk-or-test" })
  expect(result.status).toBe("already")
  expect(readFileSync(config, "utf8")).toBe(original)
})

test("install without a key omits options; dry-run writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-install-"))
  const config = join(dir, "opencode.jsonc")
  const result = await install({ configPath: config, key: undefined, dryRun: true })
  expect(result.status).toBe("installed")
  expect((parse(result.text).plugins as Array<{ package: string }>)[0]).toEqual({ package: "jev-for-all" })
  expect(result.text).not.toContain("apiKey")
  expect(existsSync(config)).toBe(false)
})

test("install refuses to write an unparseable config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-install-"))
  const config = join(dir, "opencode.jsonc")
  writeFileSync(config, "{ this is not json")
  const result = await install({ configPath: config, key: "sk-or-test" })
  expect(result.status).toBe("invalid")
  expect(readFileSync(config, "utf8")).toBe("{ this is not json")
})

test("the CLI runs through a symlink shim (npx/bunx shape)", () => {
  const node = Bun.which("node")
  if (!node) {
    console.warn("node not found; skipping the symlink shim test")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "jev-shim-"))
  const link = join(dir, "jev-for-all")
  symlinkSync(join(import.meta.dir, "jev-for-all.js"), link)

  const help = Bun.spawnSync([node, link, "help"], { stdout: "pipe", stderr: "pipe" })
  expect(help.exitCode).toBe(0)
  expect(help.stdout.toString()).toContain("Usage:")

  const config = join(dir, "opencode.jsonc")
  const installed = Bun.spawnSync([node, link, "install", "--config", config, "--key", "sk-or-shim"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(installed.exitCode).toBe(0)
  expect(existsSync(config)).toBe(true)
  const plugins = parse(readFileSync(config, "utf8")).plugins as Array<unknown>
  expect(plugins[0]).toEqual({ package: "jev-for-all", options: { apiKey: "sk-or-shim" } })
})
