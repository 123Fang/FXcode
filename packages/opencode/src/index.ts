/**
 * opencode CLI 主入口文件
 *
 * 这是整个 opencode 命令行工具的唯一入口点。负责：
 * 1. 使用 yargs 构建 CLI 命令框架
 * 2. 注册所有子命令（run, serve, debug, agent 等）
 * 3. 初始化日志系统、进程元数据
 * 4. 在首次运行时执行数据库迁移（旧 JSON 格式 → SQLite）
 * 5. 全局错误捕获与格式化输出
 *
 * 执行流程：
 *   bin/opencode（Node.js 启动脚本）→ src/index.ts（本文件）→ 各子命令 handler
 */

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import * as Log from "@opencode-ai/core/util/log"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { NamedError } from "@opencode-ai/core/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { Filesystem } from "@/util/filesystem"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/tui/attach"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { JsonMigration } from "@/storage/json-migration"
import { Database } from "@/storage/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import { isRecord } from "@/util/record"

// setTimeout(() => {
//   // 第二个参数需要是对象{}
//   Log.Default.info("dump----------------", {arr: [1]})
// },5000)

// 为当前主进程生成唯一标识元数据，包含 processRole ("main") 和 runID (UUID)
// 用于日志追踪和区分同一台机器上同时运行的多个 opencode 实例
const processMetadata = ensureProcessMetadata("main")

// 全局捕获未处理的 Promise rejection
// 避免 Node.js 因为未处理的 rejection 而崩溃（Node 未来版本中 unhandledRejection 会导致进程退出）
process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

// 全局捕获未被 try/catch 捕获的同步异常
process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

// hideBin 将 process.argv 中的 node 和脚本路径剥离，只保留用户传入的实际参数
// 例如 "node opencode run hello" → ["run", "hello"]
const args = hideBin(process.argv)

/**
 * 自定义 help 输出函数
 * 当 help 文本不以 "opencode " 开头时（如子命令的 usage），前缀加 logo
 * 当以 "opencode " 开头时（主命令的 usage），原样输出
 */
function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

// ===== yargs CLI 核心配置 =====
const cli = yargs(args)
  // "populate--": true 使得 -- 后面的额外参数被收集到 argv["--"] 数组中
  // 这样 `opencode run -- extra args` 中的 "extra args" 能被 RunCommand 访问
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  // 限制 help 文本宽度为 100 列
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  // --print-logs: 将日志也输出到 stderr（默认日志仅写入文件）
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  // --log-level: 控制日志级别，覆盖默认行为
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  // --pure: 纯净模式，不加载外部插件，仅使用内置功能
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  /**
   * 全局中间件 — 在任何命令执行前运行，负责初始化整个运行时环境
   *
   * 这是个 async 中间件，yargs 会等待其完成后再执行命令 handler
   */
  .middleware(async (opts) => {
    // 如果指定了 --pure，设置环境变量，插件系统会检测此标志跳过外部插件加载
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    // 初始化日志系统
    // print: 是否同时输出到 stderr
    // dev: 本地开发模式下使用更详细的格式
    // level: 日志级别，本地开发默认 DEBUG，发布版默认 INFO
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    // 启动堆内存监控（定时采样，用于调试内存泄漏）
    Heap.start()

    // 设置环境变量标记，供子进程和插件识别当前处于 opencode 环境中
    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    // 记录启动信息，包含版本号、参数、进程角色和运行 ID
    Log.Default.info("opencode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    // 检查 SQLite 数据库文件是否已存在
    // 如果不存在（首次运行或从旧版升级），执行 JSON → SQLite 的迁移
    const marker = path.join(Global.Path.data, "opencode.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      // ANSI 颜色码：橙色前景，灰色 muted
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      // 在 TTY 环境中隐藏光标，避免进度条闪烁
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        // JsonMigration.run 读取旧的 JSON 文件，通过 Drizzle ORM 写入 SQLite
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          // 进度回调：渲染终端进度条
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            // 如果百分比没变且未完成，跳过重绘，避免不必要的终端写入
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              // 进度条样式：■■■■■･････ 75%  messages    150/200
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              // 非 TTY 环境（如 CI/CD），使用简化的机器可读格式
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        // 无论成功或失败，恢复光标显示（TTY 环境）
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  // 注册 shell 自动补全脚本生成（`opencode completion`）
  .completion("completion", "generate shell completion script")
  // ===== 注册所有子命令 =====
  .command(AcpCommand)          // opencode acp — Agent Communication Protocol
  .command(McpCommand)          // opencode mcp — Model Context Protocol 管理
  .command(TuiThreadCommand)    // opencode thread — TUI 线程管理
  .command(AttachCommand)       // opencode attach — 附加到已有 session
  .command(RunCommand)          // opencode run — 核心命令：发送 prompt 给 AI
  .command(GenerateCommand)     // opencode generate — 代码生成（非交互式）
  .command(DebugCommand)        // opencode debug — 调试工具
  .command(ConsoleCommand)      // opencode account — 账户管理（登录/登出）
  .command(ProvidersCommand)    // opencode providers — 管理 AI 提供商
  .command(AgentCommand)        // opencode agent — 管理 agent 配置
  .command(UpgradeCommand)      // opencode upgrade — 升级到最新版本
  .command(UninstallCommand)    // opencode uninstall — 卸载 opencode
  /**我的梳理-后端服务-1：**/
  .command(ServeCommand)        // opencode serve — 启动 HTTP API 服务器
  .command(WebCommand)          // opencode web — 启动 Web UI
  .command(ModelsCommand)       // opencode models — 管理 AI 模型
  .command(StatsCommand)        // opencode stats — 显示使用统计
  .command(ExportCommand)       // opencode export — 导出会话数据
  .command(ImportCommand)       // opencode import — 导入会话数据
  .command(GithubCommand)       // opencode github — GitHub 集成管理
  .command(PrCommand)           // opencode pr — Pull Request 管理
  .command(SessionCommand)      // opencode session — session 管理（增删改查）
  .command(PluginCommand)       // opencode plugin — 插件管理
  .command(DbCommand)           // opencode db — 数据库管理工具
  /**
   * 全局错误处理 — 当 yargs 解析失败或命令执行出错时触发
   *
   * 特殊处理：如果错误是用户输入了未知参数或参数不足，
   * 不直接报错，而是显示 help 信息
   */
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  // strict mode: 遇到未知参数时抛出错误（而非静默忽略）
  .strict()

// ===== 执行 CLI 解析 =====
try {
  // help/version 使用自定义输出处理（通过回调函数手动控制输出格式）
  // 其他命令直接解析，由 yargs 内部调用命令 handler
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    console.log('执行packages/opencode/src/index.ts')
    // 启动Tui-1 (执行 bun run /Users/fangxiang/opencode-dev-my/packages/opencode/src/index.ts 走这里，启动tui)
    /***
     *   await cli.parse() 如果一直是 pedding状态，程序就会一直停留在wait cli.parse() 这一行，不会继续往下执行。
     * ，catch 和 finally 永远不执行
     * 
     * ***/
    await cli.parse()
  }
} catch (e) {
  // ===== 全局异常处理 =====
  // 收集错误信息用于日志记录
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  // NamedError 是 opencode 自定义的错误基类，支持序列化为 JSON
  // 将自定义字段（排除已收集的基本字段）合并到 data 中
  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  // Bun 的 ResolveMessage 是模块解析错误（如 import 路径不存在）
  // 包含模块路径、引用位置等诊断信息
  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  // 将完整错误信息写入日志文件
  Log.Default.error("fatal", data)
  // 格式化为用户友好的错误消息并输出到终端
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  // 如果 FormatError 返回 undefined，说明是无法格式化的未知错误
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1 // 可以设置 退出码 1（失败）
  console.log('执行到catch -- process.exitCode = 1 ')
} finally {
  // 子进程清理：某些子进程（特别是 docker 容器化的 MCP server）
  // 不会正确响应 SIGTERM。除非用 `docker run --init` 启动，
  // 否则容器内的进程收不到信号。
  // 因此显式调用 process.exit() 确保所有子进程被终止，避免悬挂进程。
  console.log('执行到finally -- process.exit()')
  process.exit() //  默认是0，成功退出。然后走入了catch分支，会把退出码改为1 ,失败退出！
}
