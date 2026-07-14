// ============================================================
// 📡 event.ts — 事件总线（ 只负责 后端 到 前端 的消息广播接收器！！！！）

// ============================================================
// 这个文件做的事情很简单：
//   后端有什么状态变了，就发一个"事件"过来。
//   前端组件通过这个文件来"订阅"自己关心的事件。
//
// 打个比方：
//   后端是一个广播电台📻，不停地广播"会话更新了""新消息来了""权限弹窗了"等等。
//   这个文件就是前端的"收音机📻"，可以：
//     1. 收听所有频道（subscribe）→ 收到任何事件都告诉我
//     2. 收听特定频道（on）      → 只告诉我"message.updated"这种特定事件
//
// 而且收音机会自动过滤：只收"全局事件"或"当前项目的事件"，
// 其他项目的事件不关心，直接丢弃。
// ============================================================

import type { Event } from "@opencode-ai/sdk/v2"
import { useProject } from "./project"
import { useSDK } from "./sdk"

// 每个事件附带一些额外的上下文信息
type EventMetadata = {
  workspace: string | undefined  // 事件来自哪个工作空间（工作目录）
}

// ============================================================
// 📻 useEvent — 事件的"收音机工厂"
// ============================================================
// 调用这个函数就拿到一个收音机实例，可以订阅事件了。
export function useEvent() {
  const project = useProject()  // 获取当前项目信息（用来判断事件是不是属于当前项目）
  const sdk = useSDK()          // 获取后端通信客户端

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      // ---------- 过滤 1：sync 类型事件不在这里处理 ----------
      if (event.payload.type === "sync") {
        return
      }

      // ---------- 过滤 2：只收全局事件或当前项目的事件 ----------
      if (event.directory === "global" || event.project === project.project()) {
        handler(event.payload, { workspace: event.workspace })
      }
    })
  }

  function on<T extends Event["type"]>(
    type: T,                                                         // 比如 "message.updated"、"permission.asked"
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return subscribe((event: Event, metadata: EventMetadata) => {
      if (event.type !== type) return                                // 类型不对 → 跳过
      handler(event as Extract<Event, { type: T }>, metadata)       // 类型匹配 → 调用回调
    })
  }

  return {
    subscribe,  // 收听所有频道  （后端->Tui）
    on,         // 只收听特定频道 (后端->Tui）
  }
}
