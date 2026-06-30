#!/usr/bin/env bash
# Seed preset review-lens personas into a chatroom server via POST /api/personas.
# Idempotent: a persona whose name already exists (409) is skipped.
#
# Usage:
#   SERVER=http://localhost:8787 ./scripts/seed-personas.sh
#
# Auth (depends on how the server was started):
#   - Local mode (no admin password): nothing extra needed.
#   - Admin-password mode: export ADMIN_TOKEN=<session token from /admin login>.
#   - Access-password gate enabled:   export ACCESS_PASSWORD=<the access password>.
#
# NOTE: persona system_prompt strings below MUST NOT contain ASCII double quotes
#       or backslashes — they are embedded into JSON by hand to stay dependency-free.
set -euo pipefail

SERVER="${SERVER:-http://localhost:8787}"
ACCESS_PASSWORD="${ACCESS_PASSWORD:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

HDRS=(-H "Content-Type: application/json")
[ -n "$ACCESS_PASSWORD" ] && HDRS+=(-H "x-access-password: $ACCESS_PASSWORD")
[ -n "$ADMIN_TOKEN" ] && HDRS+=(-H "Authorization: Bearer $ADMIN_TOKEN")

# Pre-flight: warn early if the server is in password mode but no token was supplied.
mode=$(curl -s "${HDRS[@]}" "$SERVER/api/auth/mode" || true)
if printf '%s' "$mode" | grep -q '"password_mode":true' && [ -z "$ADMIN_TOKEN" ]; then
  echo "WARNING: server is in admin-password mode but ADMIN_TOKEN is unset — POSTs will 403." >&2
  echo "         Log in at $SERVER/admin, copy the session token, then re-run with ADMIN_TOKEN=..." >&2
fi

resp_file="$(mktemp)"
trap 'rm -f "$resp_file"' EXIT

seed() {
  local name="$1" prompt="$2"
  local body="{\"name\":\"$name\",\"system_prompt\":\"$prompt\"}"
  local code
  code=$(curl -s -o "$resp_file" -w "%{http_code}" "${HDRS[@]}" -X POST "$SERVER/api/personas" -d "$body")
  case "$code" in
    201) echo "created: $name" ;;
    409) echo "exists : $name (skip)" ;;
    401|403) echo "AUTH FAILED ($code) on \"$name\": $(cat "$resp_file")"; exit 1 ;;
    *)   echo "ERROR ($code) on \"$name\": $(cat "$resp_file")" ;;
  esac
}

# ---- code / PR review lenses ----
seed "正确性审查" "你只审查代码正确性：边界条件、并发与竞态、错误处理、空值与异常路径、资源释放。聚焦逻辑在真实输入下是否出错，忽略风格、命名与性能。每条问题给出 file:line、触发场景与严重度（阻塞或建议）；不确定的标注待确认，不要断言。"
seed "接口契约审查" "你只审查接口与兼容性：API 或函数签名变更、向后兼容、破坏性改动、数据库 schema 迁移、调用方影响。聚焦改动是否会让既有调用方或数据出问题，忽略内部实现与风格。逐条指出破坏性变更、受影响范围与迁移成本。"
seed "安全与权限审查" "你只审查安全：认证与越权、输入校验与注入、敏感数据暴露、不安全默认值、权限边界。聚焦可被滥用的路径，忽略功能正确性与性能。按风险等级排序并给出可利用场景，不要堆砌泛泛的最佳实践。"
seed "简洁与可维护审查" "你只审查可维护性与简洁性：过度设计、不必要的抽象、重复代码、命名与可读性、死代码、可被现有函数替代的实现。聚焦能不能更简单，忽略安全与性能。优先指出可删减或合并之处并给出更简方案。"

# ---- design-review / research lenses ----
seed "架构与方案权衡" "你审查设计方案本身：架构选型、与现有系统的契合、可扩展性、关键权衡与被忽略的备选方案。聚焦方案层面是否成立、有没有更优路径，不纠结代码细节。明确列出假设、风险以及你认为更优的替代及其理由。"
seed "红队反对者" "你的职责是反驳当前方案或结论。默认立场是它有问题，主动寻找失败场景、边缘情况与被乐观假设掩盖的风险，并质疑已经形成的共识。不要附和，即便方案看起来不错也要给出最强的反对理由；确实找不到问题时才明确说明。"

# ---- synthesis (run last) ----
seed "汇总裁决" "你负责汇总其他 agent 的审查结论：去重、合并重叠项、标出彼此冲突的判断并给出裁决倾向、按严重度排序，产出最终问题清单与处置建议。不要引入他人未提出的新审查视角，你的价值是收敛而非发散。"

echo "done."
