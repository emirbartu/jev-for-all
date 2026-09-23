"""Jev skill decision for Hermes: contract load, roster scan, decision, injection, transport.

Stdlib only. Mirrors src/skills.ts against the shared contract; the shared
conformance fixtures are the parity check.
"""
from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

ASSETS = Path(__file__).resolve().parent / "assets"
POLICY = json.loads((ASSETS / "decisions.json").read_text())

NONE_CONTEXT = "Skills are routed externally for this turn; do not call the skill tool unless the user names one."

Ask = Callable[[Any, dict], dict]


def format_template(template: str, values: dict[str, str]) -> str:
    return re.sub(r"\{\{(\w+)\}\}", lambda match: values.get(match.group(1), match.group(0)), template)


def as_choice(value: Any) -> dict | None:
    if not isinstance(value, dict) or value.get("type") != "choice" or not isinstance(value.get("choice"), str):
        return None
    raw = value.get("probabilities")
    probabilities = {
        key: probability
        for key, probability in (raw if isinstance(raw, dict) else {}).items()
        if isinstance(probability, (int, float))
    }
    confidence = value.get("confidence")
    return {
        "choice": value["choice"],
        "probabilities": probabilities,
        "confidence": confidence if isinstance(confidence, (int, float)) else None,
    }


def as_noul(value: Any) -> float | None:
    if not isinstance(value, dict) or value.get("type") != "noul":
        return None
    noul = value.get("noul")
    return float(noul) if isinstance(noul, (int, float)) else None


def _parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {"body": text}
    end = text.find("\n---", 3)
    if end == -1:
        return {"body": text}
    head = text[3:end]
    body = text[end + 4 :].lstrip("\r\n")
    fields = {}
    for line in head.splitlines():
        match = re.match(r"^([\w-]+):\s*(.*)$", line)
        if match:
            fields[match.group(1)] = match.group(2).strip().strip("\"'")
    return {"name": fields.get("name"), "description": fields.get("description"), "body": body}


def _read_skill(path: Path, leaf: str) -> dict | None:
    try:
        parsed = _parse_frontmatter(path.read_text())
    except OSError:
        return None
    return {
        "id": leaf,
        "name": parsed.get("name") or leaf,
        "description": parsed.get("description"),
        "content": parsed["body"],
        "path": str(path),
    }


def scan_skills(dirs: Sequence[str]) -> list[dict]:
    """Scan one or two levels: <dir>/<skill>/SKILL.md and <dir>/<category>/<skill>/SKILL.md.

    Hidden entries are skipped, ids are leaf directory names, and a duplicate id
    keeps the first (top-level) occurrence. A directory with no SKILL.md at
    either level contributes nothing.
    """
    skills = []
    seen = set()

    def add(path: Path, leaf: str) -> None:
        if leaf in seen:
            return
        skill = _read_skill(path, leaf)
        if skill is not None:
            seen.add(leaf)
            skills.append(skill)

    for directory in dirs:
        try:
            entries = sorted(
                entry for entry in Path(directory).iterdir() if entry.is_dir() and not entry.name.startswith(".")
            )
        except OSError:
            continue
        for entry in entries:
            add(entry / "SKILL.md", entry.name)
        for entry in entries:
            try:
                children = sorted(
                    child for child in entry.iterdir() if child.is_dir() and not child.name.startswith(".")
                )
            except OSError:
                continue
            for child in children:
                add(child / "SKILL.md", child.name)
    return skills


def _label(skill: dict) -> str:
    criteria = POLICY["skills"]["criteria"]
    if skill.get("description"):
        return format_template(criteria["withDescription"], {"name": skill["name"], "description": skill["description"]})
    return format_template(criteria["withoutDescription"], {"name": skill["name"]})


def select_skill(ask: Ask, request: str, skills: Iterable[dict]) -> str | None:
    config = POLICY["skills"]
    ids = config["ids"]
    questions = config["questions"]
    roster = [skill for skill in skills if skill.get("id")]
    if not roster or not request.strip():
        return None

    state = {"request": request}
    try:
        criteria = {skill["id"]: _label(skill) for skill in roster}
        first = ask(
            state,
            {
                ids["rank"]: {"type": "choice", "instructions": questions["rank"], "criteria": criteria},
                ids["gateActs"]: {"type": "noul", "instructions": questions["gateActs"]},
                ids["gateProcedure"]: {"type": "noul", "instructions": questions["gateProcedure"]},
                ids["gateProse"]: {"type": "noul", "instructions": questions["gateProse"]},
            },
        )
        acts = as_noul(first.get(ids["gateActs"]))
        procedure = as_noul(first.get(ids["gateProcedure"]))
        prose = as_noul(first.get(ids["gateProse"]))
        if acts is None or procedure is None or prose is None:
            return None
        gate = (acts + procedure + (1 - prose)) / 3
        if gate < config["gateThreshold"]:
            return None

        choice = as_choice(first.get(ids["rank"]))
        if choice is None or not any(skill["id"] == choice["choice"] for skill in roster):
            return None
        confidence = choice["confidence"] if choice["confidence"] is not None else 1
        if confidence < config["minConfidence"]:
            return None

        winner = choice["choice"]
        probabilities = choice["probabilities"]
        top = max(probabilities.values()) if probabilities else 0
        want_rerank = config["rerank"] is True or (
            config["rerank"] == "auto" and (len(roster) > config["rerankAbove"] or top < config["rerankBelowP"])
        )
        if want_rerank:
            by_id = {skill["id"]: skill for skill in roster}
            shortlist = sorted(
                (name for name in probabilities if name in by_id),
                key=lambda name: probabilities.get(name, 0),
                reverse=True,
            )[: max(1, config["shortlist"])]
            if len(shortlist) > 1:
                rerank_criteria = {}
                for name in shortlist:
                    skill = by_id[name]
                    rerank_criteria[name] = _label(skill) + format_template(
                        config["criteria"]["withContent"],
                        {"content": skill["content"][: config["criteria"]["contentChars"]]},
                    )
                rerank_questions = {
                    ids["rerank"]: {"type": "choice", "instructions": questions["rerank"], "criteria": rerank_criteria}
                }
                for name in shortlist:
                    skill = by_id[name]
                    rerank_questions[format_template(ids["fits"], {"id": name})] = {
                        "type": "noul",
                        "instructions": format_template(questions["fits"], {"name": skill["name"]}),
                    }
                second = ask(state, rerank_questions)
                fits = [as_noul(second.get(format_template(ids["fits"], {"id": name}))) or 0 for name in shortlist]
                if max(fits) < config["fitsThreshold"]:
                    return None
                reranked = as_choice(second.get(ids["rerank"]))
                if reranked and reranked["choice"] in shortlist:
                    rerank_confidence = reranked["confidence"] if reranked["confidence"] is not None else 1
                    if rerank_confidence >= config["minConfidence"]:
                        winner = reranked["choice"]
        return winner
    except Exception:
        return None


def decide(ask: Ask | None, request: str, skills: Iterable[dict]) -> tuple[str, str | None]:
    roster = [skill for skill in skills if skill.get("id")]
    if ask is None or not roster or not request.strip():
        return ("no-change", None)
    ids = POLICY["skills"]["ids"]
    state = {"seen": False, "confident_none": False}

    def tracked(st, questions):
        answers = ask(st, questions)
        if not state["seen"]:
            state["seen"] = True
            choice = as_choice(answers.get(ids["rank"]))
            gate_ok = all(
                as_noul(answers.get(ids[key])) is not None for key in ("gateActs", "gateProcedure", "gateProse")
            )
            confidence = choice["confidence"] if choice and choice["confidence"] is not None else 1
            state["confident_none"] = bool(choice) and gate_ok and confidence >= POLICY["skills"]["minConfidence"]
        return answers

    try:
        winner = select_skill(tracked, request, roster)
    except Exception:
        return ("no-change", None)
    if winner:
        return ("skill", winner)
    return ("none", None) if state["confident_none"] else ("no-change", None)


def injection_for(skill: dict) -> str:
    header = f"<skill_relevance>\nRouted skill: {skill['name']} ({skill['id']}).\n</skill_relevance>"
    cap = POLICY["skills"]["injection"]["chars"]
    if len(skill["content"]) <= cap:
        return f"{header}\n\n{skill['content']}"
    summary = skill.get("description") or skill["name"]
    return f"{header} {summary} Read the full skill at {skill['path']}."


def ask_openrouter(
    state: Any,
    questions: dict,
    *,
    api_key: str,
    model: str,
    timeout_s: float,
    on_meta: Callable[[dict], None] | None = None,
) -> dict:
    request = urllib.request.Request(
        "https://openrouter.ai/api/alpha/decisions",
        data=json.dumps({"model": model, "state": state, "questions": questions}).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        body = json.loads(response.read().decode())
    answers = body.get("answers")
    if not isinstance(answers, dict):
        raise RuntimeError("system-one response missing answers")
    if on_meta is not None:
        usage = body.get("usage") or {}
        on_meta(
            {
                "model": body.get("model"),
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
            }
        )
    return answers


def log_decision(path: str | Path, record: dict) -> None:
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a") as handle:
            handle.write(json.dumps({"kind": "decision", **record}) + "\n")
    except OSError:
        pass
