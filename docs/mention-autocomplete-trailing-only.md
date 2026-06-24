# `@mention` 自动补全仅对末尾提及生效

## 现象描述

在 Web UI 输入框中连续 @ 多个成员（如 `@foo @bar`）时，只有最后一个 `@bar` 能弹出补全下拉，靠前的 `@foo` 不触发补全。回头把光标移到 `@foo` 上重新编辑时也不弹出。

## 根因分析

补全检测正则锚定到**整个输入文本的末尾** `$`，且补全/取消逻辑都假设被补全的提及位于文本末尾：

```ts
// 检测：只匹配末尾的 "@partial"
const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(text)
// 补全：从文本末尾回退 partial 长度
setText(text.slice(0, text.length - mentionMatch![1].length) + nickname + ' ')
// Escape：从文本末尾删掉整段匹配
setText(text.slice(0, text.length - mentionMatch![0].length))
```

`@foo @bar` 中 `@foo` 后面还有字符，不在末尾，因此 `$` 匹配失败 → 不弹补全。

## 修复方案

把检测目标从「整个 `text`」改为「**光标前的子串** `text.slice(0, caret)`」，正则本身不变；补全与 Escape 改为在光标处按偏移 splice，而非从末尾回退。

### 要点

| 项 | 做法 | 理由 |
|----|------|------|
| 光标读取 | 渲染时直接读 `inputRef.current?.selectionStart ?? text.length` | 避免把光标值存进 state 导致的 staleness |
| 重算触发 | textarea `onSelect` 仅 `bumpCaret` 触发重渲染（不存值） | 纯光标移动（点击/方向键回到早先提及）也能重新检测 |
| 补全 | `partialStart = caret - mentionMatch[1].length`，splice 后保留 `text.slice(caret)` | 保留 `@` 与前缀，只替换 partial，保留光标之后内容 |
| 光标恢复 | `pendingCaret` ref + `useLayoutEffect` 调 `setSelectionRange` | 受控组件重渲染会把光标推到末尾，须在 commit 后绘制前设回 |
| Escape | 基于 `mentionMatch.index` splice | 修掉同样的末尾假设 |

因 `$` 锚定在切片末尾，恒有 `mentionMatch.index + mentionMatch[0].length === caret`，splice 偏移计算自洽无 off-by-one。

### 关键代码位置

| 文件 | 位置 | 改动 |
|------|------|------|
| `packages/web/src/App.tsx` | 检测块 | `exec(text.slice(0, caret))`，新增 `caret` / `bumpCaret` / `pendingCaret` |
| `packages/web/src/App.tsx` | `completeMention` | 光标处 splice + 设 `pendingCaret` |
| `packages/web/src/App.tsx` | `useLayoutEffect` | 恢复光标 |
| `packages/web/src/App.tsx` | textarea `onSelect` / Escape 分支 | 触发重算 / splice 删除 |

## 取舍与边界

- **方案 A（已采纳）**：光标前能匹配就补全。光标位于提及中间（`@foo|bar`）时会把 `@foo` 补全为 `@<nickname> bar`，符合多数编辑器行为，实现最简。
- Escape 会连带删除提及前的一个空格（与 `completeMention` 保留前缀略有不一致），属可接受的「丢弃半截提及」语义。
- 服务端 `resolveMentions`、IME 组词、Enter 提前发送均不在本次范围（后两者为既有问题）。
- 昵称服务端校验 `/[\s@]/u` 禁止空白与 `@`，与捕获组 `[^\s@]*` 字符集一致，不会截断昵称。

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-06-24 | 初稿：定位末尾锚定根因，改为光标处检测 + splice，bump web 0.3.9 → 0.3.10 |
