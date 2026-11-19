# magpie-Capy

把 [Capy](https://capy.ai)（Scrapybara 的云端 coding agent）接进 [magpie](https://usemagpie.ai)。

**走 Capy 桌面端本机 / Worktree 线程，回答走公共 API 的原生 SSE。** 不轮询、不等整段回答，
assistant 帧一到就转成 OpenAI chunk；免费模型不需要 Capy credits。

- **Provider id**：`capy`
- **默认模型**：`particle/particle-1`（$0.00，本机设备实测免 credits）
- **模型**：64 个（公共目录 62 个 + 2 个 App 内免费广告模型）
- **免费标记**：3 个 `free: true`，其余 `free: false`；不显示倍率/单价
- **能力**：流式对话、思考档位、**图片/附件**、本机 Worktree 执行、额度卡片
- **工具**：默认开启提示词级 best-effort 兼容桥；`MAGPIE_CAPY_TOOL_SHIM=0` 关闭
- **登录**：浏览器登录（Google / GitHub / Passkey / 邮箱）+ 本机客户端导入

## 快速开始

前提：**Capy 桌面端已安装、已登录并保持运行**（设备显示在线）。

```bash
magpie plugin add https://github.com/baijiu666/magpie-Capy
# 本地开发也可以用路径：magpie plugin add "D:\AI\magpie\magpie-Capy"

magpie plugin login capy 1     # 从本机 Capy 客户端导入（零输入）
# 或
magpie plugin login capy 2     # 浏览器登录（打开 https://capy.ai/sign-in）
```

> 方法 1 / 2 的顺序以 magpie 界面为准；两个入口都在。

登录方式：

| 方式 | 需要什么 | 说明 |
|---|---|---|
| **浏览器登录** | 一个 Chromium 内核浏览器 | 打开 **`https://capy.ai/sign-in`**。页面上的 **Google / GitHub / Passkey / 邮箱** 四种方式都能用；登录成功后从 CDP 读 Clerk `__client`，自动换 API Key 并关闭窗口 |
| **从本机 Capy 客户端导入** | 已安装并登录 Capy 桌面端 | 零输入。读取 `%APPDATA%\Capy` 下 Windows DPAPI + AES-GCM 加密的登录态，换组织级 API Key，并记住已连接的本机设备 |

两条路径最终都会：

1. 用 Clerk 会话签一个带 `azp=https://capy.ai` 的 60 秒 JWT（只有这个 claim 能调 `api.capy.ai/app/*`）；
2. 用它在 `POST /app/orgs/{orgId}/api-keys` 签一个长期 API Key（`capy_…`）；
3. 记住一台 `connected: true` 的桌面设备（deviceId / deviceName）；
4. 把 **API Key + Clerk 会话（用于设备线程和续期）** 存进 magpie 的 `plugin-auth.json`。

Clerk 会话被桌面端轮换后，插件会在 401 时自动重新读本机登录态（Windows 本机导入），
不需要用户重新登录。

## 模型（免费/收费只看布尔值）

Capy 定价页（2026-11-19）确认 **三个 $0.00 模型**：

| 模型 | id | 免费方式 |
|---|---|---|
| Particle-1 | `particle/particle-1` | 免费、无广告、不耗 credits |
| GLM-5.3-Flash | `zai/glm-5.3-flash-ads` | **free with ads**（App 内广告） |
| DeepSeek V4.1 Flash | `deepseek/deepseek-v4.1-flash-ads` | **free with ads**（App 内广告） |

其余 61 个模型全部收费（Claude / GPT / Gemini / Grok / Kimi / Qwen / GLM 等）。
插件只写 `free: true/false`，不加价格、倍率或美元字段。

### 免费广告模型的硬条件

两个 `-ads` 模型 Capy 只允许 **Capy Web / 桌面 App 线程**，并按 **出口 IP** 放行：

> United States, Canada, United Kingdom, Australia, New Zealand, Ireland

这不是请求头能改的。插件会声明 App 的能力位 `x-capy-client-surface: desktop` +
`x-capy-client-features: message-edit,visual,ads-models`，但**出口 IP 不在上述地区时仍会
`region_unsupported`**。所以：

- 大陆直连跑不了这两个免费模型；
- 开着梯子也不一定行 —— **Node/Bun 的 fetch 默认不走 Windows 系统代理**，浏览器/桌面端走，
  插件却直连。插件已内置代理探测，见下一节。

## 代理（地区限制的关键）

插件按以下顺序找代理，并把它显式传给 fetch：

1. `MAGPIE_CAPY_PROXY`（最高优先级，写完整地址，如 `http://127.0.0.1:7890`）
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
3. Windows「Internet 选项」里的系统代理（`HKCU\…\Internet Settings` 的 `ProxyServer`）

运行时：

- **magpie 自带的 Bun 1.4.4**：`fetch(url, { proxy })`，已验证出口 IP 会变；
- **Node**：优先 `undici.ProxyAgent`，没有 undici 时只能直连并打印一次警告。

所以如果你用 Clash / v2rayN 之类的系统代理，插件会自动跟上；如果代理是 PAC 或只对浏览器生效，
请设置 `MAGPIE_CAPY_PROXY` 后重启 magpie。

想关掉自动探测：`MAGPIE_CAPY_PROXY=off`。

## 原生 SSE（性能）

每个 OpenAI 请求：

1. 用保存的 Clerk 会话签 60s JWT；
2. `GET /app/orgs/{orgId}/devices` 找一台已连接设备；
3. `POST /app/orgs/{orgId}/jams` 建 projectless 线程：

```json
{
  "jamId": "jam_<ULID>",
  "requestId": "<ULID>",
  "clientKey": "<ULID>",
  "message": "<拍平后的对话>",
  "model": { "modelId": "particle/particle-1", "reasoningMode": "medium" },
  "device": { "deviceId": "device_…", "workspace": { "kind": "worktree" } }
}
```

4. **立刻**跟公共 API 的原生流（不再轮询 outline）：

```
GET https://api.capy.ai/api/v1/threads/{jamId}/stream?until=run
Authorization: Bearer capy_…
Accept: text/event-stream
```

5. `assistant` 帧边到边转成 OpenAI `chat.completion.chunk`；`transcript` 用最终文本校正；
6. 只有 SSE 不可用（API key 失效 / 端点 404）才退回 outline 轮询。

实测（2026-11-19）：`particle/particle-1` 在本机设备零 credits 回答 `pong`；免费广告模型
通过 US 代理回答 `pong`；非流式与流式都通过。**首字延迟主要花在 Capy 桌面端启动线程 /
Worktree 上（几秒到几十秒），不是插件的轮询；Particle-1 有时一次给完整段，所以可能只看到
一个 content chunk。**

## 系统提示词

Capy 每个线程都会在服务端注入自己的 agent 提示词，**没有公开的关闭开关**。

- App 协议里有 `promptVariant: "default" | "minimal"`；插件默认 `auto`：
  每个进程先试一次 `minimal`，成功就用；当前账号实测返回 **403 `capy/Forbidden`**，
  插件自动改回 `default` 并记住，不重复付这个失败请求。
- 插件不再往用户消息里塞 “你正在通过一个 OpenAI 兼容接口接收对话” 这类自己的提示词；
  单条 user 消息原样发送，多轮才用 `<system>/<user>/<assistant>` 结构。
- 想强制关闭尝试：`MAGPIE_CAPY_PROMPT_VARIANT=default`；
  想强制试 `minimal`：`MAGPIE_CAPY_PROMPT_VARIANT=minimal`（403 时仍会自动降级）。

## 图片 / 附件（已支持）

OpenAI 的 `image_url`（data URL 或公网 URL）和 `file` / `input_file` 的 data URL 会走
Capy 官方附件通道：

```
POST /api/v1/files  {files:[{name,mediaType,sizeBytes}]}  → 预签名 PUT
→ POST /app/orgs/{org}/jams  files:[{fileId,name,mediaType,sizeBytes}]
```

实测：`particle/particle-1`（免费）看一张红圆 + 蓝方块的图，问“圆圈什么颜色”，
回答 **`Red`**。模型能力里 `image: true`、`attachment: true`，不再写“图片已省略”。

限制：

- 单文件 ≤ 20 MB，一次 ≤ 8 个，总计 ≤ 60 MB。
- 支持 `data:` URL、公网 `http(s)` URL、裸 base64；`file_id` 形式暂不支持。
- 公网 URL 会先由插件下载；本机/内网地址直接拒绝（防 SSRF）。
- 同一 API key + 同一份字节 1 小时内复用 `fileId`，多轮对话不会重复上传。

## 工具调用（默认开启，best-effort）

Capy 的线程协议**没有 OpenAI 原生 tools 通道**：

- `CreateJamRequest` / `SendMessageRequest` 都没有 `tools` 字段；
- agent 自己的 `tool_call` 事件只有一行摘要，没有 arguments / tool_call_id；
- 实测 Capy agent 会优先用自己的终端/浏览器/文件工具，并**明确拒绝**“只输出 JSON
  工具调用”的约定（三个免费模型都回了“我忽略了你的 JSON-only 指示，直接跑了自己的工具”）。

插件默认**打开** `toolcall`，客户端可以正常发送 `tools`。插件会把 `body.tools` 写进
提示词并解析 `{"tool_calls":[{"name":"…","arguments":{…}}]}`：

- 模型配合 → 返回标准 `tool_calls`（流式/非流式都支持）；
- 模型不配合 → 退回普通文本，不卡死；插件日志会打一条 warning 说明 agent 用了自己的工具。

**它不是稳定通道**：复杂 schema / 多工具选择可能被 agent 忽略。要关掉：

```bash
MAGPIE_CAPY_TOOL_SHIM=0   # 或 off / false；重启 magpie
```

`temperature` / `top_p` / `max_tokens` / `stop` / `response_format` 仍然没有上游字段，
静默忽略；`reasoning_effort` 映射到 `model.reasoningMode`。

## 边界

- **必须保持 Capy 桌面端在线**：没有已连接设备时返回 503。
- **每个请求创建一个本机 Worktree**：会累积在 `~/.capy/worktrees/jam_*`；Capy 桌面端负责展示/清理。
- **免费广告模型**：必须支持地区 + 代理出口；否则 `region_unsupported`。
- **付费模型**：本机设备线程也可能扣 credits；零余额账号请用三个免费模型。
- **工具调用**：没有原生通道；只有上面的 opt-in 提示词桥。
- **没有 per-request token 用量**：`usage` 字段置 0；组织级 token 数在额度卡片里展示。

## 本机文件

| 文件 | 用途 |
|---|---|
| `%APPDATA%\Capy\session-credential.json` | Capy 桌面端登录态（只读，DPAPI + AES-GCM） |
| `%APPDATA%\Capy\Local State` | Chromium `os_crypt` 密钥（DPAPI 保护，只读） |
| `%APPDATA%\Capy\device-credentials.json` | orgId / deviceId（只读） |
| `~/.capy/worktrees/jam_*` | 每个本机线程的 Worktree（桌面端创建） |
| `~/.config/magpie/plugin-auth.json` | magpie 保存的 API Key + 续期用 Clerk 会话 + deviceId |

## 开发

```bash
npm test                 # 115 个离线测试（auth/catalog/chat/proxy/attachments/tools/usage/本机导入/浏览器登录）
```

协议取证与真机探测脚本在仓库上级目录的 `.re-capy/`（不随插件发布）：
`AUTH.md`、`PROTOCOL.md`、`DESKTOP-INTERNALS.md`、`probe-*.mjs`。

## 许可证

MIT
