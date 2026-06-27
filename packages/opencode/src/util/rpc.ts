/***
 * 
 * 在 Bun 的 Worker 线程里，postMessage 和 onmessage 是全局方法，
 * 跟浏览器里 self.postMessage / self.onmessage 一模一样，不需要 import，直接拿来就用。
 * 
 * ***/


type Definition = {
  [method: string]: (input: any) => any
}

//  Worker 端注册方法
// 监听主线程的 rpc.request，按 method 名称路由到 rpc 对象上对应的方法执行，结果通过 rpc.result 返回。id 用于匹配请求和响应。
export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      const result = await rpc[parsed.method](parsed.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
    }
  }
}

// Worker 端推送事件
// Worker 主动向主线程单向推送事件（不需要响应），主线程通过 client.on() 订阅。
export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

// 主线程端客户端
// 把 new Worker() 实例包装成一个类型安全的 RPC 客户端，返回两个能力：
// call （发送 rpc.request）
// on  （订阅 Worker 推送的 rpc.event）
export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, (result: any) => void>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    global.myLog(evt.data, `
      ++++++++++++++++++++++++++++++++++++++++++
      + worker线程用postMessage发消息过来，主线程用 target.onmessage 函数对接，执行
      +
      ++++++++++++++++++++++++++++++++++++++++++
      `)
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result") {
      const resolve = pending.get(parsed.id)
      if (resolve) {
        resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    // 主线程发送 rpc.request
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
      })
    },
    // 主线程订阅 Worker 推送的 rpc.event
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
