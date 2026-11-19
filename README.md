# magpie-Capy

把 [Capy](https://capy.ai) 接进 [magpie](https://usemagpie.ai) 的 provider 插件。

- **纯无头**：自动注册 `magpie-headless` 设备，走 Capy device tunnel；运行时不需要 Capy 桌面端。
- **登录**：本机 Capy 客户端导入（只读登录态）/ 浏览器登录（Google / GitHub / Passkey / 邮箱）。
- **对话**：OpenAI 兼容 `/chat/completions`，原生 SSE，流式/非流式。
- **模型**：动态目录 + 静态兜底；3 个免费模型。
- **附件**：图片 / PDF 走 Capy files 通道（单文件 250 MB）。
- **零运行时依赖**：TypeScript + Bun，构建为单个 `dist/index.mjs`。

## 安装

```bash
bun install
bun run build
```

在 Magpie 里添加本仓库路径（或直接指向 `dist/index.mjs`）。provider id 是 `capy`。

## 开发

```bash
bun test
bun run typecheck
bun run build
bun run smoke     # 真实 Capy：本机登录 → models → particle-1 "pong"
```

`smoke` 需要本机已登录 Capy 桌面端。

## 架构

```
entry (Magpie hooks)
  → application (use cases / stream / tool bridge)
    → ports (CapyApp, CapyPublic, DeviceRuntime, SecretStore, …)
      → adapters (Capy App/Public/Device tunnel/DPAPI/Host)
domain: 纯类型/错误/事件，不依赖 I/O
```

详见 [`spec/ARCHITECTURE.md`](./spec/ARCHITECTURE.md) 与 [`spec/CONTRACTS.md`](./spec/CONTRACTS.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `src/domain/` | 纯类型、错误、事件 |
| `src/application/` | 登录、目录、聊天、设备、额度、附件、工具桥 |
| `src/ports/` | 冻结接口 |
| `src/adapters/capy/` | Capy App/Public/Device/SSE/Files/local/browser |
| `src/adapters/host/` | Magpie auth 记录 |
| `src/adapters/platform/` | proxy/DPAPI/HTTP/ULID/clock/logger |
| `src/entry/` | Magpie 插件装配 |
| `src/protocol/` | SSE / OpenAI 编解码 |
| `spec/` | 行为、架构、协议、决策、审计 |

## 边界

- 无头设备只实现最小 machine RPC；终端/浏览器/写文件工具不可用。
- 免费广告模型仍受 Capy 地区/代理限制。
- 没有原生 OpenAI tools；只有 `PromptToolBridge` 提示词约定，Capy agent 可能忽略。
- 没有数据库/队列：插件是请求作用域 + 本地 device token。
- 同一 Magpie 里只安装一份 `capy` 插件。

## License

MIT
