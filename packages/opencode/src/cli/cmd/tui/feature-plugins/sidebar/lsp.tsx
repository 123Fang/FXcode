import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-lsp"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.lsp())
  const off = createMemo(() => !props.api.state.config.lsp)

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
        <Show when={list().length > 2}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={theme().text}>
          <b>LSP</b>
        </text>
      </box>
      <Show when={list().length <= 2 || open()}>
        <Show when={list().length === 0}>
          <text fg={theme().textMuted}
            // fx 添加自定义弹窗，是否开启lsp功能（暂不对接修改lsp相关配置，先只展示ui）
            onMouseUp={() => {
              props.api.ui.dialog.replace(() => (
                <props.api.ui.DialogSelect
                  title="选择是否启用LSP (自定义)"
                  options={[
                    { title: "开启LSP (开启后，读文件时才会被激活)", value: 1 },
                    { title: "暂不开启", value: 2 },
                  ]}
                />
              ))
            }
            }
          >{off() ? "LSPs are disabled" : "LSPs will activate as files are read"}</text>
        </Show>
        <For each={list()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg: item.status === "connected" ? theme().success : theme().error,
                }}
              >
                •
              </text>
              <text fg={theme().textMuted}>
                {item.id} {item.root}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
