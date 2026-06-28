/**
 * ============================================================================
 * prompt.ts 学习注释版
 * ============================================================================
 *
 * 【整体功能】
 * 这个文件是 opencode 会话（Session）的"大脑"——它负责：
 * 1. 接收用户输入（文本/文件/agent/子任务），创建用户消息
 * 2. 进入主循环（runLoop），反复调用 LLM、收集工具调用结果、处理子任务/压缩
 * 3. 执行 Shell 命令并返回结果
 * 4. 执行自定义命令（Command），展开模板后送入 LLM
 * 5. 自动生成对话标题
 *
 * 【为什么大量使用 Effect】
 * 这个文件几乎把所有异步操作都包裹在 Effect 中，核心目的是：
 *   - 把"副作用管理"从"隐式魔法"变成"显式类型"
 *   - 每个函数的签名里直接声明了可能失败的类型（如 Image.Error、Session.BusyError），
 *     调用方不用猜"这个函数会不会抛异常"
 *   - 所有资源（Scope、Fiber、Latch）的获取和释放由 Effect 自动管理，杜绝泄漏
 *
 * 【如果不使用 Effect 会有什么坏处】
 * 1. 错误处理一塌糊涂：
 *    - async/await + try/catch 无法在类型层面区分"预期的业务错误"和"程序缺陷（bug）"
 *    - Effect 把错误分为两类：
 *      a) Effect.fail("业务错误")  — 类型签名上可见，调用方必须处理
 *      b) Effect.die("程序缺陷")   — 表示代码有 bug，不应该被 catch
 *    如果用原始 Promise，所有错误混在一起，调用方根本无法知道哪些要处理、哪些要崩溃
 *
 * 2. 资源泄漏风险高：
 *    - 这个文件里有大量需要"用完就关"的资源：Scope（生命周期）、Latch（同步开关）、
 *      AbortController（取消信号）、子进程、数据库连接
 *    - 如果用 try/finally 手动管理，很容易忘记释放，且嵌套多层后代码极其丑陋
 *    - Effect 的 Scope、addFinalizer、ensuring 等机制确保无论如何退出（成功/失败/中断）
 *      资源都会被正确释放
 *
 * 3. 并发控制困难：
 *    - Effect.forEach(..., { concurrency: "unbounded" }) 可以并发处理多个文件引用
 *    - 如果用 Promise.all + 手动控制并发数，代码会急剧膨胀
 *    - 更糟糕的是：当用户取消操作时，你需要手动追踪所有 Promise 并 abort 它们
 *      Effect 的中断传播（interruption propagation）自动向下传递取消信号
 *
 * 4. 可测试性差：
 *    - Effect 的 Layer 机制让所有依赖（数据库、文件系统、LLM、进程等）都是"注入"进来的
 *    - 测试时可以轻松替换为假的实现，而不需要 mock 全局模块
 *    - 如果用原始代码，测试任何一个函数都需要启动真实的数据、文件系统，几乎不可测
 *
 * 5. 可观测性差：
 *    - Effect.fn("Domain.method") 自动提供调用追踪（span），配合 EffectLogger 可以直接
 *      看到每一步的耗时和输入输出
 *    - 如果用 console.log 手动打日志，需要在每个函数入口加代码，而且看不到调用链路
 *
 * 6. 取消操作不可靠：
 *    - 用户随时可能取消一个正在运行的 LLM 调用或 shell 命令
 *    - 原生 AbortController 链接非常脆弱，常常忘记传递
 *    - Effect 的中断机制（Effect.onInterrupt）自动在 Fiber 树中传播，保证所有子操作都被取消
 *      runLoop 中就多次使用了 onInterrupt 来确保取消时更新消息状态
 *
 * 【Effect 核心概念速查】
 * - Effect.gen(function*() {...}):     用 generator 写异步代码（类似 async/await），但带有类型安全的错误通道
 * - yield* :                           在 gen 中"等待"一个 Effect 执行完成（类似 await），同时自动传播错误
 * - Effect.fn("name"):                 给 Effect 起个名字，用于调用链追踪和性能分析
 * - Layer.effect(Service, gen):        定义"如何创建某个服务"——简单说就是依赖注入的工厂函数
 * - yield* Xxx.Service:                从当前作用域"提取"一个已注入的服务实例（依赖获取）
 * - Effect.scoped:                     标记这个 Effect 需要一个"生命周期范围"，内部打开的资源会在离开范围时自动释放
 * - pipe:                              Effect 的函数式链式调用的核心方法，把前一步的结果传给下一步
 * - Effect.onInterrupt(callback):      当当前 Fiber 被中断时执行回调（用于清理工作）
 * - Effect.ensuring(callback):         无论成功/失败/中断都会执行回调（类似 finally）
 * - Latch:                             一种同步原语——打开前会阻塞，打开后放行（用在 shell 的"准备好再开始"）
 * - Effect.uninterruptibleMask:        创建一个"不可中断区域"——在其中执行的操作即使收到取消信号也不会中断
 *                                      常用于"标记状态为运行中"这种必须完成的操作
 *
 * ============================================================================
 */

import path from "path"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Log from "@opencode-ai/core/util/log"
import { SessionRevert } from "./revert"
import * as Session from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { Bus } from "../bus"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
// ↓ Effect 的子进程模块：类型安全地创建和管理子进程
// 不用 Effect：需要手动管理 child_process 的 stdout/stderr/exit 事件，容易写出不完整的流处理逻辑
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
// ↓ Effect 的流处理：把 Node.js 的可读流变成类型安全的、可组合的数据流
// 不用 Effect：手动处理流只能靠事件回调，一嵌套就变"回调地狱"，错误处理和取消都非常困难
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@/shell/shell"
import { ShellID } from "@/tool/shell/id"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
/**
 * ↓ Effect 核心导入
 *   - Cause:     错误原因的详细描述（类似"堆栈跟踪"但类型安全）
 *   - Effect:    核心类型——所有副作用的容器
 *   - Exit:      表示计算结果是"成功"还是"失败"（Effect 版的 Result 类型）
 *   - Latch:     同步原语——类似"门闩"，可以阻塞某个操作直到条件满足
 *   - Layer:     依赖注入的核心——定义"如何提供某个服务"
 *   - Option:    类型安全的"可能没有值"（代替 null/undefined）
 *   - Scope:     生命周期管理——保证资源在正确的时刻释放
 *   - Context:   依赖注入的容器——存储所有已提供的服务
 *   - Schema:    数据校验/序列化——类似 zod，但和 Effect 深度集成
 *   - Types:     类型工具
 */
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AgentAttachment, FileAttachment, ReferenceAttachment, Source } from "@opencode-ai/core/session-prompt"
import { Reference } from "@/reference/reference"
// ↓ 日期时间操作的类型安全封装
// 不用 Effect：原生 new Date() 的问题是：1) 不可变时间被隐式读取 2) 测试中无法替换"当前时间"
import * as DateTime from "effect/DateTime"
import { eq } from "@/storage/db"
import * as Database from "@/storage/db"
import { SessionTable } from "./session.sql"
import { referencePromptMetadata, referenceTextPart } from "./prompt/reference"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { LLMEvent } from "@opencode-ai/llm"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

/**
 * ============================================================================
 * Schema 解码器
 * ============================================================================
 * decodeUnknownExit: 把未知数据（如从数据库或 API 收到的 JSON）根据 Schema 解析，
 *   返回 Exit（成功/失败）。注意：Schema 解析失败不是"程序缺陷"，所以用的是 Exit 而非抛异常。
 *   如果不使用 Effect Schema：需要手写类型守卫 + try/catch，且无法在类型层面追踪校验失败的位置和原因。
 */
const decodeMessageInfo = Schema.decodeUnknownExit(MessageV2.Info)
const decodeMessagePart = Schema.decodeUnknownExit(MessageV2.Part)

/**
 * ============================================================================
 * 结构化输出的提示词
 * ============================================================================
 * 当用户要求"按 JSON 格式回答"时，系统会创建一个专用的 StructuredOutput 工具。
 * LLM 必须调用这个工具来提交最终答案，而不是用普通文本回复。
 * 这样做的目的：强制 LLM 输出符合 JSON Schema 的数据，而不是自由文本中"声称"包含 JSON。
 */
// 使用此工具按请求的结构化格式返回最终响应。
// - 你必须在响应结束时恰好调用一次此工具
// - 输入必须是符合所需 schema 的有效 JSON
// - 在调用此工具之前，请完成所有必要的研究和工具调用
// - 此工具提供你的最终答案——调用后不再执行任何后续动作
const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`
// 重要提示：用户已请求结构化输出。你必须使用 StructuredOutput 工具提供最终响应。不要以纯文本方式回复——你必须调用 StructuredOutput 工具，并按 schema 格式组织你的答案。


/**
 * ============================================================================
 * 日志工具
 * ============================================================================
 * Log.create: 普通的（非 Effect）日志器，用于非 Effect 上下文
 * EffectLogger.create: Effect 版本的日志器，可以用 yield* 在 Effect 中使用
 *   好处：日志自动带上 Effect.fn 的追踪信息（span ID、耗时等），不用手动拼接
 */
const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })

/**
 * ============================================================================
 * 辅助函数：判断一个工具调用是否是"被中断的孤儿"
 * ============================================================================
 * 场景：当 LLM 调用被重试或取消时，之前的 tool_use 块会被 cleanup() 标记为 interrupted=true。
 * 这些标记过的工具调用不需要被重新处理，因为它们不是"待处理的真实工作"。
 * 如果不做这个检查，hasToolCalls 判断会错误地把这些孤儿当作"还有待处理的工具调用"，
 * 导致主循环本该退出时无法退出，死循环。
 */
function isOrphanedInterruptedTool(part: MessageV2.ToolPart) {
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

/**
 * ============================================================================
 * Service Interface
 * ============================================================================
 * 定义了 SessionPrompt 服务对外暴露的 6 个核心操作。
 * 每个方法的 Effect.Effect<A, E> 中的 A 是成功返回值，E 是可能发生的错误类型。
 * 
 * 不使用 Effect 的坏处：
 *   如果用 Promise<A> 定义接口，调用方完全不知道这个函数会抛出什么错误，
 *   只能靠注释或全局搜索来了解。而 Effect 的错误类型写在签名里，编译器会强制检查。
 * 
 * 方法清单：
 *   cancel(sessionID)      — 取消正在运行的会话
 *   prompt(input)          — 处理用户输入，创建消息，启动主循环（核心入口）
 *   loop(input)            — 进入会话主循环（LLM 调用、工具执行、子任务处理等）
 *   shell(input)           — 执行 shell 命令，将输出作为工具结果返回
 *   command(input)         — 执行自定义命令（模板展开 + 子进程执行），然后送入 LLM
 *   resolvePromptParts(template) — 解析消息模板（如 @文件 引用、!命令 等）
 */
export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

/**
 * ============================================================================
 * Service 声明
 * ============================================================================
 * Context.Service<Service, Interface>()("@opencode/SessionPrompt")
 * 
 * 这是 Effect 的"服务注册"机制：
 *   1. 声明一个名为 "@opencode/SessionPrompt" 的依赖
 *   2. 它的输入类型是 Interface（调用方看到的方法集）
 *   3. 其他模块通过 yield* SessionPrompt.Service 来获取这个服务的实例
 * 
 * 不使用 Effect 的坏处：
 *   - 没有统一的依赖注入机制，每个模块会通过 import 直接耦合到具体实现
 *   - 测试时无法替换实现，只能 mock 整个模块（Jest mock），不精确且容易出错
 *   - Layer 的"按需实例化 + 自动生命周期管理"是手写代码极难复现的
 */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

/**
 * ============================================================================
 * Layer 定义 — 这是整个文件的心脏
 * ============================================================================
 * Layer.effect(Service, Effect.gen(...))
 * 
 * 这一大段代码定义了一个"工厂"：
 *   - 输入：一堆依赖服务（Session, Agent, Provider, Config, ... 共 30+ 个）
 *   - 输出：一个实现 Interface 的 Service 实例
 * 
 * 整个块内的代码通过 yield* Xxx.Service 获取依赖，然后组装出最终的 Service。
 * 
 * 用大白话说：
 *   "我需要做会话管理工作。要做这个，我得先有数据库（Session）、代理（Agent）、
 *   LLM 提供商（Provider）、配置（Config）……等等一大串东西。
 *   这些依赖不是我自己创建的——而是别人（Layer 系统）给我注入的。
 *   我的任务就是：拿到这些依赖后，拼出 cancel、prompt、loop、shell、command 这几个功能。"
 * 
 * 不使用 Effect Layer 的坏处：
 *   - 如果你用"在构造函数里 new 依赖"的方式，每一层都得知道如何创建它的所有依赖，
 *     形成了严格的创建顺序约束，改动一个依赖的创建方式会影响所有使用它的模块
 *   - Layer 的"声明式依赖"（我只说我要什么，不关心怎么创建）让模块之间彻底解耦
 *   - 测试时，Layer.provide(外部Mock) 一行代码替换依赖，而不用改变被测代码本身
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // ─── 第一步：从 Effect 容器中获取所有依赖服务 ───
    // yield* 是 Effect.gen 中的"等待并提取"语法
    // 它等价于：从上下文中取出某个服务，同时声明"如果取不到就报错"
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const references = yield* Reference.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    // ─── 第二步：把 prompt 的核心能力包装成 TaskPromptOps，供子任务工具使用 ───
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // cancel — 取消会话
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】取消指定会话的当前运行。
     * 【大白话】"用户点了停止按钮 → 通知状态管理器：这个会话不要继续了 → 当前运行的 Fiber 被中断"
     * 【解决的问题】用户需要主动终止正在运行的 LLM 调用或 shell 命令。
     *   如果不使用 Effect：手动维护 AbortController 的引用链非常容易断，
     *   经常出现"点了停止按钮，但后台 LLM 还在跑"的情况。
     *   Effect 的中断是传播式的——取消一个 Fiber，它的所有子 Fiber 也会被取消。
     */
    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* elog.info("cancel", { sessionID })
      yield* state.cancel(sessionID)
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // resolvePromptParts — 解析提示模板中的引用
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】把用户输入的消息模板解析成结构化的 parts 数组。
     * 【大白话】"用户输入里写了 @agent-name 或 @/path/to/file，这个函数把这些引用翻译成
     *   系统能理解的 parts（文本块、文件块、agent 块）"
     * 【解决的问题】
     *   消息模板是一种"人类友好"的输入方式（用户写 @某文件 就自动包含该文件内容），
     *   但 LLM 需要结构化的输入。这个函数就做这个翻译工作。
     * 【关键步骤】
     *   1. ConfigMarkdown.files() 从模板文本中提取所有 @文件 引用
     *   2. Effect.forEach(..., { concurrency: "unbounded" }) 并发处理每个引用：
     *      - 如果是已配置的 reference（如 @docs）→ 展开路径、检查存在性
     *      - 如果是普通文件路径 → 检查文件是否存在
     *      - 如果路径不存在 → 按 agent 名称去查找
     *   3. 返回组装好的 parts 数组
     * 【Effect 使用分析】
     *   - Effect.forEach 并发处理：如果用 for 循环一个个处理，速度会很慢；
     *     如果用 Promise.all 手动并发，取消操作时所有 Promise 都在后台继续跑，浪费资源
     *   - Effect.option 处理"文件可能不存在"：返回 Option.None 而非抛异常，
     *     避免 try/catch 把"文件不存在"和"真的出 bug 了"混在一起
     *   - fsys.stat().pipe(Effect.option) 的效果：文件存在 → Some(stat)，
     *     文件不存在 → None（不会中断整个处理流程）
     */
    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      const mentionSource = (match: RegExpMatchArray) => {
        const start = match.index ?? 0
        return { value: match[0], start, end: start + match[0].length }
      }
      // ↓ Effect.forEach: 并发遍历 files 数组
      //   concurrency: "unbounded" 表示无限制并发——所有文件引用同时处理
      //   不用 Effect：手动 Promise.all 没法优雅地做"当用户取消时自动中断所有并发请求"
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const slash = name.indexOf("/")
          const alias = slash === -1 ? name : name.slice(0, slash)
          const reference = yield* references.get(alias)
          if (reference) {
            const source = mentionSource(match)
            if (reference.kind === "invalid") {
              parts.push(
                referenceTextPart({ reference, source, target: slash === -1 ? undefined : name.slice(slash + 1) }),
              )
              return
            }

            yield* references.ensure(reference.path)
            if (slash === -1) {
              parts.push(referenceTextPart({ reference, source }))
              return
            }

            const target = name.slice(slash + 1)
            const targetPath = path.resolve(reference.path, target)
            if (!AppFileSystem.contains(reference.path, targetPath)) {
              parts.push(
                referenceTextPart({
                  reference,
                  source,
                  target,
                  targetPath,
                  problem: `Path escapes configured reference @${alias}: ${target}`,
                }),
              )
              return
            }

            const info = yield* fsys.stat(targetPath).pipe(Effect.option)
            if (Option.isNone(info)) {
              parts.push(
                referenceTextPart({
                  reference,
                  source,
                  target,
                  targetPath,
                  problem: `Path does not exist inside configured reference @${alias}: ${target}`,
                }),
              )
              return
            }

            parts.push({
              type: "file",
              url: pathToFileURL(targetPath).href,
              filename: name,
              mime: info.value.type === "Directory" ? "application/x-directory" : "text/plain",
            })
            return
          }

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // title (ensureTitle) — 自动生成对话标题
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】当用户发送第一条消息后，自动用 LLM 为这次对话生成一个标题。
     * 【大白话】"对话刚开始时，后台偷偷把用户第一条消息发给一个小模型，让它总结出标题"
     * 【解决的问题】
     *   "2024-01-01 12:00:00 的对话"这种默认标题毫无意义。自动生成标题让对话列表可读。
     * 【执行条件】
     *   1. 不是子对话（没有 parentID）
     *   2. 当前标题还是默认标题
     *   3. 只有一条"真实的用户消息"（排除纯子任务等合成消息）
     * 【Effect 使用分析】
     *   - Stream.filter / Stream.map / Stream.mkString: 处理 LLM 的流式输出。
     *     不用 Effect Stream：需要手动拼接 chunk → 监听 end → 解析完整结果，
     *     回调嵌套深，取消时还要手动 disconnect 连接
     *   - Effect.orDie: 如果标题生成失败，当作程序缺陷直接崩溃（因为这是后台功能，
     *     失败不应该影响前台用户，但崩溃记录了错误可以被监控到）
     *   - Effect.catchCause: 标题设置失败只记日志，不影响会话继续
     */
    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: MessageV2.WithParts[]
      providerID: ProviderID
      modelID: ModelID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      // ↓ 流式调用 LLM 获取标题文本
      //   Stream.filter(LLMEvent.is.textDelta): 只保留文本增量事件（过滤掉工具调用等）
      //   Stream.map(e => e.text): 提取纯文本
      //   Stream.mkString: 把所有文本 chunk 拼接成一个完整字符串
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      // ↓ 设置标题。如果失败只记日志，不影响主流程
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: Cause.squash(cause) })))
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // handleSubtask — 处理子任务
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】执行一个子任务（subtask）——用另一个 agent 处理一部分工作。
     * 【大白话】"主 agent 说'让张三去查数据库'→ 系统创建一个 assistant 消息记录
     *   → 调用 TaskTool 执行子 agent 逻辑 → 把结果写回消息 → 可选地再让主 agent 总结结果"
     * 【解决的问题】
     *   复杂任务需要分解成多个子步骤，每个子步骤由专业的 agent 完成。
     *   比如主 agent 负责协调，子 agent 负责代码生成、测试、搜索等。
     * 【Effect 使用分析】
     *   - Effect.catchCause: 子任务执行失败不应该让整个会话崩溃，所以把错误捕获取而
     *     不抛出（return Effect.void），同时在 tool part 里记录错误信息
     *   - Effect.onInterrupt: 用户取消操作时，需要 abort 子任务的 AbortController，
     *     并正确更新 assistant 消息和 tool part 的状态
     *   - 错误的双重记录（error 变量 + sessions.updatePart）：确保无论是正常完成、捕获异常、
     *     还是被中断，消息状态最终都是正确的（completed/error）
     */
    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: MessageV2.SubtaskPart
      model: Provider.Model
      lastUser: MessageV2.User
      sessionID: SessionID
      session: Session.Info
      msgs: MessageV2.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      // ↓ 核心执行逻辑
      //   Effect.catchCause: 子任务失败 → 记录错误但不崩溃，把 error 信息存起来后续更新 part 状态
      //   Effect.onInterrupt: 用户取消时 → 1) abort 子任务 2) 更新 assistant 消息状态 3) 更新 tool part 为 error
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies MessageV2.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
            return Effect.void
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      // ↓ 根据执行结果更新 tool part 状态：成功 → completed，失败 → error
      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!task.command) return

      // ↓ 如果子任务是 command 触发的，需要在子任务完成后插入一条合成消息，
      //   让主 agent 总结子任务的输出并继续工作
      const summaryUserMsg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies MessageV2.TextPart)
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // shellImpl — Shell 命令执行的底层实现
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】执行一个 shell 命令，把输出以流式的方式写回会话。
     * 【大白话】"用户在对话里执行了一个 shell 命令 → 创建消息记录 → 启动子进程
     *   → 把 stdout 实时写回消息 → 进程结束后标记完成/错误"
     * 【解决的问题】
     *   用户需要在 AI 对话中运行命令并看到结果（如 npm install、测试等），
     *   AI 也需要看到命令输出来决定下一步。
     * 【Effect 使用分析】
     *   - Effect.uninterruptibleMask(restore => ...):
     *     创建一个"外层不可中断，内层通过 restore() 恢复可中断"的区域。
     *     为什么需要不可中断？因为标记消息"开始执行"的状态更新必须原子完成——
     *     如果状态写到一半被中断了，数据库就留下了一个"中间态"的脏消息。
     *     但是命令的实际执行（子进程启动）可以在 restore() 内被中断。
     *   - ChildProcess + spawner.spawn: Effect 的类型安全子进程管理。
     *     不用 Effect：child_process.spawn 的 stdout/sterr 是 Node.js Stream，
     *     需要用事件回调处理，容易出错。而且进程的 kill + 超时需要有状态机管理。
     *   - Stream.runForEach(Stream.decodeText(handle.all), ...):
     *     把子进程的输出流解码为文本，逐块消费（在这里逐块更新消息的 metadata）。
     *     不用 Effect Stream：需要手动监听 data 事件、处理 backpressure、管理 Buffer 拼接，
     *     这些琐碎的细节用 callbacks 写出来又长又乱。
     *   - handle.exitCode: 等待子进程结束并获取退出码。和上面的流处理自动协调。
     *   - Effect.scoped: 确保子进程资源在 Effect 结束时被正确清理（kill）。
     *   - Effect.ensuring(markReady): 无论 setup 阶段成功还是失败，都要打开 ready Latch，
     *     防止调用方永远等待。
     *   - Latch: 这个"门闩"确保了 shell 命令的调用方（shell 函数）能知道：
     *     "消息已经创建完成、可以返回给用户了"，否则用户可能在消息还没写入数据库时
     *     就看到一个空白状态。
     */
    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: MessageV2.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: MessageV2.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: MessageV2.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: MessageV2.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Shell.Started, {
                sessionID: input.sessionID,
                timestamp: DateTime.makeUnsafe(started),
                callID: part.callID,
                command: input.command,
              })
            }
            return { msg, part, cwd: ctx.directory }
            // ↓ Effect.ensuring(markReady): 无论消息创建是否成功，都要打开 Latch
            //   否则 shell() 函数中的 startShell 会永远阻塞在 ready.wait 上
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          // ↓ finish 也是 uninterruptible 的——状态更新不能做一半被中断
          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Shell.Ended, {
                  sessionID: input.sessionID,
                  timestamp: DateTime.makeUnsafe(completed),
                  callID: part.callID,
                  output,
                })
              }
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output, description: "" },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          // ↓ restore() 恢复可中断性——子进程的实际执行可以被打断
          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              // ↓ Stream.runForEach: 逐块读取子进程输出并实时更新消息
              //   Stream.decodeText: 把字节流转为文本流
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output, description: "" }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)
          //   ↑ .pipe(Effect.exit): 把执行结果包装为 Exit 类型（成功/失败/中断），
          //     避免错误直接传播到外层导致 finish 被跳过

          // ↓ 根据 Exit 判断进程结束方式
          //   - 失败 + 有中断信号 + 没有 bug(die) → 用户取消了
          //   - 失败 + 不是取消也不是 bug → 命令执行报错了
          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // getModel — 获取 LLM 模型实例（带错误提示）
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】从 Provider 获取指定的模型实例，如果模型不存在，给出友好的错误提示。
     * 【大白话】"按 providerID + modelID 去找模型配置；找不到就告诉用户'这个模型不存在，你是不是想说 XXX？'"
     * 【Effect 使用分析】
     *   - .pipe(Effect.exit) + Exit.isSuccess: 把 Effect 的失败转为 Exit 对象检查。
     *     这种方式比 try/catch 更干净——不用嵌套 try，代码是扁平的。
     */
    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // currentModel — 获取当前会话正在使用的模型
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】查找当前会话应该使用哪个模型。查找顺序：
     *   1. 数据库里会话记录中保存的模型
     *   2. 会话历史中最近一条用户消息的模型
     *   3. Provider 的默认模型
     * 【大白话】"先看会话用到什么模型了；没有就看历史记录；还没有就用系统的默认模型"
     */
    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = Database.use((db) =>
        db.select({ model: SessionTable.model }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
      )
      if (current?.model) {
        return {
          providerID: ProviderID.make(current.model.providerID),
          modelID: ModelID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // createUserMessage — 创建用户消息（整个文件里最核心的函数之一）
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】接收用户的 PromptInput，创建一条完整的用户消息。
     *   这是整个会话管道的入口——用户输入从这里进入系统，然后触发 runLoop 主循环。
     * 【大白话】"用户发了一条消息 → 解析消息里的各种引用（文件、agent、MCP 资源）
     *   → 把引用内容自动读出来附加到消息里 → 组装成一条完整消息 → 存入数据库
     *   → 触发插件钩子 → 返回组装好的消息对象"
     *
     * 【解决了什么问题】
     *   用户输入可以包含多种引用：
     *   - @文件名：自动读取文件内容，作为消息的一部分
     *   - @agent名：触发子 agent 调用
     *   - MCP 资源引用：从 MCP 服务器读取资源
     *   - data: URL：内联内容
     *   这个函数把所有引用"展开"成 LLM 能理解的结构化消息
     *
     * 【Effect 使用分析】
     *   - Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }):
     *     并发解析多个 part（文件引用、agent 引用、文本等）。
     *     如果用 Promise.all，取消时无法自动中断所有正在读文件的 Promise。
     *   - Effect.addFinalizer: 在当前 Effect 作用域结束时（消息处理完毕）自动清理
     *     instruction 缓存。
     *   - Effect.scoped: createUserMessage 整体是 scoped 的，
     *     意味着内部打开的所有资源（如文件读取）都会在函数结束时自动释放。
     *   - Effect.gen 内部的"早返回"风格（if (!ag) throw error）：
     *     在 generator 中使用 throw 来触发 Effect.fail，比 Effect.fail(new Error())
     *     更简洁。
     */
    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const current = Database.use((db) =>
        db
          .select({ agent: SessionTable.agent, model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get(),
      )
      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      // ─── 如果 agent 或 model 切换了，发布事件通知 UI 更新 ───
      if (current?.agent !== info.agent) {
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          agent: info.agent,
        })
      }
      if (
        current?.model?.providerID !== info.model.providerID ||
        current.model.id !== info.model.modelID ||
        (current.model.variant === "default" ? undefined : current.model.variant) !== info.model.variant
      ) {
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          model: {
            id: ModelV2.ID.make(info.model.modelID),
            providerID: ProviderV2.ID.make(info.model.providerID),
            variant: ModelV2.VariantID.make(info.model.variant ?? "default"),
          },
        })
      }

      // ↓ 在消息处理完成后自动清理 instruction 缓存
      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      // ─── 内层辅助：从文件 part 中提取 reference 上下文 ───
      // 例如用户写了 @docs/api-reference → 系统发现 docs 是一个已配置的 reference
      // → 自动生成一段文本告诉 LLM "这个文件来自 @docs reference"
      const referenceContextFromFilePart = Effect.fnUntraced(function* (
        part: Extract<PromptInput["parts"][number], { type: "file" }>,
        filepath: string,
      ) {
        const name = part.filename?.replace(/#\d+(?:-\d*)?$/, "")
        if (!name) return
        const slash = name.indexOf("/")
        if (slash === -1) return

        const reference = yield* references.get(name.slice(0, slash))
        if (!reference || reference.kind === "invalid") return
        if (!AppFileSystem.contains(reference.path, filepath)) return

        const target = path.relative(reference.path, filepath).split(path.sep).join("/")
        if (!target || target.startsWith("../") || target === "..") return

        return referenceTextPart({
          reference,
          source: part.source?.text ?? { value: `@${name}`, start: 0, end: name.length + 1 },
          target,
          targetPath: filepath,
        })
      })

      // ─── resolvePart：解析单个 part 的核心逻辑 ───
      // 每种 part 类型有不同的处理方式：
      //   file + MCP 资源 → 从 MCP 服务器读取内容
      //   file + data: URL → 解码 data URL
      //   file + file: URL + 文本 → 用 Read tool 读取文件内容
      //   file + file: URL + 目录 → 用 Read tool 读取目录列表
      //   file + file: URL + 其他 → base64 编码整个文件
      //   agent → 附加 agent 描述文本
      //   文本/其他 → 原样保留
      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if ("text" in c && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && c.blob) {
                  const mime = "mimeType" in c ? c.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mime}]`,
                  })
                }
              }
              pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const referenceContext = yield* referenceContextFromFilePart(part, filepath)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              // ↓ execRead 包装：用 Read tool 读取文件，同时注入 onInterrupt 来连接 AbortController
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<MessageV2.Part>[] = [
                  ...(referenceContext
                    ? [{ ...referenceContext, messageID: info.id, sessionID: input.sessionID }]
                    : []),
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    ...(referenceContext
                      ? [{ ...referenceContext, messageID: info.id, sessionID: input.sessionID }]
                      : []),
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  ...(referenceContext
                    ? [{ ...referenceContext, messageID: info.id, sessionID: input.sessionID }]
                    : []),
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                ...(referenceContext ? [{ ...referenceContext, messageID: info.id, sessionID: input.sessionID }] : []),
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      // ↓ 并发解析所有 part，然后展平成一个数组
      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      // ↓ 对图片类型的 part 进行归一化处理（压缩、格式统一）
      //   Effect.catchIf 只捕获特定的 ResizerUnavailableError，其他错误仍然会传播
      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      // ─── Schema 校验（开发调试用）：检查消息和 parts 是否符合格式 ───
      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      parts.forEach((part, index) => {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      })

      // ↓ 保存消息和 parts 到数据库
      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      // ─── 构建 nextPrompt：为双写到新事件系统准备数据 ───
      // 把 parts 分类为 text/files/agents/references/synthetic 五类
      const nextPrompt = parts.reduce(
        (result, part) => {
          if (part.type === "text") {
            if (part.synthetic) result.synthetic.push(part.text)
            else result.text.push(part.text)
            const reference = referencePromptMetadata(part.metadata?.reference)
            if (reference) {
              result.references.push(
                new ReferenceAttachment({
                  name: reference.name,
                  kind: reference.kind,
                  uri: reference.path ? pathToFileURL(reference.path).href : undefined,
                  repository: reference.repository,
                  branch: reference.branch,
                  target: reference.target,
                  targetUri: reference.targetPath ? pathToFileURL(reference.targetPath).href : undefined,
                  problem: reference.problem,
                  source: new Source({
                    start: reference.source.start,
                    end: reference.source.end,
                    text: reference.source.value,
                  }),
                }),
              )
            }
          }
          if (part.type === "file") {
            result.files.push(
              new FileAttachment({
                uri: part.url,
                mime: part.mime,
                name: part.filename,
                source: part.source
                  ? new Source({
                      start: part.source.text.start,
                      end: part.source.text.end,
                      text: part.source.text.value,
                    })
                  : undefined,
              }),
            )
          }
          if (part.type === "agent") {
            result.agents.push(
              new AgentAttachment({
                name: part.name,
                source: part.source
                  ? new Source({
                      start: part.source.start,
                      end: part.source.end,
                      text: part.source.value,
                    })
                  : undefined,
              }),
            )
          }
          return result
        },
        {
          text: [] as string[],
          files: [] as FileAttachment[],
          agents: [] as AgentAttachment[],
          references: [] as ReferenceAttachment[],
          synthetic: [] as string[],
        },
      )

      // ─── 双写到新事件系统（v2 迁移期的过渡代码） ───
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          prompt: {
            text: nextPrompt.text.join("\n"),
            files: nextPrompt.files,
            agents: nextPrompt.agents,
            references: nextPrompt.references,
          },
        })
      }
      for (const text of nextPrompt.synthetic) {
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(info.time.created),
            text,
          })
        }
      }

      return { info, parts }
    }, Effect.scoped)

    // ═══════════════════════════════════════════════════════════════════════════
    // prompt — 用户输入的主入口
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】处理用户输入的主入口。创建用户消息，然后启动主循环。
     * 【大白话】"用户发了一条消息 → 1) 获取会话 2) 清理之前的 revert 3) 创建消息
     *   4) 合并工具权限 5) 如果不需要回复就直接返回，否则进入 runLoop 主循环"
     * 【解决的问题】
     *   这是用户交互的唯一入口。所有"用户说了什么→AI 回复什么"的流程都从这里开始。
     *   noReply 参数允许"只记录消息、不触发 LLM"的模式（如记录 shell 命令结果）。
     */
    const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: Permission.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      return yield* loop({ sessionID: input.sessionID })
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // lastAssistant — 获取最后一条助手消息（用于作为循环返回值）
    // ═══════════════════════════════════════════════════════════════════════════
    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // runLoop — 主循环（整个文件里最关键的函数）
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】不断循环处理会话中的消息：调用 LLM → 收集结果 → 执行工具 → 处理子任务 → ...
     *   直到 LLM 不再需要调用工具（finish 不是 "tool-calls"），或者达到最大步数。
     * 【大白话】"这是 AI 对话的'对话引擎'。每条用户消息触发的一次 LLM 调用可能不够：
     *   LLM 会说'我要查数据库'→ 系统执行 SQL → 把结果喂回 LLM → LLM 又说'我要读文件'
     *   → 系统读文件 → 把内容喂回 LLM → LLM 终于说'我回答完了'。
     *   这个'来回对话'就是 runLoop 要做的事。"
     *
     * 【解决了什么问题】
     *   1. LLM 的"多步推理"问题：LLM 一次回复可能不完整，需要多轮 tool-use 才能完成
     *   2. 上下文过长问题：自动检测是否需要压缩（compaction）
     *   3. 子任务调度问题：用户消息可能包含需要子 agent 处理的任务
     *   4. 结构化输出问题：如果用户要求 JSON 输出，强制 LLM 用专用工具返回
     *   5. 最大步数保护：防止 agent 无限循环（通过 agent.steps 限制）
     *
     * 【Effect 使用分析】
     *   - Effect.onInterrupt: 循环中的 LLM 调用被中断时，自动将 assistant 消息标记为 abort 状态
     *   - Effect.forkIn(scope): 标题生成和摘要生成都是"后台任务"——不阻塞主循环，
     *     但如果整个会话被取消，这些后台任务也会被自动中断
     *   - Effect.ignore: 后台任务的失败不应该传播到主循环，所以 .pipe(Effect.ignore) 吞掉错误
     *   - Effect.ensuring: 循环每轮结束时自动清理 instruction 缓存
     *   - while(true) 循环 + break/continue：在主循环中使用 break/continue 控制流，
     *     这种写法和 Effect 的异常传播机制不冲突——throw 错误会跳出循环并被 Effect 捕获，
     *     break 则是正常的循环退出
     */
    const runLoop: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        const slog = elog.with({ sessionID })
        let structured: unknown
        let step = 0
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        // ↓ 主循环：直到 LLM 停止调用工具或达到步数上限
        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* slog.info("loop", { step })

          // ↓ 从 DB 加载消息 → 压缩过滤 → 重排为 [摘要user, 摘要asst, ...tail..., 继续user]
          let msgs = yield* MessageV2.filterCompactedEffect(sessionID)

          // ↓ 提取关键消息摘要：最新 user、assistant、已完成的 assistant、待处理 task
          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          // ↓ 通过 role + id 定位最后一条 assistant 消息的完整体（含 parts 数组）
          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // ↓ 检查是否有真实的工具调用（排除中断孤儿和 provider 自动执行的）
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          // ↓ 退出条件：LLM 已停止（finish 不是 tool-calls），且没有待处理的工具调用
          if (
            lastAssistant?.finish &&
            !["tool-calls"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is MessageV2.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* slog.warn("loop exit with orphaned interrupted tool", {
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            yield* slog.info("exiting loop")
            break
          }

          // ↓ 步数递增（仅限通过"准备 LLM 调用"分支，task 分支 continue 不过此处）
          step++

          // ↓ 第一步时启动后台标题生成（不阻塞主循环）
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          // ↓ 获取完全解析的模型实例（含 provider、endpoint、token 等）
          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          // ↓ 弹出待处理的 compaction/subtask 任务
          const task = tasks.pop()

          // ↓ 如果有子任务待处理 → 先处理子任务
          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          // ↓ 如果需要压缩上下文 → 先执行压缩
          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          // ↓ 检查上下文是否溢出 → 需要自动压缩
          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }

          // ↓ 获取 agent 配置（模式、权限、系统提示词等）
          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          // ↓ agent 配置的最大步数限制，防止死循环
          const maxSteps = agent.steps ?? Infinity
          // ↓ 是否是最后一步（达到 maxSteps 上限后，本轮不发工具给 LLM，强制它直接回答）
          const isLastStep = step >= maxSteps

          // ↓ 应用提醒（如"30分钟过去了，你该做总结了"）
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(AppFileSystem.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )

          // ↓ 创建 assistant 消息（LLM 将回复的内容会填充到这里）
          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          // ↓ 取消时的清理函数：标记消息为 abort 状态
          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          // ↓ 创建 processor：LLM 调用的执行器
          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          // ════════════ 单轮处理：LLM 调用 + 工具执行 + 结果判断 ════════════
          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            // ↓ 最后一条 user 消息（可能含 agent part，用于多 agent 切换）
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            // ↓ 如果 user 消息中包含 agent part → 跳过工具权限检查（切换 agent 内部逻辑）
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            // ↓ 暴露 cancel / prompt / resolvePromptParts 给子 agent（task 工具使用）
            const promptOps = yield* ops()

            // ↓ 解析当前 agent 可用的工具集
            const tools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
            }).pipe(
              Effect.provideService(Plugin.Service, plugin),
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(MCP.Service, mcp),
              Effect.provideService(Truncate.Service, truncate),
            )

            // ↓ 如果用户请求了结构化输出（JSON 格式），创建一个 StructuredOutput 工具
            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            // ↓ 第一步时启动后台摘要任务
            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            // ↓ 多轮对话中，把新用户的消息包装成 system-reminder 格式
            //   让 LLM 知道这些是"后续指令"而非"初始问题"
            if (step > 1 && lastFinished) {
              for (const m of msgs) {
                if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
                for (const p of m.parts) {
                  if (p.type !== "text" || p.ignored || p.synthetic) continue
                  if (!p.text.trim()) continue
                  p.text = [
                    "<system-reminder>",
                    "The user sent the following message:",
                    p.text,
                    "",
                    "Please address this message and continue with your tasks.",
                    "</system-reminder>",
                  ].join("\n")
                }
              }
            }

            // ↓ 插件钩子：允许插件在消息发送前修改消息
            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            // ↓ 并行获取：skills、环境变量、系统指令、模型消息
            const [skills, env, instructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              MessageV2.toModelMessagesEffect(msgs, model),
            ])
            const system = [...env, ...instructions, ...(skills ? [skills] : [])]
            const format = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)

            // ↓ **核心 LLM 调用**：把消息、工具、system prompt 一起发给模型
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            // ↓ 如果结构化输出已完成 → 标记结束
            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            // ↓ 判断 LLM 是否已正常结束（finish 存在且不是 tool-calls / unknown）
            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              if (format.type === "json_schema") {
                // ↓ LLM 停了但没返回结构化输出 → 标记错误
                handle.message.error = new MessageV2.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            // ↓ processor 明确要求停止 → 退出循环
            if (result === "stop") return "break" as const
            // ↓ processor 要求压缩（如 LLM 返回 context_length_exceeded）→ 创建压缩任务
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            // ↓ 默认继续循环（下一轮会检测到新工具调用/压缩任务）
            return "continue" as const
          }).pipe(
            // ↓ 每轮结束时清理 instruction 缓存
            Effect.ensuring(instruction.clear(handle.message.id)),
            // ↓ 被中断时更新消息状态
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") break
          continue
        }

        // ↓ 循环结束后异步清理过期的压缩产物
        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    // ═══════════════════════════════════════════════════════════════════════════
    // loop — 主循环的入口函数
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】确保会话在正确状态下运行主循环。
     * 【大白话】"告诉状态管理器：我要开始跑 runLoop 了。如果已经有一个在跑，返回上次的结果；
     *   否则启动新的。"
     * 【Effect 使用分析】
     *   - state.ensureRunning: 利用 SessionRunState 管理并发——同一个会话同一时间只能有一个
     *     runLoop 在运行。如果不使用这种管理，两个并发请求可能导致重复调用 LLM、浪费 token。
     */
    const loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // shell — Shell 命令执行的入口
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】执行 Shell 命令的入口。用 Latch 确保 shellImpl 的消息创建完成后才对外暴露结果。
     * 【大白话】"用户要执行 shell 命令 → 先创建消息记录 → 等到消息写到数据库了
     *   → 通知外面'准备好了' → 返回 shellImpl 的执行结果"
     * 【Effect 使用分析】
     *   - Latch.make() + ready.open / ready.wait:
     *     Latch 像一个"一次性门闩"。创建时是关着的，wait 会阻塞直到 open 被调用。
     *     这里用它来保证 shell 的消息在"准备好"之前不会被调用方拿到。
     *     如果不使用 Latch：就只能靠 Promise 或手动状态变量，无法在 Effect 的类型系统中
     *     清晰地表达"我还没准备好，等等"的语义。
     *   - state.startShell: 和 loop 一样，确保同一会话同一时间只有一个 shell 在执行，
     *     返回占位结果（上次 assistant 消息）来防止状态不一致。
     */
    const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // command — 自定义命令执行
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】执行一个自定义命令（Command）。包含模板展开、shell 内联、参数替换等。
     * 【大白话】"用户输入了一个自定义命令（如 /review）→ 查配置获取命令模板
     *   → 把模板里的占位符替换为实际参数 → 如果模板里有 shell 内联就执行 shell
     *   → 确定用哪个 agent 执行 → 决定是子任务还是直接提示 → 调用 prompt 启动处理"
     * 【解决的问题】
     *   用户定义的可复用操作（如 /deploy、/lint、/review），这个函数负责把它们
     *   翻译成标准的 PromptInput 然后走正常的 prompt→loop 流程。
     * 
     * 【Effect 使用分析】
     *   - Effect.promise(async () => cmd.template): 将 Promise 包装为 Effect。
     *     原生的 async/await 没有中断机制——如果你取消了命令执行，
     *     Promise 仍然在后台跑。Effect.promise 包装后可以被 Effect 中断。
     */
    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      // ↓ Shell 内联：模板中的 !`command` 被当成 shell 命令执行，输出替换到模板中
      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...templateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      // ↓ 核心：把组装好的 parts 送入 prompt，走正常的 AI 对话流程
      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    // ─── 把所有函数组装成 Service 实例 ───
    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

/**
 * ============================================================================
 * defaultLayer — 对外提供的默认 Layer
 * ============================================================================
 * Layer.suspend 是延迟创建——只有在真正需要时才构建，避免循环依赖。
 * 
 * .pipe(Layer.provide(Xxx.layer)) 链式提供依赖：
 *   每一行 Layer.provide 都是告诉 Effect："创建 SessionPrompt 时，
 *   Session 依赖需要这样获取、Provider 依赖需要那样获取... "
 * 
 * 不使用 Layer 的坏处：
 *   - 如果手动在构造函数里 new 依赖：所有对象的创建顺序被硬编码，改一个就要改所有
 *   - Layer 是"声明式"的：我只说我要谁，不关心怎么创建。
 *     测试时可以 Layer.provide(测试Mock) 一行替换全部依赖
 */
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        EventV2Bridge.defaultLayer,
        Agent.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        Reference.defaultLayer,
        Bus.layer,
        CrossSpawnSpawner.defaultLayer,
        RuntimeFlags.defaultLayer,
      ),
    ),
  ),
)

/**
 * ============================================================================
 * Schema 定义 — 输入类型
 * ============================================================================
 * 这些 Schema 定义了各操作的输入格式，同时也用于运行时校验和 JSON Schema 生成。
 * 
 * 不使用 Effect Schema 的坏处：
 *   - 如果用 TypeScript 的 interface：只有编译时校验，运行时收到的数据
 *     （来自 CLI 参数、API 请求体）无法自动校验
 *   - Effect Schema 同时提供：TypeScript 类型 + 运行时解码 + 错误报告 + JSON Schema 输出
 *     一个 Schema 定义，四处可用
 */
const ModelRef = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(MessageV2.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      MessageV2.TextPartInput,
      MessageV2.FilePartInput,
      MessageV2.AgentPartInput,
      MessageV2.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(MessageV2.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/**
 * ============================================================================
 * createStructuredOutputTool — 创建结构化输出工具
 * ============================================================================
 * 【功能】创建一个 AI SDK 工具，用于强制 LLM 以 JSON Schema 格式输出。
 * 【大白话】"用户要 JSON 回答 → 给 LLM 一个'提交 JSON'的工具 → LLM 只能用这个工具回答
 *   → 这就保证了输出格式正确"
 * 【解决的问题】
 *   LLM 在"自由文本"模式下可能会在 JSON 外面包 markdown 围栏（```json...```）、
 *   或者格式不符合要求。通过把"回答"变成本身就是一个工具调用，强制 LLM 走工具输入校验，
 *   AI SDK 会自动根据 inputSchema 校验 LLM 的参数。
 */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}

// ============================================================================
// 正则表达式常量
// ============================================================================
const bashRegex = /!`([^`]+)`/g
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"
