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

- Skill roster: `$HERMES_HOME/skills/**/SKILL.md` by default, or the `skill_dirs` setting when
  set. Both `<skill>/SKILL.md` and `<category>/<skill>/SKILL.md` are scanned, hidden entries
  are skipped, and each skill's `id` is its leaf directory name. Each skill's `name`,
  `description`, and body are parsed from its frontmatter; a file without frontmatter still
  counts, using its directory name. A duplicate id keeps the top-level occurrence.
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

## Skill decision quality (L1)

Run 2026-09-24 against the real Hermes roster — 78 skills (76 under `<category>/<skill>/`, plus
top-level `i-have-adhd` and the `find-skills` symlink) — with the adapter's real `decide()`,
model `~typesafe/jev-latest`. Corpus: the 12 covered cases in `fixtures/skill-eval/hermes-cases.jsonl`,
written from the skills' own `SKILL.md` descriptions, plus the 20 `expected: null` cases from
`fixtures/skill-eval/agents-skills-cases.jsonl`. The adapter asks the advisory-work question
(parity with the TS core), and folded `description: >` frontmatter now parses correctly — all 78
real skills have a non-empty description.

```bash
OPENROUTER_API_KEY=... python3 adapters/hermes/eval/skill_l1.py --max-usd 0.10
```

```text
cases: 32 scored 32 skipped 0 | roster 78 | model ~typesafe/jev-latest
hit 27 (84.4%) | wrong-skill 0 (0.0%) | spurious 4 (12.5%) | missed 1 (3.1%)
latency avg 1085 ms / max 1628 ms | tokens in 128062 out 29445 | est cost $0.0054
reference bar (TypeSafe cookbook): agent-alone 16.8% wrong / 9.8% spurious; with suggestion 7.3% / 4.0%
```

Reading: 11 of 12 covered requests hit; the miss is `humanizer`. The remaining spurious picks
come from the no-skill half, where delegation skills claim terminal work. Raw per-case results
stay under `.superpowers/hermes-l1/` (gitignored).

### Timeout

Measured 2026-09-24 at 78 skills: a single Jev request (rank criteria for all 78 + the gate
nouls) takes **758–910 ms** (avg 817 ms, 5 samples), and a full `decide()` — often two requests,
because the roster exceeds `rerankAbove` — 1.1–1.7 s. The old 1 s per-request default left
~90 ms of headroom, and an earlier slow window (4.5 s per decide) would have timed out every
call; the default is now **2000 ms** per request (`timeout_ms`), with `--timeout-ms` on the
runner for experiments. Both today's runs (1000 ms and 6000 ms) had zero request errors.

## Tests

```bash
python3 -m unittest discover -s adapters/hermes/tests -v
```
