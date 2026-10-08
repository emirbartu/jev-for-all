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

## Install

```bash
bunx jev-for-all@latest init        # or: npx jev-for-all@latest init
jev-for-all doctor           # checks every piece and says how to fix what is wrong
```

Use `@latest`: `bunx` and `npx` cache the first version they ever downloaded, so a bare `bunx jev-for-all init` can run an old copy that does not know `init`. (`bun pm cache rm` clears it.)

`init` is safe to re-run. It needs [bun](https://bun.sh) (the Claude Code hook, the MCP tool and the
launcher run on it) and does four things:

1. Creates **`~/.config/jev-for-all/config.json`** (backend: your OpenRouter key or a Laya URL, mode 0600)
   and **`~/.config/jev-for-all/models.json`** (one entry per tier, see below). Existing files are never
   overwritten. The Claude Code plugin also creates them on its first session if they are missing.
2. Registers the OpenCode plugin in your OpenCode config (no secret is copied into it).
3. Installs the Claude Code plugin from this repo's marketplace.
4. Warns if the OpenCode Go login is missing, because the light tier runs on it.

Pass `--key sk-or-...` (or enter it when asked) to store the key. An exported `OPENROUTER_API_KEY` works
without storing anything. Other flags: `--laya <url>`, `--no-claude`, `--no-opencode`, `--dry-run`.

Do it by hand instead:

```text
/plugin marketplace add emirbartu/jev-for-all        # inside Claude Code
/plugin install system-one@jev-for-all
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": [ { "package": "jev-for-all" } ] }
```

Let your agent install it: point it at
<https://raw.githubusercontent.com/emirbartu/jev-for-all/main/docs/install.md>.

### Configuration

`~/.config/jev-for-all/models.json` is created with the defaults, so it doubles as the example:

```jsonc
{
  "light":    { "harness": "claude",   "model": "haiku",  "effort": "max" },
  "standard": { "harness": "claude",   "model": "sonnet", "effort": "auto" },
  "heavy":    { "harness": "claude",   "model": "sonnet", "effort": "auto", "minEffort": "high" }
}
```

`effort` is `low`, `medium`, `high`, `xhigh` or `max`, or `auto` to let Jev choose per request.
`harness` is `claude` (model alias or id, run with `--effort`) or `opencode` (`provider/model`, run with
`#variant`). Delete the file to get the defaults back. Plugin options for the OpenCode side are in
[Full configuration](#full-configuration).

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

## Pick the model and thinking level, not just the skill

Built for people who split work across cheap subscriptions (a $20 Claude plan plus OpenCode Go).
Three tiers, each a harness, a model and a thinking effort (`tierConfig` in `spec/decisions.json`):

| Tier | For | Default | Thinking |
| --- | --- | --- | --- |
| `light` | low-stakes work where burning tokens does not matter: lint or type errors across a codebase, renames, formatting, boilerplate, short questions | Claude `haiku` (or an OpenCode model, see below) | always `max` |
| `standard` | everything else, and anything Jev is unsure about | Claude `sonnet` | Jev picks `low`, `medium`, `high` or `xhigh` (`medium` when unsure) |
| `heavy` | the hardest work: architecture, subtle cross-cutting bugs, large refactors | Claude `sonnet` (same as standard for now) | Jev picks, never below `high` |

```bash
jev-for-all start "fix all the eslint errors across the codebase"   # light -> claude --model haiku --effort max
jev-for-all start "add input validation to createOrder"             # standard -> claude --model sonnet --effort medium
jev-for-all pick  "<prompt>"                                        # print the decision and command only
```

`start` decides once, from the first prompt, and never switches mid-session (a model change throws away
the prompt cache and the agent's context). One Jev call returns the tier, the effort and whether the
task needs an external service; if it does not and the task is light, a Claude session starts lean
(skills and MCP off). Change any tier in `~/.config/jev-for-all/models.json`, for example
`{ "heavy": { "model": "opus" }, "light": { "model": "opencode-go/glm-5.3" } }`.

### The orchestrator and its workers

The model at the top is whatever you started: Claude Code on Sonnet (or OpenCode). It stays in charge and
delegates cheap work to the light tier:

- **Light on Claude (default).** `jev-for-all start` launches a stronger tier with a `jev-light` subagent
  (`--agents`, built from `models.json`, so a config change applies at the next launch), and the hook adds a
  one-line "use a subagent with `model: haiku`" hint when Jev judges a prompt light.
- **Light on OpenCode.** Set `"light": { "harness": "opencode", "model": "opencode-go/..." }`. The plugin then
  advertises an MCP tool, `jev_delegate_light`, that runs `opencode run --model <model>#max "<task>"` in your
  project and returns the report plus `git status`; it advertises nothing when light is on Claude, so it costs
  no tokens then. Needs a working OpenCode Go login (`opencode auth login`; `jev-for-all doctor --deep` tests it).
- **Broad searches and parallel work to Claude subagents,** with a `model` chosen for them (the built-in
  `Explore` keeps its own small model).
- **OpenCode as the orchestrator:** `jev-for-all opencode-agents` prints a `jev-light` subagent pinned to the
  light model when light is on OpenCode (the `variant` field is unverified against OpenCode's agent schema).

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

Thinking effort barely moves the bill: Sonnet on the same 12 tasks passed 12/12 at both `low` and `high`, and `high` cost 9% more, used 45% more output tokens and took 1.75 times as long, because the roughly 70k tokens of context dominate. Letting Jev choose the effort is a small saving, not a large one.

Read it carefully. These are single-file tasks, so Haiku solving all of them says little about large
multi-file work, and one run per cell is noisy (Sonnet's one failure, `lru-ttl`, is likely luck).
Tier labels matched mine on 56 of 58 prompts, but I wrote both, and I tuned the `light` wording on ten of those cases. The default catalog is deliberately
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
