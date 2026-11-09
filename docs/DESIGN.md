# 小说阅读插件 (dsh-novel-reader) — 实现契约 v1

> 本文件是团队协作的唯一事实来源。所有成员按此契约实现；有疑问先在文件中记录并告知 Lead，不要擅自改契约。

## 目标

在 DSH Web GUI 里用「和 AI 对话」的形式读本地 txt 小说：

- 固定目录：`<DSH_HOME>/novels`（默认 `C:\Users\24070489\.dsh\novels`），里面放 `*.txt`。
- 输入框工具栏（模型选择器左侧）有一个小按钮，看起来/用起来像模型选择器，但弹出的是小说列表。
- 选中一本小说后，本会话进入「阅读模式」；用户每次发送任意消息，助手回复就是小说正文的下一段（流式、看起来和正常 AI 回复一样）。
- 每段字数适中（默认约 420 汉字，可在 cordis.patch.yml 配 `chunkChars`）。
- 进度按小说记忆（保存字符偏移），刷新/重启后继续。
- 设置 → 「小说阅读」页：列出 txt、可改显示名（即“模型名”）、看进度、重置进度、刷新列表、创建示例小说。
- 退出阅读模式后，会话恢复正常 AI。

## 架构（已定）

Host 半（`index.js`，Lead 实现）：
- 扫描固定目录，管理状态文件、进度、显示名。
- 监听 `llm/stream` 瀑布：当某会话处于阅读模式且请求 `purpose` 为 `undefined`（正常聊天请求）时，**替换**成小说下一段的流式 chunk；`purpose === 'session-title'` 返回书名作为标题；`purpose === 'compaction'` 返回阅读模式摘要（避免真实模型调用）。
- 通过 `ctx.connection.rpc.intercept('/api', matches, handler)` 暴露 RPC 给浏览器半。

Client 半（`client.js`，由 client-ui 成员实现）：
- 注册 `conversation.input.right`：触发按钮（小说选择器入口）。
- 注册 `settings.section`：小说阅读设置页。
- 通过 `ctx.connection.rpc.call('/api', 'novel-reader', { method, payload }, signal)` 调 Host。

## Host RPC 契约（端点名 `novel-reader`）

Client 端调用助手（直接照抄）：

```js
function callRpc(connection, method, payload, signal) {
  return connection.rpc.call('/api', 'novel-reader', { method, payload })
    .then((result) => {
      if (result && result.ok === true) return result.value;
      const why = result && result.error && result.error.message
        ? result.error.message
        : 'novel-reader rpc failed: ' + method;
      throw new Error(why);
    });
}
```

方法（payload 为对象；返回的 `value` 形状如下）：

1. `overview`（payload `{}`）
```json
{
  "directory": "C:\\Users\\24070489\\.dsh\\novels",
  "novels": [
    { "id": "a1b2c3d4e5f60708", "file": "斗破苍穹.txt", "name": "斗破苍穹",
      "chars": 123456, "offset": 420, "percent": 0, "finished": false }
  ]
}
```
- `novels` 按显示名排序；`name` 是用户改过的显示名或文件名去扩展名。
- `chars` 为字符数（JS string length）；`percent` 为 0-100 向下取整。

2. `session`（payload `{ "sessionId": "..." }`）
```json
{ "novelId": "a1b2c3d4e5f60708", "name": "斗破苍穹", "offset": 420, "chars": 123456,
  "percent": 0, "finished": false, "active": true }
```
没有阅读模式时：`{ "novelId": null, "active": false }`。

3. `select`（payload `{ "sessionId": "...", "novelId": "..." | null }`）
- 设/清本会话的阅读小说；返回同 `session`。
- `novelId` 非法时返回错误。

4. `rename`（payload `{ "novelId": "...", "name": "..." }`）→ 返回 `overview`。
5. `reset`（payload `{ "novelId": "..." }`）→ 返回 `overview`（进度归零）。
6. `refresh`（payload `{}`）→ 返回 `overview`（重新扫描目录）。
7. `seedDemo`（payload `{}`）→ 把包内 `samples/*.txt` 复制到固定目录（已存在同名则跳过），返回 `overview`。

错误：Client 侧只需 `throw new Error(message)`，UI 显示该 message。

## Client 半实现要求（client-ui 成员）

### 文件与模块格式

只写 `E:\workspace\gl\novel-reader\client.js`（纯 JS，无 JSX，用 `React.createElement` 或 `h`）。

```js
window.__ModuleLoader__.load({
  id: 'dsh-novel-reader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // 可选：let createPortal = null; try { createPortal = require('react-dom').createPortal; } catch {}
    const NS = 'dsh-novel-reader';
    const RPC_ENDPOINT = 'novel-reader';
    // ...组件...
    function apply(ctx) { /* 见下 */ }
    return { inject: ['slots', 'locale', 'connection'], apply };
  },
});
```

- 禁止 `require` Harness 的其它 Client 包（尤其 `@deepseek-ai/dsh-client-ui-primitives`）。
- `react-dom` 只允许在 `try/catch` 里尝试（拿不到就降级为绝对定位面板，不允许模块加载失败）。

### 服务与注册

`apply(ctx)` 里：
1. 注册字典并绑定 t：
```js
ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'novel-reader: dictionaries');
const t = ctx.locale.bind(NS);
```
2. 注册按钮：
```js
ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
  name: 'conversation.input.right',
  id: 'novel-reader-trigger',
  order: 900,
  locale: NS,
  inject: (sessionId) => ({
    sessionId,
    t,
    rpc: (method, payload, signal) => callRpc(ctx.connection, method, payload, signal),
  }),
}, NovelTrigger));
```
3. 注册设置页：
```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'novel-reader',
  order: 55,
  label: () => t('nav'),
  locale: NS,
  inject: () => ({ t, rpc: (method, payload, signal) => callRpc(ctx.connection, method, payload, signal) }),
}, NovelSettings));
```
可选：`ctx.slots.inject('settings.section.icon', ...)` 注册 16px 书本图标（可以不做，外壳有默认齿轮）。

### 触发按钮 `NovelTrigger`

props：`{ sessionId, t, rpc }`。

行为：
- 挂载时及每 2000ms（`document.visibilityState === 'visible'` 时）调用 `rpc('session', { sessionId })` 拉状态；卸载清定时器。
- 折叠态：一个紧凑小按钮（高度约 28px，圆角 8px），内容 = 书本 SVG 图标 + 文本：
  - 未开启：“阅读模式”
  - 已开启：`书名 · 42%`（书名过长省略，max-width 约 120px，单行 ellipsis）
- 点击打开/关闭弹出面板。
- 弹出面板（看起来像模型选择框）：
  - 标题：“小说阅读”（t('popup.title')）
  - 小说行：每行显示 书名 + 右侧进度 `42%`（或“已读完”），当前选中的行显示 ✓；点击行 → `rpc('select', { sessionId, novelId })`，成功后关闭面板并刷新状态。
  - 无小说时：显示 t('popup.empty') 和 “创建示例小说” 按钮（`rpc('seedDemo', {})` 后刷新）。
  - 面板底部一行：“跟随默认模型”/“退出阅读模式”（t('popup.off')），点击 `rpc('select', { sessionId, novelId: null })`。
  - 面板底部提示文字：t('popup.hint')。
  - 面板宽度约 280px，`position: fixed`（用 createPortal 到 body）或绝对定位（`bottom: calc(100% + 8px); right: 0`）均可；必须在视口内、不被输入框裁切。点击外部/Escape 关闭。
  - 加载/错误：行内小字显示，不整块崩溃。
- 状态轮询失败（例如 Host 未就绪）时保持原样，不抛错。

### 设置页 `NovelSettings`

props：`{ t, rpc }`（`t` 已绑定）。要求：

- 顶部标题 + 说明（t('settings.title') / t('settings.desc')）。
- 显示固定目录路径（来自 `overview.directory`），旁边“刷新列表”按钮（`rpc('refresh')`）。
- 小说列表：每行显示
  - 文件名（小字、次级色）
  - 输入框编辑显示名（默认值 = `name`），“保存”按钮（`rpc('rename', { novelId, name })`）；保存中禁用。
  - 进度文字：`已读 42% · 420 / 123456 字`，以及“重置进度”按钮（`rpc('reset', { novelId })`）。
- 空目录：显示提示 + “创建示例小说”按钮（`rpc('seedDemo')`）。
- 所有请求失败在页面内显示错误文案，不白屏。
- 布局：`padding: 24px; overflow: auto; height: 100%; display: flex; flex-direction: column; gap: 16px;` 风格跟随主题变量。

### 样式规则

- 只用主题 token：颜色 `var(--dsw-alias-label-primary)`, `var(--dsw-alias-label-secondary)`, `var(--dsw-alias-label-tertiary)`, `var(--dsw-alias-bg-layer-1/2)`, `var(--dsw-alias-bg-overlay)`, `var(--dsw-alias-border-l1)`, `var(--dsw-alias-interactive-bg-hover)`, `var(--dsw-alias-brand-primary)`。
- 组件内渲染 `<style>` 元素（唯一 class 前缀 `dnr-`），随卸载自动移除；不要向 document.head/body 手写 DOM（portal 除外）。
- 字号 12-14px，圆角 8-12px，按钮要有 hover 与 disabled 态。
- 不要用 `<select>`；用自绘下拉。

### i18n 字典 key（必须全部提供 zh/en）

按钮/弹层：
`trigger.idle` “阅读模式”, `popup.title` “选择小说”, `popup.empty` “固定目录里还没有 txt 文件”, `popup.hint` “选择后，发送任意消息即可继续阅读”, `popup.off` “退出阅读模式”, `popup.seed` “创建示例小说”, `popup.loading` “加载中…”, `popup.failed` “读取失败”, `popup.finished` “已读完”
设置页：
`nav` “小说阅读”, `settings.title` “小说阅读”, `settings.desc` “把 txt 小说放进固定目录，就能在对话里一段一段地读。发送任意消息继续下一段。”, `settings.folder` “小说目录”, `settings.refresh` “刷新列表”, `settings.seed` “创建示例小说”, `settings.empty` “固定目录里还没有 txt 文件。把 .txt 放进上面的目录，或创建示例小说。”, `settings.filename` “文件”, `settings.displayName` “显示名”, `settings.save` “保存”, `settings.saving` “保存中…”, `settings.saved` “已保存”, `settings.reset` “重置进度”, `settings.progress` “已读 {percent}% · {offset} / {chars} 字”, `settings.error` “操作失败”, `settings.noSession` “请在会话内使用”

英文自行翻译，简单直接。

### 交付与自检

- 运行 `node --check E:\workspace\gl\novel-reader\client.js` 必须通过。
- 不要创建/修改其它文件；完成后回报：文件路径 + 自检结果 + 未决问题（如有）。

## 参考文件（只读，别改）

- 槽位与注册示例：`C:\Users\24070489\.dsh\profiles\desktop\node_modules\dsh-opencode-go\lib\client.js` 第 4238-4256 行（`conversation.input.right` 注册 + `inject: (sessionId) => ...`）。
- 设置页示例：`C:\Users\24070489\.dsh\profiles\desktop\node_modules\@copylee\dsh-proxy\client\client.js` 第 1202-1235 行（`settings.section` 注册）与 `ProxySection` 组件。
- 宿主↔浏览器 RPC：`C:\Users\24070489\.dsh\profiles\desktop\node_modules\dsh-opencode-palette\lib\client.js` 里 `createHostBridge` / `rpcCall`（搜索 `channel`、`connection.rpc`）。
- 会话作用域槽位声明与 `sessionId` 注入机制：`E:\workspace\gl\.ref\dsh\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js` 第 22960-23020 行。
