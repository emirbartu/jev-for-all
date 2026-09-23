"""Run one Jev Ultrafast goal and print a single JSON result line.

Spawned by the system-one plugin's `browser_task` tool as

    uv run --directory <jev checkout> --env-file <checkout>/.env --quiet python jev-runner.py

so credentials stay in the checkout's .env and never appear on a command line. The goal,
start URL and action budget arrive as JEV_TASK_GOAL / JEV_TASK_URL / JEV_TASK_MAX_STEPS.

Everything is reported on one `JEV_RESULT ` line, including failures: the tool is expected
to fail open with a readable reason rather than throw. A DONE from the loop is not proof of
success, so the result carries the trace for the caller to verify.
"""

import json
import os
import sys
import time

SENTINEL = "JEV_RESULT "


def emit(payload):
    sys.stdout.write(SENTINEL + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def trace(history):
    return [
        {
            "step": item.get("step"),
            "operation": item.get("operation"),
            "action": item.get("action"),
            "url": item.get("url"),
            "text": item.get("text"),
        }
        for item in history
    ]


def cost(history):
    return round(sum((item.get("usage") or {}).get("cost") or 0 for item in history), 6)


def describe(agent, result):
    """Copy whatever the agent already observed into the result, without raising."""
    snapshot = agent.snapshot()
    page = snapshot["page"]
    result["status"] = snapshot["status"]
    result["url"] = page.get("url") or result["url"]
    result["title"] = page.get("title") or ""
    result["steps"] = trace(snapshot["history"])
    result["decisions"] = len(snapshot["decisions"])
    result["cost_usd"] = cost(snapshot["history"])


def main():
    started = time.perf_counter()
    goal = (os.environ.get("JEV_TASK_GOAL") or "").strip()
    url = (os.environ.get("JEV_TASK_URL") or "").strip() or "about:blank"
    try:
        budget = int(os.environ.get("JEV_TASK_MAX_STEPS") or "12")
    except ValueError:
        budget = 12
    result = {
        "ok": False,
        "status": "error",
        "url": url,
        "title": "",
        "steps": [],
        "decisions": 0,
        "cost_usd": 0.0,
        "elapsed_ms": 0,
        "error": None,
    }
    if not goal:
        result["error"] = "No goal supplied."
        emit(result)
        return

    try:
        from jev_ultrafast import Agent
    except Exception as error:
        result["error"] = f"Could not import jev_ultrafast: {type(error).__name__}: {error}"
        emit(result)
        return

    agent = None
    try:
        # Screenshots are display-only and unreliable on this setup; the policy never reads pixels.
        agent = Agent(url, goal, screenshots=False)
        for state in agent.run():
            if len(state["history"]) >= budget and state["status"] == "ready":
                result["error"] = f"Stopped at this task's {budget}-action budget."
                break
        describe(agent, result)
        result["ok"] = result["status"] == "done" and result["error"] is None
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"[:500]
        if agent is not None:
            try:
                describe(agent, result)
            except Exception:
                pass
    finally:
        if agent is not None:
            try:
                agent.close()
            except Exception:
                pass

    result["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
    emit(result)


if __name__ == "__main__":
    main()
