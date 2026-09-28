"""Hermes plugin: Jev-routed skill selection via pre_llm_call context injection."""
from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path

from . import decision

logger = logging.getLogger(__name__)

NONE_CONTEXT = decision.NONE_CONTEXT
DEFAULT_SKILL_DIRS = [str(Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "skills")]


def _plugin_data_dir() -> Path:
    return Path(__file__).resolve().parent


def _setting(ctx, key: str, default=None):
    """Read one plugin setting; any failure falls back to the default (fail open)."""
    try:
        return ctx.get_config(key, default=default)
    except Exception:
        return default


def _session_budget(ctx, *, session_id: str, hook: str, log_path: Path) -> int | None:
    """Prior decision count for this session, or None when the spend cap is reached (logged)."""
    cap = _setting(ctx, "max_calls_per_session") or decision.POLICY["spend"]["maxCallsPerSession"]
    calls = 0
    try:
        for line in log_path.read_text().splitlines():
            if '"kind": "decision"' in line and f'"sessionID": "{session_id}"' in line:
                calls += 1
    except OSError:
        calls = 0
    if calls >= cap:
        decision.log_decision(
            log_path,
            {"harness": "hermes", "sessionID": session_id, "hook": hook, "chosen": "no-change", "event": "cap", "calls": calls, "time": time.time()},
        )
        return None
    if calls + 1 == int(cap * decision.POLICY["spend"]["warnAt"]):
        decision.log_decision(
            log_path,
            {"harness": "hermes", "sessionID": session_id, "hook": hook, "chosen": "no-change", "event": "warn", "calls": calls + 1, "time": time.time()},
        )
    return calls


def _observe_enabled(ctx) -> bool:
    """Usage observation is opt-in: the setting decides, the contract owns the default."""
    enabled = _setting(ctx, "observe")
    if enabled is None:
        enabled = decision.POLICY.get("observe", {}).get("enabled", False)
    return bool(enabled)


def _message_id(user_message: str) -> str:
    """Fallback id when the host sends no turn_id, so every usage row has a messageID."""
    return "msg-" + hashlib.sha1((user_message or "").encode("utf-8", "replace")).hexdigest()[:12]


def _handle_turn(ctx, *, session_id: str, user_message: str, model: str = "", platform: str = "", **kwargs) -> dict | None:
    try:
        log_path = _plugin_data_dir() / "decisions.jsonl"
        if _observe_enabled(ctx):
            decision.log_usage(
                log_path,
                decision.usage_from_message(
                    session_id=session_id,
                    message_id=kwargs.get("turn_id") or _message_id(user_message),
                    agent=platform,
                    model=model,
                    time_s=time.time(),
                ),
            )

        jev_model = _setting(ctx, "model") or "~typesafe/jev-latest"
        timeout_ms = _setting(ctx, "timeout_ms") or 2000
        skill_dirs = _setting(ctx, "skill_dirs") or DEFAULT_SKILL_DIRS
        if isinstance(skill_dirs, str):
            skill_dirs = [skill_dirs]

        skills = decision.scan_skills(skill_dirs)
        if not skills:
            return None

        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            return None

        calls = _session_budget(ctx, session_id=session_id, hook="pre_llm_call", log_path=log_path)
        if calls is None:
            return None

        meta: dict = {}
        started = time.time()

        def ask(state, questions):
            return decision.ask_openrouter(
                state,
                questions,
                api_key=api_key,
                model=jev_model,
                timeout_s=timeout_ms / 1000,
                on_meta=meta.update,
            )

        kind, skill_id = decision.decide(ask, user_message, skills)
        decision.log_decision(
            log_path,
            {
                "harness": "hermes",
                "sessionID": session_id,
                "hook": "pre_llm_call",
                "chosen": skill_id if kind == "skill" else kind,
                "model": meta.get("model"),
                "inputTokens": meta.get("input_tokens"),
                "outputTokens": meta.get("output_tokens"),
                "latencyMs": int((time.time() - started) * 1000),
                "calls": calls + 1,
                "time": time.time(),
            },
        )

        if kind == "skill":
            skill = next((entry for entry in skills if entry["id"] == skill_id), None)
            return {"context": decision.injection_for(skill)} if skill else None
        if kind == "none":
            return {"context": NONE_CONTEXT}
        return None
    except Exception:
        logger.debug("system-one hook failed", exc_info=True)
        return None


def _handle_verify(ctx, *, session_id: str, attempt: int, final_response: str, changed_paths=None) -> dict | None:
    """pre_verify: one nudge per turn when a completion claim lacks a passing check."""
    try:
        enabled = _setting(ctx, "verify")
        if enabled is None:
            enabled = decision.POLICY["control"].get("verify", False)
        if not enabled:
            return None
        # pre_verify fires on every stop attempt; attempt 0 is the first, so this yields one
        # nudge per turn (agent.max_verify_nudges remains the outer bound, usually 3).
        if attempt != 0:
            return None
        model = _setting(ctx, "model") or "~typesafe/jev-latest"
        timeout_ms = _setting(ctx, "timeout_ms") or 2000
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            return None

        log_path = _plugin_data_dir() / "decisions.jsonl"
        calls = _session_budget(ctx, session_id=session_id, hook="pre_verify", log_path=log_path)
        if calls is None:
            return None

        meta: dict = {}
        started = time.time()

        def ask(state, questions):
            return decision.ask_openrouter(
                state,
                questions,
                api_key=api_key,
                model=model,
                timeout_s=timeout_ms / 1000,
                on_meta=meta.update,
            )

        hint = decision.decide_verification(ask, response=final_response or "", changed_paths=changed_paths or [])
        decision.log_decision(
            log_path,
            {
                "harness": "hermes",
                "sessionID": session_id,
                "hook": "pre_verify",
                "chosen": "nudge" if hint else "hold",
                "model": meta.get("model"),
                "inputTokens": meta.get("input_tokens"),
                "outputTokens": meta.get("output_tokens"),
                "latencyMs": int((time.time() - started) * 1000),
                "calls": calls + 1,
                "time": time.time(),
            },
        )
        return {"action": "continue", "message": hint} if hint else None
    except Exception:
        logger.debug("system-one verify hook failed", exc_info=True)
        return None


def register(ctx):
    """Wire skill routing into pre_llm_call and the verification gate into pre_verify."""
    ctx.register_hook(
        "pre_llm_call",
        lambda session_id, user_message, conversation_history, is_first_turn, model, platform, **kwargs: _handle_turn(
            ctx, session_id=session_id, user_message=user_message, model=model, platform=platform, **kwargs
        ),
    )
    ctx.register_hook(
        "pre_verify",
        lambda session_id, platform, model, coding, attempt, final_response, changed_paths, **kwargs: _handle_verify(
            ctx, session_id=session_id, attempt=attempt, final_response=final_response, changed_paths=changed_paths
        ),
    )
