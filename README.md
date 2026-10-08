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

- Which skill to load, one from the whole roster, chosen for each user message. Small mechanical
  steps (rename, bump a value, read a file, run one command) are vetoed up front by
  `gate::mechanical`, so they get no skill (`skills.mechanicalVeto`, default 0.5).
- Whether to hand the request to a subagent (Claude Code adapter), and which one. Most requests
  stay with the main agent; only broad search, independent research or parallel work delegates.
- Which tool subset this step needs, so the agent picks from a smaller catalog.
- Every operation inside `browser_task`: given a goal, Jev picks each click, target and typed
  value.

## Pick the model, not just the skill

Built for people who split work across cheap subscriptions (a $20 Claude plan, OpenCode Go). Jev
decides once, at the start, which model a session needs, then stays out of the way. Switching models
inside a session throws away the prompt cache and the agent's context, so it never does that.

```bash
jev-for-all claude   "rename x to count in utils.js"   # light  -> haiku, lean session
jev-for-all opencode "design the sync architecture"    # heavy  -> your heavy OpenCode model
jev-for-all pick     "<prompt>"                        # just print the decision as JSON
jev-for-all opencode-agents                            # per-tier subagents for opencode.json
```

- **Tiers.** One Jev choice labels the first prompt `light`, `standard` or `heavy`. Asymmetric on
  purpose: a hard task on a weak model costs quality, an easy task on a strong model only costs money,
  so `light` needs 0.6 and `heavy` 0.5 probability and anything unclear becomes `standard`.
- **Your models.** Defaults are in `spec/decisions.json`; override any tier in
  `~/.config/jev-for-all/models.json`, e.g. `{ "claude": { "standard": "haiku" } }`.
- **Lean sessions.** For a light task that needs no external service, the launcher starts Claude Code
  with skills and MCP servers off. Restart without it if you change your mind.
- **Subagents.** The Claude Code hook tells the main agent to delegate with a `model` chosen by tier,
  capped at `standard` (and `light` for `Explore`, which only gathers). In OpenCode, the printed
  `agent` block pins one subagent per tier to your catalog.
- **Fails open.** No key, timeout or unclear answer: the harness starts with your own default.

### What it measured

`bun scripts/bench-claude.ts`: 12 small coding tasks, each with a hidden check that a hand-written
reference solution passes, run through headless Claude Code with every plugin off. Costs are the
`total_cost_usd` Claude Code reports; one run per cell.

| | pass | cost | input tokens / task |
| --- | --- | --- | --- |
| always Sonnet | 11 / 12 | $1.014 | n/a |
| Jev routed (default catalog) | 11 / 12 | $0.658 (-35%) | n/a |
| always Haiku | 12 / 12 | $0.062 (-94%) | 99k |
| Haiku, lean session | 12 / 12 | $0.037 | 63k (-37%) |

Read it carefully. These are single-file tasks, so Haiku solving all of them says little about large
multi-file work, and one run per cell is noisy (Sonnet's one failure, `lru-ttl`, is likely luck).
Tier labels matched my own on 46 of 48 prompts, but I wrote both. The default catalog is deliberately
conservative (`standard` stays on Sonnet); if your tasks look like the benchmark, put Haiku on
`standard` and keep the 94%. The lean saving is the firmest result: skills and MCP schemas were about
40% of the input for a one-line edit, and it holds on any model.

## Self-hosting with Laya (experimental, not recommended yet)

[Laya](https://github.com/NandhaKishorM/laya) is an open, self-hosted System One model that speaks the
same `POST /v1/systemone` protocol as Jev, so it plugs in with one variable and no OpenRouter credits:

```bash
uv venv --python 3.12 laya-venv && VIRTUAL_ENV=$PWD/laya-venv uv pip install "laya[serve]"
LAYA_DEVICE=cuda LAYA_PRELOAD=1 LAYA_MODELS=english,multilingual LAYA_DEFAULT_MODEL=english laya-venv/bin/laya-serve
export LAYA_BASE_URL=http://127.0.0.1:8000     # every host in this repo now uses it
export LAYA_MODEL=typed-decisions              # optional: english | multilingual | typed-decisions
```

With `LAYA_BASE_URL` set Laya is used instead of OpenRouter and never falls back to it, so a stopped
server just means no routing. It is much faster (21 ms median on an RTX 3060, against about 450 ms),
**but on our decisions the stock checkpoints are much worse than Jev**, measured on the same cases:

| | Jev | Laya `english` | Laya `typed-decisions` |
| --- | --- | --- | --- |
| Skill routing, hit rate (64 cases) | 93.8% | 37.5% | 42.2% |
| Wrong skill picks | 0% | 23.4% | 31.3% |
| Spurious skill loads | 0% | 21.9% | 15.6% |
| Model tier, accuracy (48 cases) | 95.8% | 41.7% (60.4% by plain argmax) | 64.6% by plain argmax |
| Subagent delegation (12 cases) | 11 / 12 | 8 / 12, never delegated | not run |

Laya's own README says the base checkpoints are meant to be fine-tuned, and that its probabilities are
flatter and differently calibrated than Jev's, so thresholds tuned for Jev do not transfer. A wrong skill
pick is worse than none, so leave this off until a fine-tuned checkpoint beats the table above. The route
to get there is to label a few thousand prompts with Jev once (cents of credits) and fine-tune Laya on
them; that has not been done.

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
