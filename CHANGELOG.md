# Changelog

## 0.5.0 — 2026-11-20

**去掉 Capy 桌面端依赖，改成纯无头设备。**

- 删除 `src/local.mjs`、本机导入登录、`%APPDATA%\Capy` 凭据读取、桌面端设备选择代码。
- 登录只剩浏览器登录（Google / GitHub / Passkey / 邮箱）。
- 首次对话自动走设备码配对：
  `POST /app/devices/code` → 自动 approve → poll，注册 **`magpie-headless`**，拿到 `capyd_…` token。
- 新增 `src/headless.mjs`：
  - device tunnel `wss://device-tunnel-production.cloud.capy.ai/tunnel`（`Authorization: Bearer capyd_…`）；
  - `hello` / `session-config` / `ready` / ping-pong；
  - 最小 machine server：`worktree_list` / `worktree_ensure` / `volume_landed` / `volume_probe` /
    `git capture`；终端/浏览器/写文件返回 `MachineServer.Unavailable`。
- device token 用 Windows DPAPI 加密存在 `%LOCALAPPDATA%\magpie-capy\headless-device.json`。
- 实测：无桌面端、`magpie-headless` 设备，`particle-1` 回答 `pong` **8.9 秒**。
- 额度卡片去掉「本期消费」，新增「无头设备」状态。
- 96 个离线测试。

## 0.4.1 — 2026-11-20

额度卡片与「必须连接桌面端」的解释。

- 去掉额度卡片里的 **「本期消费」**。
- 额度卡片新增 **「桌面端」** 状态：
  `已连接 · baijiu` / `未连接（免费模型需打开 Capy）` / `状态未知（请打开 Capy / 重新登录）`。
- 无设备时的错误文案明确说明：浏览器登录只提供登录态，不提供算力；免费模型必须在
  本机 Capy Worktree 里跑，云端模型需要 credits。
- `toolcall` 默认开启（0.4.0 的行为保持不变；`MAGPIE_CAPY_TOOL_SHIM=0` 可关）。
- 115 个离线测试。

## 0.4.0 — 2026-11-19

图片/附件 + 工具兼容桥。

- 图片：OpenAI `image_url` 的 data URL / 公网 URL → `POST /api/v1/files` →
  预签名 PUT → jam `files:[{fileId,name,mediaType,sizeBytes}]`。
  实测 `particle/particle-1`（免费）看到红圆图片后回答 `Red`。
- 附件：`file` / `input_file` 的 data URL 也会上传；单文件 20 MB、一次 8 个、
  总计 60 MB；本机/内网 URL 拒绝（SSRF）。
- 模型能力改为 `image: true` / `attachment: true`；图片不再是“图片已省略”。
- 工具：新增 `tools` 兼容桥（把 tools 写进提示词，解析 `tool_calls` JSON），默认开启
  `toolcall: true`。实测 Capy agent 会优先用自己的工具，并明确拒绝 JSON-only 约定；
  模型配合时返回 tool_calls，不配合时退回文本并打 warning。
  想关掉：`MAGPIE_CAPY_TOOL_SHIM=0`。
- `temperature` / `top_p` / `max_tokens` / `stop` / `response_format` 仍无上游字段。
- 续期时 API key 已失效则直接重签，不再把失效 key 带进 `completeLogin`。
- 115 个离线测试。

## 0.3.0 — 2026-11-19

原生 SSE + 三个免费模型 + 代理 + 登录/续期自愈。

- 对话改为 **`GET /api/v1/threads/{id}/stream?until=run` 原生 SSE**：assistant 帧边到边转
  OpenAI chunk，不再 750ms 轮询 outline；SSE 不可用时才兜底轮询。
- 模型表从 62 扩到 **64**：补上 `zai/glm-5.3-flash-ads`、`deepseek/deepseek-v4.1-flash-ads`。
  三个 $0.00 模型标 `free: true`，其余 `free: false`；不加倍率/单价。
- 免费广告模型按 App 协议声明 `x-capy-client-features: …,ads-models`；地区仍按出口 IP 判。
- 新增 `src/proxy.mjs`：自动读 `MAGPIE_CAPY_PROXY` / `HTTPS_PROXY` / Windows 系统代理；
  Bun 用 `fetch({proxy})`，Node 用 undici `ProxyAgent`。这是免费广告模型能跑的关键。
- 浏览器登录文案覆盖 **Google / GitHub / Passkey / 邮箱** 四种官方方式；本机导入保留。
- 系统提示词：默认 `auto` 先试 `promptVariant:"minimal"`，当前账号 403 时自动降级并记住；
  不再往用户消息里塞插件自己的“OpenAI 兼容接口”提示。
- 续期自愈：API key 还有效但 Clerk 会话被桌面端轮换时，`forceSession` 回读本机登录态。
- 100 个离线测试。

## 0.2.0 — 2026-11-19

对话改走 **Capy 桌面端本机设备（Worktree）协议**，不再使用云端公共 API。

- 新增：`POST /app/orgs/{org}/jams` 创建 projectless 本机线程（真 ULID 的 `jamId`/`requestId`，
  `device:{deviceId, workspace:{kind:"worktree"}}`）。
- 新增：`GET /app/orgs/{org}/jams/{id}/events/outline` 轮询 `items[].answer` 作为最终回复。
- 登录时自动选择一台已连接的桌面设备，并保存 `deviceId/deviceName/clientId`。
- 默认模型 `particle/particle-1`（免费、无广告、本机设备零 credits 实测可跑）。
- 模型条目标记 `particle/particle-1` 的 `free: true`。
- 健康检查：`primaryMachine.kind` 不是 `device` 时明确报 503，绝不假装本机成功。
- 仍保留两条登录：本机 Capy 客户端导入 / 浏览器登录。
- 免费广告模型（`*-ads`）仍然拒绝：Capy 只允许 App 内 + 支持地区使用。
- 85 个离线测试。

## 0.1.0 — 2026-11-19

首个版本：公共 API + 本机导入/浏览器登录 + thread/SSE 映射 + 额度卡片。
