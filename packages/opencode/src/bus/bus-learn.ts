/**
 * ============================================================================
 * bus/index.ts 学习注释版
 * ============================================================================
 *
 * 【整体功能】
 * 这个文件是 opencode 系统内部的事件总线（Event Bus）。
 * 它解决的核心问题是：模块 A 做了某件事，模块 B/C/D 想知道这个事——但 A 不应该直接
 * 依赖 B/C/D。
 *
 * 用大白话说就是：
 *   系统里几十个模块互相发消息。没有总线的话，每个模块都得知道"该通知谁"——
 *   这会让代码变成一团蚯蚓（模块间互相 import，循环依赖爆炸）。
 *   有了总线后，模块只管"喊一声"（publish），对方只管"竖起耳朵听"（subscribe），
 *   双方互不认识。
 *
 * 【三条广播通道】
 * 每个事件经过三条通道同时广播：
 *   1. typed channel（按类型订阅） — 比如只关心 SessionCreated 的模块
 *   2. wildcard channel（订阅所有） — 比如全局日志器，所有事件都收
 *   3. GlobalBus（跨进程）         — 用 Node EventEmitter 跨进程广播
 *      为什么需要跨进程？openCode 可能开了多个项目窗口，事情发生在窗口 A，
 *      窗口 B 也需要知道（比如"会话列表变了，刷新一下"）
 *
 * 【Effect 核心使用分析】
 * 这个文件依赖三个 Effect 核心概念：
 *
 * 1. PubSub（发布订阅原语）
 *    - Effect 自带的广播机制，不是 Node 的 EventEmitter
 *    - 区别在哪？Node EventEmitter 是"推"模式——推送时如果没人听，事件就丢了。
 *      Effect PubSub 是"拉"模式——发布时会暂存事件，订阅者有空时再取。
 *      这解决了"我刚发了消息但对方还没准备好订阅"的竞态问题
 *    - 不用 Effect PubSub：如果用 EventEmitter，必须手动实现背压和缓冲区；
 *      如果用第三方 PubSub 库，生命周期管理和资源释放要靠手动 try/finally
 *
 * 2. InstanceState（按项目实例隔离状态）
 *    - 它的作用简单说就是：同一个代码，不同的项目目录各自有一套独立的 PubSub。
 *      用户打开了 /project-A 和 /project-B，它们的 Bus 是独立的。
 *    - InstanceState.make 内部：创建 PubSub → 注册 Finalizer（关闭时的清理）→ 返回状态
 *    - 不用 InstanceState：需要自己维护 Map<directory, Bus> 并手动处理创建和销毁，
 *      一不留神就会内存泄漏（项目关了但 PubSub 还活着）
 *
 * 3. EffectBridge（桥接 Effect 世界和原生 callback 世界）
 *    - subscribeCallback 允许外部传一个原生 callback 函数来收事件。
 *      但 callback 的世界和 Effect 的 Fiber 世界是隔离的——
 *      如果在 callback 里抛异常，Effect 不知道；如果 Fiber 被中断，callback 还在跑。
 *      EffectBridge 就是解决这个"护城河"问题的。
 *    - 不用 EffectBridge：需要手写"两边的错误互相传递，取消时互相通知"的逻辑，
 *      极其容易写出静默失败的内存泄漏
 *
 * ============================================================================
 */

import { Effect, Exit, Layer, PubSub, Scope, Context, Stream, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import * as Log from "@opencode-ai/core/util/log"
import { BusEvent } from "./bus-event"
import { GlobalBus } from "./global"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Identifier } from "@/id/id"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "bus" })

type BusProperties<D extends BusEvent.Definition<string, Schema.Top>> = Schema.Schema.Type<D["properties"]>

/**
 * ============================================================================
 * InstanceDisposed 事件定义
 * ============================================================================
 * 当某个项目实例被销毁时，总线自动发布这个事件。
 * 其他进程可以通过 GlobalBus 监听到并清理自己的资源。
 * 
 * BusEvent.define: 定义一个"事件模板"——指定事件类型名（字符串）和它的数据格式（Schema）
 */
export const InstanceDisposed = BusEvent.define(
  "server.instance.disposed",
  Schema.Struct({
    directory: Schema.String,
  }),
)

/**
 * Payload — 事件的"信封"
 * 每个在总线上传播的事件都会被包成这个格式：
 *   id:         唯一 ID（用于去重/追踪）
 *   type:       事件类型（如 "server.instance.disposed"）
 *   properties: 事件的具体数据
 */
type Payload<D extends BusEvent.Definition = BusEvent.Definition> = {
  id: string
  type: D["type"]
  properties: BusProperties<D>
}

/**
 * State — Bus 的内部状态
 *   wildcard: 一个 PubSub，所有事件都往这里发，subscribeAll 的监听者从这里收
 *   typed:    按事件类型分组的 PubSub 表，"我只关心 SessionCreated"的监听者从这里收
 *
 * 【为什么用 PubSub 而不是自己写广播逻辑？】
 * 1. PubSub 自带背压——如果订阅者消费慢了，事件不会丢，而是排队等待
 * 2. PubSub 自动管理订阅者的生命周期——订阅者 Fiber 死了，它的订阅自动取消
 * 3. PubSub.shutdown 一行关闭所有订阅，不用手动追踪订阅者列表
 * 
 * 不用 PubSub 的坏处：
 *   - 自己写 EventEmitter + Set<callback>：需要处理"callback 抛异常了要不要移除"、
 *     "发布和订阅的并发安全"、"关闭总线时怎么通知所有订阅者"——
 *     这几个问题搞不好就是内存泄漏或事件丢失
 */
type State = {
  wildcard: PubSub.PubSub<Payload>
  typed: Map<string, PubSub.PubSub<Payload>>
}

/**
 * ============================================================================
 * Interface — Bus 服务对外暴露的 5 个操作
 * ============================================================================
 * publish:           发事件 → 三条通道（typed + wildcard + GlobalBus）
 * subscribe:         订阅特定类型 → 返回 Stream（流式消费）
 * subscribeAll:      订阅所有类型 → 返回 Stream
 * subscribeCallback: 订阅特定类型 → 用回调函数消费（适合外部非 Effect 代码）
 * subscribeAllCallback: 订阅所有类型 → 用回调函数消费
 *
 * 注意 subscribe 的返回类型是 Effect<Stream, never, Scope>：
 *   这说明订阅操作需要一个 Scope（生命周期范围）——订阅者在 Scope 关闭时自动退订。
 *   这个设计保证了"从来不会忘记取消订阅"。
 *
 * 不用 Scope 的坏处：
 *   如果用 addEventListener 的模式，必须手动 removeEventListener。
 *   遇到提前 return、异常抛出、组件销毁等情况，很容易漏掉 remove 导致内存泄漏。
 */
export interface Interface {
  readonly publish: <D extends BusEvent.Definition>(
    def: D,
    properties: BusProperties<D>,
    options?: { id?: string },
  ) => Effect.Effect<void>
  readonly subscribe: <D extends BusEvent.Definition>(
    def: D,
  ) => Effect.Effect<Stream.Stream<Payload<D>>, never, Scope.Scope>
  readonly subscribeAll: () => Effect.Effect<Stream.Stream<Payload>, never, Scope.Scope>
  readonly subscribeCallback: <D extends BusEvent.Definition>(
    def: D,
    callback: (event: Payload<D>) => unknown,
  ) => Effect.Effect<() => void>
  readonly subscribeAllCallback: (callback: (event: any) => unknown) => Effect.Effect<() => void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Bus") {}

export const use = serviceUse(Service)

/**
 * ============================================================================
 * Layer — Bus 服务的工厂
 * ============================================================================
 */
export const layer = Layer.effect( // ------ 创建某个服务的实例
  Service,
  Effect.gen(function* () { // ----- 业务逻辑就写在 Effect.gen 的生成器函数里
    // ═══════════════════════════════════════════════════════════════════════════
    // State 初始化 — Bus 的核心
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】创建当前项目实例的事件总线状态。
     * 【大白话】"这个项目目录需要一套独立的广播系统——创建两个广播频道（全量+分类），
     *   注册销毁时的清理逻辑"
     *
     * 【InstanceState.make 是什么】
     * 它的作用是"每个项目目录各自拥有一份独立的状态"。
     *
     * 打个比方：openCode 同时打开了 /project-A 和 /project-B 两个项目。
     * /project-A 的事件不该和 /project-B 的混在一起。
     * InstanceState.make 保证同一个目录只创建一次 State，不同目录互不干扰。
     *
     * 不用 InstanceState 的坏处：
     *   需要手写 WeakMap<string, State>（key = 目录路径），手动管理创建和销毁——
     *   项目目录被删除时，如果不清理对应的 State，PubSub 就永远活着（内存泄漏）
     *
     * 【Effect.addFinalizer 是什么】
     * "当这个 State 被清理时，执行这段收尾代码"。
     * 类似 try/finally，但它是声明式的——你在创建资源时就声明了怎么清理。
     *
     * 这里的 Finalizer 做了三件事：
     *   1. 发一条 InstanceDisposed 事件（让其他进程知道"我关了"）
     *   2. 关闭 wildcard PubSub（所有订阅自动终止）
     *   3. 关闭所有 typed PubSub
     *
     * 不用 addFinalizer 的坏处：
     *   需要在外层手动 try/finally 关闭 PubSub。一旦忘记（或者异常跳到没执行），
     *   订阅者就会一直等待永远不会来的事件，形成僵尸 Fiber
     */
    const state = yield* InstanceState.make<State>(
      Effect.fn("Bus.state")(function* (ctx) {
        // ↓ PubSub.unbounded: 创建一个无容量限制的广播通道
        //   "unbounded" 的意思是：队列无限长，发布者永远不会被阻塞。
        //   如果写 bounded(100)，当队列满 100 条时发布者就会等待，形成背压。
        //   这里选 unbounded 是因为事件不能丢（一个都不能少）
        const wildcard = yield* PubSub.unbounded<Payload>()
        const typed = new Map<string, PubSub.PubSub<Payload>>()

        // ↓ 注册清理逻辑：销毁时先广播"我关了"，再逐个关闭 PubSub
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* PubSub.publish(wildcard, {
              type: InstanceDisposed.type,
              id: createID(),
              properties: { directory: ctx.directory },
            })
            yield* PubSub.shutdown(wildcard)
            for (const ps of typed.values()) {
              yield* PubSub.shutdown(ps)
            }
          }),
        )

        return { wildcard, typed }
      }),
    )

    /**
     * getOrCreate — 懒创建 typed PubSub
     * 【大白话】"查一下有没有这个事件类型对应的频道；没有就现场建一个"
     * 这是典型的"用时才创建"模式，避免提前为所有事件类型建好频道
     */
    function getOrCreate<D extends BusEvent.Definition>(state: State, def: D) {
      return Effect.gen(function* () {
        let ps = state.typed.get(def.type)
        if (!ps) {
          ps = yield* PubSub.unbounded<Payload>()
          state.typed.set(def.type, ps)
        }
        return ps as unknown as PubSub.PubSub<Payload<D>>
      })
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // publish — 发布事件
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】把一个事件广播出去。
     * 【大白话】"有人做了某件事 → 通知 typed 频道的订阅者 + 通知 wildcard（全量）订阅者
     *   + 通过 GlobalBus 通知其他进程的窗口"
     *
     * 三条广播路径：
     *   1. s.typed.get(def.type): 按类型发布 → 只通知关心这个事件类型的聆听者
     *   2. s.wildcard: 全量发布 → 通知所有订阅了 subscribeAll 的聆听者
     *   3. GlobalBus.emit: 跨进程 → 通知其他 openCode 窗口
     *
     * 为什么 typed 和 wildcard 都要发？
     *   如果没有 wildcard：日志器、调试工具这些"对所有事件都感兴趣"的模块就得
     *   订阅每一种事件类型，声明几十条 subscribe，又丑又不灵活。
     *
     * 为什么还需要 GlobalBus？
     *   因为 Effect PubSub 局限在当前进程内。GlobalBus 是 Node EventEmitter，
     *   通过 electron 的 IPC 或类似的跨窗口机制传播事件。
     */
    function publish<D extends BusEvent.Definition>(def: D, properties: BusProperties<D>, options?: { id?: string }) {
      return Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        const payload: Payload = { id: options?.id ?? createID(), type: def.type, properties }
        log.info("publishing", { type: def.type })

        const ps = s.typed.get(def.type)
        if (ps) yield* PubSub.publish(ps, payload)
        yield* PubSub.publish(s.wildcard, payload)

        const dir = yield* InstanceState.directory
        const context = yield* InstanceState.context
        const workspace = yield* InstanceState.workspaceID

        GlobalBus.emit("event", {
          directory: dir,
          project: context.project.id,
          workspace,
          payload,
        })
      })
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // subscribe — 订阅特定事件（返回 Stream）
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】订阅某个事件类型，返回一个 Stream，调用方可以一步步消费事件。
     * 【大白话】"我要听 SessionCreated 事件 → 找到（或创建）对应的 PubSub 频道
     *   → 拿到订阅句柄 → 转成 Stream  → 返回给调用方慢慢消费"
     *
     * 【关键步骤解析】
     *   1. InstanceState.get(state): 确保当前有活跃的 instance（如果项目已经销毁了，这里会报错）
     *   2. getOrCreate(s, def): 拿到对应类型的 PubSub（有就用，没有就建）
     *   3. PubSub.subscribe(ps): 在 PubSub 里注册一个订阅者，返回 subscription
     *   4. Effect.addFinalizer: 当 Scope 关闭时，打印一条"退订了"的日志
     *   5. Stream.fromSubscription(subscription): 把 Effect 的 Subscription 对象
     *      转成 Stream——这样调用方可以用 Stream 的全部操作（filter、map、take 等）
     *
     * 【为什么返回 Stream 而不是直接给 callback？】
     *   - 用 Stream + 它的操作符（filter/map/take/...），调用方可以管式处理事件：
     *     stream.pipe(Stream.filter(e => ...), Stream.take(5), Stream.runForEach(...))
     *   - 用 callback 的话：嵌套回调 → 取消困难 → 错误处理分散
     *
     * 【Scope.Scope 约束】
     *   返回类型里 Consume 了 Scope.Scope，意味着"谁调用 subscribe，谁就要提供一个 Scope"。
     *   Scope 关闭时 → addFinalizer 触发 → 打印日志（实际退订是 PubSub 自动管理的）
     */
    const subscribe = <D extends BusEvent.Definition>(
      def: D,
    ): Effect.Effect<Stream.Stream<Payload<D>>, never, Scope.Scope> =>
      Effect.gen(function* () {
        log.info("subscribing", { type: def.type })
        const s = yield* InstanceState.get(state)
        const ps = yield* getOrCreate(s, def)
        const subscription = yield* PubSub.subscribe(ps)
        yield* Effect.addFinalizer(() => Effect.sync(() => log.info("unsubscribing", { type: def.type })))
        return Stream.fromSubscription(subscription)
      })

    // ═══════════════════════════════════════════════════════════════════════════
    // subscribeAll — 订阅所有事件（返回 Stream）
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】和 subscribe 一样，只是订阅的是 wildcard 通道——所有类型的事件都收。
     */
    const subscribeAll = (): Effect.Effect<Stream.Stream<Payload>, never, Scope.Scope> =>
      Effect.gen(function* () {
        log.info("subscribing", { type: "*" })
        const s = yield* InstanceState.get(state)
        const subscription = yield* PubSub.subscribe(s.wildcard)
        yield* Effect.addFinalizer(() => Effect.sync(() => log.info("unsubscribing", { type: "*" })))
        return Stream.fromSubscription(subscription)
      })

    // ═══════════════════════════════════════════════════════════════════════════
    // on — callback 订阅的底层实现
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】在 PubSub 上注册一个原生的 callback 监听器。
     * 【大白话】"给一个 callback 函数，我帮你监听到 PubSub 上的事件，然后回调它。
     *   返回一个取消函数，调了就停止监听。"
     *
     * 【为什么要分 Stream 和 Callback 两种订阅方式？】
     *   - Stream 方式：适合 Effect 内部的模块之间通信（都在 Effect 世界）
     *   - Callback 方式：适合外部非 Effect 代码（如 UI 层、第三方库）需要收事件
     *
     * 【EffectBridge 是什么】
     *   EffectBridge 是一个"桥"，连接两个世界：
     *     - Effect 世界：Fiber 管理、Scope 清理、中断传播
     *     - 原生世界：callback 函数、没有自动清理、没有中断
     *
     *   在这个场景里，外部传了一个 callback。这个 callback 不在 Effect 的管辖范围内，
     *   如果它抛异常了，Effect 默认不知道（不会传播到调用链）。
     *   EffectBridge 保证两边的事件和错误能正确互通。
     *
     *   Scope.make() + Scope.provide(scope):
     *     建一个独立的 Scope，把 PubSub 订阅和 Stream 消费都关在这个 Scope 里。
     *     返回的取消函数本质是"关闭这个 Scope"，Scope 一关 → PubSub 订阅取消 → Stream 停止。
     *
     *   Stream.runForEach + Effect.forkScoped:
     *     启动一个后台协程（Fiber）不断消费 Stream 中的事件并调用 callback。
     *     用 Effect.tryPromise(callback) 包住 callback，防止 callback 抛错导致整个 Fiber 崩掉。
     */
    function on<T>(pubsub: PubSub.PubSub<T>, type: string, callback: (event: T) => unknown) {
      return Effect.gen(function* () {
        log.info("subscribing", { type })
        const bridge = yield* EffectBridge.make()
        const scope = yield* Scope.make()

        // ↓ 在独立 Scope 里订阅 PubSub
        const subscription = yield* Scope.provide(scope)(PubSub.subscribe(pubsub))

        // ↓ 在同一个 Scope 里启动后台消费协程
        yield* Scope.provide(scope)(
          Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((msg) =>
              // ↓ Effect.tryPromise: 把 Promise 转成 Effect，同时捕获同步/异步错误
              Effect.tryPromise({
                try: () => Promise.resolve().then(() => callback(msg)),
                catch: (cause) => {
                  log.error("subscriber failed", { type, cause })
                },
              }).pipe(Effect.ignore), // callback 失败不传播到外层（一个 callback 坏了不影响其他）
            ),
            // ↓ forkScoped: 在 scope 里启动协程——scope 关闭时自动中断这个协程
            Effect.forkScoped,
          ),
        )

        // ↓ 返回取消函数：关闭 scope → PubSub 退订 → 协程自动中断
        return () => {
          log.info("unsubscribing", { type })
          bridge.fork(Scope.close(scope, Exit.void))
        }
      })
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // subscribeCallback / subscribeAllCallback — callback 订阅的公开接口
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * 【功能】这两个函数是对 on() 的封装，分别订阅特定类型和所有类型。
     * Effect.fn("Bus.subscribeCallback") 给予调用追踪能力。
     */
    const subscribeCallback = Effect.fn("Bus.subscribeCallback")(function* <D extends BusEvent.Definition>(
      def: D,
      callback: (event: Payload<D>) => unknown,
    ) {
      const s = yield* InstanceState.get(state)
      const ps = yield* getOrCreate(s, def)
      return yield* on(ps, def.type, callback)
    })

    const subscribeAllCallback = Effect.fn("Bus.subscribeAllCallback")(function* (callback: (event: any) => unknown) {
      const s = yield* InstanceState.get(state)
      return yield* on(s.wildcard, "*", callback)
    })

    return Service.of({ publish, subscribe, subscribeAll, subscribeCallback, subscribeAllCallback })
  }),
)

export const defaultLayer = layer

/**
 * ============================================================================
 * makeRuntime — 创建一个独立运行时
 * ============================================================================
 * makeRuntime(Service, layer):
 *   把 Bus 服务 + 它的 Layer 变成 { runPromise, runSync } 两个函数。
 *
 *   runPromise: 在多实例环境下运行——给每个项目分配独立的 Bus 实例
 *   runSync:    在单例模式下运行——用于全局唯一场景（如 createID）
 *
 * 【用途】
 *   文件底部的 publish/subscribe/subscribeAll 三个导出函数就是"非 Effect 世界的便利层"：
 *   外部代码不需要自己管理 Scope 和 Fiber，直接调这些函数就能发/收事件。
 *
 *   不用 makeRuntime 的坏处：
 *     需要在每个调用点手动创建 Runtime → 提供 Layer → 运行 Effect → 回收资源。
 *     重复代码多，一不小心就忘记回收导致内存泄漏
 */
const { runPromise, runSync } = makeRuntime(Service, layer)

/**
 * createID — 生成事件唯一 ID
 * runSync 安全的原因：subscribe 链上的操作（InstanceState.get, PubSub.subscribe,
 * Scope.make, Effect.forkScoped）全都是同步完成的，没有异步等待。
 * 如果将来任何一个环节变成异步的，runSync 这里就会抛异常（sync 不允许有 await 点）
 */
export function createID() {
  return Identifier.create("evt", "ascending")
}

/**
 * ============================================================================
 * 公开的便利函数（非 Effect 世界用）
 * ============================================================================
 * 这三个函数封装了 Effect 的复杂度，让外部代码可以像调普通函数一样使用事件总线。
 * 内部通过 runPromise/runSync 把 Effect 的执行细节全部隐藏。
 */
export async function publish<D extends BusEvent.Definition>(
  ctx: InstanceContext,
  def: D,
  properties: BusProperties<D>,
  options?: { id?: string },
) {
  return runPromise((svc) => svc.publish(def, properties, options).pipe(Effect.provideService(InstanceRef, ctx)))
}

export function subscribe<D extends BusEvent.Definition>(def: D, callback: (event: Payload<D>) => unknown) {
  return runSync((svc) => svc.subscribeCallback(def, callback))
}

export function subscribeAll(callback: (event: any) => unknown) {
  return runSync((svc) => svc.subscribeAllCallback(callback))
}

export * as Bus from "."
