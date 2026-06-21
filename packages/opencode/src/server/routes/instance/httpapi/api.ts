import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { EventApi } from "./groups/event"
import { ExperimentalApi } from "./groups/experimental"
import { FileApi } from "./groups/file"
import { GlobalApi } from "./groups/global"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { PermissionApi } from "./groups/permission"
import { ProjectApi } from "./groups/project"
import { ProviderApi } from "./groups/provider"
import { PtyApi, PtyConnectApi } from "./groups/pty"
import { QuestionApi } from "./groups/question"
import { SessionApi } from "./groups/session"
import { SyncApi } from "./groups/sync"
import { TuiApi } from "./groups/tui"
import { WorkspaceApi } from "./groups/workspace"
import { V2Api } from "./groups/v2"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

/***
 * 
 * 这个文件是 HttpApi 的组装入口，将所有 API group 组装成三层结构：
  OpenCodeHttpApi (顶级)
    ├── RootHttpApi           — 无需 instance 上下文的端点
    │   ├── ControlApi        — 健康检查等控制端点
    │   └── GlobalApi         — 全局端点
    │
    ├── EventApi              — SSE 事件流端点
    │
    ├── InstanceHttpApi       — 需要 instance 上下文的端点（与工作区/实例相关）
    │   ├── ConfigApi         — 配置管理
    │   ├── FileApi           — 文件操作
    │   ├── SessionApi        — 会话管理
    │   ├── McpApi            — MCP 工具/资源
    │   ├── ProviderApi       — AI 提供商
    │   ├── ProjectApi        — 项目管理
    │   ├── PtyApi            — 终端(PTY)
    │   ├── QuestionApi       — 提问
    │   ├── PermissionApi     — 权限
    │   ├── SyncApi           — 同步
    │   ├── V2Api             — V2 API
    │   ├── TuiApi            — TUI
    │   ├── WorkspaceApi      — 工作区
    │   ├── ExperimentalApi   — 实验性功能
    │   └── InstanceApi       — 实例级别操作
    │
    └── PtyConnectApi         — WebSocket PTY 连接
 * 
 * 
 * ***/

// SSE event schemas built from the BusEvent/SyncEvent registries.
const EventSchema = Schema.Union(BusEvent.effectPayloads()).annotate({ identifier: "Event" })
const SyncEventSchemas = SyncEvent.effectPayloads()

export const RootHttpApi = HttpApi.make("opencode-root")
  .addHttpApi(ControlApi)
  .addHttpApi(GlobalApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(McpApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(SessionApi)
  .addHttpApi(SyncApi)
  .addHttpApi(V2Api)
  .addHttpApi(TuiApi)
  .addHttpApi(WorkspaceApi)
  .middleware(SchemaErrorMiddleware)

export const OpenCodeHttpApi = HttpApi.make("opencode")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(PtyConnectApi)
  .annotate(HttpApi.AdditionalSchemas, [EventSchema, ...SyncEventSchemas])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
