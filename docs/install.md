# Install jev-for-all (for agents)

One command registers the OpenCode plugin in the user's config:

```bash
bunx jev-for-all install
```

- It writes this entry into `~/.config/opencode/opencode.jsonc` (or
  `$XDG_CONFIG_HOME/opencode/opencode.jsonc`), inserting it first in the `"plugins"` array:

  ```jsonc
  {
    "plugins": [
      { "package": "jev-for-all", "options": { "apiKey": "sk-or-..." } }
    ]
  }
  ```

- It is idempotent: an existing `jev-for-all` entry (npm name or a clone path ending in
  `/jev-for-all`) is left alone.
- Flags: `--config <path>` targets another config file; `--key <sk-or-...>` skips the prompt;
  `--dry-run` prints the edited text without writing.
- No key yet? Either export `OPENROUTER_API_KEY`, or add `options.apiKey` to the entry later.
- The installer never touches anything else in the file, and refuses to write if the config is
  not valid JSONC.

## Verify

1. Restart OpenCode.
2. The plugin loads with the session; with `"debug": true` in the options, routing decisions log
   to the console.
3. `bunx jev-for-all install` again prints `already installed — nothing to do`.

## Uninstall

Remove the `jev-for-all` entry from the `"plugins"` array and restart OpenCode.
