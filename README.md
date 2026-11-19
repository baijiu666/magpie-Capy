# magpie-Capy

把 [Capy](https://capy.ai)（Scrapybara 的云端 coding agent）接进 [magpie](https://usemagpie.ai)。

**纯无头**：浏览器登录 + 自动注册 `magpie-headless` 设备 + device tunnel。**不需要 Capy 桌面端**，
不需要开着窗口/进程，也不读 `%APPDATA%\Capy` 的登录凭据。

- **Provider id**：`capy`
- **默认模型**：`particle/particle-1`（$0.00，免费）
- **模型**：64 个（公共目录 62 个 + 2 个 App 内免费广告模型）
- **免费标记**：3 个 `free: true`，其余 `free: false`；不显示倍率/单价
- **能力**：流式对话、思考档位、图片/附件、无头设备、额度卡片
- **登录**：浏览器登录（Google / GitHub / Passkey / 邮箱）

## 快速开始

```bash
magpie plugin add https://github.com/baijiu666/magpie-Capy
magpie plugin login capy 1     # 浏览器登录（打开 https://capy.ai/sign-in）
```

首次对话会自动：

1. 用浏览器登录的 Clerk 会话调 `POST /app/devices/code` 拿设备码；
2. 自动 `code/approve` + `code/poll`，注册一台名为 **`magpie-headless`** 的设备；
3. 把 `capyd_…` device token 用 Windows DPAPI 加密存到本机；
4. 连 `wss://device-tunnel-production.cloud.capy.ai/tunnel`，发 `hello` / `ready`；
5. 之后所有对话都在这个无头设备上跑，**无需任何 Capy 桌面端**。

## 设备隧道与最小 machine server

无头设备实现了一个最小 machine server：

| 功能 | 实现 |
|---|---|
| `worktree_list` / `worktree_ensure` | 创建/列出 `~/.capy/worktrees/jam_*` |
| `volume_landed` / `volume_probe` | 返回 `current` |
| `git capture` | 返回空 repos |
| terminal / browser / write / transfer | 返回 `MachineServer.Unavailable`（不执行） |

因此适合**纯文本 / 图片对话**；终端、浏览器、写文件这类 coding agent 工具不会真正执行。
实测：无桌面端、`magpie-headless` 设备，`particle-1` 回答 `pong` 用时 **8.9 秒**。

## 模型（免费/收费只看布尔值）

Capy 定价页（2026-11-19）确认 **三个 $0.00 模型**：

| 模型 | id | 免费方式 |
|---|---|---|
| Particle-1 | `particle/particle-1` | 免费、无广告、不耗 credits |
| GLM-5.3-Flash | `zai/glm-5.3-flash-ads` | **free with ads**（App 内广告） |
| DeepSeek V4.1 Flash | `deepseek/deepseek-v4.1-flash-ads` | **free with ads**（App 内广告） |

其余 61 个模型全部收费。插件只写 `free: true/false`，不加价格、倍率或美元字段。
三个免费模型排在目录最前（magpie 的 `/v1/models` 每个 provider 只展示前 24 个）。

### 免费广告模型的地区限制

两个 `-ads` 模型按 **出口 IP** 放行：

> United States, Canada, United Kingdom, Australia, New Zealand, Ireland

这是服务端判定，不是请求头。插件会自动读代理并显式传给 fetch：

1. `MAGPIE_CAPY_PROXY`
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
3. Windows 系统代理

Bun 用 `fetch({ proxy })`，Node 用 undici `ProxyAgent`。没有代理也能用 `particle-1`；
两个 `-ads` 模型需要支持地区的出口。

## 原生 SSE（性能）

每个 OpenAI 请求：

1. 用保存的 Clerk 会话签 60s JWT；
2. 确保 `magpie-headless` 设备在线；
3. `POST /app/orgs/{orgId}/jams` 建 projectless 设备线程；
4. 跟公共 API 原生流：

```
GET https://api.capy.ai/api/v1/threads/{jamId}/stream?until=run
Authorization: Bearer capy_…
Accept: text/event-stream
```

5. `assistant` 帧边到边转 OpenAI chunk；`transcript` 用最终文本校正；
6. 只有 SSE 不可用时才退回 outline 轮询。

首字延迟主要花在 Capy 调度/agent 启动上；插件本身不轮询。

## 图片 / 附件

OpenAI 的 `image_url`（data URL 或公网 URL）和 `file` / `input_file` 的 data URL 会走
Capy 官方附件通道：

```
POST /api/v1/files → 预签名 PUT → jam files:[{fileId,name,mediaType,sizeBytes}]
```

实测：`particle/particle-1` 看红圆图片后回答 **`Red`**（非流式 + 流式都通过）。

- 单文件 ≤ 20 MB，一次 ≤ 8 个，总计 ≤ 60 MB。
- 支持 `data:` URL、公网 `http(s)` URL、裸 base64；`file_id` 形式暂不支持。
- 本机/内网 URL 拒绝（防 SSRF）。
- 同一 API key + 同一份字节 1 小时内复用 `fileId`。

## 系统提示词

Capy 每个线程都会在服务端注入自己的 agent 提示词，**没有公开关闭开关**。

- 插件默认 `auto`：每个进程先试一次 `promptVariant:"minimal"`；当前账号 403，
  自动改回 `default` 并记住。
- 不再往用户消息里塞插件自己的“OpenAI 兼容接口”提示；单条 user 消息原样发送。
- `MAGPIE_CAPY_PROMPT_VARIANT=default` 关闭尝试；`minimal` 强制试（403 仍会降级）。

## 工具调用（默认开启，best-effort）

Capy 线程协议没有 OpenAI 原生 tools 通道；插件把 `body.tools` 写进提示词并解析：

```json
{"tool_calls":[{"name":"…","arguments":{…}}]}
```

模型配合时返回标准 `tool_calls`；不配合时退回文本并打 warning。
`MAGPIE_CAPY_TOOL_SHIM=0` 可关闭。**它不是稳定通道**。

`temperature` / `top_p` / `max_tokens` / `stop` / `response_format` 没有上游字段，静默忽略；
`reasoning_effort` 映射到 `model.reasoningMode`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAGPIE_CAPY_PROXY` | 自动探测 | 代理地址；`off` 关闭 |
| `MAGPIE_CAPY_HEADLESS` | `auto` | `off` 关闭无头设备（会没有可用设备） |
| `MAGPIE_CAPY_PROMPT_VARIANT` | `auto` | `default` / `minimal` / `auto` |
| `MAGPIE_CAPY_TOOL_SHIM` | 开启 | `0` 关闭 tools 兼容桥 |
| `MAGPIE_CAPY_BROWSER` | 自动发现 | 浏览器 exe 路径 |

## 本机文件

| 文件 | 用途 |
|---|---|
| `%LOCALAPPDATA%\magpie-capy\headless-device.json` | 无头设备状态（DPAPI 加密的 `capyd_…` token） |
| `~/.config/magpie/plugin-auth.json` | magpie 保存的 API Key + Clerk 会话 |
| `~/.capy/worktrees/jam_*` | 无头设备创建的 Worktree |

**不再读取** `%APPDATA%\Capy\device-credentials.json` / `Local State` / `session-credential.json`。

## 边界

- **纯无头**：不需要 Capy 桌面端，但无头设备只实现最小 machine server；终端/浏览器/写文件工具不可用。
- **免费广告模型**：需要支持地区 + 代理出口；否则 `region_unsupported`。
- **付费模型**：仍受 Capy credits / 套餐限制。
- **工具调用**：只有提示词级 best-effort 桥。
- **没有 per-request token 用量**：`usage` 字段置 0；组织级 token 数在额度卡片里展示。

## 开发

```bash
npm test                 # 96 个离线测试（auth/catalog/chat/proxy/headless/attachments/tools/usage/browser）
```

设备隧道取证见 [DEVICE-TUNNEL.md](./DEVICE-TUNNEL.md)。

## 许可证

MIT
