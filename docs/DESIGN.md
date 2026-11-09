# 设计说明

本文记录 dsh-novel-reader 的实现方式与关键取舍，方便二次开发。

## 目标

在 DSH Web GUI 里用「对话」的形式读本地 txt 小说：

- 选定一本小说后，每条消息读出一章正文，进度按书记忆；
- 正文放在助手消息的「思考」块里，可见回复是一段固定的结构化总结，整体看起来像一次带思考过程的正常 AI 回答；
- 不调用真实模型、不联网（`session-title` 和 `compaction` 也被接管，避免误发请求）。

## 包结构

这是一个不需要构建的 DSH bundle：

```
package.json        dsh.bundle.patch + dsh.client 声明，无运行时依赖
cordis.patch.yml    插入 novel-reader 行的 Loader patch，并给出默认配置
index.js            宿主半：扫描/切章/进度/接管 llm/stream/RPC 路由
client.js           浏览器半：输入框旁按钮、小说选择面板、设置页（纯 JS + React.createElement）
locale/*.json       插件管理器里的标题/描述
icon.svg            插件图标
samples/*.txt       自带示例小说（其中一篇带章节，便于试整章阅读）
test/*.mjs          宿主半自动化测试（假 ctx 装载 index.js）
```

`client.js` 通过 `window.__ModuleLoader__.load` 注册，`package.json` 的 `dsh.client` 让宿主把它当作 Web 端模块加载；宿主侧 `inject: ['connection']` 用于注册 HTTP 路由。

## 输出接管（宿主半）

宿主监听 `llm/stream` 瀑布。对处于阅读模式的会话：

| 请求 `purpose` | 处理 |
| --- | --- |
| 未设置（正常聊天） | 返回小说正文的流式 chunk（思考块 + 可见总结），不经过真实模型 |
| `session-title` | 返回普通工作型标题（不出现书名） |
| `compaction` | 返回一段阅读模式摘要，避免压缩时调用真实模型 |
| 其他 | `next()` 透传 |

流式 chunk 布局：

- `display: thinking`（默认）：`reasoning` block（正文，逐段流式）→ `text` block（固定总结模板，`summaryTemplate`）。
- `display: answer`：正文直接作为 `text` block。

细节：

- 段落排版：原文每行是一个 Markdown 自然段，段间空行；行首缩进/行尾空白被去掉；`*`、反引号、`[]`、`<>` 与行首 `#`/`-`/`>`/编号等被转义，避免被 Markdown 渲染成标题、列表、引用、代码块。
- 节奏：4 字一片 + 轻微抖动，首字前有 `firstTokenDelayMs` 停顿，接近真实模型出词。
- 中断：用户停止时按「最后一个完整自然段」回退进度，下次从断点续读；若正文已完整输出、只是总结被打断，则整章算已读。
- 进度只在正文成功输出后落盘（`assistant/message` 对应的 turn 内），失败不会推进。

## 章节识别与数字跳章

- 按行扫描「单独成行、长度 ≤80 字、不含句号」的标题：`第X章/节/回/话/篇`、`第1章`、`Chapter N`、`楔子`/`序章`/`引子`/`前言`/`尾声`/`终章`/`后记`/`番外`。
- 第一个标题之前的正文（书名页、作者的话）并入第 1 章，保证「第一章」是序号 1。
- 章节按出现顺序编号，`1..N`；没有识别到章节时自动退回 `chunkChars` 按字数切段。
- 阅读模式下，用户消息若是纯数字，则把它当作「跳到第 N 章」：进度设为该章开头并立刻读该章；越界时只提示总章数、不改进度。运行时注入的上下文 user 消息会被跳过。
- `maxChapterChars > 0` 时，超长章节会截成多次输出，下一次继续同一章。

## 状态与目录

- 小说目录优先级：`cordis.patch.yml` 的 `directory` > 设置页保存的目录 > `<DSH_HOME>/novels`。
- 设置页选的目录写在 `<DSH_HOME>/novel-reader.settings.json`（固定位置，不跟目录走）。
- 每个目录内用 `.reader-state.json` 保存：显示名、每本书的字符偏移进度、会话→小说映射、调试标记。
- 进度是字符偏移（不是章节序号），所以切章逻辑变化不会破坏已有进度；换目录等于换书库。
- 状态写入串行 + 原子替换（Windows 上 `rename` 失败会退化先删再换），避免并发写损坏。

## 浏览器半

- `conversation.input.right`：模型选择器左侧的小按钮，轮询 `session` RPC 显示「书名 · 第 X/Y 章」，点击打开小说选择面板（portal 到 body，避免被输入框裁切）。
- `settings.section`：设置页，支持改显示名、重置进度、刷新列表、创建示例小说、修改/恢复小说目录（可选原生目录选择器：`ctx.get('uiWorkspace').pickDirectory()`，没有就手动输入）。
- 宿主通信：浏览器端 `ctx.connection.rpc.call('/api','novel-reader',{method,payload})`，宿主端 `connection.fetch.register('/api/novel-reader')` 精确路由（共享 `/api` 通道只允许一个 interceptor，本 profile 已被其他插件占用，所以用精确路由）。

## 已知取舍

- 一次只扫描一个目录，不递归子目录；目录切换不迁移进度。
- 章节识别是启发式，非常规排版会退回按字数模式。
- 阅读模式下该会话的标题与压缩摘要也被接管；需要真实模型时请退出阅读模式或另开会话。
- 固定总结是模板文案（可用 `summaryTemplate` 覆盖），不跟随正文内容变化。
