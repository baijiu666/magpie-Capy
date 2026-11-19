# ERROR-CODES —— 错误词表与出口

每个错误出口都有 **status + code + 有信息量的 message**。宿主只看 status（换号/换模型/退避），人只看 message。

## 词表

| code | status | 什么时候 | 宿主/用户看到 |
|---|---|---|---|
| `invalid_request` | 400 | 请求体不是 JSON、messages 为空、对话超过 160k 字符、没有 projectId | 请求本身的问题，不换号 |
| `model_not_found` | 404 | `resolveModel` 不认识这个 id；Capy 回 `ModelSelection.Rejected` | 只搁置这个模型，其它模型照用 |
| `sign_in_required` | 401 | API Key 缺失/吊销；Clerk 换票失败；`/app/*` 401 | 让宿主把这个账号标成「需要重新登录」 |
| `insufficient_quota` | 402 | `/usage/balance` 无余额，或线程 `ask.kind=credits` | 提示用户去 Capy 充值/订阅 |
| `region_unsupported` | 403 | 免费广告模型 + 出口 IP 不在 US/CA/UK/AU/NZ/IE | 换支持地区的代理，或改用 `particle/particle-1` |
| `upstream_error` | 403 | Capy 回 `capy/Forbidden`（账号/套餐/入口不允许） | 不自动重试；检查登录方式与地区 |
| `prompt_variant_forbidden` | 403 | 账号不允许 `promptVariant:"minimal"` | 插件内部捕获并改回 default，不暴露给用户 |
| `rate_limited` | 429 | Capy 回 `capy/RateLimited` | 透传 `retry-after`，换号或退避 |
| `upstream_unavailable` | 503 | Capy 5xx、连不上、DNS/代理失败、流提前断开 | 可重试，换号/退避 |
| `upstream_timeout` | 504 | 连接 Capy 超时；原生 SSE 空闲超过 90s | 可重试 |
| `upstream_error` | 502 | 无法归类的 4xx / 线程没有产生 assistant 文本 | 不自动重试 |
| `internal_error` | 502 | 插件自己的 bug | 请求失败，看日志 |
| `not_implemented` | 501 | 打到 `/embeddings` 等端点 | 明确告诉 agent「只有 /chat/completions 与 /models」 |

## 附件错误

| 场景 | code / status |
|---|---|
| 单文件 > 20 MB、一次 > 8 个、总计 > 60 MB、本机/内网 URL、坏 data URL | `invalid_request` / 400 |
| `POST /files` 或预签名 PUT 失败 | `upstream_error` / 502 |
| 下载远程附件 / 上传超时 | `upstream_timeout` / 504 |
| 上传需要 API key 但未登录 | `sign_in_required` / 401 |

## 三条容易写错的

1. **模型不存在用 404，不用 400/500。** 宿主只搁置这个模型；写成 500 会让整条路由都抖。
2. **没有余额用 402 + `insufficient_quota`。** 这是账号级阻塞，不该被当成限流反复重试。
3. **超时/连不上落 503/504，不落 502。** 502 在宿主语义里不可重试。

## 流式通道里的错误

正常路径是公共 API 的原生 SSE（`/api/v1/threads/{id}/stream`）；如果流里出现 `error` 帧
（例如 `region_unsupported`），`streamThread` 会先抛成 `CapyError`，由外层决定是退回轮询
还是把错误交给客户端。只有 OpenAI 响应已经 200 之后 status 才改不了，这时补一帧 error chunk，再 `[DONE]`：

```json
data: {"error":{"message":"Add credits or pick a plan to resume this thread","type":"upstream_error","code":"insufficient_quota","status":402}}

data: [DONE]
```

实现见 `src/chat.mjs` 的 `ReadableStream` catch 分支。

## 上游错误归一

Capy 的错误是 `HTTP status + {"_tag": "capy/…", "message": …}`。
`src/errors.mjs` 的 `fromUpstream()` 按 status + `_tag` 归一；不要依赖 message 文本做分支。
