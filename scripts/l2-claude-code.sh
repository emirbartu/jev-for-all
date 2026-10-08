#!/bin/bash
# L2 pilot: same prompts through headless Claude Code with and without the jev adapter. n=1 per cell, so noisy.
# Prints cost, total input tokens (cache included), output tokens, wall ms, turns. Uses real quota (~$0.07/run).
# usage: run.sh arm prompt
arm=$1; p=$2
cd ${PROJ:?set PROJ to a scratch project dir}
if [ $arm = base ]; then extra=(--settings '{"enabledPlugins":{"system-one@jev-local":false}}'); else extra=(--settings '{"enabledPlugins":{"system-one@jev-local":false}}' --plugin-dir /home/gerius/Desktop/jev-for-all/adapters/claude-code); fi
SYSTEM_ONE_SKILL_DIRS=$HOME/.agents/skills:$HOME/.claude/skills SYSTEM_ONE_STATE_DIR=${TMPDIR:-/tmp}/s1-state \
timeout 170 claude -p "$p" --output-format json --model sonnet --max-budget-usd 0.5 --permission-mode bypassPermissions "${extra[@]}" </dev/null 2>/dev/null | python3 -c "
import json,sys
raw=sys.stdin.read().strip().splitlines()[-1]
try:
  d=json.loads(raw); u=d['usage']
  print('$arm', round(d['total_cost_usd'],4),'in',u['input_tokens']+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0),'out',u['output_tokens'],'ms',d['duration_ms'],'turns',d['num_turns'])
except Exception as e: print('ERR',raw[:300])
"
