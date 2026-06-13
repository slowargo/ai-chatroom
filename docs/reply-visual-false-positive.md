# 回复消息视觉误判：`@mention` 左侧边框与 blockquote 混淆

## 现象描述

当 agent 回复一条带有 `@mention` 的消息时，被 @ 的用户在 Web UI 中看到这条回复带有左侧彩色边框，视觉上形如 `<blockquote>`。

## 根因分析

### 数据流

1. **chatroom_post** 设置 `reply_to` → 服务器存储为 `in_reply_to`
2. 服务器解析消息文本中的 `@xxx` → 将目标用户 UID 加入 `ev.mentions` 数组
3. Web 前端 `EventLine` 组件渲染时对 `ev.mentions.includes(myUid)` 为真的消息加上 `mentioned` CSS 类

### 误判链

```
消息文本含 @mention
        ↓
后端将 @目标 的 uid 写入 ev.mentions
        ↓
前端 EventLine: const mentioned = ev.mentions.includes(myUid) || ev.mentions.includes('all')
        ↓
CSS: .msg.mentioned { border-left: 3px solid var(--accent); padding-left: 10px; }
        ↓
视觉上 = blockquote 样式（border-left + padding）
```

### 关键代码位置

| 文件 | 行号 | 代码 |
|------|------|------|
| `packages/web/src/App.tsx` | 287 | `const mentioned = ev.mentions.includes(myUid) \|\| ev.mentions.includes('all')` |
| `packages/web/src/styles.css` | 36 | `.msg.mentioned { border-left: 3px solid var(--accent); ... }` |
| `packages/web/src/styles.css` | 57 | `.markdown blockquote { border-left: 3px solid var(--border); ... }` |

两个选择器均使用 `border-left + padding-left`，但是用不同 CSS 变量：

- `.msg.mentioned` → `var(--accent)`（强调色）
- `.markdown blockquote` → `var(--border)`（边框色）

颜色实际不同，混淆主要来自 **结构相似**（都是 border-left + padding-left 的排版模式），而不是颜色本身。

## 根本问题

**`mentioned` 的语义与 `reply` 的语义正交，但视觉效果重叠。**

- `mentioned` = 这条消息提到了你（需要你注意）
- `reply_to` = 这条消息是对某条消息的回复（结构关联）

当前前端代码 `EventLine` 完全忽略了 `ev.in_reply_to` 字段。回复消息在视觉上与普通消息无区别，只有通过 @mention 侧边高亮才间接体现出"被叫到"。

## 相关代码

### `in_reply_to` 数据完整

服务器端完整存储了 `in_reply_to`：

- `packages/server/src/store.ts:37` — 类型定义 `in_reply_to?: string | null`
- `packages/server/src/store.ts:263` — 写入 `in_reply_to: input.in_reply_to ?? null`
- `packages/server/src/store.ts:271` — SQL INSERT `in_reply_to` 列

### 但前端未消费

`packages/web/src/App.tsx` 的 `EventLine` 组件仅使用 `ev.mentions`：

```tsx
const mentioned = ev.mentions.includes(myUid) || ev.mentions.includes('all')
```

`EventLine` 的 props 类型没有声明 `in_reply_to` 相关字段，但 `ev` 参数（`ChatEvent` 类型）本身的 `in_reply_to: string | null` 数据是完整可用的——只是没有被消费。

## 可能的改进方向

### 方向 A：分离 `mentioned` 与 `reply` 的视觉呈现

保留 `mentioned` 高亮，同时添加回复结构的视觉线索（如缩进、左侧连线、引用面板）：

```tsx
<div className={`msg ${ev.in_reply_to ? 'reply' : ''} ${mentioned ? 'mentioned' : ''} ...`}>
```

CSS：

```css
.msg.reply { margin-left: 16px; border-left: 2px solid var(--border); }
```

### 方向 B：降低 `mentioned` 的视觉权重

将 `.msg.mentioned` 的样式改为更微妙的标记（如右上角标记或背景色），避免与 blockquote 混淆：

```css
.msg.mentioned { background: var(--accent-bg); }
```

### 方向 C：回复消息隐藏 @mention 高亮

如果回复消息中的 @ 是引用性质的（`reply_to` 存在且 mentions 包含被回复消息的发送者），跳过 `mentioned` 类。这样回复时 @ 对方不会产生左边框，但独立 @ 仍然高亮：

```tsx
const isReplyMention = ev.in_reply_to && ev.mentions.length > 0
  && events.find(e => e.msg_id === ev.in_reply_to)?.sender_uid
    ? ev.mentions.includes(events.find(e => e.msg_id === ev.in_reply_to)!.sender_uid!)
    : false
const mentioned = !isReplyMention && (ev.mentions.includes(myUid) || ev.mentions.includes('all'))
```

**注意**：此逻辑需要 `events` 数组全局可用或者通过查找原消息的 sender 来判断，不能仅靠 `mentions.length === 1`——因为一条回复可以同时 @ 多人。

## 结论

当前行为不是 bug，是 `mentioned` CSS 的副作用。`in_reply_to` 字段数据完整可用，但前端未利用它进行视觉区分。选择哪个改进方向取决于产品设计意图——回复结构需要做多深的 UI 表达。

## 更新记录

| 日期 | 变更 |
|------|------|
| 2026-06-13 | 初版撰写 |
| 2026-06-13 | 修正行号（183→287）、补全 `mentions.includes('all')`、强调颜色差异、优化方向 C 逻辑 |
