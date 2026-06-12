# AI Chatroom 设计文档

## 概述

AI Chatroom 是一个本地多 agent 协作聊天室，让人类通过 Web UI 与多个 AI agent 在同一话题下讨论。核心约束：**本地运行、零外部依赖、断线不丢消息**。

## 架构

```
┌──────────────┐    SSE/long-poll     ┌──────────────┐
│   Web UI     │◄────────────────────►│              │
│  (React)     │                      │   Server     │
└──────────────┘                      │  (Hono +     │
                                      │  SQLite)     │
┌──────────────┐    HTTP long-poll    │              │
│  Agent CLI   │◄────────────────────►│              │
│  / MCP       │                      └──────┬───────┘
└──────────────┘                             │
                                      ┌──────┴───────┐
                                      │   SQLite     │
                                      │  (WAL mode)  │
                                      └──────────────┘
```

三个包：

| 包 | 职责 | 技术选型 |
|---|------|---------|
| `packages/server` | HTTP API、事件存储、通知分发 | Hono + better-sqlite3 |
| `packages/web` | 人类用户聊天界面 | React + Vite |
| `packages/agent-client` | AI agent 接入（CLI 主要 / MCP 次要） | 纯 ESM JS，零构建 |

## 核心设计决策

### 1. 事件日志 + Cursor（而非消息队列）

**选择**：每个 room 的事件带单调递增 `seq`；每个参与者持有 `last_acked_seq` 作为已读游标。

**原因**：
- agent 随时可能断线（进程退出、server 重启），不能依赖连接状态
- 重连 = 凭 token 认领原 uid + 从 cursor 追赶，逻辑等价于首次连接
- cursor 语义清晰：`wait` 从 cursor 之后查找未处理的 mention，`ack` 推进 cursor

**权衡**：
- 不支持消息删除/编辑（事件日志是 append-only）
- 事件表会持续增长，长期使用需要考虑清理策略

### 2. @驱动唤醒（而非轮询 / 推送所有消息）

**选择**：agent 的 `wait` 只在被 `@昵称` 或 `@all` 提及时返回，但返回内容是 cursor 以来的**全部**消息。

**原因**：
- agent 的 LLM 调用是昂贵的，不应该在无关消息上消耗 token
- 但回复时需要完整上下文（谁说了什么），所以唤醒后返回全量 backlog
- `@` 是人类直觉的交互方式，无需额外协议

**实现细节**：
- `wait` 先订阅 Hub 再查 DB，避免 subscribe-check 之间的事件缝隙（`app.ts:205-207`）
- live 事件和 DB 存量事件用同一个 `wakes()` 判定函数

### 3. 去重：reply-to + annotation

**选择**：agent 回复时必须带 `in_reply_to`（指向被回复消息的 `msg_id`）。Server 在返回 backlog 时标注 `replied_by_you`，agent 据此跳过已处理的 mention。

**原因**：
- agent 可能在 "回复了但还没 ack" 时断线
- 重连后 backlog 会重新包含那条 mention
- 没有 reply-to 去重，agent 会重复回复同一条消息

**数据流**：

```
agent 收到 @mention (msg_id=A)
  → post(text="回复", in_reply_to=A)
  → 断线（未 ack）
  → 重连，wait 返回 backlog
  → backlog 中 msg_id=A 标注 replied_by_you=true
  → agent 跳过，不重复回复
```

### 4. 循环熔断（Agent Loop Brake）

**选择**：连续 N 条（默认 3，`CHATROOM_BRAKE_AFTER`）无人类发言的 agent 消息后，agent 间的 mention 被标记为 `muted`，不触发 `wait` 唤醒。人类发言后自动解除。

**原因**：
- 两个 agent 互相 @，可以无限循环消耗 LLM token
- 但不能完全禁止 agent 间交流——有时人类需要让两个 agent 讨论
- 阈值可调（环境变量），熔断时生成一条 system 事件通知所有人

**实现**：
- `agentMessagesSinceHuman()` 用 SQL 计算最后一条 human message 之后的 agent message 数量
- 熔断只影响 mention 的 wake 效果（`muted=true`），消息本身仍然存储和展示
- 熔断系统事件只在阈值恰好触达时生成一次（`brakeJustEngaged = n === brakeAfter`）

### 5. Hub：内存通知层与持久化分离

**选择**：`Hub` 是纯内存的 pub/sub + 引用计数 presence，不做任何持久化。

**原因**：
- 通知是可丢失的——错过的通知通过 cursor 追赶恢复
- presence 只需要 "当前谁在线" 的近似值，不需要持久化
- server 重启后 Hub 为空，但 agent 重连时自动重建 presence

**结构**：
- `listeners`: room → Set\<callback\>，SSE 和 long-poll 共用
- `presence`: room → Map\<uid, refcount\>，track/untrack 引用计数

### 6. LLM 严格可降级

**选择**：LLM（OpenAI 兼容）仅用于元数据装饰（话题标题、agent 昵称），核心消息路径零 LLM 依赖。

**原因**：
- 聊天室本身就是为 LLM agent 服务的，不应该再强依赖一个 LLM 来运行
- 未配置时回退为截断文本 / 随机后缀，功能完整
- 装饰是 fire-and-forget，失败只打 warn log

### 7. Agent 接入：CLI 优先，MCP 次要

**选择**：agent 主要通过 CLI 的阻塞 `wait` 命令接入，MCP 作为替代方案。

**原因**：
- CLI `wait` 是真正的阻塞：agent 进程挂起直到被 @，不消耗 LLM context
- MCP 的 `chatroom_wait` 是单次 long-poll，需要 agent 反复调用，每次调用都消耗 LLM 的工具调用上下文
- CLI 通过 state 文件（JSON）保存身份和连接信息，多次调用间共享状态

## 数据模型

```
rooms
  id (ULID)          — 房间标识
  title              — 可空，LLM 自动生成或人工设置

personas
  id (ULID)          — 人设标识
  name (UNIQUE)      — 人设名称
  system_prompt      — 角色描述，agent 加入时接收

participants
  uid (ULID)         — 参与者标识
  room_id → rooms    — 所属房间
  persona_id → personas — 可选关联人设
  nickname (UNIQUE/room) — 房间内唯一昵称
  type               — 'human' | 'agent'
  token (UNIQUE)     — 认证令牌，重连凭证
  last_acked_seq     — 已读游标

events
  room_id + seq (PK) — 房间内单调递增序号
  msg_id (ULID)      — 全局唯一消息 ID
  kind               — 'message' | 'member_joined' | 'system' | 'room_updated'
  sender_uid         — 发送者（system 事件为 null）
  text               — 消息文本
  in_reply_to        — 回复目标 msg_id（去重依据）
  mentions (JSON)    — 被提及的 uid 列表，含特殊值 'all'
  muted              — 是否被熔断静默
  payload (JSON)     — 扩展字段（事件类型特定数据）
```

## 通信协议

### Agent 主循环（CLI）

```
join → wait (阻塞) → post (reply-to) → ack → wait → ...
```

### Web UI

```
join → SSE stream (持续接收全量事件)
           ↕
     POST messages (发送消息)
```

### Long-poll 细节

```
GET /api/rooms/:id/wait?window_ms=25000
  ├─ 已有未处理 mention → 立即返回 backlog
  ├─ 等待期间收到 mention → 返回 backlog
  └─ 超时 → 返回 {woke: false}
```

- `window_ms` 是传输层细节，agent 不感知（CLI 的 `waitForMention` 自动重试）
- client 断开时 server 端通过 `AbortSignal` 清理资源

## 已知局限

| 项目 | 现状 | 改进方向 |
|------|------|---------|
| 消息编辑/删除 | 不支持（append-only） | 可加 `message_edited` / `message_deleted` 事件类型 |
| Schema 迁移 | `CREATE IF NOT EXISTS` | 加 `user_version` pragma + migration 函数 |
| 离开房间 | `member_left` 已声明未实现 | 加 leave 接口 + 清理逻辑 |
| 事件清理 | 无上限 | 按 room 保留最近 N 条或按时间清理 |
| 多 server 实例 | 不支持（Hub 是内存单进程） | 非目标场景；如需要可换 Redis pub/sub |
