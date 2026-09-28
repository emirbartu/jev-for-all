# system-one for pi (senpi)

Jev (TypeSafe System One) decides; this extension only enforces. It is the pi/senpi
member of the same decision family as the OpenCode plugin and the Claude Code adapter:
one contract (`spec/decisions.json`), one set of thresholds, one fail-open rule.

It adds five things to a pi session:

| Feature | pi hook | What Jev decides |
| --- | --- | --- |
| Skill routing | `input` → `before_agent_start` | at most one skill to load, or none |
| Tool routing | `context` | the tool subset to keep active, plus a routing hint |
| Verification gate | `context` | whether a completion claim lacks evidence |
| Usage observation | `message_end`, `session_shutdown` | nothing; it records token usage |
| Spend guard | every Jev call site | nothing; it caps calls per session |

No decision logic is reimplemented here. Skill routing is
`adapters/claude-code/lib/decide.ts` + `src/skills.ts`, tool routing is `src/tools.ts`,
the gate is `src/verify.ts`, the cache is `index.ts`, and every threshold comes from
`src/policy.ts` reading `spec/decisions.json` (synced copy in `assets/`).

## Install

The extension is TypeScript loaded by jiti — no build step. Drop the repository
somewhere stable and point pi at the file:

```bash
mkdir -p ~/.omo/extensions
ln -s /abs/path/to/jev-for-all/adapters/pi-senpi/index.ts ~/.omo/extensions/system-one-pi.ts
```

Discovery also accepts `<cwd>/.omo/extensions/*.ts`. The adapter imports `../../src/*`,
`../../index` and `../claude-code/lib/*`, so keep the whole repository in place.

## Configure

Credentials come from the environment: `OPENROUTER_API_KEY`. Everything else lives in
the `systemOne` block of `<agentDir>/settings.json` (agentDir is `~/.omo/agent` by
default). A missing or unparsable settings file is inert, never fatal.

```json
{
  "systemOne": {
    "apiKey": "sk-or-...",
    "model": "~typesafe/jev-latest",
    "timeoutMs": 1000,
    "debug": false,
    "skills": { "enabled": true },
    "tools": { "enabled": true, "maxTools": 12, "stateBudget": 6000 },
    "control": { "verify": true },
    "observe": { "enabled": true, "file": "~/.omo/agent/system-one/usage.jsonl" },
    "spend": { "maxCallsPerSession": 500, "warnAt": 0.8 },
    "skillDirs": ["~/.omo/agent/skills", "~/.agents/skills"],
    "decisionsFile": "~/.omo/agent/system-one/decisions.jsonl"
  }
}
```

With no key in settings and none in the environment, the extension registers its hooks
but makes no call: every hook returns unchanged and the session behaves exactly as if
the extension were absent.

Thresholds not listed above (gate, rerank, confidence, needs-tool) are the contract's;
do not fork them here. `SYSTEM_ONE_SERVER_URL`, `SYSTEM_ONE_SKILL_DIRS`,
`SYSTEM_ONE_DECISIONS_FILE` and `SYSTEM_ONE_DEBUG` exist for tests and proxies.

Skills are discovered by scanning `<agentDir>/skills`, `~/.agents/skills` and
`<cwd>/.agents/skills`; a directory holding `SKILL.md` is a skill and is not recursed
into. pi has no skills API, so the roster comes from the filesystem, exactly as in the
Claude Code adapter.

## Contract

- **Fail open.** No key, timeout, non-2xx, malformed answer, low confidence, unknown id
  or an exhausted spend cap leaves the request untouched. No hook throws; failures warn
  at most once per session.
- **One skill call per user message.** Skill decisions are cached by input id, so a
  repeated or replayed input costs nothing.
- **Spend cap.** `spend.maxCallsPerSession` bounds every Jev call in a session;
  `spend.warnAt` (a fraction) logs a warning line at that share of the cap.
- **Observable.** Each decision appends one JSON object to `decisionsFile` with
  `"harness":"pi"`, the hook name, the chosen id or tool, the model when Jev reports one,
  and the session's call count. Usage samples go to the recorder's JSONL.

## Data egress

The `input` hook sends the user's prompt text plus every skill's name, description and a
700-character slice of its body. The `context` hook sends the conversation tail
rendered up to `tools.stateBudget` characters — including tool-result bodies such as
file contents and shell output — plus every active tool name and the first 300
characters of its description. The verification gate sends the same tail at a 2000
character budget. Everything goes to OpenRouter's decisions endpoint
(`POST /api/alpha/decisions`). Excluding tool-result bodies is not supported.

## Tests

```bash
bun test adapters/pi-senpi
```

The suite is offline: a `Bun.serve` mock on port 0 stands in for the Jev API and every
case asserts the request path, the authorization header and the request body. It covers
skill routing and its cache, tool narrowing and hint replacement, the verification gate,
fail-open without a key, fail-open on a 500 with a single warning, the spend cap, the
JSONL decision log with `"harness":"pi"`, and the exported helpers.

## Notes for maintainers

- `assets/decisions.json` and `assets/conformance.jsonl` are synced copies of the
  canonical contract; `scripts/sync-adapter-assets.ts` keeps every adapter's copy in step.
- pi's assistant message shape differs from OpenCode's, so `piUsageSample` maps pi's
  message onto the shared `UsageSample` that `src/observe.ts` already writes and
  summarizes. The recorder itself is reused unchanged.
- The routing hint is injected by replacing this extension's own trailing hint message,
  so repeated `context` events never accumulate hints. No hint means no message is
  added at all, which is the fail-open path.
