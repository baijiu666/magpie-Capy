# AGENTS.md —— 给 AI 执行者的入口

先读这个，再动代码。契约细节在 `D:\AI\magpie\magpie-PhanthyCode\HOOKS.md`；Capy 的协议取证在
`.re-capy\AUTH.md`、`.re-capy\PROTOCOL.md`、`.re-capy\DESKTOP-INTERNALS.md`、`DEVICE-TUNNEL.md`。

## 一、这个插件的形状

**纯无头：浏览器登录 → 自动注册 magpie-headless → device tunnel → 设备线程。不需要 Capy 桌面端。**

```
用户            OpenAI 请求                      Capy App / device tunnel
────           ─────────────                     ───────────────────────
浏览器登录  →  Clerk 会话 + API Key
首次对话    →  /devices/code → approve → poll  →  capyd_… 设备 token（DPAPI 保存）
对话        →  POST /chat/completions          →  POST /app/orgs/{org}/jams
                                                  device:{deviceId, worktree}
                                               →  GET /api/v1/threads/{id}/stream?until=run
                                                  assistant 帧 = 实时文本
```

`index.mjs` 只做装配；实现全在 `src/`：

| 文件 | 负责 |
|---|---|
| `src/constants.mjs` | 端点、provider、默认模型、TTL、图标 |
| `src/models.mjs` | 62 个公共模型快照 + 2 个 App 内 free-with-ads 模型 |
| `src/browser.mjs` | 浏览器登录：临时 Chromium + CDP 读 `__client` Cookie（Google/GitHub/Passkey/邮箱） |
| `src/auth.mjs` | Clerk 换票（azp）、读账号/组织、签 API Key、续期 |
| `src/catalog.mjs` | `GET /models`、模型解析、3 个免费模型的 `free` 标记 |
| `src/chat.mjs` | messages 拍平、ULID、建设备线程、**原生 SSE**、OpenAI chunk/JSON、outline 兜底 |
| `src/headless.mjs` | 设备码配对、DPAPI state、device tunnel、最小 machine server RPC |
| `src/attachments.mjs` | `image_url`/`file` → `POST /api/v1/files` → 预签名 PUT → jam `files[]` |
| `src/tools.mjs` | opt-in 的 OpenAI tools 提示词桥（默认开启） |
| `src/proxy.mjs` | 系统代理 / 环境变量 / Bun fetch proxy；地区限制靠出口 IP |
| `src/usage.mjs` | `/usage` + `/usage/balance` → magpie 额度窗口 |
| `src/errors.mjs` | 错误词表、Capy `_tag` 归一、SSE error 帧 |

## 二、会静默出错的坑

| # | 症状 | 判据 |
|---|---|---|
| 1 | 登录成功，但所有 `/app/*` 都 401 | Clerk 换票必须走 **`Origin: https://capy.ai` + `Cookie: __client=…`**，这样 JWT 才带 `azp`；`Origin` 和 `Authorization` 同传会被 Clerk 400 |
| 2 | 建线程 400 空 body | App API 的 `jamId` 和 `requestId` 必须是**真 ULID**（26 位 Crockford base32） |
| 3 | 建线程返回 `primaryMachine.kind:"cloud"` | 无头设备没连上；检查 `startHeadless` / `/devices` 的 `connected:true` |
| 4 | 免费广告模型 400/403 | 只允许 App 线程 + **US/CA/UK/AU/NZ/IE 出口 IP**；必须带 `x-capy-client-features: …,ads-models`，且请求要走代理 |
| 5 | 梯子开着，插件仍 `region_unsupported` | **Node/Bun fetch 不会自动读 Windows 系统代理**；插件必须用 `src/proxy.mjs` 显式传 proxy |
| 6 | `promptVariant:"minimal"` 403 | 当前账号不允许 minimal；`runThread` 会捕获 `prompt_variant_forbidden` 并改回 default |
| 7 | 设备码配对失败 | 检查 `/devices/code` → `/orgs/{org}/devices/code/approve` → `/devices/code/poll` 三步；`codeApprove` 需要 Clerk 会话 + orgId |
| 8 | 无头设备已连隧道但线程 503 | `waitForDevice` 没等到 `connected:true`；检查 hello 的 `deviceId` 与配对返回的是否一致 |
| 9 | 线程一直 working / 很慢 | machine server 的 `worktree_*` / `volume_*` 没回；看 `HeadlessDevice` 的 `#handleStream` |
| 10 | 想用终端/浏览器/写文件 | 无头设备只实现最小 RPC；其他 handler 返回 `MachineServer.Unavailable`，不会执行 |
| 11 | 带图片建线程 400 空 body | App 的 `files[]` 必须带 **`{fileId,name,mediaType,sizeBytes}`**，不是公共 API 的 `{fileId,name}` |
| 12 | 图片上传后模型看不见 | `POST /api/v1/files` 只给预签名 URL；必须再 PUT 字节（Content-Type/Length 一致，不带 Authorization） |
| 13 | 免费模型仍被 credits 拦 | 线程跑在云端；无头设备线程不会。检查 `primaryMachine.kind` 和 `device` |
| 14 | 用 `CAPY_*` 模型 id 时 404 | magpie 会发 `capy/particle/particle-1`；`resolveModel` 会剥掉 `capy/` 前缀 |
| 15 | 设备 token 丢失/失效 | `%LOCALAPPDATA%\magpie-capy\headless-device.json`（DPAPI）；删掉后会自动重新配对 |

## 三、命令

```bash
node --test                 # 96 个离线测试
magpie plugin add "D:\AI\magpie\magpie-Capy"
magpie plugin login capy 1  # 浏览器登录 https://capy.ai/sign-in（Google/GitHub/Passkey/邮箱）
magpie plugin list | grep -A1 capy

# 走真实网关（本机 3425）
curl -sS http://127.0.0.1:3425/v1/chat/completions \
  -H "authorization: Bearer <caller-keys.json 里的 secret>" \
  -H 'content-type: application/json' \
  -d '{"model":"capy/particle/particle-1","messages":[{"role":"user","content":"Reply with exactly: pong"}]}'
```

## 四、免费模型与地区

| id | 免费方式 |
|---|---|
| `particle/particle-1` | $0.00，无广告，无头设备零 credits |
| `zai/glm-5.3-flash-ads` | $0.00，free with ads |
| `deepseek/deepseek-v4.1-flash-ads` | $0.00，free with ads |

其余 61 个模型收费。插件只设置 `free: true/false`，不写倍率/单价。
免费广告模型的地区判定在服务端，按出口 IP；改请求头没用。

## 五、不要做的事

- 不要往 `~/.config/magpie` 写东西（插件只通过 magpie 的 auth 记录保存；无头状态写到 `%LOCALAPPDATA%\magpie-capy`）。
- 不要把 Capy 的 client JWT / API Key / `capyd_` token 打进日志或错误文案。
- 不要把 API Key 用于 `/app/*`（只认 Clerk token），也不要把 Clerk token 用于 `/api/v1/*`（只认 API Key）。
- 不要伪造广告曝光/`impUrl`；插件只声明 App 能力位，不伪造曝光。
- 不要再引入 Capy 桌面端依赖（不读 `%APPDATA%\Capy`、不要求运行 Capy.exe）。
- 不要声称无头设备能跑终端/浏览器/写文件；它只有最小 machine server。
- 不要声称原生 OpenAI tools：默认是提示词桥，Capy agent 会优先用自己的工具。
- 不要声称 temperature / top_p / max_tokens / stop / response_format / PDF 解析。
- 不要为了“性能”重新加 750ms outline 轮询；原生 SSE 才是主路径。
