// ============================================================
// 📡 event.ts — 事件总线（后端到前端的消息广播接收器）
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

  // ============================================================
  // 📡 subscribe — 订阅所有事件
  // ============================================================
  // "不管什么类型的事件，都告诉我一声"
  //
  // 工作流程：
  //   1. 通过 SDK 向后端说"我要订阅 event 频道"
  //   2. 每当有事件过来，先做两层过滤：
  //      a) 如果是 "sync" 类型的事件 → 跳过（sync 事件由 sync.tsx 单独处理）
  //      b) 检查事件的归属范围：
  //         - directory === "global" → 全局事件，所有项目都收 ✅
  //         - event.project === 当前项目 → 属于当前项目的事件 ✅
  //         - 其他项目的事件 → 丢弃 ❌
  //   3. 通过过滤后，调用 handler 回调，把事件和元数据传给你
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

  // ============================================================
  // 🎯 on — 订阅特定类型的事件
  // ============================================================
  // "我只关心 message.updated 这种事件，其他的别烦我"
  //
  // 这是 subscribe 的"精装版"，底层还是调用 subscribe，
  // 但多加了一层类型过滤：
  //   - 事件的 type 跟你要的不一样 → 直接忽略
  //   - 事件的 type 匹配 → 调用你的 handler，并且 TypeScript 能自动推断出事件的具体字段
  //
  // 为什么用泛型 <T extends Event["type"]>？
  //   这样当你写 on("message.updated", ...) 时，回调里的 event 对象
  //   TypeScript 就知道是 MessageUpdated 类型，能提示出所有字段，
  //   不会给一个模糊的 Event 让你自己猜。
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
    subscribe,  // 收听所有频道
    on,         // 只收听特定频道
  }
}
