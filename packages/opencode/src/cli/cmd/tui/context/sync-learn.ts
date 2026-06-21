// ============================================================
// 📡 sync.tsx — 数据同步中枢（带小白注释版）
// ============================================================
// 这个文件是 TUI（终端界面）和后端之间的"数据搬运工"。
// 它负责两件事：
//   1. 启动时从后端一次性拉取所有需要的数据
//   2. 运行时监听后端推送的变化，实时更新本地数据
// 其他界面组件只管从这里读数据，不用关心数据怎么来的。
// ============================================================

// ---------- 引入后端数据结构类型 ----------
// 这些是从 SDK 导入的"数据形状"定义，比如 Message 长什么样、Session 长什么样
import type {
  Message,       // 一条聊天消息
  Agent,         // AI 助手配置
  Provider,      // AI 模型提供商（如 OpenAI、Anthropic）
  Session,       // 一次对话会话
  Part,          // 消息的"零件"——一条消息可能由多个 Part 组成（文本、工具调用等）
  Config,        // 全局配置
  Todo,          // AI 待办事项
  Command,       // 自定义命令
  PermissionRequest,   // 权限请求（比如 AI 想读写文件时的弹窗）
  QuestionRequest,     // 提问请求（AI 向用户问问题）
  LspStatus,           // LSP（语言服务器）状态
  McpStatus,           // MCP（模型上下文协议）状态
  McpResource,         // MCP 资源
  FormatterStatus,     // 代码格式化工具状态
  SessionStatus,       // 会话状态
  ProviderListResponse,      // Provider 列表返回格式
  ProviderAuthMethod,        // Provider 认证方式
  VcsInfo,                   // 版本控制信息（git 分支等）
} from "@opencode-ai/sdk/v2"

// ---------- 引入工具库 ----------
// solid-js/store：一个响应式状态管理库，数据变了界面就自动刷新
import { createStore, produce, reconcile } from "solid-js/store"
// 项目上下文：获取当前项目的信息
import { useProject } from "@tui/context/project"
// 事件上下文：监听后端发来的各种事件
import { useEvent } from "@tui/context/event"
// SDK 客户端：跟后端通信的"信使"
import { useSDK } from "@tui/context/sdk"
// 二分查找工具：在有序数组中快速定位某个元素的位置
import { Binary } from "@opencode-ai/core/util/binary"
// 创建简化版上下文（类似 React 的 Context，但更轻量）
import { createSimpleContext } from "./helper"
// 快照类型定义
import type { Snapshot } from "@/snapshot"
// 退出处理
import { useExit } from "./exit"
// 命令行参数
import { useArgs } from "./args"
// SolidJS 的工具函数：batch 合并更新，onMount 挂载后执行
import { batch, onMount } from "solid-js"
// 日志工具
import * as Log from "@opencode-ai/core/util/log"
// 控制台状态的空值
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"
// Node.js 路径处理
import path from "path"
// 键值存储（本地缓存）
import { useKV } from "./kv"
// 聚合失败信息的工具函数
import { aggregateFailures } from "./aggregate-failures"

// ============================================================
// 📦 创建 Sync 上下文
// ============================================================
// createSimpleContext 创建一个"全局共享的数据袋"，
// 任何组件都可以通过 useSync() 来获取里面的数据。
// 就像全班同学可以看同一块黑板一样。
export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    // ============================================================
    // 🗄️ 本地数据仓库（store）
    // ============================================================
    // 这就是那块"黑板"，存着所有 TUI 需要展示的数据。
    // solid-js 的 createStore 是响应式的——数据一变，界面就自动更新。
    // 就像 Excel 里的公式单元格，源数据变了，结果自动跟着变。
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete" // 加载状态：加载中 / 半成品 / 全好了
      provider: Provider[]                        // 所有可用的 AI 提供商列表
      provider_default: Record<string, string>    // 每个类型默认用哪个提供商
      provider_next: ProviderListResponse         // provider 列表的完整返回
      console_state: ConsoleState                 // 控制台状态
      provider_auth: Record<string, ProviderAuthMethod[]>  // 每个提供商的认证方式
      agent: Agent[]                              // 所有可用 Agent 列表
      command: Command[]                          // 自定义命令列表
      permission: {                               // 权限请求，按会话 ID 分组
        [sessionID: string]: PermissionRequest[]
      }
      question: {                                 // 提问请求，按会话 ID 分组
        [sessionID: string]: QuestionRequest[]
      }
      config: Config                              // 全局配置
      session: Session[]                          // 会话列表
      session_status: {                           // 每个会话的状态
        [sessionID: string]: SessionStatus
      }
      session_diff: {                             // 每个会话的文件变更
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {                                     // 每个会话的待办事项
        [sessionID: string]: Todo[]
      }
      message: {                                  // 每个会话的消息列表
        [sessionID: string]: Message[]
      }
      part: {                                     // 每个消息的 Part 列表
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]                            // LSP 语言服务器状态列表
      mcp: {                                      // MCP 服务器状态
        [key: string]: McpStatus
      }
      mcp_resource: {                             // MCP 资源
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]                // 格式化工具状态列表
      vcs: VcsInfo | undefined                    // 版本控制信息（当前分支等）
    }>({
      // ---------- 初始值：全是空的 ----------
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",   // 一开始是 "加载中"
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    // ---------- 获取其他上下文 ----------
    const event = useEvent()     // 事件总线：监听后端发来的事件
    const project = useProject() // 项目信息：当前打开的是哪个项目
    const sdk = useSDK()         // SDK 客户端：向后端发请求的"水管"
    const kv = useKV()           // 本地键值存储：存一些本地设置

    // ============================================================
    // 🏷️ 记录哪些会话已经"完整同步"过
    // ============================================================
    // 有些会话只是列表里能看到，但消息详情还没拉下来。
    // 这个 Set 记录哪些会话已经拉过完整数据（消息、todo、diff）。
    // 避免重复请求——就像你不需要反复下载同一个文件。
    const fullSyncedSessions = new Set<string>()

    // ============================================================
    // 🔍 会话列表的查询参数
    // ============================================================
    // opencode 支持"目录过滤"——在不同的项目目录下看到的会话不同。
    // 这个函数决定是查所有项目会话，还是只查当前目录的。
    function sessionListQuery(): { scope?: "project"; path?: string } {
      // 如果用户关了"目录过滤"，就查所有项目会话
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      // 如果没有 worktree 或 directory 信息，查所有项目会话
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      // 否则，算出当前目录相对于项目根目录的路径，作为过滤条件
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),  // Windows 路径转成正斜杠
      }
    }

    // ============================================================
    // 📋 调用后端接口，获取会话列表
    // ============================================================
    // 只查最近 30 天内的会话，按 ID 字母排序
    function listSessions() {
      return sdk.client.session
        .list({
          start: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 天前的时间戳
          ...sessionListQuery(),                          // 目录过滤条件
        })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    // ============================================================
    // 🎧 事件监听：后端的"广播喇叭"
    // ============================================================
    // 后端有任何状态变化，就会发一个事件过来。
    // 这里相当于订阅了后端的"朋友圈"，有任何动静都知道。
    event.subscribe((event, { workspace }) => {
      // 根据事件类型分发处理
      switch (event.type) {
        // ----------------------------------------------------------
        // 🔄 服务器实例被销毁了 → 重新初始化
        // ----------------------------------------------------------
        case "server.instance.disposed":
          void bootstrap()
          break

        // ----------------------------------------------------------
        // ✅ 权限请求被回复了 → 从待处理列表中移除
        // ----------------------------------------------------------
        case "permission.replied": {
          // 找到这个会话的权限请求列表
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break  // 没有就忽略

          // 用二分查找找到这个请求在列表中的位置（请求列表按 ID 排好序了）
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break  // 没找到就算了

          // 从列表中删除这个已处理的请求
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)  // splice 删除第 match.index 个元素
            }),
          )
          break
        }

        // ----------------------------------------------------------
        // 🔔 新的权限请求来了
        // ----------------------------------------------------------
        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]

          // 如果这个会话还没有权限请求列表 → 新建一个
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }

          // 用二分查找看这个请求是否已经存在（可能是更新）
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            // 已存在 → 替换（reconcile 是增量更新，只改动变化的部分）
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }

          // 不存在 → 在正确位置插入（保持有序）
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)  // splice(match.index, 0, item) 是在 match.index 位置插入
            }),
          )
          break
        }

        // ----------------------------------------------------------
        // 💬 提问被回复或拒绝了 → 从待处理列表中移除
        // ----------------------------------------------------------
        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        // ----------------------------------------------------------
        // 🔔 新的提问来了
        // ----------------------------------------------------------
        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        // ----------------------------------------------------------
        // 📝 Todo 列表更新了 → 直接覆盖
        // ----------------------------------------------------------
        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        // ----------------------------------------------------------
        // 📁 文件变更（diff）更新了
        // ----------------------------------------------------------
        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        // ----------------------------------------------------------
        // 🗑️ 会话被删除了 → 从列表中移除
        // ----------------------------------------------------------
        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        // ----------------------------------------------------------
        // ✏️ 会话信息更新了（比如标题改了）
        // ----------------------------------------------------------
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            // 找到了 → 替换这个会话的信息
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          // 没找到 → 说明是新会话，插入到列表中
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        // ----------------------------------------------------------
        // 📊 会话状态变化（空闲 / 工作中 / 压缩中）
        // ----------------------------------------------------------
        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        // ----------------------------------------------------------
        // 💬 消息更新了（新消息来了或旧消息被编辑）
        // ----------------------------------------------------------
        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]

          // 如果这个会话还没有消息列表 → 创建
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }

          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            // 已存在 → 更新这条消息
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }

          // 新消息 → 按 ID 顺序插入
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )

          // 🧹 消息太多（超过 100 条）→ 删掉最老的那条，防止内存爆炸
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]  // 第一条就是最老的
            batch(() => {
              // 删掉最老的消息
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()  // shift 删掉数组第一个元素
                }),
              )
              // 同时也删掉这条消息对应的 Part 数据
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }

        // ----------------------------------------------------------
        // 🗑️ 消息被删除了
        // ----------------------------------------------------------
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        // ----------------------------------------------------------
        // 🧩 消息的"零件"（Part）更新了
        // ----------------------------------------------------------
        // 一条消息可能包含多个 Part：
        //   - 文本 Part（AI 说的话）
        //   - 工具调用 Part（AI 调用了什么工具）
        //   - 工具结果 Part（工具返回了什么）
        // 每个 Part 都独立存储，便于增量更新。
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            // 还没有这个消息的 Part 列表 → 创建
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            // 已存在 → 更新
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          // 新 Part → 按 ID 插入
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        // ----------------------------------------------------------
        // ✍️ 流式更新：AI 正在逐字吐出内容
        // ----------------------------------------------------------
        // 这是最有趣的部分！AI 回复不是一次性出来的，而是一个字一个字（或一小段一小段）流式地"吐"出来。
        // 每吐一小段，后端就发一个 delta 事件，告诉前端"把这个字符串拼到某个 Part 的某个字段上"。
        // 这样用户就能看到 AI 正在"打字"的效果，而不是干等着。
        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break  // 没有 Part 列表就忽略
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break  // 没找到对应的 Part 也忽略

          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              // 找到要更新的字段（比如 "text" 字段）
              const field = event.properties.field as keyof typeof part
              // 获取字段当前值，如果还没有就是空字符串
              const existing = part[field] as string | undefined
              // 拼接！把新的 delta 追加到已有内容后面
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        // ----------------------------------------------------------
        // 🗑️ 消息的某个 Part 被删除了
        // ----------------------------------------------------------
        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        // ----------------------------------------------------------
        // 🔧 LSP（语言服务器）状态变化
        // ----------------------------------------------------------
        case "lsp.updated": {
          const workspace = project.workspace.current()
          // 直接去后端拉最新的 LSP 状态并覆盖
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        // ----------------------------------------------------------
        // 🌿 版本控制分支变了（git 切换分支）
        // ----------------------------------------------------------
        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    // ---------- 获取退出功能和命令行参数 ----------
    const exit = useExit()
    const args = useArgs()

    // ============================================================
    // 🚀 核心启动流程：bootstrap（"启动引导"）
    // ============================================================
    // 这是整个文件的"发动机"。
    // 启动时分两阶段拉数据：
    //   第一阶段（阻塞）：必须等的数据，没拿到之前界面可能显示不全
    //   第二阶段（非阻塞）：可以先显示界面，后台慢慢补完
    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true  // 失败时是否致命退出
      const workspace = project.workspace.current()  // 当前工作空间
      const projectPromise = project.sync()          // 先同步项目信息
      const sessionListPromise = projectPromise.then(() => listSessions())  // 项目同步完再拉会话列表

      // ==========================================================
      // 🧱 第一阶段：阻塞请求（关键数据，必须等）
      // ==========================================================
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)  // 控制台数据拿不到就算了，用空值
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })

      // 把这些请求打包在一起，统一管理
      const blockingRequests: { name: string; promise: Promise<unknown> }[] = [
        { name: "config.providers", promise: providersPromise },
        { name: "provider.list", promise: providerListPromise },
        { name: "app.agents", promise: agentsPromise },
        { name: "config.get", promise: configPromise },
        { name: "project.sync", promise: projectPromise },
        // 如果是 --continue 模式（继续之前的会话），会话列表也是关键数据
        ...(args.continue ? [{ name: "session.list", promise: sessionListPromise }] : []),
      ]

      // 等待所有阻塞请求完成（allSettled：不管成功失败，都等）
      await Promise.allSettled(blockingRequests.map((r) => r.promise))
        .then((settled) => {
          // ---------- 检查有没有失败的 ----------
          // aggregateFailures 把所有失败的请求信息收集起来，
          // 一次性展示给用户，而不是让第一个失败就把后面的全吞了。
          const failure = aggregateFailures(blockingRequests.map((r, i) => ({ name: r.name, result: settled[i] })))
          if (failure) throw failure  // 有失败就抛异常
        })
        .then(async () => {
          // ---------- 全部成功 → 把数据写入 store ----------
          // 因为前面 promise 已经全部 resolve 了，这里 .then() 拿到的就是结果
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            // batch 把多次更新合并成一次界面刷新，避免闪来闪去
            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          // ----------------------------------------------------------
          // 第一阶段完成 → 状态变成 "partial"（半成品）
          // 界面可以显示了，但还需要补充更多数据
          // ----------------------------------------------------------
          if (store.status !== "complete") setStore("status", "partial")

          // ==========================================================
          // 🏃 第二阶段：非阻塞请求（次要数据，后台慢慢补）
          // ==========================================================
          // 这些都是同时发出，不互相等待。界面已经能看了，这些数据
          // 回来一个就更新一个，用户几乎无感知。
          void Promise.all([
            // 如果不是 --continue 模式，会话列表也是后台补
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            // 全好了！状态变成 "complete"
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          // ---------- 出错了 → 记录日志，必要时退出 ----------
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            await exit(e)  // 致命错误 → 退出程序
          } else {
            throw e
          }
        })
    }

    // ============================================================
    // 🎬 组件挂载后自动启动
    // ============================================================
    // onMount 是 SolidJS 的生命周期钩子，组件第一次渲染到屏幕后执行。
    // 这里就是整个数据同步流程的"开关"——页面一出来就开始拉数据。
    onMount(() => {
      void bootstrap()
    })

    // ============================================================
    // 📤 对外暴露的 API
    // ============================================================
    // 其他组件通过 useSync() 拿到的就是这个 result 对象。
    // 里面包含了所有数据 + 一些辅助方法。
    const result = {
      data: store,      // 整个数据仓库，组件可以直接读
      set: setStore,    // 更新数据的方法（一般组件不需要直接用）

      // 加载状态："loading" -> "partial" -> "complete"
      get status() {
        return store.status
      },

      // 是否准备好了（可以安全展示界面了）
      // 如果环境变量 OPENCODE_FAST_BOOT 设了，就不等，直接显示
      get ready() {
        if (process.env.OPENCODE_FAST_BOOT) return true
        return store.status !== "loading"
      },

      // 当前项目路径
      get path() {
        return project.instance.path()
      },

      // ==========================================================
      // 💬 会话相关操作
      // ==========================================================
      session: {
        // 根据 sessionID 获取单个会话
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },

        // 获取会话列表查询参数
        query() {
          return sessionListQuery()
        },

        // 手动刷新会话列表（比如切目录后）
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },

        // 获取某个会话的运行状态（idle / working / compacting）
        // 逻辑：
        //   - 会话不存在 → idle
        //   - 正在压缩 → compacting
        //   - 没有消息 → idle
        //   - 最后一条是用户消息（AI 还没回）→ working
        //   - 最后一条是 AI 但没完成 → working
        //   - 最后一条是 AI 且完成了 → idle
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)  // 取最后一条
          if (!last) return "idle"
          if (last.role === "user") return "working"  // 用户发了消息，AI 在思考
          return last.time.completed ? "idle" : "working"
        },

        // 完整同步某个会话：拉消息、todo、文件变更等详细信息
        // fullSyncedSessions 防止重复同步（幂等）
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return  // 已经同步过了，跳过

          // 同时发起三个请求：会话本身、消息、todo、diff
          const [session, messages, todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            sdk.client.session.messages({ sessionID, limit: 100 }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
          ])

          // 一次性更新 store 的多个字段
          setStore(
            produce((draft) => {
              // 更新会话信息（找到就替换，找不到就插入）
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)

              // 更新 todo 列表
              draft.todo[sessionID] = todo.data ?? []

              // 更新消息列表和 Part 数据
              const infos: (typeof draft.message)[string] = []
              for (const message of messages.data ?? []) {
                infos.push(message.info)                    // 消息元信息
                draft.part[message.info.id] = message.parts  // 消息的 Part 内容
              }
              draft.message[sessionID] = infos

              // 更新文件变更
              draft.session_diff[sessionID] = diff.data ?? []
            }),
          )

          // 标记已同步
          fullSyncedSessions.add(sessionID)
        },
      },

      // 把 bootstrap 也暴露出去，允许外部手动重新启动
      bootstrap,
    }

    return result
  },
})
