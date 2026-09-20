# opencode-system-one

An OpenCode V2 plugin that pairs the System One model Jev (TypeSafe, reached through
OpenRouter's alpha Decisions API) with a classic coding agent. Jev makes the fast,
structured decisions — which skill to load, which tool subset this step needs — and the
classic agent does the work. The agent starts building instead of deliberating: a smaller
tool catalog, no tool-choice reasoning, and more reliable skill loads.

## Install and configure

```jsonc
{
  "plugins": [
    {
      "package": "opencode-system-one",
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
        "observe": { "enabled": false, "file": "/tmp/system-one-usage.jsonl", "retain": 20 }
      }
    }
  ]
}
```

The API key comes from `options.apiKey` or the `OPENROUTER_API_KEY` environment variable.
Zero config works once the env var is set. Main options:

- `model` — Jev model slug (default `~typesafe/jev-latest`).
- `timeoutMs` — per-request timeout (default 1000 ms).
- `skills.*` / `tools.*` — thresholds and caps for the two hooks; `skills.enabled` and
  `tools.enabled` toggle them.
- `agents` — allowlist for tool routing (default: all agents).
- `debug` — log routing decisions.
- `serverURL` — override the API host (test/proxy seam; default `https://openrouter.ai`).
- `observe.enabled` — record per-message usage (default false).
- `observe.file` — JSONL path for usage records (optional; nothing written when unset).
- `observe.retain` — in-memory session cap for usage dedupe (default 20).

## Data egress

On every model dispatch the `context` hook sends the **tail of the conversation** to
OpenRouter's alpha Decisions endpoint (`https://openrouter.ai/api/alpha/decisions`) so Jev
can pick tools. That tail includes **tool-result bodies** — file contents, shell output,
search hits — rendered up to `tools.stateBudget` characters (default 6000), plus the tool
catalog's names and descriptions. Tool input schemas are not sent. Nothing is sent when no
API key is configured or the plugin is disabled.

There is no option to exclude tool-result bodies from the state today.

Usage records are local numbers only (message counts, tokens, cache, cost) and are never
uploaded.

## Fail-open

Every Jev call fails open: a timeout, non-2xx, malformed answer, or below-threshold
decision changes nothing. Routing failures degrade to no routing and log one warning per
session; they never block or fail a model call.

## Live probe

Requires a working OpenRouter key:

```bash
OPENROUTER_API_KEY=... bun scripts/jev-probe.ts decisions
OPENROUTER_API_KEY=... bun scripts/jev-probe.ts catalog tools.json
```
