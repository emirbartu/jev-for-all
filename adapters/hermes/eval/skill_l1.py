"""L1 eval for the Hermes adapter's skill decision: real cases against the live Jev path.

Runs the adapter's real decide() over the real roster; only this CLI touches the
network. Stdlib only. Raw per-case results land as JSONL under .superpowers/.

  python3 adapters/hermes/eval/skill_l1.py --max-usd 0.10
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from system_one import decision  # noqa: E402

INPUT_USD_PER_MTOK = 0.042
CLASSIFICATIONS = ("hit", "wrong-skill", "spurious", "missed", "skipped")


def cost_of(input_tokens: int) -> float:
    return (input_tokens / 1_000_000) * INPUT_USD_PER_MTOK


def expand_home(path: str) -> str:
    if path == "~":
        return os.path.expanduser("~")
    if path.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), path[2:])
    return path


def load_cases(path: str, *, only_null: bool = False) -> list[dict]:
    cases = []
    for index, raw in enumerate(Path(path).read_text().splitlines()):
        if not raw.strip():
            continue
        try:
            candidate = json.loads(raw)
        except json.JSONDecodeError as error:
            raise SystemExit(f"case line {index + 1}: invalid JSON ({error})") from error
        if not isinstance(candidate.get("id"), str) or not isinstance(candidate.get("request"), str):
            raise SystemExit(f"case line {index + 1}: expected {{id, request, expected: id | null, acceptable?}}")
        expected = candidate.get("expected")
        acceptable = candidate.get("acceptable") or []
        if expected is not None and not isinstance(expected, str):
            raise SystemExit(f"case line {index + 1}: expected must be an id or null")
        if not isinstance(acceptable, list) or not all(isinstance(item, str) for item in acceptable):
            raise SystemExit(f"case line {index + 1}: acceptable must be a list of ids")
        if only_null and expected is not None:
            continue
        cases.append(
            {"id": candidate["id"], "request": candidate["request"], "expected": expected, "acceptable": acceptable}
        )
    return cases


def validate_cases(cases: list[dict], roster_ids: list[str]) -> None:
    known = set(roster_ids)
    unknown = [
        f"{case['id']} -> {skill_id}"
        for case in cases
        for skill_id in [case["expected"], *case["acceptable"]]
        if skill_id is not None and skill_id not in known
    ]
    if unknown:
        raise SystemExit("cases reference skills outside the roster:\n  " + "\n  ".join(unknown))


def classify(expected: str | None, acceptable: list[str], chosen: str | None) -> str:
    if chosen is None:
        return "hit" if expected is None else "missed"
    if expected is None:
        return "spurious"
    return "hit" if chosen in [expected, *acceptable] else "wrong-skill"


def summarize(results: list[dict]) -> dict:
    scored = [result for result in results if result["classification"] != "skipped"]
    count = lambda kind: sum(1 for result in scored if result["classification"] == kind)  # noqa: E731
    denominator = len(scored) or 1
    latencies = [result["latencyMs"] for result in scored]
    return {
        "total": len(results),
        "scored": len(scored),
        "skipped": len(results) - len(scored),
        "hits": count("hit"),
        "wrongSkill": count("wrong-skill"),
        "spurious": count("spurious"),
        "missed": count("missed"),
        "hitRate": count("hit") / denominator,
        "wrongSkillRate": count("wrong-skill") / denominator,
        "spuriousRate": count("spurious") / denominator,
        "missedRate": count("missed") / denominator,
        "avgLatencyMs": round(sum(latencies) / len(latencies)) if latencies else 0,
        "maxLatencyMs": max(latencies) if latencies else 0,
        "inputTokens": sum(result["inputTokens"] for result in scored),
        "outputTokens": sum(result["outputTokens"] for result in scored),
        "costUsd": sum(result["costUsd"] for result in scored),
    }


def format_summary(summary: dict, meta: dict) -> str:
    pct = lambda value: f"{value * 100:.1f}%"  # noqa: E731
    return "\n".join(
        [
            f"cases: {summary['total']} scored {summary['scored']} skipped {summary['skipped']} | roster {meta['rosterSize']} | model {meta['model']}",
            f"hit {summary['hits']} ({pct(summary['hitRate'])}) | wrong-skill {summary['wrongSkill']} ({pct(summary['wrongSkillRate'])}) | spurious {summary['spurious']} ({pct(summary['spuriousRate'])}) | missed {summary['missed']} ({pct(summary['missedRate'])})",
            f"latency avg {summary['avgLatencyMs']} ms / max {summary['maxLatencyMs']} ms | tokens in {summary['inputTokens']} out {summary['outputTokens']} | est cost ${summary['costUsd']:.4f}",
            "reference bar (TypeSafe cookbook): agent-alone 16.8% wrong / 9.8% spurious; with suggestion 7.3% / 4.0%",
        ]
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--roster", default="~/.hermes/skills")
    parser.add_argument("--cases", default="fixtures/skill-eval/hermes-cases.jsonl")
    parser.add_argument(
        "--null-cases",
        default="fixtures/skill-eval/agents-skills-cases.jsonl",
        help="extra corpus; only its expected:null cases are used",
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument("--max-usd", type=float, default=0.10)
    parser.add_argument("--timeout-ms", type=int, default=10000, help="per-request timeout; the plugin default is 1000")
    parser.add_argument("--model", default="~typesafe/jev-latest")
    stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime())
    parser.add_argument("--out", default=f".superpowers/hermes-l1/{stamp}.jsonl")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise SystemExit("OPENROUTER_API_KEY is required for a live run")
    roster = decision.scan_skills([expand_home(args.roster)])
    if not roster:
        raise SystemExit(f"no skills found under {args.roster}")
    cases = load_cases(args.cases) + load_cases(args.null_cases, only_null=True)
    validate_cases(cases, [skill["id"] for skill in roster])
    selected = cases if args.limit is None else cases[: args.limit]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []
    spent = 0.0
    for case in selected:
        if spent >= args.max_usd:
            results.append({**case, "decision": None, "kind": "skipped", "classification": "skipped",
                            "latencyMs": 0, "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0, "errors": 0})
            continue
        meta: dict = {"input_tokens": 0, "output_tokens": 0, "errors": 0}

        def ask(state, questions, _meta=meta):
            def on_meta(info):
                _meta["model"] = info.get("model")
                _meta["input_tokens"] += info.get("input_tokens") or 0
                _meta["output_tokens"] += info.get("output_tokens") or 0

            try:
                return decision.ask_openrouter(
                    state,
                    questions,
                    api_key=api_key,
                    model=args.model,
                    timeout_s=args.timeout_ms / 1000,
                    on_meta=on_meta,
                )
            except Exception:
                _meta["errors"] += 1
                raise

        started = time.perf_counter()
        kind, skill_id = decision.decide(ask, case["request"], roster)
        latency_ms = round((time.perf_counter() - started) * 1000)
        chosen = skill_id if kind == "skill" else None
        cost_usd = cost_of(meta["input_tokens"])
        spent += cost_usd
        result = {
            **case,
            "decision": chosen,
            "kind": kind,
            "classification": classify(case["expected"], case["acceptable"], chosen),
            "latencyMs": latency_ms,
            "model": meta.get("model"),
            "inputTokens": meta["input_tokens"],
            "outputTokens": meta["output_tokens"],
            "costUsd": cost_usd,
            "errors": meta["errors"],
        }
        results.append(result)
        with out.open("a") as handle:
            handle.write(json.dumps(result) + "\n")
        mark = "PASS" if result["classification"] == "hit" else "FAIL"
        print(f"{mark} {case['id']} -> {chosen or '(none)'} expected {case['expected'] or '(none)'}")
    print(format_summary(summarize(results), {"rosterSize": len(roster), "model": args.model}))
    print(f"raw results: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
