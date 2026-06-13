# Agent 加入审批机制 + 移除 stateful mode

## 背景

当前 chatroom 的 join 流程完全开放——任何 agent 调用 join 即可获得身份和 token。存在两个问题：

1. MCP 的 stateful mode（共享 state file）导致多 session 身份互踩
2. Agent 丢失 token 后可以随意 rejoin，存在冒充风险

## 鉴权规则

| 请求方 | 有 token | 无 token |
|--------|---------|---------|
| Human (type=human) | 直接 rejoin | 直接加入，自动成为 admin |
| Agent (type=agent) | 直接 rejoin | **挂起等待 admin 审批** |

## Agent 无 token 加入流程

```
Agent ---(join, no token, type=agent)---> Server
  ← 202 { status: 'pending', request_id }

Agent ---(poll, request_id)---> Server      # 首次立即轮询，之后指数退避，窗口 60s
  ← { status: 'pending' }                  # 未审批，继续轮询
  ← { status: 'approved', uid, token, nickname, ... }  # 审批通过
  ← { status: 'rejected', reason? }        # 被拒绝

Admin (web UI) 看到 pending 请求 → 选择:
  a) 批准（新 UID）：确认或修改 agent 上报的昵称
  b) 批准（绑定既有 UID）：将已有成员身份分配给该 agent
  c) 拒绝
```

### 身份声明

Agent 可以在 join 时通过 `nickname` 声明自己的身份。如果该 nickname 对应的成员已存在于 room 中，审批面板自动选中"绑定既有"并预填该成员，admin 一键确认即可。

## 实现细节

### 1. 移除 MCP stateful mode（`packages/agent-client/src/mcp.js`）

- 删除 `statePath`、`loadState()`、`clientFor()` 函数
- `server`、`room_id`、`token` 从 optional 变为 required（除 `chatroom_join` 和 `chatroom_list_rooms` 外）
- `chatroom_join` 不再写 state file
- 删除 `identityArgs` 定义

### 2. Server: Pending join 机制（`packages/server/src/`）

#### 数据结构（内存 Map）

```ts
interface PendingJoin {
  request_id: string       // ULID，申请唯一标识
  room_id: string
  nickname_requested: string
  persona_id?: string
  created_at: number
  status: 'pending' | 'approved' | 'rejected'
  // 审批结果（approved 时填充）
  assigned_uid?: string
  assigned_nickname?: string
  token?: string
  reason?: string          // rejected 时的拒绝原因
}
```

存储：`Map<request_id, PendingJoin>`，内存即可。

#### 修改 join 端点

`POST /api/rooms/:id/join`：
- 有 token + 验证通过 → 直接 rejoin（不变）
- type=human + 无 token → 直接加入（不变）
- type=agent + 无 token → 创建 pending 记录，返回 `202 { status: 'pending', request_id }`

#### 新增端点

- `GET /api/rooms/:id/pending-joins` — 列出待审批请求（admin only）
- `POST /api/rooms/:id/pending-joins/:request_id/approve` — 审批通过
  - body: `{ action: 'new' | 'bind', nickname?: string, bind_uid?: string }`
  - `action: 'new'`: 分配新 UID，nickname 可由 admin 修改
  - `action: 'bind'`: 绑定到 `bind_uid` 对应的既有成员
- `POST /api/rooms/:id/pending-joins/:request_id/reject` — 拒绝
  - body: `{ reason?: string }`
- `GET /api/rooms/:id/pending-joins/:request_id/poll` — agent 长轮询审批结果
  - 无需 auth（request_id 本身是不可猜测的 ULID）
  - 60s 长轮询窗口，未审批返回 `{ status: 'pending' }`
  - 审批通过返回完整身份信息 `{ status: 'approved', uid, token, nickname, ... }`
  - 被拒绝返回 `{ status: 'rejected', reason? }`

#### Admin 鉴权

当前阶段：auth middleware 中 `me.type === 'human'` 即为 admin。admin-only 端点检查此条件。

### 3. Web UI: 审批面板（`packages/web/src/`）

- ChatRoom 界面新增"待审批"区域，支持同时展示多个 pending 请求
- 每个请求显示：请求的昵称、persona、请求时间
- 操作：
  - **批准（新 UID）**：昵称输入框（预填 agent 上报值），确认按钮
  - **批准（绑定既有）**：下拉选择已有 agent 成员（如果 agent 声明的 nickname 匹配既有成员，自动选中），确认按钮
  - **拒绝**：可选填拒绝原因
- 通过 SSE/stream 实时接收新 pending 请求

### 4. MCP client 处理（`packages/agent-client/src/mcp.js`）

`chatroom_join`：
- 收到 202 → 返回 `{ status: 'pending', request_id, next: '...' }`
- 提示 agent 调用 `chatroom_join_poll` 轮询，首次立即调用，之后指数退避

新工具 `chatroom_join_poll`：
- 输入：`server`, `room_id`, `request_id`
- 60s 长轮询
- 返回审批结果

## 关键文件

- `packages/server/src/app.ts` — 路由、auth 中间件
- `packages/server/src/store.ts` — 数据存储、join/rejoin 逻辑
- `packages/server/src/types.ts` — 类型定义
- `packages/web/src/App.tsx` — 主界面组件
- `packages/web/src/api.ts` — 前端 API
- `packages/agent-client/src/mcp.js` — MCP server
- `packages/agent-client/src/client.js` — ChatroomClient

## 验证

1. Agent 无 token join → 返回 202 pending
2. Web UI 显示 pending 请求（支持多个同时存在）
3. Admin 批准（新 UID）→ agent poll 获得新身份
4. Admin 批准（绑定既有）→ agent poll 获得既有身份
5. Admin 拒绝 → agent poll 收到 rejected
6. Agent 声明已有 nickname → 审批面板自动预选绑定
7. Human 加入不受影响
8. Agent 有效 token rejoin 不受影响
9. MCP 不传 token 调用 post 等工具 → 报错（stateful fallback 已移除）
