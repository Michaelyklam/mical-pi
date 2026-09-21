#!/usr/bin/env bash
# Summarize one or more pi session .jsonl files for an A/B self-compact comparison.
# Usage: scripts/ab-session-status.sh <session.jsonl> [...]
set -euo pipefail
for f in "$@"; do
  echo "=================================================================="
  echo "== $(basename "$f")"
  echo "mode: $(jq -c 'select(.type=="custom" and .customType=="self-compact-mode") | .data.mode' "$f" | tail -1 | tr -d '"' || true)"
  echo "last write: $(date -r "$f" '+%H:%M:%S')  lines: $(wc -l < "$f" | tr -d ' ')"
  echo "-- per-assistant-turn usage (input output cacheRead cacheWrite cost stop)"
  jq -r 'select(.type=="message" and .message.role=="assistant") | [.message.usage.input, .message.usage.output, .message.usage.cacheRead, .message.usage.cacheWrite, ((.message.usage.cost.total // 0)*1000|round/1000), .message.stopReason] | @tsv' "$f" \
    | awk '{print; i+=$1;o+=$2;r+=$3;w+=$4;c+=$5;n++} END{printf "-- turns=%d input=%d output=%d cacheRead=%d cacheWrite=%d cost=$%.3f\n", n,i,o,r,w,c}'
  echo "-- tool calls: $(jq -c 'select(.type=="message" and .message.role=="assistant") | .message.content[] | select(.type=="toolCall") | .name' "$f" | wc -l | tr -d ' ')  by name:"
  jq -r 'select(.type=="message" and .message.role=="assistant") | .message.content[] | select(.type=="toolCall") | .name' "$f" | sort | uniq -c | sort -rn | head -12 | sed 's/^/     /'
  echo "-- self-compact events:"
  jq -c 'select(.type=="custom" or .type=="custom_message" or .type=="compaction") | select((.customType // "" | startswith("self-compact")) or .type=="compaction") | {ts:.timestamp, type, customType, level:(.data.level // .details.level // null), toolCalls:(.data.toolCalls // .details.toolCalls // null), cycle:(.data.cycle // .details.cycle // null), text:((.content // .data.text // .summary // "")|tostring|.[0:120])}' "$f" | grep -v usage-footer || true
  echo "-- compaction tool calls:"
  jq -c 'select(.type=="message" and .message.role=="assistant") | .message.content[] | select(.type=="toolCall" and (.name|startswith("self_compact"))) | {name, noteChars:(.arguments.note_to_self|length)}' "$f" || true
  echo "-- user turns:"
  jq -r 'select(.type=="message" and .message.role=="user") | .message.content | if type=="string" then . else map(select(.type=="text")|.text)|join(" ") end | .[0:160]' "$f" | sed 's/^/     /'
  echo "-- last assistant text:"
  jq -r 'select(.type=="message" and .message.role=="assistant") | .message.content | map(select(.type=="text")|.text) | join(" ")' "$f" | grep -v '^$' | tail -1 | cut -c1-400 | sed 's/^/     /'
done
