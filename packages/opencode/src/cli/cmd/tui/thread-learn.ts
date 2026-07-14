/**
 * ============================================================================
 * TuiThreadCommand — opencode 的默认启动命令
 * ============================================================================
 *
 * 【一句话概括】
 * 当你终端里敲 `opencode` 回车时，就是这个文件在响应。它负责同时启动
 * "后端服务"和"前端 TUI 界面"，然后让你可以愉快地在终端里和 AI 对话。
 *
 *
 * 【整体架构 —— 用前端类比理解】
 *
 * 想象你要做一个全栈应用，有后端 API + 前端 React 页面。你打开了一个浏览器 Tab：
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ 浏览器（一个进程）                                     │
 *   │  ┌──────────────┐       ┌──────────────────────┐    │
 *   │  │ 前端 React UI │ ←──→ │ Service Worker（后端）  │    │
 *   │  │  （主线程）    │       │  （后台线程）           │    │
 *   │  └──────────────┘       └──────────────────────┘    │
 *   └─────────────────────────────────────────────────────┘
 *
 * opencode 的架构非常类似：
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ Node.js 进程                                          │
 *   │  ┌──────────────┐       ┌──────────────────────┐    │
 *   │  │  TUI 渲染器    │ ←──→ │ Worker 线程（后端）     │    │
 *   │  │  （主线程）     │ RPC  │  AI 对话、文件系统、     │    │
 *   │  │  终端 UI 界面   │       │  HTTP API 等全部逻辑    │    │
 *   │  └──────────────┘       └──────────────────────┘    │
 *   └─────────────────────────────────────────────────────┘
 *
 * 主线程 = TUI（前端界面，渲染终端 UI）
 * Worker 线程 = 后端服务（处理 AI 对话、文件操作等所有业务逻辑）
 *
 *
 * 【什么是 RPC（Remote Procedure Call）？—— 前端必读】
 *
 * RPC 这个词在前端很少见，但概念其实很直白：
 *
 *   RPC = 远程过程调用 = 在"别的地方"调用一个函数，拿到返回值，
 *         就好像调用本地函数一样。
 *
 * 前端类比 1：iframe 通信
 *   父页面想调用 iframe 里的 `getUserInfo()`：
 *     父页面: iframe.contentWindow.postMessage({ method: "getUserInfo", params: [1] })
 *     iframe: window.addEventListener("message", (e) => {
 *               if (e.data.method === "getUserInfo") {
 *                 const result = getUserInfo(e.data.params[0])
 *                 e.source.postMessage({ result })
 *               }
 *             })
 *   这本质上就是一个简陋的 RPC 实现。
 *
 * 前端类比 2：tRPC / GraphQL
 *   tRPC 让你在客户端直接写 `trpc.user.getInfo.query({ id: 1 })`，
 *   但实际它会序列化参数 → 发 HTTP 请求 → 服务端反序列化 → 调用函数 →
 *   序列化返回值 → 返回客户端。这就是 RPC —— 你感觉在"本地调用"，但实际"远程执行"。
 *
 * 在 opencode 中：
 *   主线程调用 `client.call("fetch", { url, method, body })`
 *   这个调用通过消息通道发给 Worker 线程，Worker 收到后执行真正的 HTTP 请求，
 *   然后把响应序列化传回来。主线程拿到的是一个普通的 JavaScript 值，
 *   完全不用关心"跨线程通信"的细节 —— 这就是 RPC 的价值。
 *
 *
 * 【两种通信模式 —— 类似 Vite 的 dev server 概念】
 *
 *   模式 1：内部模式（默认）
 *     - 不暴露网络端口，不占用 localhost:4096
 *     - TUI 和 Worker 之间通过 RPC 直接调用，不经过 HTTP 网络层
 *     - 就像 Vite dev server 的 HMR（热更新）走 WebSocket 内部通道一样
 *     - 好处：零端口占用、无需 HTTP 认证、低延迟
 *
 *   模式 2：外部模式（指定 --port 时触发）
 *     - Worker 启动真正的 HTTP 服务器，监听 localhost:4096
 *     - TUI 作为标准 HTTP 客户端连接（和浏览器发请求一样）
 *     - 好处：允许 attach 其他客户端、允许外部工具调用 API
 *
 *
 * 【为什么用 Worker 线程而不是子进程？—— 前端类比】
 *
 * 前端同学熟悉 Web Worker：`new Worker("./worker.js")` 启动一个后台线程，
 * 通过 `postMessage` 通信，共享同一个页面的生命周期。
 *
 * Bun 的 Worker 和 Web Worker 原理相同：
 *   - 共享同一个进程内存（不需要序列化传输大对象）
 *   - 自动生命周期管理（主线程退出时 Worker 自动被回收）
 *   - 比 spawn 子进程快得多（进程创建 ~100ms → 线程创建 ~1ms）
 *   - 比 HTTP 通信更高效（不走网络栈，纯内存数据传输）
 *
 *
 * 【生命周期 —— 类似 React 组件】
 *
 *   挂载 (mount)      → 启动 Worker + 创建 TUI 渲染器
 *   运行 (running)    → 主线程阻塞在 TUI，等待用户操作
 *   卸载 (unmount)    → stop() → 通知 Worker 关闭 → 终止线程 → 退出进程
 *
 *   类比 React：
 *     useEffect(() => {
 *       startWorker()    // 挂载
 *       return () => {   // 卸载清理
 *         stopWorker()
 *       }
 *     }, [])
 */

import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import * as Log from "@opencode-ai/core/util/log"
import { errorMessage } from "@/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { writeHeapSnapshot } from "v8"
import { TuiConfig } from "./config/tui"
import {
  OPENCODE_PROCESS_ROLE,
  OPENCODE_RUN_ID,
  ensureRunID,
  sanitizedProcessEnv,
} from "@opencode-ai/core/util/opencode-process"
import { validateSession } from "./validate-session"

/**
 * OPENCODE_WORKER_PATH 是编译时由构建脚本（Bun.build）注入的全局常量。
 * 生产环境下它指向打包后的 worker.js 文件路径。
 *
 * 前端类比：类似 Vite 的 `import.meta.env.VITE_*` 环境变量注入，
 * 都是在构建阶段把值写死到产物中的手段。
 */
declare global {
  const OPENCODE_WORKER_PATH: string
}

/**
 * RpcClient 类型：基于 Worker RPC 通道的类型化客户端。
 *
 * 它的类型来自 `typeof Rpc.client<typeof rpc>`，其中 `rpc` 是
 * worker.ts 导出的 RPC 接口定义（所有可以跨线程调用的方法）。
 * 所以这个 client 拥有完整的 TypeScript 类型提示——你写
 * `client.call("fetch", ...)` 时，参数和返回值都有类型安全保证。
 *
 * 前端类比：类似 tRPC 的 client 类型推导 —— 服务端定义了 `user.getInfo` 方法，
 * 前端的 trpc client 就直接有 `trpc.user.getInfo.query()` 的自动补全。
 */
type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

/**
 * ============================================================================
 * createWorkerFetch —— 创建一个"假的" fetch 函数，实际请求由 Worker 执行
 * ============================================================================
 *
 * 【为什么需要这个？】
 * 在内部模式下，TUI 需要调用后端 API。正常情况下你需要：
 *   1. Worker 启动一个 HTTP 服务器（比如 localhost:4096）
 *   2. TUI 通过 `fetch("http://localhost:4096/api/xxx")` 发 HTTP 请求
 *   3. 请求走网络栈 → TCP → localhost → HTTP 解析 → Worker
 *
 * 这个方案有两个问题：
 *   - 占用了网络端口（4096 端口冲突、防火墙弹窗等）
 *   - 走 HTTP 多了一层序列化/反序列化开销
 *
 * 【解决方案】
 * 不走 HTTP，直接通过 RPC 把请求序列化后发给 Worker，
 * Worker 直接调用内部 handler 处理，然后返回结果。
 *
 * 过程就像：
 *   主线程：喂，帮我发个请求，地址是 /api/session，方法是 GET
 *   Worker：好，我执行完了，这是响应：{ status: 200, body: "..." }
 *
 *
 * 【前端类比】
 * 这和你把 axios 实例的 adapter 替换成 mock 实现是一个道理：
 *
 *   // 正常 axios：底层走 XMLHttpRequest / fetch，真的发 HTTP 请求
 *   const axios = new Axios({ adapter: httpAdapter })
 *
 *   // Mock axios：底层不走网络，直接返回假数据
 *   const mockAxios = new Axios({ adapter: mockAdapter })
 *
 * 这里的 createWorkerFetch 就是实现了一个 "RPC adapter" 替代了 "HTTP adapter"，
 * 对外接口还是标准的 fetch 签名，但底层走的是线程间的消息通道。
 *
 *
 * 【函数签名说明】
 * 返回类型 `typeof fetch` 表示这个函数遵循浏览器标准的 fetch API。
 * TUI 代码可以完全不知情地使用它 —— 传给它的代码看到的就是一个普通 fetch。
 * 这是经典的"依赖注入 + 接口抽象"模式，类似 React 中把 `fetch` 换成 `msal.fetch`
 * 来注入认证 token，调用方不需要知道底层差异。
 */
function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // 和浏览器 fetch 一样，先把参数组装成标准 Request 对象
    const request = new Request(input, init)

    // Body 如果是流的话需要先读出来（因为要序列化传给 Worker）
    // 注意：这里用 .text() 读取，意味着不支持真正的流式 body 传递。
    // 如果 body 是 ReadableStream，会在这一步被完整读取为字符串。
    const body = request.body ? await request.text() : undefined

    // ===== 核心调用 =====
    // 通过 RPC 调用 Worker 中定义的 "fetch" 方法，
    // 把 url、method、headers、body 都传过去。
    // Worker 那边收到后，会用真正的 fetch 执行请求，然后把结果返回。
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()), // Headers 对象 → 普通 JS 对象
      body,
    })

    // 把 Worker 返回的结果重新包装成标准 Response 对象
    // TUI 代码完全感知不到这个 Response 不是真正 HTTP 请求得来的
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }

  // as typeof fetch 类型断言 —— 告诉 TypeScript 这个函数就是 fetch 类型，
  // 可以赋值给任何期望 `typeof fetch` 的地方
  return fn as typeof fetch
}

/**
 * ============================================================================
 * createEventSource —— 创建一个基于 RPC 的事件监听器
 * ============================================================================
 *
 * 【解决什么问题？】
 * 在正常的 HTTP 模式下，客户端通过 Server-Sent Events (SSE) 来实时接收
 * 服务端推送的消息。就像你用 ChatGPT 网页版时，"打字机"效果就是靠 SSE 实现的
 * —— 服务端不断推送文本块，前端不断渲染。
 *
 * SSE 的本质是一个 HTTP 长连接：
 *   客户端: GET /api/events
 *   服务端: (保持连接不关闭，有新消息就写一行 "data: ...\n\n")
 *   客户端: (每收到一行就触发 onmessage 回调)
 *
 * 但在内部模式下，我们不启动 HTTP 服务，也就没有 SSE 端点可连。
 *
 * 【解决方案】
 * 把 SSE 替换成 RPC 消息通道 —— 当后端有事件需要推送给前端时，
 * Worker 通过 RPC 的 "global.event" 通道发送消息，
 * 主线程通过 `client.on("global.event", handler)` 监听。
 *
 * 【前端类比】
 * 这就像把你的事件流从 SSE 换成了 WebSocket：
 *
 *   // 原来：走 SSE（HTTP 长连接）
 *   const eventSource = new EventSource("/api/events")
 *   eventSource.onmessage = (e) => renderMessage(e.data)
 *
 *   // 现在：走 RPC（线程间消息通道）
 *   client.on("global.event", (e) => renderMessage(e.data))
 *
 * 对外暴露的 EventSource 接口不变，但底层通信方式完全换了。
 */
function createEventSource(client: RpcClient): EventSource {
  return {
    // subscribe 方法：注册一个事件处理函数，返回一个"取消订阅"函数
    subscribe: async (handler) => {
      // client.on() 返回一个取消监听的函数，类似 addEventListener 的返回值
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

/**
 * ============================================================================
 * target —— 确定 Worker 线程要执行的 JS 文件路径
 * ============================================================================
 *
 * 这个函数解决"去哪里找 Worker 的执行文件"的问题，有三条路径：
 *
 *   优先级 1：编译时注入的常量 OPENCODE_WORKER_PATH
 *     生产环境打包后，构建脚本把这个常量替换成实际路径，
 *     类似于 Vite 的 define: { __WORKER_PATH__: JSON.stringify("./worker.js") }
 *
 *   优先级 2：打包后的 dist 文件
 *     检查是否存在 ./cli/cmd/tui/worker.js（tsc/build 输出），
 *     如果有就用编译好的 JS 文件。
 *
 *   优先级 3：开发时的源文件
 *     什么都没有的话，直接用 worker.ts 源文件。
 *     Bun 支持直接运行 TypeScript，所以开发时不需要预编译步骤。
 *
 * 【前端类比】
 * 这类似于 Webpack 的 resolve.alias 或 Vite 的 resolve.alias 配置：
 *   开发环境: '@/utils' → './src/utils.ts'
 *   生产环境: '@/utils' → './dist/utils.js'
 * 目标文件内容相同，只是路径根据环境不同。
 */
async function target() {
  // 生产环境：使用构建时注入的路径（优先级最高）
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH

  // 检查打包产物是否存在
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist

  // 开发环境：直接运行 TypeScript 源文件
  return new URL("./worker.ts", import.meta.url)
}

/**
 * ============================================================================
 * input —— 合并"管道输入"和 --prompt 参数
 * ============================================================================
 *
 * 【"管道输入"是什么？—— 前端不太接触的概念】
 *
 * 在终端中，`|`（管道符）和 `<`（重定向）可以把一个命令的输出
 * 作为另一个命令的输入：
 *
 *   echo "帮我修复这个 bug" | opencode
 *   //                     ↑
 *   //                     process.stdin 收到 "帮我修复这个 bug"
 *
 *   opencode < myfile.txt
 *   //        ↑
 *   //        process.stdin 收到 myfile.txt 的全部内容
 *
 * `process.stdin.isTTY` 判断标准输入是不是"终端"：
 *   - 是 TTY：用户直接敲键盘输入，这时候不读 stdin
 *   - 不是 TTY：有管道输入，需要读取
 *
 * 【前端类比】
 * 这类似 `<input type="file" />` + `<textarea />` 的组合：
 *   - `<textarea>` 里手动输入的内容 = --prompt 参数
 *   - 拖拽到 input 里的文件内容 = 管道输入
 *   - 两者可以同时存在，拼在一起作为最终的 prompt
 *
 * 【合并逻辑】
 *   1. 没有管道，有 --prompt  → 用 --prompt
 *   2. 有管道，没有 --prompt  → 用管道
 *   3. 两个都有              → 管道 + "\n" + --prompt（管道在前）
 *   4. 两个都没有            → undefined
 */
async function input(value?: string) {
  // process.stdin.isTTY === true  → 用户直接在终端里打字，没管道
  // process.stdin.isTTY === false → 有管道或重定向，管道过来的数据在 stdin 里
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()

  if (!value) return piped       // 情况 1：只有管道
  if (!piped) return value       // 情况 2：只有 --prompt
  return piped + "\n" + value   // 情况 3：两个都有，拼在一起
}

/**
 * ============================================================================
 * resolveThreadDirectory —— 解析 opencode 应该工作在哪个目录
 * ============================================================================
 *
 * opencode 是"按项目工作"的 —— 你需要告诉它你要在哪个项目里操作：
 *
 *   opencode                           # 当前目录
 *   opencode /home/user/my-project     # 指定项目路径
 *   opencode ../other-project          # 相对路径
 *
 * 【为什么目录很重要？】
 * opencode 会：
 *   - 读取该目录下的 opencode.json 配置
 *   - 读取 .gitignore 规则来判断哪些文件需要关注
 *   - 在该目录下创建 .opencode/ 存放本地数据
 *   - 把该目录的文件结构作为 AI 的上下文
 *
 * 所以"工作在哪个目录"是 opencode 最核心的配置之一。
 *
 * 【PWD 环境变量是什么？—— 前端不常见】
 * PWD = Present Working Directory，记录"用户最初在哪个目录敲的命令"。
 * 它和 process.cwd() 的区别：
 *   - PWD：用户敲命令时的目录（不变）
 *   - process.cwd()：当前进程的工作目录（可以通过 process.chdir() 修改）
 *
 * 优先用 PWD 解析相对路径，因为相对路径应该是"相对于用户站的目录"，
 * 而不是进程被 chdir 之后的目录。
 */
export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)

  if (project) {
    // 如果是绝对路径（如 /home/user/project），直接解析
    // 如果是相对路径（如 ../project），拼接到 root 上再解析
    return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  }

  // 没有指定 --project 参数，就是用当前目录
  return Filesystem.resolve(cwd)
}

/**
 * ============================================================================
 * TuiThreadCommand —— opencode 的默认 CLI 命令
 * ============================================================================
 *
 * 【yargs 的 $0 是什么意思？—— 类似前端路由的默认路由】
 *
 * yargs 是 Node.js 的 CLI 框架（类似前端的 commander.js、cac）。
 * `$0` 是 yargs 的特殊占位符，代表"脚本自身"，也就是"当用户不传子命令时的默认入口"。
 *
 * 类比前端路由：
 *
 *   // React Router 的默认路由（* 通配符）
 *   <Route path="*" element={<NotFound />} />
 *
 *   // yargs 的默认命令（$0）
 *   cmd({ command: "$0 [project]", ... })
 *
 * 当用户执行 `opencode`（不带任何子命令），yargs 发现没有匹配的子命令，
 * 就会走到这个 `$0` handler。
 *
 *
 * 【和其他命令的关系】
 *
 *   opencode                   → $0 handler（这个文件）→ 启动 TUI
 *   opencode run "fix bug"    → run handler（run.ts）   → 单次对话模式
 *   opencode serve             → serve handler（serve.ts）→ 纯后端 HTTP 服务
 *   opencode attach <url>     → attach handler（attach.ts）→ 连接到已有服务
 *   opencode debug ...        → debug handler（debug/index.ts）→ 调试工具
 *
 *
 * 【Handler 执行流程总览】
 *
 *   1. 解析工作目录并 chdir                               // 确定在哪个项目里工作
 *   2. 启动 Worker 线程（跑后端服务）                         // 类似 npm run dev 的后端
 *   3. 建立 RPC 通信通道                                   // 类似 axios 的 request interceptor
 *   4. 根据网络配置选择内部/外部传输模式                       // 类似 dev server 的 proxy 配置
 *   5. 读取 TUI 配置（主题、快捷键等）                        // 类似读取 .eslintrc
 *   6. 如果有 --session，验证 session 是否存在              // 类似路由参数校验
 *   7. 动态导入并启动 TUI 渲染器                             // 类似 ReactDOM.createRoot().render()
 *   8. 阻塞等待 TUI 退出（用户按 Ctrl+C）                   // 类似 await modal.show()
 *   9. 清理：停止 Worker、恢复终端设置                       // 类似 useEffect cleanup
 */
export const TuiThreadCommand = cmd({
  // yargs 命令定义："$0" = 默认命令，"[project]" = 可选的位置参数
  command: "$0 [project]",
  describe: "start opencode tui",

  // builder 函数：定义这个命令支持哪些 flags（命令行选项）
  builder: (yargs) =>
    withNetworkOptions(yargs) // 注入 --port, --hostname, --mdns 等网络相关选项
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),

  /**
   * handler 函数 —— 命令的实际执行体
   *
   * yargs 解析完参数后，把解析结果（args 对象）传给这个函数。
   * 前端类比：类似 React 组件接收 props，
   *   或者 Express 的路由 handler: app.get("/", (req, res) => { ... })
   */
  handler: async (args) => {
    global.myLog('TuiThreadCommand handler 执行')

    /**
     * ================================================================
     * 第一步：Windows 终端的特殊处理
     * ================================================================
     *
     * Windows 终端的控制台模式（ENABLE_PROCESSED_INPUT）会把 Ctrl+C 转成
     * CTRL_C_EVENT 信号，这会杀死整个进程组（包括 Worker 线程）。
     * 我们在启动 Worker 之前就禁用这个行为，改成手动处理键盘输入。
     *
     * win32InstallCtrlCGuard 返回一个"恢复函数"，
     * 在 finally 块中调用它来恢复终端原始设置。
     *
     * 前端类比：类似在 React 的 useEffect 里：
     *   useEffect(() => {
     *     const handler = (e) => e.preventDefault() // 阻止默认行为
     *     document.addEventListener("keydown", handler)
     *     return () => document.removeEventListener("keydown", handler)
     *   }, [])
     */
    const unguard = win32InstallCtrlCGuard()
    try {
      win32DisableProcessedInput()

      /**
       * ================================================================
       * 第二步：参数校验
       * ================================================================
       *
       * --fork 必须配合 --continue 或 --session 使用。
       * fork 的意思是"从已有 session 分叉出一个新 session"，
       * 如果你要 fork，总得告诉 opencode 从哪个 session fork 吧。
       *
       * 类比你用 Git：
       *   git checkout -b new-feature   → 从当前分支 fork
       *   --continue                    → "从当前分支 fork"（从最新 session）
       *   --session <id>               → "从指定分支 fork"（从指定 session）
       *   不传这两个                      → 不知道从哪 fork，报错
       */
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      /**
       * ================================================================
       * 第三步：确定工作目录并切换
       * ================================================================
       *
       * process.chdir() 的作用是改变当前 Node.js 进程的工作目录，
       * 类似于在终端里 `cd /path/to/dir`。
       *
       * 为什么需要 chdir？
       *   - 后续所有相对路径操作（读文件、执行命令等）都基于这个目录
       *   - Worker 线程继承主线程的工作目录
       *
       * 这步失败（比如目录不存在）就报错退出。
       */
      const next = resolveThreadDirectory(args.project)
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      /**
       * ================================================================
       * 第四步：准备 Worker 线程的环境变量
       * ================================================================
       *
       * 给 Worker 设置环境变量，用来标识这个线程的身份：
       *   - OPENCODE_PROCESS_ROLE = "worker"：告诉下游代码"我是 Worker 线程，不是主线程"
       *   - OPENCODE_RUN_ID：每次启动的唯一 ID，用于日志追踪
       *
       * sanitizedProcessEnv 会过滤掉一些敏感或不需要传递的环境变量。
       *
       * 前端类比：类似你在 React 中通过 Context Provider 传递：
       *   <UserContext.Provider value={{ role: "admin", runId: "abc123" }}>
       */
      const env = sanitizedProcessEnv({
        [OPENCODE_PROCESS_ROLE]: "worker",
        [OPENCODE_RUN_ID]: ensureRunID(),
      })

      /**
       * ================================================================
       * 第五步：创建 Worker 线程（启动后端服务）
       * ================================================================
       *
       * new Worker(file, { env }) 创建一个新的系统线程来执行 worker.ts。
       *
       * 【Worker 线程 vs 子进程 —— 关键区别】
       *
       *   Worker 线程：
       *     - 共享同一个进程的内存空间
       *     - 创建开销极小（约 1ms）
       *     - 类似前端 `new Worker("./worker.js")`
       *     - 适合高频通信、需要共享状态的场景
       *
       *   子进程（child_process.spawn）：
       *     - 独立的操作系统进程 + 独立内存空间
       *     - 创建开销大（约 100ms+）
       *     - 只有 stdio 管道通信，必须序列化
       *     - 适合需要进程隔离、独立重启的场景
       *
       * opencode 选择 Worker 线程因为：
       *   1. TUI 和 后端需要高频通信（每次键盘事件都可能触发 API 调用）
       *   2. 同一个项目目录，共享文件系统访问
       *   3. 生命周期一致（TUI 退出 → 后端自动回收，没有孤儿进程风险）
       */
      const worker = new Worker(file, {
        env,
      })

      // Worker 线程如果抛未被捕获的异常，记录到日志（不影响主线程正常运行）
      worker.onerror = (e) => {
        Log.Default.error("thread error", {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          error: e.error,
        })
      }

      /**
       * ================================================================
       * 第六步：建立 RPC 通信通道
       * ================================================================
       *
       * Rpc.client<typeof rpc>(worker) 创建一个类型安全的 RPC 客户端，
       * 所有对 Worker 的调用都通过这个 client。
       *
       * 它是怎么工作的？（简化版）：
       *
       *   主线程                         Worker 线程
       *   ──────                         ───────────
       *   client.call("fetch", params)
       *     ↓
       *   序列化 { method: "fetch", params }
       *     ↓
       *   worker.postMessage(msg)  ────→  worker.onmessage
       *                                      ↓
       *                                    反序列化消息
       *                                      ↓
       *                                    switch (method) {
       *                                      case "fetch": return doFetch(params)
       *                                    }
       *                                      ↓
       *                                    序列化结果
       *                                      ↓
       *   worker.onmessage  ←────────────  worker.postMessage(result)
       *     ↓
       *   反序列化结果
       *     ↓
       *   Promise<result> resolve
       *
       * 每一步的序列化/反序列化都被 Rpc 库封装了，
       * 调用方只需要写 `await client.call("fetch", params)`。
       */
      const client = Rpc.client<typeof rpc>(worker)

      /**
       * ================================================================
       * 第七步：注册主线程的全局错误处理
       * ================================================================
       *
       * uncaughtException：同步代码中未被 try/catch 捕获的异常
       * unhandledRejection：异步 Promise 中未被 .catch() 处理的 rejection
       *
       * 这些处理是"兜底"的 —— 正常业务逻辑不会走到这里，
       * 但如果某个角落的代码崩了，error() 至少会把错误日志记下来，
       * 而不是让进程静默退出（用户完全不知道发生了什么）。
       *
       * 前端类比：类似 Vue 的 `app.config.errorHandler` 或
       * React ErrorBoundary 的 componentDidCatch。
       */
      const error = (e: unknown) => {
        Log.Default.error("process error", { error: errorMessage(e) })
      }

      /**
       * SIGUSR2 信号处理 —— 开发时的热重载
       *
       * SIGUSR2 是 Unix 的"用户自定义信号 2"，Node.js 用它来表示"检测到文件变更，请重载"。
       * Bun 的 --hot / --watch 模式就是通过发送 SIGUSR2 来通知进程重启。
       *
       * 在这里收到 SIGUSR2 时，我们通过 RPC 通知 Worker 重新加载配置，
       * 而不是让整个进程重启（重启会导致 TUI 闪烁，体验很差）。
       *
       * 前端类比：类似 Vite 的 HMR（Hot Module Replacement），
       * 只是更新变更的模块，不刷新整个页面。
       */
      const reload = () => {
        client.call("reload", undefined).catch((err) => {
          Log.Default.warn("worker reload failed", {
            error: errorMessage(err),
          })
        })
      }
      process.on("uncaughtException", error)
      process.on("unhandledRejection", error)
      process.on("SIGUSR2", reload)

      /**
       * ================================================================
       * 第八步：定义停止函数（cleanup / teardown）
       * ================================================================
       *
       * stopped 标志位保证 stop() 是幂等的 —— 多次调用不会重复执行清理逻辑。
       * 这在 finally 块中很重要，因为可能同时多条代码路径触发清理。
       *
       * 清理步骤（顺序很重要）：
       *   1. 解除事件监听（避免内存泄漏 + 避免旧 handler 干扰）
       *   2. 通过 RPC 优雅关闭 Worker（最多等 5 秒，超时就放弃）
       *      —— 这允许 Worker 保存未完成的 session 数据
       *   3. worker.terminate() 强制终止线程（兜底，防止僵尸线程）
       *
       * 前端类比：类似 React hook 的 cleanup：
       *   useEffect(() => {
       *     const ws = new WebSocket(url)
       *     return () => {
       *       ws.close(1000, "Component unmounted") // 优雅关闭
       *     }
       *   }, [])
       */
      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true

        // 解除事件监听（removeEventListener 等价操作）
        process.off("uncaughtException", error)
        process.off("unhandledRejection", error)
        process.off("SIGUSR2", reload)

        // 优雅关闭 Worker，最多等 5 秒
        await withTimeout(client.call("shutdown", undefined), 5000).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: errorMessage(error),
          })
        })

        // 兜底：强制终止线程
        worker.terminate()
      }

      /**
       * ================================================================
       * 第九步：处理初始 prompt
       * ================================================================
       *
       * 用户可以通过三种方式传入初始 prompt：
       *   1. 命令行参数：opencode --prompt "帮我重构代码"
       *   2. 管道输入：   echo "帮我重构代码" | opencode
       *   3. 两者都用：   echo "看这段代码" | opencode --prompt "帮我重构一下"
       *                  → 结果："看这段代码\n帮我重构一下"
       *
       * 如果用户没有传任何 prompt，prompt 为 undefined。
       * 这时 TUI 会正常启动，用户在界面里手动输入。
       */
      const prompt = await input(args.prompt)

      // 读取 TUI 配置：用户自定义的主题颜色、快捷键映射等
      const config = await TuiConfig.get()

      /**
       * ================================================================
       * 第十步：判断网络模式（内部 vs 外部）
       * ================================================================
       *
       * 【判断逻辑】
       * 以下任一条件满足，就使用外部模式：
       *   - 用户传了 --port（如 --port 4096）
       *   - 用户传了 --hostname（如 --hostname 0.0.0.0）
       *   - 用户传了 --mdns（启用 mDNS 服务发现）
       *   - 配置文件中指定了 mDNS
       *   - 端口不是 0（0 表示随机端口，用户要求对外暴露）
       *   - hostname 不是 127.0.0.1（监听非本地地址）
       *
       * 如果以上都不满足 → 内部模式（默认，推荐）
       */
      const network = resolveNetworkOptionsNoConfig(args)
      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      /**
       * ================================================================
       * 第十一步：构建传输层（Transport Layer）
       * ================================================================
       *
       * 【外部模式】
       *   - 通过 RPC 调用 Worker 的 "server" 方法，让 Worker 启动真正的 HTTP 服务器
       *   - Worker 返回服务器的 URL（如 http://localhost:4096）
       *   - TUI 使用浏览器原生 fetch 连接这个 URL
       *   - fetch 和 events 设为 undefined（TUI 内部会自己构造标准 HTTP 的 fetch 和 EventSource）
       *
       * 【内部模式】
       *   - url 设为占位符 "http://opencode.internal"（不会被使用，仅用于标识）
       *   - fetch 用 createWorkerFetch 替代（RPC 代理，不走 HTTP）
       *   - events 用 createEventSource 替代（RPC 消息通道，不走 SSE）
       *
       * 前端类比：类似 axios 的 baseURL + adapter 配置：
       *   直接请求:   axios.create({ baseURL: "http://localhost:4096" })
       *   内部 RPC：   axios.create({ baseURL: "internal://", adapter: rpcAdapter })
       */
      const transport = external // external 在我测试的这个例子中为 false 
        ? {
            url: (await client.call("server", network)).url,
            fetch: undefined,
            events: undefined,
          }
        : {
            url: "http://opencode.internal", // 不会被使用，仅用于标识
            fetch: createWorkerFetch(client),
            events: createEventSource(client),
          }

      /**
       * ================================================================
       * 第十二步：验证 session（如果用户指定了）
       * ================================================================
       *
       * 如果用户传了 --session <id>（继续之前的对话），
       * 在启动 TUI 之前先检查这个 session 是否存在、是否可访问。
       *
       * 怎么验证？
       *   通过 transport 发一个请求到 /api/session/<id>，
       *   如果返回 404 或者没权限，就报错退出，不让用户空等。
       *
       * 前端类比：类似页面加载时先调 `GET /api/user/me` 验证登录状态，
       * 检票失败就直接跳登录页，不让用户看到空页面。
       */
      try {
        await validateSession({
          url: transport.url,
          sessionID: args.session,
          directory: cwd,
          fetch: transport.fetch,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      /**
       * ================================================================
       * 第十三步：异步检查版本更新（不阻塞启动）
       * ================================================================
       *
       * 延迟 1 秒后，通过 RPC 让 Worker 检查是否有新版本可以升级。
       * 放在 setTimeout 里是为了：
       *   1. 不阻塞 TUI 启动（TUI 立刻出现，版本检查是后台任务）
       *   2. 延迟 1 秒是给 Worker 内部初始化留时间
       *
       * .unref() 是 Node.js 的 Timer 方法，
       * 告诉事件循环"这个 timer 不阻止进程退出"。
       * 也就是说如果用户马上按 Ctrl+C 退出，版本检查也不会拖慢退出速度。
       *
       * 前端类比：类似页面加载后，延迟执行埋点上报或检查更新通知
       */
      setTimeout(() => {
        client.call("checkUpgrade", { directory: cwd }).catch(() => {})
      }, 1000).unref?.()

      /**
       * ================================================================
       * 第十四步：启动 TUI（核心步骤）
       * ================================================================
       *
       * 这里终于启动了终端交互界面。
       *
       * 1. dynamic import("./app")：延迟加载 TUI 模块
       *    - 用 dynamic import 而不是顶层 import 是为了：
       *      a. 减小启动阶段的内存占用（TUI 模块很重）
       *      b. 等 config 等前置依赖准备好再加载
       *
       * 2. createTuiRenderer(config)：
       *    - 创建终端渲染器（负责把 React 组件树画到终端上）
       *    - config 包含用户自定义的主题（颜色）、快捷键等
       *
       * 3. tui({...})：
       *    - 实际启动 TUI，传入所有运行时依赖
       *    - 返回一个 handle 对象，handle.done 是一个 Promise，
       *      在用户退出 TUI 时 resolve（比如按了 Ctrl+C 或执行了 /exit）
       *
       * 4. await handle.done：
       *    - 主线程阻塞在这一行，等待 TUI 运行完毕
       *    - TUI 运行期间，所有用户输入、AI 响应都由 TUI 的事件循环处理
       *    - 这个 await 期间不会卡死 —— TUI 内部有自己的事件循环（类似 JS 的 event loop）
       *
       * 【onSnapshot 回调】
       * 当用户请求生成内存快照时，同时生成：
       *   - TUI 主线程的堆快照（writeHeapSnapshot）
       *   - Worker 线程的堆快照（通过 RPC 调用 Worker 的 snapshot 方法）
       * 用于排查内存泄漏问题。
       *
       * 前端类比：类似 React 18 的 createRoot：
       *   const root = createRoot(document.getElementById("app"))
       *   root.render(<App config={config} />)
       *   await root.unmount()  // 等待组件卸载
       */
      try {
        const { createTuiRenderer, tui } = await import("./app")
        const renderer = await createTuiRenderer(config)
        const handle = tui({
          url: transport.url,
          renderer,
          async onSnapshot() {
            const tui = writeHeapSnapshot("tui.heapsnapshot")
            const server = await client.call("snapshot", undefined)
            return [tui, server]
          },
          config,
          directory: cwd,
          fetch: transport.fetch,
          events: transport.events,
          args: {
            continue: args.continue,
            sessionID: args.session,
            agent: args.agent,
            model: args.model,
            prompt,
            fork: args.fork,
          },
        })
        // 阻塞等待用户退出 TUI
        await handle.done
      } finally {
        /**
         * ================================================================
         * 第十五步：清理（不管 TUI 正常退出还是异常退出都要执行）
         * ================================================================
         *
         * finally 块保证无论 TUI 如何退出（用户主动退出 / 异常崩溃 / Ctrl+C），
         * worker 都会被妥善清理。
         *
         * 这很重要：没有这步的话，Worker 线程可能变成"僵尸"——
         * 它还在后台运行（占用内存和 CPU），但主线程已经退出了，
         * 用户根本不知道。类似 Web Worker 没有被 terminate() 的后果。
         */
        await stop()
      }
    } finally {
      /**
       * ================================================================
       * 第十六步：恢复 Windows 终端设置
       * ================================================================
       *
       * finally 保证即使出错了，终端设置也能恢复。
       * 想象一下如果程序崩溃后你的终端 Ctrl+C 还是不好用……
       * 这就是为什么这行代码在 finally 里面。
       */
      unguard?.()
    }

    // 正常退出，退出码 0（表示成功）
    process.exit(0)
  },
})
