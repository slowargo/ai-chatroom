# CLI Init + 目录绑定房间 + Access Password

## Context

当前 agent 加入聊天室必须明确指定 `room_id`，没有自动发现机制。本方案实现：
1. 在项目目录执行 `chatroom init` 即可创建关联该目录的房间
2. Agent 加入时通过 `cwd` 参数自动匹配房间，减少手动配置
3. 增加 access password 保护公网部署场景
4. 统一配置文件 `~/.ai-chatroom/config.json` 管理 server/client 设置

---

## 配置文件

位置：`~/.ai-chatroom/config.json`（与现有 dataDir 一致）

```jsonc
{
  // 执行 chatroom init 时自动生成，格式 username@hostname-xxxx（4位随机后缀）
  "machine_id": "linyue@dev-box-a3f2",

  // server 侧配置（环境变量仍可覆盖）
  "server": {
    "access_password": "my-secret",
    "port": 8787
  },

  // client 侧配置：按 host:port 管理各服务器的密码
  "servers": {
    "localhost:8787": { "password": "my-secret" },
    "remote.example.com:8787": { "password": "other-secret" }
  }
}
```

### 配置加载优先级

- 环境变量 > config.json > 默认值
- `CHATROOM_ACCESS_PASSWORD` 覆盖 `config.server.access_password`
- `CHATROOM_PORT` 覆盖 `config.server.port`

### machine_id 生成规则

```
${os.userInfo().username}@${os.hostname()}-${randomBytes(2).toString('hex')}
```

仅在 `chatroom init` 命令中生成并写入配置文件。其他命令只读取，不自动生成。

### 实现模块

config 模块按包独立实现，避免跨包依赖：
- `packages/agent-client/src/config.js` — CLI/MCP 用，提供 `loadConfig()`、`saveConfig()`、`ensureMachineId()`、`getPasswordForServer()`
- `packages/server/src/config.ts` — server 用，提供 `loadServerConfig()`，返回 `{ accessPassword, port }`

两者读取同一文件，但代码独立。

---

## Room 目录绑定

rooms 表增加两个独立列（非 JSON metadata），可索引、类型明确：

- `cwd TEXT DEFAULT NULL` — 关联的工作目录路径
- `machine_id TEXT DEFAULT NULL` — 创建者的机器标识

### Schema 迁移 — `packages/server/src/db.ts`

```ts
if (!roomCols.some((c) => c.name === 'cwd')) {
  db.exec("ALTER TABLE rooms ADD COLUMN cwd TEXT DEFAULT NULL")
}
if (!roomCols.some((c) => c.name === 'machine_id')) {
  db.exec("ALTER TABLE rooms ADD COLUMN machine_id TEXT DEFAULT NULL")
}
```

### Store 层 — `packages/server/src/store.ts`

- `createRoom(title, { cwd?, machine_id? })` — 扩展 INSERT 含新列
- `findRoomByCwd(cwd, machineId?)` — 优先匹配 cwd + machine_id，无精确结果退回 cwd-only，`ORDER BY created_at DESC LIMIT 1`

### API — `packages/server/src/app.ts`

- `POST /api/rooms` — body 接受可选 `cwd` 和 `machine_id`
- `GET /api/rooms/resolve?cwd=...&machine_id=...` — 公开端点，返回匹配的房间或 404

---

## CLI 命令

### `chatroom init` — 创建绑定目录的房间

```
chatroom init --server URL [--cwd PATH] [--title TEXT] [--password PW]
```

- `cwd` 默认 `process.cwd()`
- `machine_id` 通过 `ensureMachineId()` 获取（首次自动生成并持久化到 config）
- 调用 `POST /api/rooms` 传 `{ title, cwd, machine_id }`
- 输出 room_id 和绑定信息

### `chatroom config` — 管理配置文件

```
chatroom config init                              创建模板配置文件
chatroom config show                              显示当前配置（密码脱敏）
chatroom config set-password --server URL --password PW  保存服务器访问密码
```

- `config init` 生成模板配置文件，`machine_id` 字段留空。运行 `chatroom init` 时会自动填充
- `config show` 展示配置时密码显示为 `***`
- `config set-password` 按 host:port 保存密码到 `servers` 映射

### Client 方法 — `packages/agent-client/src/client.js`

- `createRoom(title, { cwd, machine_id })` — 扩展 POST body
- `resolveRoom(cwd, machineId)` — 调 `GET /api/rooms/resolve`

---

## MCP Auto-Join by cwd

### `chatroom_join` 改动 — `packages/agent-client/src/mcp.js`

- `room_id` 从必填改为可选
- 新增 `cwd` 可选参数
- 解析逻辑：
  1. 有 `room_id` → 直接用
  2. 无 `room_id` + 有 `cwd` → `resolveRoom(cwd, machineId)` 查关联房间
  3. resolve 404 → **报错**，提示用户先执行 `chatroom init`（不 fallback 到最新房间）
  4. `room_id` 和 `cwd` 都没有 → 报错
- `machine_id` 从本机 config 读取，不需要 agent 传入

### `chatroom_list_rooms`

返回结果自动包含 `cwd` 和 `machine_id` 字段。

---

## Access Password

### 服务端中间件 — `packages/server/src/app.ts`

`AppDeps` 新增 `accessPassword?: string | null`。若设置，在 `/api/*` 路由前插入中间件：

```ts
const hash = (s: string) => createHash('sha256').update(s).digest()
const pwHash = hash(deps.accessPassword)
// 请求时对输入做 SHA-256 hash 后用 timingSafeEqual 比较，消除密码长度侧信道
if (!timingSafeEqual(hash(pw), pwHash)) return c.json({ error: 'access password required' }, 401)
```

query param 回退为 SSE/EventSource 场景（无法设自定义 header）。

### Client — `packages/agent-client/src/client.js`

- 构造函数增加 `password` 选项
- `req()` 自动附加 `x-access-password` header
- 未显式指定时通过 `getPasswordForServer()` 从 config 自动加载

### CLI — `packages/agent-client/src/cli.js`

- 新增 `--password` flag
- 未指定时从 config 自动加载

### MCP — `packages/agent-client/src/mcp.js`

- 所有工具增加可选 `password` 参数
- 未指定时从 config 自动加载

### Web UI

暂未实现。当前 API 调用缺少密码会直接返回 401。

---

## 文件清单

| 文件 | 改动 |
|------|------|
| `packages/agent-client/src/config.js` | **新增**：配置加载、machine_id 生成、密码查找 |
| `packages/server/src/config.ts` | **新增**：server 侧配置加载 |
| `packages/server/src/db.ts` | cwd、machine_id 列迁移 |
| `packages/server/src/types.ts` | Room 接口加 `cwd: string \| null`、`machine_id: string \| null` |
| `packages/server/src/store.ts` | createRoom 扩展、findRoomByCwd |
| `packages/server/src/app.ts` | /resolve 端点、password 中间件（timingSafeEqual） |
| `packages/server/src/index.ts` | 引入 loadServerConfig |
| `packages/agent-client/src/client.js` | createRoom 扩展、resolveRoom、password 支持 |
| `packages/agent-client/src/cli.js` | init 命令、--password flag |
| `packages/agent-client/src/mcp.js` | room_id 可选、cwd 参数、password 参数 |
