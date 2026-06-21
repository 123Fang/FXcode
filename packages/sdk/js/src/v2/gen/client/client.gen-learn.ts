/**
 * 这个文件是 `@hey-api/openapi-ts` 自动生成的。
 *
 * 它的作用就一个：创建一个能发 HTTP 请求的“客户端对象”。
 *
 * 你用 `createClient()` 创建一个 client 对象，这个对象上有 `get()`、`post()`、
 * `delete()` 等快捷方法。你不需要关心底层是 Request / fetch 还是别的什么，
 * client 帮你把这些脏活都干了。
 *
 * 类似于：你开一家饭店，客人只需要说“来碗面”，你负责去厨房切菜、煮面、端上来。
 * createClient 就是那个厨师长。
 */

import { createSseClient } from "../core/serverSentEvents.gen.js"
import type { HttpMethod } from "../core/types.gen.js"
import { getValidRequestBody } from "../core/utils.gen.js"
import type { Client, Config, RequestOptions, ResolvedRequestOptions } from "./types.gen.js"
import {
  buildUrl,
  createConfig,
  createInterceptors,
  getParseAs,
  mergeConfigs,
  mergeHeaders,
  setAuthParams,
} from "./utils.gen.js"

/**
 * 把普通的 RequestInit 改造成我们内部用的类型。
 * 区别是 body 可以是任意类型（后面会被序列化成字符串/Buffer)，headers 是我们自己的合并逻辑。
 */
type ReqInit = Omit<RequestInit, "body" | "headers"> & {
  body?: any
  headers: ReturnType<typeof mergeHeaders>
}

/**
 * 核心函数：创建一个 HTTP 客户端对象。
 *
 * 你需要传一个 Config（配置），它和默认配置合并后，存成一个“全局基础配置”。
 * 之后每次发请求，都会把“全局基础配置”和“这次请求的配置”再次合并。
 *
 * 打个比方：
 *   - Config 就像是“这家店默认所有面都加辣”。
 *   - 每次请求时可以覆盖“这次不加辣”。
 *
 * @param config - 基础配置，包括 baseUrl、headers、fetch 实现等
 * @returns 一个 Client 对象，上面有 get/post/put/delete 等方法
 */
export const createClient = (config: Config = {}): Client => {
  // _config 是“当前生效的全局配置”，闭包变量，外部不能直接碰它。
  let _config = mergeConfigs(createConfig(), config)

  // 获取当前配置的快照（只读副本）。
  const getConfig = (): Config => ({ ..._config })

  // 更新配置：把新配置合并进去。
  const setConfig = (config: Config): Config => {
    _config = mergeConfigs(_config, config)
    return getConfig()
  }

  /**
   * 拦截器（interceptors）：类似于快递站的“检查点”。
   * 你可以在请求发出前/响应回来后/出错时，插入你自己的处理逻辑。
   *
   * 比如：
   *   - 请求拦截器：加一个全局 token header
   *   - 响应拦截器：统一处理 401 跳转登录页
   *   - 错误拦截器：统一 toast 弹窗报错
   */
  const interceptors = createInterceptors<Request, Response, unknown, ResolvedRequestOptions>()

  /**
   * 请求发出前的准备工作。
   *
   * 这一步做了这些事情：
   *   1. 把全局配置和本次请求配置合并
   *   2. 如果有安全认证（security），去设置认证参数（比如加 token header）
   *   3. 如果有请求校验器（requestValidator），先校验一下请求参数
   *   4. 把请求体（body）序列化成字符串或 FormData
   *   5. 构建最终的 URL（拼接 baseUrl + path + query params）
   *
   * 返回解析后的配置和 URL，供后面真正发请求用。
   */
  const beforeRequest = async (options: RequestOptions) => {
    const opts = {
      ..._config,
      ...options,
      // 优先用本次请求的 fetch，否则用全局配置的，再否则用浏览器自带的。
      fetch: options.fetch ?? _config.fetch ?? globalThis.fetch,
      // 把全局 headers 和本次 headers 合并。
      headers: mergeHeaders(_config.headers, options.headers),
      serializedBody: undefined,
    }

    // 处理认证（比如 OpenAPI 中的 securitySchemes）
    if (opts.security) {
      await setAuthParams({
        ...opts,
        security: opts.security,
      })
    }

    // 请求前校验
    if (opts.requestValidator) {
      await opts.requestValidator(opts)
    }

    // 把 body 序列化（对象 → JSON 字符串 / FormData 等）
    if (opts.body !== undefined && opts.bodySerializer) {
      opts.serializedBody = opts.bodySerializer(opts.body)
    }

    // 如果 body 为空，删掉 Content-Type header，避免发无效请求。
    if (opts.body === undefined || opts.serializedBody === "") {
      opts.headers.delete("Content-Type")
    }

    // 构建最终 URL（拼接 baseUrl、路径参数、查询参数）
    const url = buildUrl(opts)

    return { opts, url }
  }

  /**
   * 真正发请求的核心函数。
   *
   * 整个流程示意图：
   *
   *   调用方调用 client.post({ url: "/xxx", body: {...} })
   *          │
   *          ▼
   *   beforeRequest()  —— 准备阶段：合并配置、序列化 body、构建 URL
   *          │
   *          ▼
   *   创建 Request 对象
   *          │
   *          ▼
   *   请求拦截器  —— 可以修改 Request（比如偷偷加 header）
   *          │
   *          ▼
   *   fetch()      —— 真正发网络请求！
   *          │
   *          ├── 网络挂了？
   *          │      │
   *          │      ▼
   *          │   错误拦截器  —— 统一处理错误
   *          │      │
   *          │      ▼
   *          │   返回 { error: ... } 或直接 throw
   *          │
   *          ├── 成功了！
   *          │      │
   *          │      ▼
   *          │   响应拦截器  —— 可以修改 Response
   *          │      │
   *          │      ▼
   *          │   解析响应体  —— 根据 Content-Type 自动选择 JSON / text / blob 等
   *          │      │
   *          │      ▼
   *          │   校验响应数据（responseValidator）
   *          │      │
   *          │      ▼
   *          │   转换响应数据（responseTransformer）
   *          │      │
   *          │      ▼
   *          │   返回 { data: ..., request: ..., response: ... }
   *          │
   *          └── 服务器返回 4xx/5xx？
   *                 │
   *                 ▼
   *               读取错误文本 → JSON.parse 试试看 → 走错误拦截器 → 返回 { error: ... }
   */
  const request: Client["request"] = async (options) => {
    // ======== 第 1 步：准备阶段 ========
    const { opts, url } = await beforeRequest(options)
    const requestInit: ReqInit = {
      redirect: "follow",
      ...opts,
      body: getValidRequestBody(opts),
    }

    // ======== 第 2 步：创建 Request + 走请求拦截器 ========
    let request = new Request(url, requestInit)

    for (const fn of interceptors.request.fns) {
      if (fn) {
        request = await fn(request, opts)
      }
    }

    // 注意：opts.fetch 不能直接传给 Request，必须在这里手动调。
    // 因为 fetch 绑定在 window 上的，一旦被解绑再调用就会报 "Illegal invocation"。
    const _fetch = opts.fetch!
    let response: Response

    // ======== 第 3 步：发请求 ========
    try {
      response = await _fetch(request)
    } catch (error) {
      // 网络错误、请求被取消（AbortError）等都会进这里。
      let finalError = error

      for (const fn of interceptors.error.fns) {
        if (fn) {
          finalError = (await fn(error, undefined as any, request, opts)) as unknown
        }
      }

      finalError = finalError || ({} as unknown)

      // 如果配置了抛出错误，直接 throw。
      if (opts.throwOnError) {
        throw finalError
      }

      // 不抛的话，返回 undefined 或者 { error: ... }
      return opts.responseStyle === "data"
        ? undefined
        : {
            error: finalError,
            request,
            response: undefined as any,
          }
    }

    // ======== 第 4 步：走响应拦截器 ========
    for (const fn of interceptors.response.fns) {
      if (fn) {
        response = await fn(response, request, opts)
      }
    }

    const result = {
      request,
      response,
    }

    // ======== 第 5 步：解析成功的响应 ========
    if (response.ok) {
      // 根据 Content-Type 自动判断用哪种方式解析响应体。
      // 比如 application/json → 用 JSON.parse
      //      text/plain → 用 response.text()
      const parseAs =
        (opts.parseAs === "auto" ? getParseAs(response.headers.get("Content-Type")) : opts.parseAs) ?? "json"

      // 如果是 204 No Content 或者 Content-Length 为 0，说明响应体为空。
      if (response.status === 204 || response.headers.get("Content-Length") === "0") {
        let emptyData: any
        switch (parseAs) {
          case "arrayBuffer":
          case "blob":
          case "text":
            emptyData = await response[parseAs]()
            break
          case "formData":
            emptyData = new FormData()
            break
          case "stream":
            emptyData = response.body
            break
          case "json":
          default:
            emptyData = {}
            break
        }
        return opts.responseStyle === "data"
          ? emptyData
          : {
              data: emptyData,
              ...result,
            }
      }

      let data: any
      switch (parseAs) {
        case "arrayBuffer":
        case "blob":
        case "formData":
        case "text":
          data = await response[parseAs]()
          break
        case "json": {
          // 有些后端返回 200 但不带 Content-Length 且 body 为空，
          // 直接调 response.json() 会报错。所以先读文本，非空才 parse。
          const text = await response.text()
          data = text ? JSON.parse(text) : {}
          break
        }
        case "stream":
          // 流式响应直接返回 body，不消费它。
          return opts.responseStyle === "data"
            ? response.body
            : {
                data: response.body,
                ...result,
              }
      }

      // 如果是 JSON，走校验器和转换器。
      if (parseAs === "json") {
        if (opts.responseValidator) {
          await opts.responseValidator(data)
        }

        if (opts.responseTransformer) {
          data = await opts.responseTransformer(data)
        }
      }

      return opts.responseStyle === "data"
        ? data
        : {
            data,
            ...result,
          }
    }

    // ======== 第 6 步：处理失败的响应（4xx / 5xx） ========
    const textError = await response.text()
    let jsonError: unknown

    try {
      jsonError = JSON.parse(textError)
    } catch {
      // 不是 JSON 就算了，直接用文本。
    }

    const error = jsonError ?? textError
    let finalError = error

    for (const fn of interceptors.error.fns) {
      if (fn) {
        finalError = (await fn(error, response, request, opts)) as string
      }
    }

    finalError = finalError || ({} as string)

    if (opts.throwOnError) {
      throw finalError
    }

    return opts.responseStyle === "data"
      ? undefined
      : {
          error: finalError,
          ...result,
        }
  }

  /**
   * 工厂函数：给每个 HTTP 方法（GET/POST/DELETE...）创建一个快捷方法。
   *
   * 比如 makeMethodFn("POST") 返回一个函数，调用这个函数就等于调 request({..., method: "POST"})。
   *
   * 这样你写 client.post({ url: "/xxx" }) 时，它会自动把 method 设成 "POST"。
   */
  const makeMethodFn = (method: Uppercase<HttpMethod>) => (options: RequestOptions) => request({ ...options, method })

  /**
   * 工厂函数：给 SSE（Server-Sent Events，服务端推送事件）创建快捷方法。
   *
   * SSE 是一种让服务器持续向客户端推送数据的技术。
   * 普通 HTTP 请求是“请求一次，响应一次，完事”。
   * SSE 请求是“请求一次，服务器不断往你推送数据，直到你关掉”。
   *
   * 在 opencode 的场景里，当 AI 生成回复时，token 是一个一个字蹦出来的，
   * 这就需要 SSE 来实时推送每一个新 token。
   *
   * 这个函数比 makeMethodFn 多做了几件事：
   *   - 用了 createSseClient 来创建专门的 SSE 客户端
   *   - 也需要走请求拦截器（所以传了 onRequest 回调）
   */
  const makeSseFn = (method: Uppercase<HttpMethod>) => async (options: RequestOptions) => {
    const { opts, url } = await beforeRequest(options)
    return createSseClient({
      ...opts,
      body: opts.body as BodyInit | null | undefined,
      headers: opts.headers as unknown as Record<string, string>,
      method,
      // SSE 客户端发请求时也走一遍请求拦截器。
      onRequest: async (url, init) => {
        let request = new Request(url, init)
        for (const fn of interceptors.request.fns) {
          if (fn) {
            request = await fn(request, opts)
          }
        }
        return request
      },
      serializedBody: getValidRequestBody(opts) as BodyInit | null | undefined,
      url,
    })
  }

  // ======== 返回组装好的 Client 对象 ========
  return {
    buildUrl,           // URL 构建工具
    connect: makeMethodFn("CONNECT"),
    delete: makeMethodFn("DELETE"),
    get: makeMethodFn("GET"),
    getConfig,          // 获取当前配置
    head: makeMethodFn("HEAD"),
    interceptors,       // 暴露拦截器，让外部能注册 hook
    options: makeMethodFn("OPTIONS"),
    patch: makeMethodFn("PATCH"),
    post: makeMethodFn("POST"),
    put: makeMethodFn("PUT"),
    request,            // 暴露底层 request 方法，以备不时之需
    setConfig,          // 更新配置
    // SSE 方法：用于需要服务端持续推送数据的场景。
    sse: {
      connect: makeSseFn("CONNECT"),
      delete: makeSseFn("DELETE"),
      get: makeSseFn("GET"),
      head: makeSseFn("HEAD"),
      options: makeSseFn("OPTIONS"),
      patch: makeSseFn("PATCH"),
      post: makeSseFn("POST"),
      put: makeSseFn("PUT"),
      trace: makeSseFn("TRACE"),
    },
    trace: makeMethodFn("TRACE"),
  } as Client
}
