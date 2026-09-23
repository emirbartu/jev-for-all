# Jev Decision Portfolio — Design

Date: 2026-09-23
Status: approved in chat; wave 1 in progress

## Goal

Treat every place Jev could make a decision as a portfolio entry with a measurable payoff, and
let data — not enthusiasm — decide what ships. Wave 1 builds the measuring instruments: an L1
case-file eval for the shipped skill decision, and the cross-harness decision report.

## The eligibility filter (every candidate decision)

A decision may go to Jev only if all three hold:

1. It is a snap judgment a knowledgeable person answers in about a second given the state.
2. It is expressible as a typed question (choice / noul / score) over state we already have.
3. It is cheap to be wrong — a hint, or validated by code.

Never authority over correctness or security. Never multi-step reasoning.

## The gate every decision passes

- **L1 — does Jev answer right?** A case file of real examples with expected answers, run
  against the live decision path: hit rate, wrong-skill rate, spurious rate (spoke when nothing
  fits), missed rate, latency, cost. Pennies; minutes to see.
- **L2 — does the agent do better?** Only after L1 passes: headless off-vs-on runs on the metric
  that decision claims to move (wasted turns, wrong loads, context size, false "dones").
- Wins ship behind the decision's own flag; losses are killed and recorded. The model is
  Hermes's compaction scorecard (`~/.hermes/hermes-agent/evals/compaction/results/SCORECARD-2026-09-19-jev.md`):
  a reasoned "do not adopt" is a valid, valuable outcome.
- Every Jev call is logged by its adapter; the cross-harness report makes the portfolio visible.

## Laziness clause

One concrete eval per decision. No shared eval framework until a second decision exists and
shows the duplication. The only shared piece right now is the report, because three harnesses
already write logs.

## Portfolio

| Decision point | Where it would live | Status |
| --- | --- | --- |
| Skill choice (one skill per turn, or none) | OpenCode, Claude Code, Hermes | **shipped** — wave 1's L1 target |
| Tool choice (subset routing + hint) | OpenCode | shipped |
| Browser operation choice (click/type/target) | jev-ultrafast policy, via all three | shipped |
| Criteria/gate quality (advisory skills route) | OpenCode Phase 2 | specced |
| Checkpoint validation | OpenCode Phase 4 | specced |
| Tool-result aging (context pruning) | OpenCode Phase 5 | specced |
| Done/stuck checks | OpenCode Phase 6 | specced (wave 2) |
| Research triage (sources → keep/drop) | unassigned | unspecced |
| Subagent-report acceptance | unassigned | unspecced |
| Commit hygiene (message/scope checks) | unassigned | unspecced |

## Waves

- **W1 (this spec):** the instruments. L1 for skill choice; the cross-harness decision report.
  Measurement only — no behavior changes.
- **W2:** the verification gate (OpenCode Phase 6a) — L1, then L2 if it passes.
- **W3+:** context pruning (Phase 5), skill authority (Phase 2), research triage,
  subagent-report acceptance — each entering only with its own L1 case file.

## Confirmed facts (2026-09-23, recon)

- The OpenCode/agent roster on this machine is `~/.agents/skills` (22 skills with `SKILL.md`
  frontmatter), the exact set this session's `available_skills` lists.
- Hermes's real skills are **nested** (`~/.hermes/skills/<category>/<skill>/SKILL.md`, 76 files),
  while the shipped Hermes adapter scans exactly one level and therefore finds **2** skills
  (`find-skills`, `i-have-adhd`). Recorded as a wave-1 finding; not fixed in this wave.
- A real Hermes decision log exists at `~/.hermes/plugins/system-one/decisions.jsonl` (written
  after the plugin was enabled in the real home); the proof-home log lives under `/tmp`.
- No OpenCode usage log exists yet (`observe.enabled` is off), so the report must tolerate a
  missing input.

## L1 method (skill choice)

- **Case file:** JSONL, one case per line: `{id, request, expected: <skill id> | null,
  acceptable?: [ids]}`. Covered cases come from real skills' own `SKILL.md` content against the
  real roster; no invented skills. `acceptable` exists only for genuinely ambiguous requests and
  is documented with the case file.
- **Label:** a hit is `expected` matched exactly or via `acceptable`; `expected: null` +
  decision null is a hit; `expected: null` + any skill is **spurious**; `expected: <id>` +
  decision null is **missed**; anything else is **wrong-skill**.
- **Runner:** live Jev calls through the implementation under test; records per-case latency,
  model, tokens, and estimated cost ($0.042/Mtok input, output free). Hard cap per run,
  `--limit`, results written under `.superpowers/` (gitignored) — never committed raw.
- **Reference bar:** TypeSafe's skill-suggestion cookbook reports agent-alone 16.8% wrong /
  9.8% spurious; with suggestion 7.3% / 4.0%. L1 numbers are quoted against that bar for
  context, not as a pass/fail threshold.

## Non-goals

- No L2 runs, no threshold tuning, no plugin behavior changes, no new decisions in wave 1.
- No Hermes real-home writes; the adapter's nested-roster gap is reported, not fixed here.
- No shared eval framework; wave 1 has exactly one eval and one report script.

## Risks

| Risk | Mitigation |
| --- | --- |
| Case file drifts from real skill content | Cases are written from the skill files' own text; the runner validates every expected id against the live roster and fails loudly on unknown ids |
| Cost overrun | `--max-usd` (default 0.10) stops the run; per-call cost estimate logged; expected spend ≤ 0.02 |
| A misleading single run | Report records model, date, roster size, and case count; results are data, not claims, and the command is reproducible |
| Ambiguous cases skew the wrong-skill rate | `acceptable` lists are explicit and kept small, each documented |
