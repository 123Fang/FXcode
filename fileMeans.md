# /packages/core/src/effect/observability.ts

**OpenTelemetry 可观测性的开关层**：如果配了 `OTEL_EXPORTER_OTLP_ENDPOINT` 环境变量，就把运行时的日志和调用链（traces）上报到远程 OTLP 后端（如 Grafana、Datadog、Jaeger）；没配置就走本地日志。

具体三件事：

1. **`resource()`** — 构建服务元数据（服务名 `opencode`、版本号、实例 UUID、进程角色等），给每条上报数据打标签，方便在后端按版本/实例等维度筛选。

2. **`logs()`** — 日志双写 Layer：本地 `EffectLogger.logger` + 远端 `OtlpLogger`（`/v1/logs`），一份不漏。

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
