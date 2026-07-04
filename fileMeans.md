# /packages/core/src/effect/observability.ts

**OpenTelemetry 可观测性的开关层**：如果配了 `OTEL_EXPORTER_OTLP_ENDPOINT` 环境变量，就把运行时的日志和调用链（traces）上报到远程 OTLP 后端（如 Grafana、Datadog、Jaeger）；没配置就走本地日志。

具体三件事：

1. **`resource()`** — 构建服务元数据（服务名 `opencode`、版本号、实例 UUID、进程角色等），给每条上报数据打标签，方便在后端按版本/实例等维度筛选。

2. **`logs()`** — 日志双写 Layer：本地 `EffectLogger.logger` + 远端 `OtlpLogger`（`/v1/logs`），一份不漏。

<br/><br/><br/><br/><br/>

## packages/opencode/script/publish.ts（发布 fxcode 到 npm 仅当前平台）
> 2026-06-29 12:00:00

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/script/publish.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/script/publish.ts)

#### 用户输入的问题

帮我总结，你这次如何发布的。我下次copy你的命令。

#### 回复

```bash
# === 发布 fxcode 到 npm（仅当前平台） ===

# 0. 首次需要登录 + 设 token（之后可跳过）
npm login --registry https://registry.npmjs.org/
npm config set //registry.npmjs.org/:_authToken <token>

# 1. 构建
cd packages/opencode
rm -rf dist
OPENCODE_VERSION=<版本号> bun run build -- --single --skip-embed-web-ui

# 2. 发布二进制包
cd dist/fxcode-darwin-*
bun pm pack && npm publish *.tgz --access public --tag latest --registry https://registry.npmjs.org/
cd ../../

# 3. 发布主包
rm -rf dist/fxcode
OPENCODE_VERSION=<版本号> npm_config_registry=https://registry.npmjs.org/ bun run script/publish.ts
cd dist/fxcode
bun pm pack && npm publish *.tgz --access public --tag latest --registry https://registry.npmjs.org/
```

**注意：**
- `<版本号>` 每次递增（1.0.3 → 1.0.4），npm 不允许覆盖
- 第 3 步 publish.ts 会报 `already published` 和 Docker 错误，都忽略，手动 `cd dist/fxcode` 执行发布即可
- `--skip-embed-web-ui` 是因为你 Node 版本太低跑不起 Vite

3. **`traces()`** — 链路追踪 Layer，用 `@opentelemetry` 生态把 span 发到 `/v1/traces`。额外修复了一个 bug：`@effect/opentelemetry` 创建了 `NodeTracerProvider` 但没注册，导致非 Effect 代码（如 AI SDK）的 span 丢失父子关系，全部变成独立 trace。这里手动注册了 `AsyncLocalStorageContextManager` 来解决。

类比前端接 Sentry / Datadog RUM：配了 endpoint 就上报，没配就不影响核心逻辑。导出 `layer` 根据 `base` 有无决定走增强还是本地模式。

## packages/core/src/effect/observability.ts
> 2026-06-26 12:16:58

[vscode://file/Users/fangxiang/opencode-dev-my/packages/core/src/effect/observability.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/core/src/effect/observability.ts)

这个文件是 opencode 的 OpenTelemetry 可观测性配置模块，用前端开发类比的话相当于前端的"监控 SDK 初始化配置"。它负责：
1. 从环境变量读取 OTLP endpoint，条件启用远程日志和链路追踪上报
2. 通过 `resource()` 构建服务元数据（服务名 "opencode"、版本、部署环境、客户端类型、进程角色等），相当于前端的 `Sentry.init({ release, environment })`
3. `logs()` 创建日志上报 Layer，将应用日志通过 OTLP 协议发送到可观测性后端（类似前端的 log transport）
4. `traces()` 创建链路追踪 Layer，关键性地手动注册 `AsyncLocalStorageContextManager` 来解决非 Effect 代码（如 AI SDK）的 trace context 传播问题——类似于前端中确保第三方库也能挂载到当前 span 上下文
5. `layer` 是最终的导出层：如果没配置 OTLP endpoint 就用本地 logger，否则合并 trace 和 logs 的远程上报层

核心设计：这是一个"门面模式"——对外暴露统一的 `Observability.layer`，内部根据是否有 OTLP endpoint 决定使用本地日志还是远程上报。

<br/><br/><br/><br/><br/>

## src/tool/tool.ts
> 2026-06-27 

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/tool/tool.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/tool/tool.ts)

#### 用户输入的问题

/Users/fangxiang/opencode-dev-my/packages/opencode/src/tool/tool.ts -- 这个文件在做什么

#### 回答

这个文件是 opencode 的**工具注册/定义系统**——把 LLM 可调用的工具（如 read、bash、edit 等）包装成统一的标准化工具定义。

#### 核心函数

**`define(id, init)` — 工具注册工厂函数（第 173-191 行）**

| 维度 | 说明 |
|---|---|
| 输入 | `id`（工具唯一标识，如 `"read"`）+ `init`（一个 Effect，返回工具的定义对象 `DefWithoutID` 或工厂函数） |
| 做了什么 | 1. 解析 `init` 拿到工具原始定义<br>2. 调用内部 `wrap()` 函数，给工具的 `execute` 方法自动注入**参数校验**、**输出截断**（超出 token 限制的内容写入临时文件）、**遥测追踪**（OpenTelemetry span 属性）<br>3. 返回一个 `Info` 对象 |
| 输出 | 一个 `Effect<Info>`，调用方可执行它获得 `{ id, init }`，后续再调用 `init()` 得到完整的 `Def` 对象 |

**`init(info)` — 延迟初始化（第 193-203 行）**：从 `Info` 的懒加载 `init` 中解析出最终的 `Def` 给调用方使用。

**`InvalidArgumentsError`** — 当 LLM 传给工具的参数不符合 schema 时，抛出的带友好提示的错误，模型可以据此修正输入后重试。

#### 核心类型

| 类型 | 说明 |
|---|---|
| `Def` | 工具完整定义（id + schema + execute 函数等） |
| `Info` | 工具的懒加载包装，id + 延迟 `init()` 方法 |
| `Context` | 工具执行时的上下文（sessionID、messageID、agent、中断信号等） |
| `ExecuteResult` | 工具执行结果（title + output + metadata + attachments） |

<br/><br/><br/><br/><br/>

## src/session/message-v2.ts + src/session/prompt.ts
> 2026-06-27

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/session/message-v2.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/session/message-v2.ts)

#### 用户输入的问题

工具调用后的结果，在 opencode 核心函数中发送给 LLM 的？

#### 回答

工具调用结果通过 **下一轮 agent loop 中重新构建 messages 数组** 的方式发送给 LLM，不是即时发送的。

## 核心流程

**两个关键文件：**

1. **`src/session/prompt.ts:1262-1511`** — `runLoop()` 主循环  
   每轮检查上次 assistant 消息是否有待处理的 tool calls，有则继续循环，重新加载消息历史调用 LLM。

2. **`src/session/message-v2.ts:630-913`** — `toModelMessagesEffect()` 转换消息  
   将 DB 中的 `ToolPart`（状态为 `completed`）转为 AI SDK 格式的 `tool-result` part，和其他文本消息一起组成 `ModelMessage[]` 发给 LLM。

## 时序简图

```
Round 1: 用户消息 → LLM 返回 tool_use → AI SDK 自动执行 → completeToolCall 写入结果到 DB

Round 2: runLoop 检测到 hasToolCalls → 继续循环
         → toModelMessagesEffect() 加载 DB 中的 tool_result
         → 转为 ModelMessage 数组 → streamText(messages) 发给 LLM
```

**关键点**：`convertToModelMessages()`（AI SDK 函数）会把同一 assistant 消息中的 `tool-result` part 拆为 role=`tool` 的独立消息，构成完整的 `[..., assistant(tool_use), tool(tool_result), ...]` 序列发给模型。

<br/><br/><br/><br/><br/>

## src/tool/task.ts
> 2026-06-27

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/tool/task.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/tool/task.ts)

#### 用户输入的问题

taskTool.execute() 执行子 agent，其实本质上和主 agent 是一样的是吗？也是调用 loop 函数？

#### 回答

**是的，完全一样。** 调用链：

```
taskTool.execute()
  └→ runTask()                      // task.ts:183
       └→ ops.prompt(...)           // 实际就是 prompt.ts 的 prompt()
            └→ loop(sessionID)      // prompt.ts:1251
                 └→ runLoop(...)    // prompt.ts:1262 — 同一个主循环函数
```

子 agent 和主 agent 共用完全相同的 `runLoop()` 函数。区别仅在于：

| | 主 agent | 子 agent |
|---|---|---|
| Session | 原 session ID | 新建的独立 session ID（`parentID` 指向父 session） |
| Agent 配置 | 当前 agent | `next.name` 指定的 subagent |
| Permission | 原 session permission | 从父 session 派生（`deriveSubagentSessionPermission`） |
| 阻塞方式 | AI SDK 自动执行 tool | `handleSubtask` **同步等待**子 agent 跑完（`yield* runTask()`） |

本质上就是：**新开一个 session，在上面重新跑一轮 `runLoop()`**，然后把跑出来的结果作为 tool 的 output 还给主 agent 继续推理。

<br/><br/><br/><br/><br/>

## src/session/processor.ts
> 2026-06-27

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/session/processor.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/session/processor.ts)

#### 用户输入的问题

`ensureToolCall` 做了什么。输入和输出是什么，有写入数据库吗

#### 回答

### `ensureToolCall`（`processor.ts:231-278`）

**输入**

```ts
{ id: string; name: string; providerExecuted?: boolean }
```

| 字段 | 说明 |
|---|---|
| `id` | AI SDK 分配的 `toolCallId` |
| `name` | 工具名称（如 `"read"`） |
| `providerExecuted` | 可选，是否由 provider（如 Anthropic）自动执行 |

**做什么**

确保对应 `toolCallID` 的 `ToolPart` 记录存在于 DB 中，不存在就创建：

1. `readToolCall(id)` → 检查是否已有记录
2. **已存在** → 如果只是补 `providerExecuted` 标记，更新 metadata；否则直接返回
3. **不存在** → `session.updatePart()` **写入 DB**（`pending` 状态），同时在 `ctx.toolcalls` 中注册一个 `Deferred`（用于后续 `completeToolCall` 时的同步等待）

**输出**

```ts
{ call: ToolCall; part: MessageV2.ToolPart }
```

| 字段 | 说明 |
|---|---|
| `call` | 内部追踪对象（含 partID、messageID、`done` Deferred、`inputEnded` 标志） |
| `part` | 数据库中的 ToolPart 记录 |

**是否写数据库**：**是。** 首次调用时通过 `session.updatePart()` 创建 ToolPart（`pending` 状态）写入 DB（第 260-269 行）。

**三个调用点**（都在 `handleEvent` 中）

| 事件 | 行号 | 作用 |
|---|---|---|
| `tool-input-start` | 365 | 首次收到工具调用 → 创建 ToolPart |
| `tool-input-end` | 374 | 标记 `inputEnded = true` |
| `tool-call` | 392 | 工具调用完整就绪 → 确保 ToolPart 存在，写入参数 |

<br/><br/><br/><br/><br/>

## src/session/message-v2.ts
> 2026-06-27

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/session/message-v2.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/session/message-v2.ts)

#### 用户输入的问题

LLM 回复的数据会有一个 parts 字段，这个字段是 LLM 的一次完整回复吗？

#### 回答

`parts` 是 **一个 `streamText()` 调用中 LLM 返回的完整响应**，不是多次调用的汇总。

```ts
// message-v2.ts:554-561
export type WithParts = {
  info: Info          // 消息元信息（id, role, modelID 等）
  parts: Part[]       // TextPart | ReasoningPart | ToolPart | ...
}
```

一次 `streamText()` 调用产出一条 assistant 消息，它的 `parts` 数组可以包含多种类型混合在同一轮响应中：

```
一次 LLM 调用
  → Assistant Message
    parts: [
      ReasoningPart,   // "我先分析一下..."
      ToolPart(read),  // "我需要读取文件"
      ToolPart(bash),  // "还需要执行命令"
      TextPart,        // "根据结果，答案是..."
      ToolPart(write), // "等等，还需要写文件"
    ]
```

每个 `ToolPart` 内部还有 `state` 字段追踪工具执行状态（`pending` → `running` → `completed`），执行结果是同一个 LLM 流中 AI SDK 自动执行工具后逐个填入的。

<br/><br/><br/><br/><br/>

## packages/opencode/script/publish.ts（发布命令逐条解析）
> 2026-06-29 12:30:00

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/script/publish.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/script/publish.ts)

#### 用户输入的问题

帮我解析每一个命令，我想学习

#### 回答

```bash
# ① 登录 npm 官方（验证身份），仅首次需要
npm login --registry https://registry.npmjs.org/

# ② 把 token 存入全局 .npmrc，之后 npm publish 自动携带鉴权
npm config set //registry.npmjs.org/:_authToken <token>

# ③ 进入 opencode 子包目录
cd packages/opencode

# ④ 删掉上次构建产物
rm -rf dist

# ⑤ 构建 — 设置环境变量 OPENCODE_VERSION=1.0.4，传给 build.ts
#    --single         → 只构建当前平台（macOS arm64 → fxcode-darwin-arm64）
#    --skip-embed-web-ui → 跳过 Web UI（Vite 需要 Node 20+，你机器是 16）
#    产物：dist/fxcode-darwin-*/bin/opencode（编译好的可执行文件）
#         + dist/fxcode-darwin-*/package.json
OPENCODE_VERSION=<版本号> bun run build -- --single --skip-embed-web-ui

# ⑥ 进入二进制包的构建产物目录
#    * 通配符匹配 fxcode-darwin-arm64 或 fxcode-darwin-x64
cd dist/fxcode-darwin-*

# ⑦ bun pm pack → 把当前目录打包成 .tgz 文件
#    npm publish *.tgz → 把这个 .tgz 发到 npm，access public 公开可见，
#    tag latest 标记为最新版，--registry 确保发到 npm 官方而非镜像
bun pm pack && npm publish *.tgz --access public --tag latest --registry https://registry.npmjs.org/

# ⑧ 退回 opencode 包目录
cd ../../

# ⑨ 删掉上次 publish.ts 生成的 fxcode 目录（避免 binaries 扫描混乱）
rm -rf dist/fxcode

# ⑩ 运行 publish.ts — 它做三件事：
#    1. 扫描 dist/*/package.json 收集二进制包名和版本
#    2. 在 dist/fxcode/ 下组装主包：
#       - 复制 postinstall.mjs
#       - 生成 package.json（name:"fxcode-ai"，optionalDependencies 指向二进制包）
#       - 写入占位 bin/fxcode.exe
#    3. 尝试用 npm publish 发布（但通常误判"already published"）
OPENCODE_VERSION=<版本号> npm_config_registry=https://registry.npmjs.org/ bun run script/publish.ts

# ⑪ 进入 publish.ts 组装好的主包目录
cd dist/fxcode

# ⑫ 打包并发布主包 fxcode-ai
bun pm pack && npm publish *.tgz --access public --tag latest --registry https://registry.npmjs.org/
```

---

**问答：**

**Q: 第⑤步 build 和第⑩步 publish.ts 为什么都要设版本号？**

build.ts 把版本号编译进二进制（`fxcode --version` 显示的值）。publish.ts 把版本号写入 `fxcode-ai/package.json` 和 `fxcode-darwin-*/package.json`。两者必须一致。

**Q: 第⑨步为什么要 rm -rf dist/fxcode？**

上次失败的 publish.ts 可能残留了 `dist/fxcode/` 目录，里面 package.json 叫 `fxcode-ai`，它会被第⑩步的扫描当成一个二进制包，导致路径混乱。

**Q: 为什么 publish.ts 会误判 "already published"？**

它的 `published()` 函数在 monorepo workspace 环境下，`npm view <包名>@<版本> version` 的退出码被 Bun shell 的 `.nothrow()` 吞掉，误以为包已存在。所以第⑫步手动覆盖发布。

<br/><br/><br/><br/><br/>

## packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/lsp.tsx
> 2026-06-30 12:00:00

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/lsp.tsx](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/lsp.tsx)

#### 用户输入的问题

opencode的read tool 在读文件的时候，LSPs are disabled 提示也没有改变。为什么？不是读文件就会改变吗？

因为提示文本是**配置静态检查**，不是动态检测 LSP 运行状态。

看 `lsp.tsx:11`：

```ts
const off = createMemo(() => !props.api.state.config.lsp)
```

它只检查 `config.lsp` 是否为 `true`。只要 `opencode.json` 里没设 `"lsp": true`，它就永远是 "LSPs are disabled"，你读多少文件都不会变。"LSPs will activate as files are read" 是说开启后 LSP 会按需启动，不是说"读到文件就会自动开启 LSP 功能"。

需要先在配置里加 `"lsp": true`。

<br/><br/><br/><br/><br/>

## packages/opencode/src/tool/edit.ts
> 2026-06-30 12:00:00

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/tool/edit.ts](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/tool/edit.ts)

#### 用户输入的问题

AI 能像 IDE 一样看到类型错误和语法问题--- 本质是lsp错误的信息也会一起发给llm？

对，本质就是 LSP 错误信息**嵌入到工具返回值**里一起发给 LLM。

`src/tool/edit.ts:193-197`：

```ts
yield* lsp.touchFile(filePath, "document")  // 触发 LSP 诊断
const diagnostics = yield* lsp.diagnostics() // 获取诊断结果
const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`
```

`apply_patch` 和 `write` 工具也做了同样的事。所以 LLM 看到的工具返回是：

```
Edit applied successfully.

LSP errors detected in this file, please fix:
  src/foo.ts:12:5 - Type 'string' is not assignable to type 'number'
```

LLM 拿到后能主动修复它自己引入的类型错误。不开 LSP，这一步就没了。

<br/><br/><br/><br/><br/>

## 概念总结：opencode 发 HTTP 请求的能力
> 2026-06-30 12:00:00

#### 用户输入的问题

Q1: opencode 能发邮件/公众号吗？Q2: curl 调这些 API 是标准吗？本质是 HTTP 吗？Q3: HTTP 只有浏览器能发吗？

---

**Q1: opencode 能发邮件/公众号吗？**

内置没有专用工具，但通过 `bash` 工具执行 curl 调 API 能做到。

**Q2: curl 调这些 API 是标准吗？本质是 HTTP 吗？**

是。邮件协议（SMTP）和公众号 API（微信官方 HTTP 接口）都是早已存在的标准。本质就是发 HTTP 请求。

**Q3: HTTP 只有浏览器能发吗？**

不是。HTTP 是七层协议，任何能建 TCP 连接的程序都能发。浏览器只是"会发 HTTP 的程序之一"，curl、Python requests、Go http.Client 都一样，底层协议完全相同。

<br/><br/><br/><br/><br/>

## TUI 弹窗组件 & 样式指南 (api.ui.dialog / Dialog / Theme)
> 2026-06-30 15:27:04

[vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/cli/cmd/tui/ui/dialog.tsx](vscode://file/Users/fangxiang/opencode-dev-my/packages/opencode/src/cli/cmd/tui/ui/dialog.tsx)

#### 用户输入的问题

props.api.ui.dialog.replace(() => (<box><text fg={theme().text}>弹窗内容</text></box>)) --- 有没有好看的样式。或者直接使用现成的组件

#### 回答

根据代码库分析，你有两种方式：

## 方式一：用现成组件（推荐）

如果场景匹配，直接用 `api.ui` 上挂载的预设组件，不需要自己写样式：

```tsx
// 确认框
props.api.ui.dialog.replace(() => (
  <api.ui.DialogConfirm
    title="删除确认"
    message="确定要删除吗？"
    confirmLabel="确认删除"
    onConfirm={async () => { /* ... */ }}
  />
))

// 提示框
props.api.ui.dialog.replace(() => (
  <api.ui.DialogAlert
    title="提示"
    message="操作成功"
  />
))

// 文本输入
props.api.ui.dialog.replace(() => (
  <api.ui.DialogPrompt
    title="输入名称"
    placeholder="请输入..."
    onSubmit={async (value) => { /* ... */ }}
  />
))

// 选项列表
props.api.ui.dialog.replace(() => (
  <api.ui.DialogSelect
    title="选择操作"
    options={[
      { title: "选项一", value: 1 },
      { title: "选项二", value: 2 },
    ]}
  />
))
```

## 方式二：自定义内容样式模板

如果内容必须自定义，参考项目中 dialog 组件的样式模式：

```tsx
props.api.ui.dialog.replace(() => {
  const theme = useTheme().theme  // 获取主题

  return (
    <box padding={1} flexDirection="column">
      {/* 标题栏：标题 + esc 提示 */}
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text bold fg={theme.text}>弹窗标题</text>
        <text fg={theme.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
          esc
        </text>
      </box>

      {/* 正文 */}
      <box paddingY={1}>
        <text fg={theme.textMuted}>这里放你的自定义内容</text>
      </box>

      {/* 底部按钮 */}
      <box flexDirection="row" justifyContent="flex-end" paddingTop={1}>
        <box paddingLeft={3} paddingRight={3} paddingY={0}>
          <text fg={theme.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
            取消
          </text>
        </box>
        <box
          marginLeft={1}
          paddingLeft={3} paddingRight={3} paddingY={0}
          backgroundColor={theme.primary}
        >
          <text bold fg={theme.selectedListItemText}>
            确认
          </text>
        </box>
      </box>
    </box>
  )
})
```

**关键颜色规范**：
| 用途 | 颜色 |
|------|------|
| 标题/正文 | `theme.text` / `theme.textMuted` |
| 主按钮背景 | `theme.primary` |
| 主按钮文字 | `theme.selectedListItemText` |
| 边框 | `theme.border` |
| 错误/警告 | `theme.error` / `theme.warning` |

直接用方式一最简单，除非确实需要自定义内容的布局。



<br/><br/><br/><br/><br/>

## upstream（git 上游分支）为什么需要
> 2026-07-04 10:52:44

#### 远程已有 origin/master，本地只是没设 upstream。执行推送并关联：--- upstream 为什么需要这个？

#upstream 是什么

`upstream`（上游分支）就是给你的**本地分支**指定一个**默认对应的远程分支**。设置后，本地 `master` 就"记住"了它对应远程的 `origin/master`。

## 为什么需要它

没设 upstream 时，Git 不知道你的本地分支该跟哪个远程分支对应，所以：

```
$ git push
fatal: The current branch master has no upstream branch.
```

你就必须每次都写全：

```
git push origin master     # 每次都要指定 远程名 + 分支名
git pull origin master
```

设了 upstream 后，Git 记住了对应关系，就能简写：

```
git push      # 自动 = git push origin master
git pull      # 自动 = git pull origin master
git status    # 还能告诉你"本地比远程领先/落后几个提交"
```

## 一个比喻

把本地分支想成你手机里的联系人。upstream 就是**存好的号码**：

- 没存号码 → 每次打电话都要手输一长串号码（`git push origin master`）
- 存了号码 → 直接点名字就能打（`git push`）

## 关键点

- `--set-upstream`（简写 `-u`）**只需做一次**，关系就记住了。
- 它记录在 `.git/config` 里，不是每次 push 都要设。
- 之后 `git status` 能显示 `Your branch is ahead of 'origin/master' by 1 commit` 这类提示，就是靠 upstream 才知道跟谁比。

所以你刚才那次 `--set-upstream` 之后，我也提示了「以后直接 `git push` 即可」——就是这个原因。
