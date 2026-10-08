# Install jev-for-all (for agents)

Run these, in order. Every step is idempotent.

```bash
bunx jev-for-all@latest init --key <OPENROUTER_KEY>     # or: npx jev-for-all@latest init
bunx jev-for-all@latest doctor
```

Requirements: [bun](https://bun.sh) on `PATH`. Claude Code and OpenCode are each optional; `init` skips
the one that is not installed.

## What `init` does

1. Creates `~/.config/jev-for-all/` (or `$XDG_CONFIG_HOME/jev-for-all/`) with two files, only if missing:
   - `config.json`: `{ "apiKey": "", "layaUrl": "", "hints": false }`, mode 0600. `--key` fills `apiKey`, `--laya <url>`
     fills `layaUrl`. `hints` turns the per-prompt Claude Code skill and subagent hints on (default off). A key already exported as `OPENROUTER_API_KEY` is used without storing it.
   - `models.json`: the three tiers (`light` = claude haiku, `standard` and `heavy` = claude sonnet), each
     `{ harness, model, effort }`. This is the example config; edit it to change models or thinking levels,
     or set `light` to `{ "harness": "opencode", "model": "opencode-go/deepseek-v4.1-flash" }`.
2. OpenCode: inserts `{ "package": "jev-for-all" }` first in the `"plugins"` array of
   `~/.config/opencode/opencode.jsonc` (never touches anything else; refuses an invalid file).
3. Claude Code: `claude plugin marketplace add emirbartu/jev-for-all`, then
   `claude plugin install system-one@jev-for-all`. Use `--claude-source <checkout>` for a local clone.
4. Prints a warning if `opencode auth list` shows no OpenCode Go login (only needed when a tier uses OpenCode).

Flags: `--no-claude`, `--no-opencode`, `--dry-run`, `--config <opencode config path>`.

## Verify

`bunx jev-for-all@latest doctor` prints one line per check (bun, both config files, backend, a live decision,
the Claude Code plugin, the OpenCode Go login) and exits non-zero if something is wrong.
`doctor --deep` also sends a few tokens to DeepSeek to prove the OpenCode Go credential works.
Restart Claude Code and OpenCode after the first install.

## Use

```bash
jev-for-all start "fix all the eslint errors across the codebase"   # picks harness, model and effort once
jev-for-all pick  "<prompt>"                                         # print the decision only
```

## Uninstall

```bash
claude plugin uninstall system-one@jev-for-all
claude plugin marketplace remove jev-for-all
```

Remove the `jev-for-all` entry from the OpenCode `"plugins"` array, and delete
`~/.config/jev-for-all/` if you want the config gone too.
