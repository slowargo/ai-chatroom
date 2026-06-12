#!/usr/bin/env bash
# E2E spike: exercises the full agent loop against a real server instance.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=18787
SERVER="http://localhost:$PORT"
TMP=$(mktemp -d)
STATE="$TMP/agent-state.json"
CLI="node packages/agent-client/src/cli.js"
DB="$TMP/chatroom.db"

cleanup() { kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

start_server() {
  CHATROOM_PORT=$PORT CHATROOM_DB="$DB" CHATROOM_POLL_WINDOW_MS=3000 \
    packages/server/node_modules/.bin/tsx packages/server/src/index.ts >"$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -sf "$SERVER/api/rooms" >/dev/null 2>&1 && return; sleep 0.1; done
  echo "FAIL: server did not start"; cat "$TMP/server.log"; exit 1
}

step() { echo; echo "== $1"; }

start_server

step "create room + persona, join human"
ROOM=$(curl -sf -X POST "$SERVER/api/rooms" -H content-type:application/json -d '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
PERSONA=$(curl -sf -X POST "$SERVER/api/personas" -H content-type:application/json \
  -d '{"name":"reviewer","system_prompt":"You are a strict code reviewer."}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
HUMAN=$(curl -sf -X POST "$SERVER/api/rooms/$ROOM/join" -H content-type:application/json \
  -d '{"nickname":"linyue","type":"human"}')
HUMAN_TOKEN=$(echo "$HUMAN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
echo "room=$ROOM persona=$PERSONA"

step "agent joins via CLI"
$CLI join --server "$SERVER" --room "$ROOM" --persona "$PERSONA" --nickname reviewer-bot --state "$STATE"

step "agent blocks on wait; human mentions it"
$CLI wait --state "$STATE" >"$TMP/wait1.out" &
WAIT_PID=$!
sleep 0.5
curl -sf -X POST "$SERVER/api/rooms/$ROOM/messages" -H content-type:application/json \
  -H "authorization: Bearer $HUMAN_TOKEN" -d '{"text":"@reviewer-bot please review the cursor design"}' >/dev/null
wait $WAIT_PID
grep -q "MENTIONS YOU" "$TMP/wait1.out" || { echo "FAIL: wait did not flag the mention"; cat "$TMP/wait1.out"; exit 1; }
cat "$TMP/wait1.out"

step "agent replies with --reply-to, then crashes BEFORE acking (worst case for duplicates)"
MSG_ID=$(grep -- '<-- MENTIONS YOU' "$TMP/wait1.out" | sed -E 's/.*\[([0-9A-Z]{26})\].*/\1/')
$CLI post --state "$STATE" --text "Looks solid. The cursor-as-source-of-truth design is correct." --reply-to "$MSG_ID"

step "agent goes offline; messages pile up; server restarts"
curl -sf -X POST "$SERVER/api/rooms/$ROOM/messages" -H content-type:application/json \
  -H "authorization: Bearer $HUMAN_TOKEN" -d '{"text":"some context while agent is away"}' >/dev/null
kill "$SERVER_PID"; sleep 0.3
start_server
curl -sf -X POST "$SERVER/api/rooms/$ROOM/messages" -H content-type:application/json \
  -H "authorization: Bearer $HUMAN_TOKEN" -d '{"text":"@reviewer-bot still around after the restart?"}' >/dev/null

step "agent rejoins (token reclaim) and catches up instantly"
$CLI join --server "$SERVER" --room "$ROOM" --state "$STATE" | head -2
$CLI wait --state "$STATE" >"$TMP/wait2.out"
cat "$TMP/wait2.out"
grep -q "some context while agent is away" "$TMP/wait2.out" || { echo "FAIL: missed offline message"; exit 1; }
grep -q "still around after the restart" "$TMP/wait2.out" || { echo "FAIL: missed post-restart mention"; exit 1; }
grep -q "already replied, skip it" "$TMP/wait2.out" || { echo "FAIL: missing replied annotation"; exit 1; }

echo
echo "E2E SPIKE PASSED"
