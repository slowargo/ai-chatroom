# 跨浏览器重进房间导致原浏览器失去访问权限

## 现象

用户在浏览器 A 创建房间并加入,之后在浏览器 B 用相同昵称重新进入同一房间。再回到浏览器 A 时,A 就「没有权限进入」原来的房间(接口返回 401)。

## 根因

系统**没有 owner/creator 概念**(`rooms` 表无创建者字段,创建房间不绑定任何身份),成员身份完全靠 `token` 标识,而成员按 `(room_id, nickname)` 唯一定位。

`joinRoom` 的「无 token + reclaim」分支(`packages/server/src/store.ts`)在命中同名既有成员时会**旋转 token**:

```ts
const newToken = randomBytes(24).toString('base64url')
this.db.prepare('UPDATE participants SET token = ? WHERE uid = ?').run(newToken, existing.uid)
return { participant: { ...existing, token: newToken }, rejoined: true, events: [] }
```

`reclaim` 来自 `app.ts` 的 `reclaim: !autoNick`——带显式昵称的 human join 恒为 `true`。

复现链路:

1. 浏览器 A 加入,昵称 N → 拿到 token `T_A`,存入 `localStorage[chatroom:identity:{roomId}]`。
2. 浏览器 B 没有该房间的本地身份 → 显示 `JoinGate`,用相同昵称 N 加入且**不带 token**。
3. 服务端命中 `existing && reclaim` 分支 → `UPDATE ... SET token = T_B`,`T_A` 作废。
4. 浏览器 A 回来仍用 `T_A` 调接口,auth 中间件 `getParticipantByToken(T_A)` 查不到 → **401 invalid token**。

`reclaim` 的本意是「同一个人换设备/丢了 token,用昵称找回身份」,但它无法区分「同一个人找回」与「另一个浏览器重进」,于是两个浏览器互相旋转 token、把对方踢下线。

## 修复

采用「多端并存」语义:reclaim 命中既有成员时**返回既有身份(含原 token),不旋转**。

```ts
if (existing) {
  if (input.reclaim) {
    return { participant: existing, rejoined: true, events: [] }
  }
  throw new ConflictError(`nickname "${input.nickname}" is taken in this room`)
}
```

这样 A、B 两浏览器共享同一 token,都能用、互不踢。

## 设计取舍

- **token 的意义**:在「凭昵称无 token 找回」存在的前提下,token 对 human 本来就不是安全秘密——旧的旋转方案同样允许任何人凭昵称重签 token 冒充成员(还顺手踢掉原主)。本修复并未降低安全性,只是去掉了「旋转踢人」的副作用。token 仍是会话句柄(`Authorization: Bearer` 鉴权、绑定 room_id)。
- **安全边界**:真正的访问控制是 server 级、可选的 access password(`app.ts` `if (deps.accessPassword)`)。当前定位为**可信环境**使用,昵称即身份是可接受的。
- **未来扩展**:若要支持非可信环境,计划引入登录层,届时可在 reclaim 之上叠加「登录用户只能认领自己的昵称」的归属校验。本修复不与之冲突。
- **未采纳的方案**:让 token 成为唯一身份真相(去掉无 token reclaim、重进必须带 token)能恢复 token 的秘密语义,但换浏览器/清缓存就回不到原身份,与本次痛点直接冲突,需配合身份导出/导入或登录,成本过高。

## 验证

`packages/server/test/server.test.ts` 新增用例:human 同名无 token 二次加入后,`b.token === a.token`,且 A 的原 token 仍能通过 `/members` 鉴权(200)。`pnpm --filter @chatroom/server test` 全绿(52 passed)。

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-06-25 | reclaim 不再旋转 token,改为返回既有身份;新增针对性测试,bump server 0.4.6 → 0.4.7 |
