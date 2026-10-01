# jev-for-all

Jev is TypeSafe's System One decision model. It answers a question in roughly 70 to 500 ms with a
typed answer and a confidence score. This repo connects Jev to coding agents so they can ask it
which skill to load, which tools a step needs, and how to move in the browser.

For the reasoning behind the design, including where Jev wins and where it loses, see
[When Jev wins](WHERE-JEV-WINS.md).

## What this is

Jev runs on OpenRouter's alpha Decisions API. It is not an LLM. You pass it state, it returns
typed answers with a calibrated confidence for each. The repo connects it to OpenCode, Claude
Code, Hermes and pi (senpi) through one shared decision contract, so every harness gets the same
answers.

## Quick start (OpenCode)

```bash
bunx jev-for-all install
```

The installer writes the plugin block into your OpenCode config and asks for your OpenRouter key
([create one](https://openrouter.ai/keys)). It is idempotent and leaves the rest of the file
alone. Restart OpenCode and routing is on for every session.

V2 also has a native manager. `opencode plugin add jev-for-all` writes a plain
`"plugins": ["jev-for-all"]` entry; it cannot add `options`, so set `OPENROUTER_API_KEY` instead
of `apiKey`.

Or edit the config yourself:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "jev-for-all", "options": { "apiKey": "sk-or-..." } }
  ]
}
```

A local clone path works too when you develop the plugin.

Let your agent install it: point it at
<https://raw.githubusercontent.com/emirbartu/jev-for-all/main/docs/install.md>.

## Results

- Skill routing: 64 real requests against a 22-skill roster, 0 wrong picks and an 85.9% hit rate.
  A full run costs about $0.005.
- Decision cost: about $0.0001 per decision, so a busy session costs pennies.
- Browser: one live `browser_task` run, "open this page and click that article", took 2 steps and
  3 decisions, cost $0.000199, and finished in 3.7 s on the correct page.
- Hermes adapter: the same contract against a 78-skill roster hit 75% with 0 wrong picks
  ([numbers](adapters/hermes/README.md)).

## What Jev decides

- Which skill to load, one from the whole roster, chosen for each user message.
- Which tool subset this step needs, so the agent picks from a smaller catalog.
- Every operation inside `browser_task`: given a goal, Jev picks each click, target and typed
  value.

## The other harnesses

| Harness | Adapter |
| --- | --- |
| Claude Code | [`adapters/claude-code`](adapters/claude-code) |
| Hermes | [`adapters/hermes`](adapters/hermes) |
| pi (senpi) | [`adapters/pi-senpi`](adapters/pi-senpi) |
| Any MCP client (`browser_task` alone) | [`adapters/browser-mcp`](adapters/browser-mcp) |

## Browser tasks

`browser_task` runs one natural-language goal in a real browser. Jev picks every move, and only a
`TYPE_TEXT` step calls a text model, so a task costs less than a cent. Prerequisites (uv, a
`jev-ultrafast` checkout, and a Chromium-family browser over CDP) and the MCP wiring are in
[`adapters/browser-mcp/README.md`](adapters/browser-mcp/README.md).

## Privacy and fail-open behavior

Every model dispatch sends the conversation tail, including tool-result bodies up to
`tools.stateBudget` (6000) characters, plus the tool catalog's names and descriptions, to
OpenRouter's alpha Decisions endpoint. `browser_task` also sends the current page's text and
controls on every step while it runs. Nothing is sent without an API key. Every Jev call fails
open: a timeout, error, malformed answer or low-confidence decision changes nothing and never
blocks a model call.

## Configuration

The useful options, with defaults:

- `apiKey`: OpenRouter key, or set `OPENROUTER_API_KEY`
- `model`: `~typesafe/jev-latest`
- `timeoutMs`: `2500`, the per-request timeout
- `skills.enabled`, `skills.gateThreshold`: `true`, `0.3` for skill routing
- `tools.enabled`, `tools.maxTools`: `true`, `12` for tool-subset routing
- `observe.enabled`, `observe.file`: `false`, none, per-message usage JSONL
- `browser.enabled`, `browser.jevDir`: `false`, `~/jev-ultrafast`
- `control.verify`: `false`, verification-gate hint before a completion claim

## Full configuration

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/jev-for-all",
      "options": {
        "apiKey": "sk-or-...",        // or set OPENROUTER_API_KEY
        "model": "~typesafe/jev-latest",
        "timeoutMs": 2500,
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
bun run typecheck                                        # type check
OPENROUTER_API_KEY=... bun scripts/jev-probe.ts decisions  # live Jev smoke test
```

## Status

Skill and tool routing are shipped and measured. The verification gate is built and measured
(80.0% hit on 15 cases, above its bar) and ships off (`control.verify`) pending an L2 run. Next is
the routing-quality design pass.

---

Jev is a TypeSafe model; this is an independent integration, and the repo is not affiliated with
any other organization or team.
