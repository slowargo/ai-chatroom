# Agent Thinking Status Indicator

## 概述

在成员列表中显示 agent 的"思考中"状态动画，让用户能观察到 agent 已收到消息并正在处理。

## 架构

### 数据流

```
agent 在 /wait 中等待 → 收到 @mention → /wait 返回(woke=true)
→ agent 调用 /ack → hub.setThinking(roomId, uid) → SSE 广播 status 事件
→ Web UI 显示 thinking 动画
→ agent 处理完毕，进入下一轮 /wait
→ hub.clearThinking(roomId, uid) → SSE 广播 status 清除
→ Web UI 移除 thinking 动画
```

### 触发点

| 动作 | 端点 | 效果 |
|------|------|------|
| Agent ACK 消息 | `POST /ack` | `setThinking`（仅 type=agent） |
| Agent 进入等待 | `GET /wait` 开头 | `clearThinking` |
| 连接断开 | `untrack()` refcount=0 | 自动 `clearThinking` |

### 关键设计决策

- **纯内存状态**：thinking 不持久化到 SQLite，是瞬态信息
- **专用 status 通道**：Hub 中 `subscribeStatus`/`setThinking`/`clearThinking` 与 `subscribe`/`publish` 平级，类型隔离
- **SSE 队列化**：status 事件推入主循环 queue 由统一 `await writeSSE` 处理，避免写入交错
- **thinking 隐含 online**：`/members` 返回 `online: online.has(uid) || isThinking(roomId, uid)`

## waiting_human 状态

### 概述

`waiting_human` 是与 `thinking` 平级的瞬态状态，专门用于 agent 暂停等待本地操作者输入的场景。当 agent 在 CLI 侧需要向执行它的人类提问时，应主动调用 MCP 工具 `chatroom_set_status`（传 `status="waiting_human"`），让聊天室其他参与者看到"⏸ 等待操作者"徽章，而不是误以为 agent 仍在思考。

### 设置方式

- MCP 工具：`chatroom_set_status`，参数 `status="waiting_human"`
- 对应服务端端点：`POST /api/rooms/:id/status`，body `{ status: "waiting_human" }`

### 加法集合设计（Additive Set）

`thinking` 与 `waiting_human` 在 Hub 中用两个独立的 Set 维护（roomId → Set of uids），而非单一枚举 Map。衍生状态由 `statusOf(roomId, uid)` 以固定优先级计算：

```
waiting_human > thinking > idle
```

这样设计的原因：`setThinking`（由 `/ack` 触发）不会覆盖掉 `waiting_human`。即使 agent 在 `waiting_human` 状态下收到了新 ACK，状态仍保持 `waiting_human`，直到下次 `/wait` 调用一次性清除两个 Set。

### 隐含 online

设置 `waiting_human` 的 agent 即使无活跃连接，也在 `/members` 和 SSE presence snapshot 中视为 online（与 `thinking` 行为一致）。`isBusy(roomId, uid)` 检查两个 Set，替代原有的 `isThinking` 用于 online 推断。

### 自动清除

`/wait` 入口（`GET /wait` 开头）调用 `clearThinking`，该函数同时清空 `thinking` 和 `waiting` 两个 Set，广播 `idle` 状态。untrack refcount→0 时同样触发。

### 已知局限

1. **staleness window（状态残留窗口）**：`chatroom_set_status` 设置后，状态持续到下次 `/wait` 调用才清除。因此 agent 恢复处理并发送回复期间，成员列表仍会显示 `waiting_human` 徽章，直到它进入下一轮 `chatroom_wait`。

2. **stale-waiting on crash（崩溃后状态滞留）**：agent 处于 `waiting_human` 期间通常无活跃连接，若 agent 进程崩溃，`waiting_human` 状态会一直存在，直到该 agent 下次成功调用 `/wait`（因为没有连接断开可触发 untrack）。TTL 自动过期机制留待后续实现。

## 已知问题：Presence 闪烁

### 现象

用户发消息 @mention agent 后，agent 的在线圆点会短暂变灰（约 3-8 秒），然后恢复绿色并显示 thinking 动画。

### 原因分析

时序如下：

```
T0: 用户发消息 @agent
T1: server hub 唤醒 agent 的 /wait 请求
T2: /wait 返回 → finally 里 untrack() → agent 变 offline（灰点）
    ← 间隙开始：agent 侧 MCP 工具在处理响应 →
T3: agent MCP 客户端收到 wait 响应，Claude Code 开始处理
T4: agent 调用 /ack → setThinking → thinking 隐含 online → 绿点 + thinking 动画
    ← 间隙结束 →
T5: agent 处理完，发 /messages 回复
T6: agent 进入下一轮 /wait → clearThinking + track() → 绿点保持
```

T2→T4 的间隙是问题所在。这段时间 agent 没有活跃的 HTTP 连接，presence 从 server 视角确实是 offline。间隙长度取决于：

1. MCP 工具的网络延迟
2. Claude Code 内部决策时间（读消息、决定是否 ACK）
3. Agent 运行时的调度延迟

### 可能的优化方案

**方案 A：延迟 untrack**

在 `/wait` 返回 `woke=true` 时，不立即 untrack，而是延迟 N 秒（如 10s）再执行。给 agent 时间来 ACK。

- 优点：消除闪烁
- 缺点：presence 语义变模糊（agent 已断开但仍显示在线）；如果 agent 进程崩溃，延迟期内显示假在线

**方案 B：接受间隙（当前选择）**

保持现有行为，间隙很短且语义准确。

- 优点：简单，语义正确
- 缺点：用户可见的短暂闪烁

**方案 C：前端防抖**

Web UI 侧对 online 状态变化加 debounce（如 5s），online→offline 的变化延迟显示。

- 优点：零后端改动，纯 UI 优化
- 缺点：所有成员的离线检测都会延迟，不仅仅是 agent

### 当前实现

采用方案 C（前端三态 grace period）：
- 绿点 = 在线，黄点闪烁 = 10s 过渡态，灰点 = 离线
- members poll 间隔从 10s 缩短到 2s 以提高响应速度

## 待实现：SSE Presence 推送

### 需求

当前 presence 状态（online/offline）依赖前端 2s 轮询 `/members` 端点。更好的方案是通过 SSE 实时推送 presence 变化，轮询作为兜底。

### 设计思路

在 Hub 的 `track()`/`untrack()` 中，当某个 uid 的 refcount 从 0→1（上线）或 1→0（下线）时，通过已有的 status 通道广播 presence 变化：

```
Hub 新增：
  subscribePresence(roomId, fn) 或复用 subscribeStatus
  track() refcount 0→1 时广播 { uid, online: true }
  untrack() refcount 1→0 时广播 { uid, online: false }

SSE stream：
  监听 presence 事件，以 event: 'presence' 发送

Web UI：
  监听 'presence' SSE 事件，实时更新 member 的 online 状态
  members poll 间隔可恢复到 10s（仅作兜底）
```

### 好处
- presence 变化从 2s 延迟降到毫秒级
- 减少不必要的 HTTP 请求
- 与 thinking status 的 SSE 推送模式一致
