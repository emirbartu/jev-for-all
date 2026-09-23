# jev-for-all

**Jev for every agentic development workflow.** The home for using the System One model Jev
(TypeSafe, reached through OpenRouter's alpha Decisions API) wherever an agent codes —
OpenCode today, Claude Code and Hermes adapters next — so every workflow gets Jev's benefits
from one shared contract.

Shipped piece: an OpenCode V2 plugin that pairs Jev with a classic coding agent. Jev makes the
fast, structured decisions — which skill to load, which tool subset this step needs — and the
classic agent does the work. The agent starts building instead of deliberating: a smaller tool
catalog, no tool-choice reasoning, and more reliable skill loads.

## Install and configure

```jsonc
{
  "plugins": [
    {
      "package": "jev-for-all",
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
                     "maxSteps": 12, "timeoutMs": 180000 }
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
- `browser.enabled` — register the `browser_task` tool (default false; see below).
- `browser.jevDir` — jev-ultrafast checkout to run (default `~/jev-ultrafast`; `~` is expanded).
- `browser.envFile` — `.env` holding the jev credentials, relative to `jevDir` (default `.env`).
- `browser.uvPath` — `uv` binary used to launch the loop (default `uv`).
- `browser.maxSteps` — default action budget per task (default 12, ceiling 60).
- `browser.timeoutMs` — wall-clock cap on one task (default 180000).

## Browser tasks

With `browser.enabled`, the plugin registers one tool, `browser_task`. Give it a goal and a
URL; it runs the jev-ultrafast loop as a subprocess and returns the final URL, the page title
and the action trace.

The coding agent does **not** choose the clicks. Inside the loop a hosted Jev policy model
picks every operation and target, and only a `TYPE_TEXT` step calls a text model, so a task
costs about **$0.00003 per decision** (a five-step task is well under a cent). That is the
whole reason the tool exists: the agent states a goal and verifies the outcome instead of
scripting selectors.

Prerequisites, all outside this plugin:

1. A checkout of `browser-use/jev-ultrafast` with its own `.env` (see that repo's `FORK.md`
   for the OpenRouter-backed policy). It is **the checkout's** credentials that are used, not
   this plugin's `apiKey`.
2. `uv` on `PATH`.
3. A Chromium-family browser connected through browser-harness over CDP. Flatpak Chromium
   never writes `DevToolsActivePort`, so seed the daemon once with an explicit endpoint:

   ```bash
   flatpak run org.chromium.Chromium \
     --user-data-dir="$HOME/.var/app/org.chromium.Chromium/config/jev-profile" \
     --remote-debugging-port=9222
   cd ~/jev-ultrafast && BU_CDP_WS=$(curl -s http://127.0.0.1:9222/json/version |
     python3 -c 'import sys,json;print(json.load(sys.stdin)["webSocketDebuggerUrl"])') \
     uv run browser-harness <<<'print(page_info().get("title"))'
   ```

   The daemon keeps the connection, so the tool needs no environment of its own after that.
   Without a browser the tool still returns a readable failure rather than throwing.

A stopped run is not a failed one: `status: "blocked"` and a `DONE` both come from the policy
model, so the trace is a report, not proof. Verify the outcome before reporting success, and
never retry a browser mutation blindly.

## Skill decision quality (L1)

The shipped skill decision is measured against real skills, not invented ones: 64 cases (44
covered across all 22 skills in `~/.agents/skills`, 20 no-skill requests) run live through
`selectSkill` and classified as hit / wrong-skill / spurious / missed.

```bash
OPENROUTER_API_KEY=... bun scripts/skill-l1.ts --roster ~/.agents/skills \
  --cases fixtures/skill-eval/agents-skills-cases.jsonl
```

```text
cases: 64 scored 64 skipped 0 | roster 22 | model ~typesafe/jev-latest
hit 51 (79.7%) | wrong-skill 0 (0.0%) | spurious 6 (9.4%) | missed 7 (10.9%)
latency avg 613 ms / max 1252 ms | tokens in 113748 out 18534 | est cost $0.0048
reference bar (TypeSafe cookbook): agent-alone 16.8% wrong / 9.8% spurious; with suggestion 7.3% / 4.0%
```

Run 2026-09-23 against `~typesafe/jev-latest`, $0.0048 total. Raw per-case results stay under
`.superpowers/skill-l1/` (gitignored).

Reading: zero wrong picks; the 7 misses are advisory skills the gate turns away (brainstorming,
planning, parallel dispatch, skill discovery), and the 6 spurious picks are generic edit/run
requests that `ponytail`'s "use on any coding task" description attracts.

## Data egress

On every model dispatch the `context` hook sends the **tail of the conversation** to
OpenRouter's alpha Decisions endpoint (`https://openrouter.ai/api/alpha/decisions`) so Jev
can pick tools. That tail includes **tool-result bodies** — file contents, shell output,
search hits — rendered up to `tools.stateBudget` characters (default 6000), plus the tool
catalog's names and descriptions. Tool input schemas are not sent. Nothing is sent when no
API key is configured or the plugin is disabled.

There is no option to exclude tool-result bodies from the state today.

`browser_task` adds a second, larger egress path, and only while it runs: the goal and start
URL leave the machine, and for **every step** the loop sends the current page's URL, title,
visible text, indexed controls and recent actions to the policy model. That is the page the
browser is on, so anything rendered on that tab — including content behind a session you are
already signed into — can be sent. No screenshots and no HTML are sent, only the extracted
text and control list; a step that types a value also sends that field's meaning and page
context to the text model. The trace and the cost figures stay local.

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
