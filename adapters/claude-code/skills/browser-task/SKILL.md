---
name: browser-task
description: Use when a task needs a real browser — navigating, filling, clicking, or reading a live page. State the goal and its acceptance criteria for the browser_task tool, then verify the outcome.
---

# Browser tasks

`browser_task` runs one natural-language goal in a real browser. A Jev policy model — not
you — chooses every click, field value and target, so state the goal and how to tell it
succeeded instead of scripting selectors.

- Reach for it when the work needs a live page: filling a form, walking a site, reading a
  rendered page that a plain fetch cannot reach.
- Give it a goal with acceptance criteria, and a start URL when the page matters.
- The returned trace is a report, not proof. Verify the outcome (re-read the page, check the
  result) before reporting success.
- Never retry a browser mutation blindly. If the run is `blocked`, report what was observed
  and ask how to proceed.
- Keep `max_steps` small for simple goals; each step is one cheap Jev decision.
