# AGENTS.md —— 给 AI 执行者的入口

先读这个，再动代码。契约细节在 `D:\AI\magpie\magpie-PhanthyCode\HOOKS.md`；Capy 的协议取证在
`.re-capy\AUTH.md`、`.re-capy\PROTOCOL.md`、`.re-capy\DESKTOP-INTERNALS.md`。

## 一、这个插件的形状

**对话走桌面端本机设备（Worktree），回答走公共 API 的原生 SSE，不再轮询 outline。**

```
用户            OpenAI 请求                         Capy 桌面协议
────           ─────────────                        ──────────────
登录 →  浏览器登录 / 本机导入  →  Clerk azp 会话  →  组织级 API Key（模型/额度）
对话 →  POST /chat/completions  →  POST /app/orgs/{org}/jams
                                     {jamId/requestId: ULID, message, model,
                                      device:{deviceId, workspace:{kind:"worktree"}}}
                                   → 桌面端在 ~/.capy/worktrees/jam_<id> 执行
                                   → GET /api/v1/threads/{id}/stream?until=run
                                     assistant 帧 = 实时文本；transcript = 最终文本
```

`index.mjs` 只做装配；实现全在 `src/`：

| 文件 | 负责 |
|---|---|
| `src/constants.mjs` | 端点、provider、默认模型、TTL、图标 |
| `src/models.mjs` | 62 个公共模型快照 + 2 个 App 内 free-with-ads 模型 |
| `src/local.mjs` | 本机导入：DPAPI → AES-256-GCM → Clerk client JWT |
| `src/browser.mjs` | 浏览器登录：临时 Chromium + CDP 读 `__client` Cookie（Google/GitHub/Passkey/邮箱都在官方页） |
| `src/auth.mjs` | Clerk 换票（azp）、读账号/组织/设备、签 API Key、续期（401 时回读本机登录态） |
| `src/catalog.mjs` | `GET /models`、模型解析、3 个免费模型的 `free` 标记 |
| `src/chat.mjs` | messages 拍平、ULID、建本机线程、**原生 SSE**、OpenAI chunk/JSON、outline 兜底 |
| `src/attachments.mjs` | `image_url`/`file` → `POST /api/v1/files` → 预签名 PUT → jam `files[]` |
| `src/tools.mjs` | OpenAI tools 提示词桥（默认开启；`MAGPIE_CAPY_TOOL_SHIM=0` 关闭） |
| `src/proxy.mjs` | 系统代理 / 环境变量 / Bun fetch proxy；地区限制靠出口 IP |
| `src/usage.mjs` | `/usage` + `/usage/balance` → magpie 额度窗口 |
| `src/errors.mjs` | 错误词表、Capy `_tag` 归一、SSE error 帧 |

## 二、会静默出错的坑

| # | 症状 | 判据 |
|---|---|---|
| 1 | 登录成功，但所有 `/app/*` 都 401 | Clerk 换票必须走 **`Origin: https://capy.ai` + `Cookie: __client=…`**，这样 JWT 才带 `azp`；`Origin` 和 `Authorization` 同传会被 Clerk 400 |
| 2 | 建线程 400 空 body | App API 的 `jamId` 和 `requestId` 必须是**真 ULID**（26 位 Crockford base32）。假 ULID 能过正则，但服务端 schema 会 400 |
| 3 | 建线程返回 `primaryMachine.kind:"cloud"` | 没带 `device` 或设备不在线；必须带 `device:{deviceId,workspace:{kind:"worktree"}}`，并在 `createDeviceThread` 里硬校验 |
| 4 | 免费广告模型 400/403 | 两个 `*-ads` 模型只允许 App 线程 + **US/CA/UK/AU/NZ/IE 出口 IP**；必须带 `x-capy-client-features: …,ads-models`，且请求要走代理 |
| 5 | 梯子开着，插件仍 `region_unsupported` | **Node/Bun fetch 不会自动读 Windows 系统代理**；插件必须用 `src/proxy.mjs` 显式传 proxy。浏览器能上 ≠ 插件能上 |
| 6 | `promptVariant:"minimal"` 403 | 当前账号不允许 minimal；`runThread` 会捕获 `prompt_variant_forbidden` 并改回 default。不要把它当致命错误 |
| 7 | 聊天 401，重新登录后又好了 | magpie 里保存的 Clerk 会话可能被桌面端轮换；`refreshCredential(forceSession)` 会回读本机 Capy 登录态，无需重新扫码 |
| 8 | 线程建了但一直没回答 | 先看 `GET /app/.../jams/{id}` 的 `ask`：`credits` → 402；`desktop` → 503。公共 SSE 不可用时才退回 outline 轮询 |
| 9 | 想用 `deepseek/deepseek-v4.1-flash-ads` / `zai/glm-5.3-flash-ads` 但 404 | 它们不在公共 `/models` 里，`catalog.mjs` 手动合并；`resolveModel` 必须能解析，别再按 `-ads` 拒绝 |
| 10 | 桌面端没开 | `resolveDeviceSession` 找不到 `connected:true` 设备 → 503；错误文案要让用户打开 Capy 桌面端 |
| 11 | 改了代码重装行为没变 | 路径插件直接读源码；如果装到 `node_modules` 副本，重新 `magpie plugin add` |
| 12 | 卡片「剩余额度未知」 | 每条 window 都必须有有限 `used`；`remainingDollars:null` 时要给 `used:100`，不能漏 |
| 13 | 免费模型仍被 credits 拦 | 说明线程跑在云端；本机设备线程不会。检查 `primaryMachine.kind` 和 `device` |
| 14 | 用 `CAPY_*` 模型 id 时 404 | magpie 会发 `capy/particle/particle-1`；`resolveModel` 会剥掉 `capy/` 前缀 |
| 15 | Capy App 的模型标签 ≠ 实际模型 | credits 不足时 App 会静默降级到 `particle/particle-1`；以线程 `lastModelId` / assistant 事件 `model.modelId` 为准 |
| 16 | 带图片建线程 400 空 body | App 的 `files[]` 不是公共 API 的 `{fileId,name}`，必须带 **`{fileId,name,mediaType,sizeBytes}`**；`sizeBytes` 必须是整数 |
| 17 | 图片上传后模型看不见 | `POST /api/v1/files` 只给预签名 URL；必须再 PUT 字节（Content-Type/Length 与声明一致，不带 Authorization），然后 jam 带 `files` |
| 18 | 想用 OpenAI tools 却拿不到 `tool_calls` | Capy agent 会优先用自己的工具，并明确拒绝“只输出 JSON”的约定。默认 `toolcall:true` + best-effort 桥；模型不配合时退回文本并打 warning。`MAGPIE_CAPY_TOOL_SHIM=0` 关闭 |

## 三、命令

```bash
node --test                 # 115 个离线测试
magpie plugin add "D:\AI\magpie\magpie-Capy"
magpie plugin login capy 1  # 本机导入（需要桌面端在线）
magpie plugin login capy 2  # 浏览器登录 https://capy.ai/sign-in（Google/GitHub/Passkey/邮箱）
magpie plugin list | grep -A1 capy

# 走真实网关（本机 3425）验证本机设备线程
curl -sS http://127.0.0.1:3425/v1/chat/completions \
  -H "authorization: Bearer <caller-keys.json 里的 secret>" \
  -H 'content-type: application/json' \
  -d '{"model":"capy/particle/particle-1","messages":[{"role":"user","content":"Reply with exactly: pong"}]}'
```

## 四、免费模型与地区

唯一来源是 Capy 定价页（2026-11-19）：

| id | 免费方式 |
|---|---|
| `particle/particle-1` | $0.00，无广告，本机设备零 credits |
| `zai/glm-5.3-flash-ads` | $0.00，free with ads |
| `deepseek/deepseek-v4.1-flash-ads` | $0.00，free with ads |

其余 61 个模型收费。插件只设置 `free: true/false`，不写倍率/单价。
免费广告模型的地区判定在服务端，按出口 IP；改请求头没用。

## 五、不要做的事

- 不要往 `~/.config/magpie` 写东西（插件只通过 magpie 的 auth 记录保存）。
- 不要把 Capy 的 client JWT / API Key 打进日志或错误文案。
- 不要把 API Key 用于 `/app/*`（只认 Clerk token），也不要把 Clerk token 用于 `/api/v1/*`（只认 API Key）。
- 不要伪造广告曝光/`impUrl`；插件只声明 App 能力位，不伪造曝光。
- 图片/附件是支持的（`POST /api/v1/files` + jam `files`）；不要再写“图片已省略”。
- 不要声称原生 OpenAI tools：默认开着 `MAGPIE_CAPY_TOOL_SHIM` 的提示词桥，但 Capy agent 会优先用自己的工具，必要时退回文本。
- 不要声称 temperature / top_p / max_tokens / stop / response_format / PDF 解析 —— 上游没有对应字段。
- 不要静默把未知模型换成默认模型（必须 404）。
- 不要为了“性能”重新加 750ms outline 轮询；原生 SSE 才是主路径。
