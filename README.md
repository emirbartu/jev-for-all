# jev-for-all

**Stop making your coding agent deliberate.** Jev — a decision model that answers in ~500 ms —
picks the skill to load, the tool subset for the step, and every browser move; the coding agent
just builds.

## What this is

Jev is TypeSafe's System One model, reached through OpenRouter's alpha Decisions API. It is not
an LLM: state in, typed answers out, each with a calibrated confidence. This repo wires it into
**OpenCode, Claude Code and Hermes** from one shared decision contract, so every harness gets the
same fast decisions instead of another prompt.

## Quick start (OpenCode)

```bash
bunx jev-for-all install
```

The installer writes the plugin block into your OpenCode config and prompts for your OpenRouter
key ([create one](https://openrouter.ai/keys)); it is idempotent and leaves everything else in
the file alone. Restart OpenCode — routing is on for every session.

V2 also has a native manager: `opencode plugin add jev-for-all` writes a plain
`"plugins": ["jev-for-all"]` entry. It cannot add `options`, so set `OPENROUTER_API_KEY` instead
of `apiKey`.

Or edit it yourself:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "/path/to/jev-for-all", "options": { "apiKey": "sk-or-..." } }
  ]
}
```

Let your agent install it: point it at
<https://raw.githubusercontent.com/emirbartu/jev-for-all/main/docs/install.md>.

## Measured results, not promises

- **Skill routing** — 64 real requests against a 22-skill roster: **0 wrong picks**, hit rate
  **81.3%**, a full run costs **~$0.005**.
- **Decision cost** — **≈ $0.0001 per decision**; a busy session costs pennies.
- **Browser** — one live `browser_task` run, "open this page and click that article": **2 steps,
  3 decisions, $0.000199, 3.7 s**, correct final page.
- **Hermes adapter** — same contract, a 78-skill roster, measured: hit 75%, 0 wrong picks
  ([numbers](adapters/hermes/README.md)).

## What Jev decides

- **Which skill to load** — one from your whole roster, chosen per user message.
- **Which tool subset this step needs** — a smaller catalog, no tool-choice deliberation.
- **Every operation inside `browser_task`** — given a goal, Jev picks each click, target and
  typed value.

## The other harnesses

| Harness | Adapter |
| --- | --- |
| Claude Code | [`adapters/claude-code`](adapters/claude-code) |
| Hermes | [`adapters/hermes`](adapters/hermes) |
| Any MCP client (`browser_task` alone) | [`adapters/browser-mcp`](adapters/browser-mcp) |

## Browser tasks

`browser_task` runs one natural-language goal in a real browser; Jev picks every move, and only a
`TYPE_TEXT` step calls a text model, so a task costs less than a cent. Prerequisites (uv, a
`jev-ultrafast` checkout, a Chromium-family browser over CDP) and the MCP wiring live in
[`adapters/browser-mcp/README.md`](adapters/browser-mcp/README.md).

## Privacy & fail-open

Every model dispatch sends the conversation tail — including tool-result bodies, up to
`tools.stateBudget` (6000) characters — plus the tool catalog's names and descriptions to
OpenRouter's alpha Decisions endpoint. `browser_task` additionally sends the current page's text
and controls on every step while it runs. Nothing is sent without an API key. Every Jev call
fails open: a timeout, error, malformed answer or low-confidence decision changes nothing and
never blocks a model call.

## Configuration

The useful options (defaults shown):

- `apiKey` — OpenRouter key, or set `OPENROUTER_API_KEY`
- `model` — `~typesafe/jev-latest`
- `timeoutMs` — `1000`, the per-request timeout
- `skills.enabled` / `skills.gateThreshold` — `true` / `0.3`, skill routing
- `tools.enabled` / `tools.maxTools` — `true` / `12`, tool-subset routing
- `observe.enabled` / `observe.file` — `false` / —, per-message usage JSONL
- `browser.enabled` / `browser.jevDir` — `false` / `~/jev-ultrafast`
- `control.verify` — `false`, verification-gate hint before a completion claim

## Full configuration

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/jev-for-all",
      "options": {
        "apiKey": "sk-or-...",        // or set OPENROUTER_API_KEY
        "model": "~typesafe/jev-latest",
        "timeoutMs": 1000,
        "debug": false,
        "agents": ["build"],
        "serverURL": "https://openrouter.ai",
        "skills": { "enabled": true, "rerank": "auto", "gateThreshold": 0.3,
                    "rerankAbove": 40, "rerankBelowP": 0.5, "shortlist": 3,
                    "fitsThreshold": 0.3, "minConfidence": 0.3 },
        "tools":  { "enabled": true, "maxTools": 12, "minToolProbability": 0.05,
                    "needsToolThreshold": 0.3, "minConfidence": 0.3,
                    "alwaysVisible": ["read","write","edit","bash","grep","glob"],
                    "stateBudget": 6000 },
        "observe": { "enabled": false, "file": "/tmp/system-one-usage.jsonl", "retain": 20 },
        "browser": { "enabled": false, "jevDir": "~/jev-ultrafast",
                     "maxSteps": 12, "timeoutMs": 180000 },
        "control": { "verify": false }
      }
    }
  ]
}
```

## Development

```bash
bun test && bun run typecheck                            # unit suite
OPENROUTER_API_KEY=... bun scripts/jev-probe.ts decisions  # live Jev smoke test
```

## Status

Skill and tool routing are shipped and measured. The verification gate is built and measured
(73.3% hit on 15 cases) and ships off (`control.verify`) until it passes its bar. Next: the
routing-quality design pass.

---

Jev is a TypeSafe model; this is an independent integration. Not affiliated with the OpenCode
team.
