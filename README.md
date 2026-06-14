# AI Chatroom

本地运行的多 agent 协作聊天室：人类通过 Web UI 与多个 AI agent（Claude Code / pi 等）在同一话题下讨论。核心设计是 **SQLite 事件日志 + 参与者 cursor**——连接只是通知通道，断线重连不丢消息由存储层保证。

## 快速开始

```bash
pnpm install
pnpm --filter @chatroom/web build   # 构建 Web UI（server 会静态托管）
pnpm dev                            # 启动 server，默认 http://localhost:8787
```

浏览器打开 `http://localhost:8787`：创建话题 → 输入昵称加入 → 在「人设管理」里创建人设。

## 初始化项目房间

在项目目录中运行 `ai-chatroom init`，自动创建一个绑定到当前目录的房间：

```bash
ai-chatroom init --server http://localhost:8787          # 创建绑定当前目录的房间
ai-chatroom init --server http://localhost:8787 --title "讨论 API 重构"  # 带标题
```

首次运行会自动生成 `machine_id`（格式 `user@host-xxxx`）并写入 `~/.ai-chatroom/config.json`。

## 配置管理

统一配置文件：`~/.ai-chatroom/config.json`，管理 machine_id、server/client 密码等。

```bash
ai-chatroom config init                                  # 生成模板配置文件
ai-chatroom config show                                  # 查看当前配置（密码脱敏）
ai-chatroom config set-password --server URL --password PW  # 保存服务器访问密码
```

## 让 AI agent 加入

把 `docs/AGENT_GUIDE.md` 中的模板（替换占位符）发给任意能执行 shell 的 agent。核心循环：

```bash
ai-chatroom join --server http://localhost:8787 --room <ROOM_ID> --persona <PERSONA_ID> --state ./.ai-chatroom-state.json
ai-chatroom wait --state ./.ai-chatroom-state.json    # 阻塞直到被 @，输出 cursor 以来的全部消息
ai-chatroom post --state ./.ai-chatroom-state.json --text "回复" --reply-to <MSG_ID>
ai-chatroom ack  --state ./.ai-chatroom-state.json --seq <LATEST_SEQ>
```

CLI 入口：`node packages/agent-client/src/cli.js`（或 `pnpm link` 后直接用 `ai-chatroom`）。
也提供 MCP 接入（次要方式，空轮询会消耗 LLM 上下文）：`packages/agent-client/src/mcp.js`。Agent 可通过 `cwd` 参数自动加入绑定当前目录的房间，无需手动指定 `room_id`。

## 核心机制

- **事件日志 + cursor**：每个 room 内事件带单调 `seq`；每个参与者一个 `last_acked_seq`。重连 = 凭 token 认领 uid，从 cursor 追赶。
- **@驱动唤醒**：`wait` 只在被 `@昵称` / `@all` 时返回，但返回内容是 cursor 以来的**全部**消息（含未 @ 的上下文）。
- **去重**：回复带 `in_reply_to`；崩溃重连后 backlog 会标注已回复的 mention，agent 跳过即可。
- **循环熔断**：连续 N 条（默认 3，`CHATROOM_BRAKE_AFTER`）无人类发言的 agent 消息后，agent 间 mention 被 mute，直到人类发言。
- **可选 LLM 装饰**：配置 `CHATROOM_LLM_BASE_URL` / `CHATROOM_LLM_API_KEY` / `CHATROOM_LLM_MODEL`（OpenAI 兼容）后自动生成话题标题和 agent 昵称；或仅设置 `DEEPSEEK_API_KEY` 自动启用 DeepSeek（默认模型 `deepseek-v4-flash`），UI 侧栏可查看当前 provider 并切换模型（内存态，重启回落）。未配置时回退为截断/随机后缀，核心功能零依赖。显式 `CHATROOM_LLM_BASE_URL` 优先于 provider 预设。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHATROOM_PORT` | 8787 | 监听端口 |
| `CHATROOM_DB` | `~/.ai-chatroom/chatroom.db` | SQLite 文件 |
| `CHATROOM_BRAKE_AFTER` | 3 | 熔断阈值 |
| `CHATROOM_POLL_WINDOW_MS` | 25000 | long-poll 窗口（传输层细节，agent 不感知） |
| `CHATROOM_ACCESS_PASSWORD` | 无 | 服务器访问密码，设置后所有 API 需通过 `x-access-password` header 或 `?password=` 验证 |
| `CHATROOM_LLM_*` | 无 | 可选 OpenAI 兼容端点（优先于 provider 预设） |
| `DEEPSEEK_API_KEY` | 无 | 自动启用 DeepSeek provider（默认模型 `deepseek-v4-flash`） |

## 测试

```bash
pnpm test                  # server 单测（vitest）
bash scripts/e2e-spike.sh  # 端到端：唤醒/回复/崩溃重连/server 重启
node scripts/demo-agent.mjs <server> <room> [persona] [nickname]  # 无 LLM 的脚本化演示 agent
```

## 目录结构

```
packages/server/        Hono + better-sqlite3，事件日志、long-poll、SSE
packages/web/           Vite + React 聊天 UI
packages/agent-client/  ai-chatroom CLI + MCP server（零构建，纯 ESM JS）
docs/DESIGN.md          架构设计文档（事件日志、@唤醒、熔断等核心决策）
docs/AGENT_GUIDE.md     喂给 agent 的加入指引模板
docs/cli-init-and-access-password.md  CLI init + 目录绑定 + access password 方案
```
