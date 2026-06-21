/**
 * ============================================================================
 * TuiConfig — opencode 的 TUI 配置系统
 * ============================================================================
 *
 * 【一句话概括】
 * 这个文件负责加载 opencode 的"皮肤设置"——快捷键、主题、插件、提示音等。
 * 用户可以在 tui.json 里自定义这些东西，这个文件把它读出来、合并好、返回给 UI 用。
 *
 *
 * 【前端类比】
 * 这和你项目里的 prettier.config.js / vite.config.ts 一样——都是一套"读配置 →
 * 合并多层配置 → 校验格式 → 给应用使用"的标准流程。
 *
 * 具体来说：
 *   全局配置（~/.config/opencode/tui.json）→ 全局默认
 *   项目配置（.opencode/tui.json）        → 覆盖全局
 *   命令行环境变量（OPENCODE_TUI_CONFIG）   → 最高优先级
 *
 * 最终合并成一份 `Resolved` 对象，送到 App 组件里使用。
 *
 *
 * 【主要概念】
 *
 * TuiConfig.Info      = 配置的结构定义（Schema），定义哪些字段合法、什么类型
 * TuiConfig.Resolved  = 合并+填充默认值后的最终配置对象
 * TuiConfig.Service   = Effect 服务，提供 get() 方法获取配置
 * TuiConfig.get()     = 获取配置的工厂函数（同步 API，内部走 Effect 运行时）
 * TuiConfig.waitForDependencies() = 等待插件安装完成
 */

import path from "path"
import { createBindingLookup } from "@opentui/keymap/extras"
import { mergeDeep, unique } from "remeda"
import { Cause, Context, Effect, Fiber, Layer, Schema } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { migrateTuiConfig } from "./tui-migrate"
import { KeymapLeaderTimeoutDefault, resolveAttentionSoundPaths, TuiInfo } from "./tui-schema"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isRecord } from "@/util/record"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CurrentWorkingDirectory } from "./cwd"
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "./keybind"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { ConfigVariable } from "@/config/variable"
import { Npm } from "@opencode-ai/core/npm"
import type { DeepMutable } from "@opencode-ai/core/schema"
import type { TuiAttentionSoundName } from "@opencode-ai/plugin/tui"
import { FormatError, FormatUnknownError } from "@/cli/error"

// ============================================================================
// 日志实例 —— 所有日志都带上 "tui.config" 标签，方便调试时过滤
// ============================================================================
const log = Log.create({ service: "tui.config" })

// ============================================================================
// Info / Resolved —— 配置的数据结构
// ============================================================================

/**
 * Info 是 tui.json 的数据结构定义（由 Schema 生成）。
 * 它规定了你到底能在 tui.json 里写哪些字段：
 *
 * 比如：
 * {
 *   "model": "anthropic/claude-sonnet-4-20250514",  // 默认模型
 *   "agent": "build",                                // 默认 agent
 *   "keybinds": {                                    // 自定义快捷键
 *     "model_list": "ctrl+m",
 *     "session_list": "ctrl+s"
 *   },
 *   "plugin": ["@opencode-ai/plugin-tui-mcp"],       // 插件列表
 *   "leader_timeout": 2000,                           // 快捷键 leader 等待时间（ms）
 *   "attention": {                                    // 提示音/通知设置
 *     "enabled": true,
 *     "sound": true,
 *     "volume": 0.5
 *   }
 * }
 *
 * DeepMutable 的意思是"把 Schema 类型的所有 readonly 去掉"，
 * 因为我们在加载过程中需要逐步合并、修改这个配置对象。
 */
export const Info = TuiInfo
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

/**
 * Acc 是加载过程中用来累积配置的"临时容器"。
 *
 * 为什么要这个？
 * 因为配置可能是从多个文件合并来的（全局 + 项目 + 环境变量），
 * 我们在加载过程中需要一个地方把结果存起来。
 *
 *   result         —— 合并后的配置内容
 *   plugin_origins —— 插件的来源信息（哪个文件、哪个目录、哪个 scope）
 */
type Acc = {
  result: Info
  plugin_origins: ConfigPlugin.Origin[]
}

/**
 * Resolved 是"最终可用版"的配置。
 *
 * 相比 Info，它做了这些处理：
 *   1. attention 字段 —— 填充了默认值（比如默认音量 0.4）
 *   2. keybinds 字段 —— 从原始字符串解析成了结构化的键盘绑定查询表
 *   3. leader_timeout —— 填充了默认值
 *   4. plugin_origins —— 插件来源列表（供运行时加载用）
 *
 * 前端类比：这就像 Vite 的 `resolveConfig()` 返回的最终配置对象，
 * 一切默认值都已填充，所有简写都已展开，拿过来就能直接用。
 */
export type Resolved = Omit<Info, "attention" | "keybinds" | "leader_timeout"> & {
  attention: {
    enabled: boolean
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: Partial<Record<TuiAttentionSoundName, string>>
  }
  keybinds: TuiKeybind.BindingLookupView
  leader_timeout: number
  plugin_origins?: ConfigPlugin.Origin[]
}

// ============================================================================
// Service —— Effect 依赖注入的配置服务
// ============================================================================

/**
 * Interface 定义了这个服务提供两个方法：
 *
 *   get()                → 拿配置（同步，实际上从缓存返回）
 *   waitForDependencies() → 等插件安装完成再继续（阻塞 UI 启动）
 *
 * 前端类比：这有点像 React Context 的接口定义 —— 你先声明
 * Context 里有什么值/方法，然后 Provider 提供具体实现。
 */
export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
  readonly waitForDependencies: () => Effect.Effect<void>
}

/**
 * Service 是 Effect 世界的"服务标签"。
 * 它把上面的 Interface 注册到 Effect 的依赖注入容器里，
 * 其他模块可以通过 `yield* TuiConfig.Service` 拿到这个服务。
 *
 * 用前端类比：这是把 Context 注册到了 React 的组件树里。
 */
export class Service extends Context.Service<Service, Interface>()("@opencode/TuiConfig") {}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断一个插件文件属于什么 scope（作用域）。
 *
 * 规则很简单：
 *   如果你的插件在项目目录里   → local（本地项目插件）
 *   如果你的插件在外面          → global（全局安装的插件）
 *
 * 这个信息后续用于决定插件的安装位置和加载优先级。
 */
function pluginScope(file: string, ctx: { directory: string }): ConfigPlugin.Scope {
  if (Filesystem.contains(ctx.directory, file)) return "local"
  return "global"
}

/**
 * 处理 tui.json 中 "tui" 嵌套键的历史遗留问题。
 *
 * 背景：以前（v1）的配置文件叫 opencode.json，结构是：
 *   { "tui": { "model": "xxx", "keybinds": {...} } }
 *
 * 现在拆成了独立文件 tui.json，结构是：
 *   { "model": "xxx", "keybinds": {...} }
 *
 * 但是如果有人还在 tui.json 里写了 { "tui": { ... } } 的嵌套格式，
 * 这个函数会把里面的内容"提出来"放在顶层，保证兼容性。
 *
 * 前端类比：API 升级后对旧请求格式的兼容处理。
 */
function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

/**
 * 过滤掉用户配置中未知的快捷键。
 *
 * tui.json 的 keybinds 只能写系统预定义的命令键（如 "model_list"）。
 * 如果用户写了一个不存在的键（比如拼写错误），这里会：
 *   1. 打一条 warning 日志，告诉用户哪些键不认识
 *   2. 把这些无效的键删掉，不让它们影响后面的处理
 *
 * 前端类比：TypeScript 的 no-unused-vars 检查，警告但不阻断编译。
 */
function dropUnknownKeybinds(input: Record<string, unknown>, configFilepath: string) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  log.warn("ignored unknown tui keybinds", {
    path: configFilepath,
    keybinds: invalid,
    hint: "Remove these entries or rename them to keys from the tui.json schema.",
  })
  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

// ============================================================================
// loadState —— 配置加载的核心函数
// ============================================================================

/**
 * loadState 是配置加载的地基函数。
 * 它负责从全局配置、项目配置、环境变量中读取所有 tui.json 文件，
 * 合并它们，填充默认值，最后返回 Resolved 配置。
 *
 * 加载优先级（后面的覆盖前面的）：
 *   1. 全局配置（~/.config/opencode/tui.json）
 *   2. OPENCODE_TUI_CONFIG 环境变量指定的文件
 *   3. 项目配置（.opencode/tui.json，越靠近当前目录优先级越高）
 *   4. .opencode 目录里的配置（从项目根往上走到 ~/ 为止）
 *
 * 前端类比：像 Webpack 配置的 merge 策略 ——
 *   webpack.base.js  ← 基础配置（低优先级）
 *   webpack.dev.js   ← 开发覆盖（高优先级）
 *   webpack.prod.js  ← 生产覆盖（高优先级）
 *   → 最终合并成一个完整的配置对象
 */
const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* AppFileSystem.Service
  let appliedOrder = 0

  /**
   * 把插件字符串（如 "@opencode-ai/plugin-tui-mcp"）解析成完整路径。
   *
   * 用户可以在 tui.json 里写 `"plugin": ["@opencode-ai/plugin-tui-mcp"]`，
   * 但运行时需要知道这个包到底安装在哪个目录。
   * ConfigPlugin.resolvePluginSpec 就是做这个解析的。
   */
  const resolvePlugins = (config: Info, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const plugins = config.plugin
      if (!plugins) return config
      for (let i = 0; i < plugins.length; i++) {
        plugins[i] = yield* Effect.promise(() => ConfigPlugin.resolvePluginSpec(plugins[i], configFilepath))
      }
      return config
    })

  /**
   * 把一段 JSON 文本解析成 Info 对象。
   *
   * 步骤：
   *   1. 替换环境变量（如 ${HOME} → /Users/xxx）
   *   2. JSONC 解析（支持注释 + 尾部逗号）
   *   3. 处理历史遗留的嵌套 "tui" 键
   *   4. 过滤未知快捷键
   *   5. Schema 校验 + 类型转换
   *   6. 解析提示音文件路径（相对路径 → 绝对路径）
   *   7. 解析插件路径
   *
   * 如果任何一步失败，整个文件被跳过（返回 {}），
   * 不会因为一个配置文件坏了导致整个 TUI 启动失败。
   *
   * 前端类比：Vite 插件系统的 load() + transform() 流水线。
   */
  const load = (text: string, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // 第 1 步：替换 ${VAR} 环境变量
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty" }),
      )
      // 第 2 步：JSONC 解析（支持注释 + 尾部逗号）
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return {} as Info
      // 第 3 步：展开嵌套的 "tui" 键 + 第 4 步：过滤未知快捷键
      const normalized = dropUnknownKeybinds(normalize(data), configFilepath)
      // 第 5 步：Schema 校验
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      // 第 6 步：解析提示音文件路径
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      // 第 7 步：解析插件路径
      return yield* resolvePlugins(validated, configFilepath)
    }).pipe(
      // 如果任何一步出错了，吃下错误，打日志，返回空配置
      // 为什么用 catchCause 而不是常规错误处理？
      // 因为 JSONC 解析和 Schema 校验可能在同步阶段就抛异常（不是 Effect 错误），
      // 常规的 catchAll 抓不到这类缺陷错误。
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause)
          const reason = FormatError(error) ?? FormatUnknownError(error)
          log.warn("skipping invalid tui config", {
            path: configFilepath,
            reason,
          })
          return {} as Info
        }),
      ),
    )

  /**
   * 加载单个配置文件。
   *
   * 读取文件 → 解析 JSON → 返回 Info
   * 如果文件读不到（权限问题、IO 错误），静默跳过，不阻止启动。
   */
  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause)
            const reason = FormatError(error) ?? FormatUnknownError(error)
            log.warn("failed to read tui config", {
              path: filepath,
              reason,
            })
            return undefined
          }),
        ),
      )
      if (!text) return {} as Info
      log.info("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  /**
   * 加载一个配置文件并合并到累积配置中。
   *
   * mergeDeep 是做"深合并"的工具函数（来自 remeda 库）。
   * 它可以让你全局配置写 keybinds: { model_list: "ctrl+m" }，
   * 项目配置只写 keybinds: { session_list: "ctrl+s" }，
   * 最终合出来两个快捷键都有。
   *
   * 同时记录插件的来源信息，方便后续去重和安装。
   */
  const mergeFile = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)
      if (Object.keys(data).length) {
        appliedOrder += 1
        log.info("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
      if (!data.plugin?.length) return

      const scope = pluginScope(file, ctx)
      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...data.plugin.map((spec) => ({ spec, scope, source: file })),
      ])
      acc.result.plugin = plugins.map((item) => item.spec)
      acc.plugin_origins = plugins
    })

  /**
   * 收集所有可能存放 tui.json 的目录。
   *
   * ConfigPaths.directories() 会从当前目录开始往上走，
   * 找到所有 .opencode 目录和 OPENCODE_CONFIG_DIR 环境变量指定的目录。
   *
   * 同时检查旧版配置是否需要迁移（从 opencode.json 里的 tui 字段迁移到独立的 tui.json）。
   */
  const directories = yield* ConfigPaths.directories(ctx.directory)
  yield* Effect.promise(() => migrateTuiConfig({ directories, cwd: ctx.directory }))

  /**
   * 收集项目配置文件。
   *
   * ConfigPaths.files("tui", ctx.directory) 会从当前目录往上找，
   * 返回所有 tui.json / tui.jsonc 文件路径，按"离根目录最近 → 离当前目录最近"排序。
   *
   * 除非设置了 OPENCODE_DISABLE_PROJECT_CONFIG 环境变量（禁止加载项目配置），
   * 否则项目配置一定会被加载。
   */
  const projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", ctx.directory)

  // 初始化累积容器
  const acc: Acc = {
    result: {},
    plugin_origins: [],
  }

  /**
   * ==================== 按优先级加载配置 ====================
   *
   * 下面的加载顺序很重要：后面的覆盖前面的，所以优先级从低到高。
   */

  // 第 1 步：全局配置（最低优先级）
  // ~/.config/opencode/tui.json —— 所有的项目共享
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file)
  }

  // 第 2 步：环境变量指定的配置文件（中等优先级）
  // 如果你设置了 OPENCODE_TUI_CONFIG=/my/custom/tui.json，这个文件会覆盖全局配置
  if (Flag.OPENCODE_TUI_CONFIG) {
    const configFile = Flag.OPENCODE_TUI_CONFIG
    yield* mergeFile(acc, configFile)
    log.debug("loaded custom tui config", { path: configFile })
  }

  // 第 3 步：项目配置文件（较高优先级）
  // .opencode/tui.json —— 越靠近项目根目录的文件优先级越高
  // root-first 意思是：先加载根目录（优先级低），再加载当前目录（优先级高），
  // 这样当前目录的配置可以覆盖上层目录的配置。
  for (const file of projectFiles) {
    yield* mergeFile(acc, file)
  }

  // 第 4 步：.opencode 目录里的配置
  // 从项目根目录往上走到 home 目录，每个 .opencode 里的 tui.json 都会被加载。
  // 去重：同一个目录不会被加载两次。
  const dirs = unique(directories).filter((dir) => dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR)

  for (const dir of dirs) {
    if (!dir.endsWith(".opencode") && dir !== Flag.OPENCODE_CONFIG_DIR) continue
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      yield* mergeFile(acc, file)
    }
  }

  /**
   * ==================== 加载完成，开始拼装最终配置 ====================
   */

  // 处理快捷键绑定的平台差异
  // 在 Windows 上，终端不支持 POSIX 的 Ctrl+Z 挂起操作，
  // 所以把 terminal_suspend 禁用，换成 input_undo。
  const keybinds = { ...acc.result.keybinds }
  if (process.platform === "win32") {
    keybinds.terminal_suspend = "none"
    const inputUndo = TuiKeybind.defaultValue("input_undo")
    keybinds.input_undo ??= unique(["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]).join(",")
  }

  // 解析快捷键字符串 → 结构化的键盘绑定查询表
  // "ctrl+m" → { key: "m", ctrl: true }
  const parsedKeybinds = TuiKeybind.parse(keybinds)

  /**
   * 拼装最终的 Resolved 对象。
   *
   * createBindingLookup 的作用：
   * 把解析后的快捷键对象转成 O(1) 查询表，这样运行时
   * 键盘事件来了直接 O(1) 查表，不需要每次遍历所有绑定。
   *
   * || 填充默认值：
   *   attention.enabled    → 默认 false
   *   attention.notifications → 默认 true
   *   attention.sound      → 默认 true
   *   attention.volume     → 默认 0.4（40% 音量）
   *   attention.sound_pack → 默认 "opencode.default"
   *   leader_timeout       → 默认使用 schema 中定义的常量
   */
  const result: Resolved = {
    ...acc.result,
    attention: {
      enabled: acc.result.attention?.enabled ?? false,
      notifications: acc.result.attention?.notifications ?? true,
      sound: acc.result.attention?.sound ?? true,
      volume: acc.result.attention?.volume ?? 0.4,
      sound_pack: acc.result.attention?.sound_pack ?? "opencode.default",
      sounds: acc.result.attention?.sounds ?? {},
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(parsedKeybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: acc.result.leader_timeout ?? KeymapLeaderTimeoutDefault,
    plugin_origins: acc.plugin_origins.length ? acc.plugin_origins : undefined,
  }

  return {
    config: result,
    dirs: result.plugin?.length ? dirs : [],
  }
})

// ============================================================================
// layer —— 组装服务层
// ============================================================================

/**
 * Effect 的世界里，所有依赖都是通过 Layer 注入的。
 * 这个函数构造了 TuiConfig.Service 的完整依赖图：
 *
 *   需要的东西：
 *     - CurrentWorkingDirectory（当前工作目录）
 *     - Npm.Service（用于安装插件包）
 *
 *   做的事：
 *     1. 调用 loadState() 加载所有配置
 *     2. 遍历所有需要插件的目录，并行安装 @opencode-ai/plugin 包
 *     3. 提供 get() 和 waitForDependencies() 两个方法
 *
 *   forkScoped 的意思是：插件安装这个任务"后台运行"，
 *   不阻塞配置的返回。但主线程可以通过 waitForDependencies()
 *   在需要的时候等待安装完成。
 *
 *   前端类比：React.lazy() + Suspense —— 配置可以先用起来，
 *   插件在后台加载，需要的时候再等它们就绪。
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* CurrentWorkingDirectory
    const npm = yield* Npm.Service
    const data = yield* loadState({ directory })
    // 并行启动插件安装（不阻塞，后台运行）
    const deps = yield* Effect.forEach(
      data.dirs,
      (dir) =>
        npm
          .install(dir, {
            add: [
              {
                name: "@opencode-ai/plugin",
                version: InstallationLocal ? undefined : InstallationVersion,
              },
            ],
          })
          .pipe(Effect.forkScoped),
      {
        concurrency: "unbounded",
      },
    )

    // get 方法：直接返回缓存的配置（配置在 loadState 阶段已经算好了）
    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))

    // waitForDependencies 方法：等待所有插件安装任务完成
    // Effect.ignore() 的意思是——安装失败也不报错，日志已经打了，UI 正常启动
    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() =>
      Effect.forEach(deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.ignore(), Effect.asVoid),
    )
    return Service.of({ get, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

/**
 * defaultLayer 是给外部用的"开箱即用"版本。
 *
 * 它自动注入了 Npm.defaultLayer 和 AppFileSystem.defaultLayer，
 * 调用方不需要手动提供这些依赖。
 *
 * 类比：npm 包的默认导出 —— import xxx from "xxx" 就能直接用。
 */
export const defaultLayer = layer.pipe(Layer.provide(Npm.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

// ============================================================================
// 同步 API 出口 —— 让非 Effect 代码也能方便地使用配置服务
// ============================================================================

/**
 * makeRuntime 是 Effect 的"运行时工厂"。
 * 你把服务 + 依赖给它，它返回一个 { runPromise } 对象，
 * 让你在普通 async/await 代码里也能调用 Effect 服务的方法。
 *
 * 前端类比：这就像 Next.js 的 API Route —— 你在普通函数里
 * 发一个 await 请求，背后走整个服务层。
 */
const { runPromise } = makeRuntime(Service, defaultLayer)

/**
 * 等待插件安装完成（同步 API）。
 * 在 TUI 启动阶段调用，确保所有插件都就绪了再展示主界面。
 */
export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

/**
 * 获取 TUI 配置（同步 API）。
 * 这是最常用的入口 —— 一行代码拿到所有配置。
 *
 * 使用方式：
 *   const config = await TuiConfig.get()
 *   console.log(config.keybinds)      // 热键绑定
 *   console.log(config.attention)     // 提醒设置
 *   console.log(config.leader_timeout) // leader 等待时间
 */
export async function get() {
  return runPromise((svc) => svc.get())
}

// ============================================================================
// 模块自我导出
// ============================================================================

/**
 * 这行允许其他文件这样导入：
 *   import { TuiConfig } from "@/cli/cmd/tui/config/tui"
 *   TuiConfig.get()
 *   TuiConfig.Info
 *   TuiConfig.layer
 *
 * 把整个文件的导出打包成一个命名空间，方便按模块调用。
 */
export * as TuiConfig from "./tui"
