# When Jev wins: field notes from a measured portfolio

We run Jev, TypeSafe's System One decision model, inside coding agents. This document is the
field record for the implementation in this repo. Every number below was measured on
2026-09-23/24 in this repo unless marked otherwise. We publish the losses next to the wins,
because the losses are the useful part.

## What Jev is, and what it is not

Jev is not an LLM. It generates no text, writes no code, and calls no tools. You give it state,
it returns typed answers with a calibrated confidence, in roughly 70 to 500 ms. TypeSafe's own
docs say it is not a drop-in coding-agent model. The pattern is to keep the LLM and let Jev make
the decisions.

| Primitive | Returns | Use when |
| --- | --- | --- |
| Choice | one option id, probabilities, confidence | the answer is one of a known set |
| Score | a score, probabilities, confidence | the answer is a position on a scale |
| Noul | a probability (0 to 1) that a statement is true | the answer is yes or no |

We reach it through OpenRouter's alpha Decisions API (`POST /api/alpha/decisions`), model alias
`~typesafe/jev-latest`. Pricing: $0.042 per million input tokens, output free.

## Method

A decision is eligible for Jev only if all three hold:

1. A knowledgeable person makes it in about a second given the state.
2. It can be expressed as a typed question (choice, score or noul) over state we already have.
3. It is cheap to be wrong. The answer is a hint, or code validates it, never authority over
   correctness.

Then the gates. First L1: does Jev answer right on a case file of real examples (hit, wrong,
spurious, missed, latency, cost)? Only after L1 passes, L2: does the agent actually do better
with it? Every winner ships behind its own flag and stays off until it wins. Every loser is
killed and recorded. See the [README](README.md) for what is built.

## Where Jev beats the traditional technique

Skill routing. 64 real requests against a 22-skill roster: hit 55 (85.9%), 0 wrong picks,
spurious 6 (9.4%), missed 3 (4.7%), about 0.6 s average, $0.0052 per full run. A project-scoped
advisory question opens the gate for design and planning work too. The reference bar from
TypeSafe's skill-suggestion cookbook: agent-alone 16.8% wrong and 9.8% spurious (7.3% and 4.0%
with a suggestion).

Verification gate. Splitting "was it checked" into `claim`, `ran` and `passed` moved the gate to
12/15 (80.0%) on its L1 corpus, and the red-run case is caught. Wired into Hermes' `pre_verify`, a
live nudge costs 673 ms and a hold 671 ms, about $0.00002 per call. It passed L1 but not L2, so it
ships off by default.

Browser loop. One live action goal through browser-use's `jev-ultrafast` policy: 2 steps, 3 Jev
decisions, $0.000199, 3.7 s.

TypeSafe's own cookbook results (their numbers, their corpora): support triage 34/34; log triage
where one severity score caught 4/7 critical events and 7/7 when split into specific yes or no
questions; moderation 0 harmful published and 0 clean blocked; dedupe 0 wrong automatic merges;
PII scanner 25/25.

The one published benchmark
([gemanor/jev-code-review-benchmark](https://github.com/gemanor/jev-code-review-benchmark), 360
calls per model): Jev 98% against 100% correctness, 45 times cheaper than Gemini Flash and 274
times cheaper than Claude Fable, median 0.75 s against 3.59 s and 4.31 s.

## Where Jev loses

The kill list. Each candidate was implemented or specced, measured, and killed when the numbers
did not hold.

- Compaction: Jev 75.5% at 115K retained tokens per turn against the built-in summary at 78.9%
  and 55K. It lost on recall and held 2.1 times the context. Killed.
- Rank-time "no skill fits": cut spurious picks from 6 to 4 but broke 7 genuine routes (47/13
  net). Killed.
- CI-failure triage: 48/50 CI runs red, the same "5 failed / 33 passed" every run, 0 reruns in
  100. No distribution to classify. Killed.
- Diff-risk ranking: 186 entries; Jev top-3 31% against a path heuristic at 33% and chance at 30%
  ($0.0115, 0 errors). Killed, because it lost to the dumb heuristic it had to beat.
- Threshold tuning alone: genuine misses score 0.12 to 0.28, spurious picks 0.39 to 0.88. No
  threshold separates them. Tuning does not create signal that is not in the state.

## What the rest of the ecosystem gets wrong

Most Jev implementations treat it as a personality, a smarter-feeling router, instead of a
measured decision. They define no kill condition and publish no baseline to beat.

- Model-routing crowd (jev-router and others, jcm-router, pi-jev-router, jev-codex-router, Jev
  Auto Router): none publishes a measured quality delta. jev-codex-router's "about -60% vs full
  Astra" is self-labeled a historical simulation under an old policy, "not measured Codex quota
  saved".
- Demo-ware (DiffJury, jev-review, jev-voice, jev-shell-history): good question design, no
  accuracy claim, no corpus, nothing falsifiable.
- The awesome-list long tail: the lists themselves warn that curation is not endorsement and flag
  same-day bulk submissions with more prose than code.

Ours is the opposite bet. A candidate must beat the dumb heuristic and the chance baseline on a
corpus we already own, L1 before L2, off by default until it wins.

## Jev's own weak spots

Jev does not get a pass from us.

- Confidence is calibrated across groups, not per answer. Average confidence measured 0.59 while
  at chance on diff-risk ranking. A 0.91-scored rule can still be a false positive; limpet tunes
  for recall for this reason.
- Assertion reads as evidence. A bare "All tests pass." scores claim 0.72, ran 0.92 and passed
  0.84. That is the verify gate's known miss, and one reason it is still off.
- Choice degrades with option count. Over 31 to 60 options it falls to chance: 5% top-3.
- TypeSafe publishes its own known-weak-spots doc:
  <https://docs.typesafe.ai/model-jaggedness/jev-1.13>.

## How to tell if your idea deserves Jev

Five questions. Any "no" is a stop.

1. Is it a snap judgment a knowledgeable person makes in about a second?
2. Is the state already in hand, expressible as a typed question?
3. Is it cheap to be wrong (a hint, or code-validated), never authority over correctness?
4. Do we own a corpus of real examples to score it on?
5. Does it beat both the dumb heuristic and the chance baseline?

If it cannot clear those, it belongs on the kill list, not in production.

## Links

- This repo: [README](README.md), <https://github.com/emirbartu/jev-for-all>
- TypeSafe cookbooks: <https://docs.typesafe.ai/cookbooks>
- Benchmark: <https://github.com/gemanor/jev-code-review-benchmark>
- TypeSafe docs: [primitives](https://docs.typesafe.ai/primitives),
  [patterns catalog](https://docs.typesafe.ai/patterns),
  [coding agents](https://docs.typesafe.ai/introduction/coding-agents),
  [Jev 1.13 weak spots](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- browser-use/jev-ultrafast: <https://github.com/browser-use/jev-ultrafast>
