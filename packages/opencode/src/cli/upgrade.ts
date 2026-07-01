import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

/**
 * TUI 启动时的版本检查与升级逻辑
 *
 * 根据版本差距严重程度，决定三种行为：
 *   patch (1.0.0 → 1.0.1)  → 后台静默自动升级，不打扰用户
 *   minor (1.0.0 → 1.1.0)  → 弹窗通知用户有新版本，让用户手动决定
 *   major (1.0.0 → 2.0.0)  → 弹窗通知用户
 *
 * 流程图：
 *   读配置 → 检测安装方式 → 查询最新版本 → 比较版本差距
 *     ↓                            ↓
 *   autoupdate: false 直接跳过   无新版本则返回
 *                                    ↓
 *            patch? → 静默升级   minor/major? → 发射事件让 TUI 弹窗
 */
export async function upgrade() {
  // 读取全局配置中的 autoupdate 设置
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  // 如果用户关闭了自动更新，或者环境变量禁用了，直接跳过
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return

  // 检测是通过什么方式安装的：npm / brew / curl / scoop / choco
  const method = await Installation.method()
  // 查询对应渠道的最新版本号
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  // 调试标志：强制总是弹窗，不执行自动升级
  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  // 已经是最新版本，无需操作
  if (InstallationVersion === latest) return

  // 计算版本差距类型：major / minor / patch
  const kind = Installation.getReleaseType(InstallationVersion, latest)

  // 用户设置了仅通知模式，或者不是 patch 级别更新 → 弹窗让用户决定
  if (config.autoupdate === "notify" || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  // 无法确定安装方式，放弃自动升级
  if (method === "unknown") return

  // patch 级别更新 → 后台静默升级
  await Installation.upgrade(method, latest)
    .then(() =>
      // 升级成功后发射事件，TUI 可能会显示提示
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
