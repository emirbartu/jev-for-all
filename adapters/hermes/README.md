# system-one for Hermes

Jev-routed skill selection for [Hermes](https://hermes-agent.nousresearch.com). On every
`pre_llm_call` the plugin asks [Jev](https://docs.typesafe.ai) whether the turn needs a
skill; if one fits, its body is injected into the current turn's user message, otherwise a
short "skills are routed externally" line is injected.

**Harness ceiling.** `pre_llm_call` is Hermes' context-injection hook: it can append text to
the current turn's user message and nothing else. It cannot filter the tool catalog or rewrite
the system prompt, so the skill list stays visible and this plugin never touches either — the
prompt cache stays intact.

## Install

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
cp -R /home/gerius/Desktop/jev-for-all/adapters/hermes/system_one \
      "${HERMES_HOME:-$HOME/.hermes}/plugins/system-one"
hermes plugins doctor  "${HERMES_HOME:-$HOME/.hermes}/plugins/system-one" --ci
hermes plugins validate "${HERMES_HOME:-$HOME/.hermes}/plugins/system-one"
hermes plugins enable system-one
```

The first three commands only copy and check files. `hermes plugins enable system-one` is the
user's step: it writes `plugins.enabled` into `${HERMES_HOME:-$HOME/.hermes}/config.yaml`.

## What it reads

- Skill roster: `$HERMES_HOME/skills/*/SKILL.md` by default, or the `skill_dirs` setting when
  set. Each skill's `name`, `description`, and body are parsed from its frontmatter; a file
  without frontmatter still counts, using its directory name.
- Decision contract: `assets/decisions.json` — gate thresholds, confidence floor, rerank
  settings, injection cap (8000 chars), and the spend cap. Code paths read from it; no
  thresholds are hardcoded.

## What it injects

- Jev picked a skill: `<skill_relevance>` with the routed skill's name and id, followed by the
  skill body (capped at the contract's 8000 chars; past the cap, a pointer to the `SKILL.md`
  path instead).
- Jev answered "none": the fixed line `Skills are routed externally for this turn; do not call
  the skill tool unless the user names one.`
- No roster, no API key, transport error, malformed answer, low confidence, or unknown id:
  nothing is injected and the request is unchanged.

The injection lands in the current turn's user message only. The system prompt and the toolset
are never modified.

## Settings

Set under `plugins.entries.system-one.settings` in `config.yaml`, or through the Desktop
Capabilities → Plugins form (driven by `plugin.yaml`'s `config_schema`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | `~typesafe/jev-latest` | Jev model slug. |
| `max_calls_per_session` | `500` (contract) | Stop calling Jev past this many calls in one session. |
| `timeout_ms` | `1000` | Per-request timeout in milliseconds. |
| `skill_dirs` | `[]` → `$HERMES_HOME/skills` | Skill directories to scan. |

## Decision log

Every Jev call appends one JSON line to `decisions.jsonl` **next to the module** — in a repo
checkout `adapters/hermes/system_one/decisions.jsonl`, installed
`$HERMES_HOME/plugins/system-one/decisions.jsonl`. The line records the chosen skill (or
`none` / `no-change`), the resolved model id, token usage, latency, and the per-session call
count; cap and warn events are logged the same way.

## Data egress

The `pre_llm_call` hook sends the latest user message and the skill roster (names, ids,
descriptions) to OpenRouter's decisions endpoint. When the contract's rerank runs, the first
700 characters of each shortlisted skill's body are sent too. The injected skill body stays
local, conversation history is not sent, and the decision log is local-only.

## Fail-open

The hook never raises and never changes the request on failure: a missing `OPENROUTER_API_KEY`,
an empty roster, a timeout, a non-2xx, a malformed answer, an unknown skill id, or a
low-confidence answer all leave Hermes' behavior exactly as it was.

## Proof

Run against an isolated home so nothing in the real `~/.hermes` is touched:

```bash
export PROOF_HOME=/tmp/opencode/hermes-system-one-proof
rm -rf "$PROOF_HOME"
mkdir -p "$PROOF_HOME/plugins" "$PROOF_HOME/skills/demo"
cp -R adapters/hermes/system_one "$PROOF_HOME/plugins/system-one"
printf 'plugins:\n  enabled:\n    - system-one\n' > "$PROOF_HOME/config.yaml"
printf -- '---\nname: demo\ndescription: Demo skill for the routing proof\n---\n\nWhen this skill is loaded, say the word DONE-DEMO.\n' > "$PROOF_HOME/skills/demo/SKILL.md"
printf 'The system-one routing proof file.\nLine two, for the summarizer.\n' > "$PROOF_HOME/system-one-proof.txt"

HERMES_HOME="$PROOF_HOME" hermes plugins doctor adapters/hermes/system_one --ci
HERMES_HOME="$PROOF_HOME" hermes plugins validate adapters/hermes/system_one
HERMES_HOME="$PROOF_HOME" hermes chat -q "summarize the file $PROOF_HOME/system-one-proof.txt"
HERMES_HOME="$PROOF_HOME" hermes chat -q "use the demo skill: announce completion"
cat "$PROOF_HOME/plugins/system-one/decisions.jsonl"
```

`OPENROUTER_API_KEY` must be in the Hermes process environment. The durable proof is one
decision line per turn, for example:

```json
{"kind": "decision", "harness": "hermes", "sessionID": "...", "hook": "pre_llm_call", "chosen": "demo", "model": "typesafe/jev-1.13-20260917", "inputTokens": 446, "outputTokens": 80, "latencyMs": 744, "calls": 1, "time": ...}
```

The injected context is observable in the turn: with the demo skill loaded the model answers
`DONE-DEMO`. If the main model call fails for lack of provider auth, the decision line still
lands; that is the proof the hook ran.

## Tests

```bash
python3 -m unittest discover -s adapters/hermes/tests -v
```
