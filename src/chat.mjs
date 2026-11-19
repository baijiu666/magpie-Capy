// OpenAI /chat/completions → Capy **无头设备线程**，回答走公共 API 的原生 SSE。
//
// 上游事实（2026-11-19 实测）：
//   · 建线程：POST /app/orgs/{orgId}/jams（projectless + device/worktree）
//   · 流：GET /api/v1/threads/{threadId}/stream?until=run（API key，SSE）
//         事件 assistant / transcript / turn / run / status / heartbeat / error / done
//   · 免费广告模型（*-ads）必须带 x-capy-client-features: …,ads-models；
//     服务端按出口 IP 判地区（US/CA/UK/AU/NZ/IE），所以插件要把系统代理显式传给 fetch。
//
// 这里不再轮询 outline（等待整段回答），而是把 assistant 帧边到边转成 OpenAI chunk；
// 只有 SSE 不可用时才退回 outline 轮询。
//
// 系统提示词：
//   Capy 每个线程都会注入自己的 agent 提示词，服务端不提供“关闭”开关。
//   App 协议里有一个 promptVariant: "default" | "minimal"，但当前账号调 "minimal"
//   会 403（实测）；插件仍会在每个进程里尝试一次，成功就用 minimal，失败就记住并
//   退回 default，同时把客户端自己的 system 消息单独放，不伪造进用户消息。

import crypto from "node:crypto"

import { APP_BASE, API_BASE, DEFAULT_MODEL, TOOL_SHIM } from "./constants.mjs"
import { isAdsModel } from "./catalog.mjs"
import { collectAttachments, uploadAttachments } from "./attachments.mjs"
import { CODES, chatErrorStatus, errorCode, fromUpstream, upstreamError } from "./errors.mjs"
import { authHeaders, requestJson, sleep } from "./http.mjs"
import { mintSessionJwt, parseRefresh } from "./auth.mjs"
import { hasTools, parseToolCalls, toolCallId, toolInstruction } from "./tools.mjs"

export const MAX_PROMPT_CHARS = 160_000
const POLL_MS = 750
const ANSWER_TIMEOUT_MS = 10 * 60_000
const STREAM_IDLE_MS = 90_000

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function idSuffix() {
  return crypto.randomUUID().replace(/-/gu, "").slice(0, 24)
}

let toolFallbackWarned = false
function warnToolFallback() {
  if (toolFallbackWarned) return
  toolFallbackWarned = true
  try {
    console.warn(
      "[magpie-capy] 请求了 OpenAI tools，但 Capy agent 返回文本、没有 tool_calls；"
      + "Capy agent 会优先使用自己的终端/浏览器/目录工具。",
    )
  } catch {}
}

/** 真正的 ULID（48-bit 时间 + 80-bit 随机，Crockford base32，26 字符）。 */
export function ulid(now = Date.now(), random = crypto.randomBytes(10)) {
  let time = Math.max(0, Number(now) || 0)
  const timeChars = new Array(10)
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = ULID_ALPHABET[time % 32]
    time = Math.floor(time / 32)
  }
  let bits = 0n
  for (const byte of random) bits = (bits << 8n) | BigInt(byte)
  const randChars = new Array(16)
  for (let i = 15; i >= 0; i -= 1) {
    randChars[i] = ULID_ALPHABET[Number(bits & 31n)]
    bits >>= 5n
  }
  return timeChars.join("") + randChars.join("")
}

export function newJamId() {
  return `jam_${ulid()}`
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part)
        continue
      }
      const type = String(part?.type ?? "")
      if (type === "text" || type === "input_text" || type === "output_text") {
        parts.push(String(part?.text ?? ""))
      } else if (type === "image_url" || type === "input_image" || type === "image") {
        parts.push("[图片已省略：Capy 插件当前只转发文本]")
      }
    }
    return parts.join("\n")
  }
  return ""
}

/**
 * magpie 的 messages → Capy 线程的初始 message。
 *
 * 单条 user 消息原样发送（最接近原生 API，不加任何包装）；
 * 多轮才拍成带角色的 transcript，system 单独成块，不混进用户消息。
 */
export function buildPrompt(messages, { tools = [], toolChoice = "auto" } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const toolText = toolInstruction(tools, toolChoice)
  if (!list.length) {
    throw upstreamError("messages 为空", 400, { code: CODES.invalidRequest })
  }

  const systems = []
  const turns = []
  for (const message of list) {
    const role = String(message?.role ?? "").trim().toLowerCase()
    const text = textOf(message?.content).trim()
    if (role === "system" || role === "developer") {
      if (text) systems.push(text)
      continue
    }
    if (role === "user") {
      if (text) turns.push({ role: "user", text })
      continue
    }
    if (role === "assistant") {
      const toolNames = Array.isArray(message?.tool_calls)
        ? message.tool_calls.map((call) => String(call?.function?.name ?? call?.name ?? "tool")).filter(Boolean)
        : []
      const suffix = toolNames.length ? ` [调用工具: ${toolNames.join(", ")}]` : ""
      if (text || suffix) turns.push({ role: "assistant", text: `${text}${suffix}`.trim() })
      continue
    }
    if (role === "tool") {
      const name = String(message?.name ?? message?.tool_call_id ?? "tool")
      turns.push({ role: "tool", name, text: text || "(无输出)" })
    }
  }

  if (!turns.length) {
    throw upstreamError("messages 里没有 user/assistant 内容", 400, { code: CODES.invalidRequest })
  }

  // 最常见的情况：只有一条 user 消息（可能带 system）。此时把 user 原文直接发给
  // Capy，不额外加“你在通过 OpenAI 接口接收对话”这类会污染模型行为的提示。
  if (turns.length === 1 && turns[0].role === "user") {
    const only = turns[0].text
    let text = systems.length
      ? `<system>\n${systems.join("\n\n")}\n</system>\n\n<user>\n${only}\n</user>`
      : only
    if (toolText) text = `${text}\n\n${toolText}`
    if (text.length > MAX_PROMPT_CHARS) {
      throw upstreamError(
        `对话太长（${text.length} 字符，上限 ${MAX_PROMPT_CHARS}）。请缩短上下文后重试。`,
        400,
        { code: CODES.invalidRequest },
      )
    }
    return text
  }

  const blocks = []
  if (systems.length) blocks.push(`<system>\n${systems.join("\n\n")}\n</system>`)
  blocks.push("<conversation>")
  for (const turn of turns) {
    if (turn.role === "tool") blocks.push(`<tool name="${turn.name}">\n${turn.text}\n</tool>`)
    else blocks.push(`<${turn.role}>\n${turn.text}\n</${turn.role}>`)
  }
  blocks.push("</conversation>")
  const last = turns[turns.length - 1]
  blocks.push(last.role === "assistant" ? "Continue the last assistant message." : "Reply to the last user message.")
  if (toolText) blocks.push(toolText)

  const text = blocks.join("\n\n")
  if (text.length > MAX_PROMPT_CHARS) {
    throw upstreamError(
      `对话太长（${text.length} 字符，上限 ${MAX_PROMPT_CHARS}）。请缩短上下文后重试。`,
      400,
      { code: CODES.invalidRequest },
    )
  }
  return text
}

// 兼容旧名字；行为见 buildPrompt。
export const flattenMessages = buildPrompt

function appHeaders(jwt, clientId, { ads = false } = {}) {
  const features = ["message-edit", "visual"]
  if (ads) features.push("ads-models")
  return {
    authorization: `Bearer ${jwt}`,
    "content-type": "application/json",
    origin: "https://capy.ai",
    "x-capy-client-surface": "desktop",
    "x-capy-client-features": features.join(","),
    "x-capy-client-timezone": (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } catch { return "UTC" }
    })(),
    ...(clientId ? { "x-capy-client-id": clientId } : {}),
  }
}

/** 从账号记录里恢复 Clerk 会话，并拿到无头设备。 */
export async function resolveDeviceSession(fetchImpl, auth, { signal, headless } = {}) {
  const cred = parseRefresh(auth?.refresh)
  if (!cred?.clientJwt || !cred?.sessionId) {
    throw upstreamError("Capy 登录态不完整（缺少 Clerk 会话），请重新登录", 401, {
      code: CODES.signInRequired,
    })
  }
  const jwt = await mintSessionJwt(fetchImpl, {
    clientJwt: cred.clientJwt,
    sessionId: cred.sessionId,
    signal,
  })
  const orgId = String(cred.orgId || auth?.metadata?.orgId || "").trim()
  if (!orgId) {
    throw upstreamError("Capy 登录态缺少组织（orgId），请重新登录", 401, {
      code: CODES.signInRequired,
    })
  }
  if (typeof headless !== "function") {
    throw upstreamError(
      "无头设备未启用。请重启 magpie，或显式打开 MAGPIE_CAPY_HEADLESS。",
      503,
      { code: CODES.upstreamUnavailable },
    )
  }

  let info
  try {
    info = await headless({ jwt, orgId, signal })
  } catch (error) {
    if (Number(error?.status)) throw error
    throw upstreamError(
      `注册/连接无头设备失败：${String(error?.message ?? error)}`,
      503,
      { code: CODES.upstreamUnavailable },
    )
  }
  const deviceId = String(info?.deviceId || info?.device?.id || info?.id || "").trim()
  if (!deviceId) {
    throw upstreamError("无头设备没有返回 deviceId", 503, { code: CODES.upstreamUnavailable })
  }
  return {
    jwt,
    orgId,
    device: {
      id: deviceId,
      name: String(info?.name || info?.device?.name || "magpie-headless"),
    },
    clientId: String(cred.clientId || auth?.metadata?.clientId || "").trim(),
  }
}

/**
 * 建一个 projectless 的本机设备线程（Worktree）。
 * @param {object} options
 * @param {string} [options.promptVariant] "minimal" 尝试剥离官方提示词；"" / "default" 不传。
 */
export async function createDeviceThread(fetchImpl, {
  jwt,
  orgId,
  deviceId,
  clientId,
  message,
  modelId = DEFAULT_MODEL,
  reasoningMode = "",
  promptVariant = "",
  title = "",
  files = [],
  signal,
} = {}) {
  if (!deviceId) {
    throw upstreamError("没有可用的本机设备", 503, { code: CODES.upstreamUnavailable })
  }
  const requestId = ulid()
  const jamId = `jam_${ulid()}`
  const ads = isAdsModel(modelId)
  const payload = {
    jamId,
    requestId,
    clientKey: requestId,
    message,
    model: {
      modelId,
      ...(reasoningMode ? { reasoningMode } : {}),
    },
    device: {
      deviceId,
      workspace: { kind: "worktree" },
    },
    ...(title ? { title } : {}),
    ...(Array.isArray(files) && files.length ? { files } : {}),
    ...(promptVariant && promptVariant !== "default" ? { promptVariant } : {}),
  }
  const { response, body, text } = await requestJson(
    fetchImpl,
    `${APP_BASE}/orgs/${encodeURIComponent(orgId)}/jams`,
    {
      method: "POST",
      headers: appHeaders(jwt, clientId, { ads }),
      body: JSON.stringify(payload),
      signal,
      timeoutMs: 90_000,
    },
  )
  if (!response.ok) {
    if (response.status === 403 && promptVariant === "minimal") {
      throw upstreamError(
        "Capy 不允许这个账号使用 minimal 提示词档位；插件会改回 default 重试。",
        403,
        { code: "prompt_variant_forbidden", detail: text.slice(0, 200) },
      )
    }
    throw fromUpstream(response.status, body, text.slice(0, 300))
  }
  if (!body?.id) throw upstreamError("Capy 创建本机线程没有返回 id", 502, { code: "upstream_error" })
  if (body?.primaryMachine?.kind !== "device") {
    throw upstreamError(
      "Capy 没有把线程放到无头设备（返回了云端机器）。请检查无头设备是否 connected；必要时删掉 %LOCALAPPDATA%\magpie-capy\headless-device.json 让它重新配对。",
      503,
      { code: CODES.upstreamUnavailable, detail: `primaryMachine=${body?.primaryMachine?.kind ?? "unknown"}` },
    )
  }
  return body
}

export async function getThread(fetchImpl, jwt, orgId, threadId, { signal, clientId = "", ads = false } = {}) {
  const { response, body, text } = await requestJson(
    fetchImpl,
    `${APP_BASE}/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(threadId)}`,
    { headers: appHeaders(jwt, clientId, { ads }), signal, timeoutMs: 20_000 },
  )
  if (!response.ok) throw fromUpstream(response.status, body, text.slice(0, 300))
  return body
}

export async function getOutline(fetchImpl, jwt, orgId, threadId, { signal, clientId = "", ads = false } = {}) {
  const { response, body, text } = await requestJson(
    fetchImpl,
    `${APP_BASE}/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(threadId)}/events/outline`,
    { headers: appHeaders(jwt, clientId, { ads }), signal, timeoutMs: 20_000 },
  )
  if (!response.ok) throw fromUpstream(response.status, body, text.slice(0, 300))
  return Array.isArray(body?.items) ? body.items : []
}

export function askError(thread) {
  const ask = thread?.ask
  if (!ask) return null
  if (ask.kind === "credits") {
    return upstreamError(
      ask.text || "Capy 额度不足（没有余额或套餐），请先在 Capy 里充值。",
      402,
      { code: CODES.insufficientQuota, detail: "ask.kind=credits" },
    )
  }
  if (ask.kind === "desktop") {
    return upstreamError(
      ask.text || "Capy 线程需要人工/桌面端操作，无头设备无法继续；请在 Capy 网页端处理。",
      503,
      { code: CODES.upstreamUnavailable, detail: "ask.kind=desktop" },
    )
  }
  return upstreamError(
    `Capy 线程需要人工处理：${ask.text || ask.kind || "未知阻塞"}。请在 Capy 网页端里处理。`,
    409,
    { code: "upstream_error", detail: `ask.kind=${ask.kind ?? ""}` },
  )
}

/** 从 outline 里取本轮最终回答（最新一条有 answer 的 user 轮）。 */
export function answerFromOutline(items) {
  const list = Array.isArray(items) ? items : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const answer = list[i]?.answer
    if (typeof answer === "string" && answer.trim()) return answer
  }
  return ""
}

/**
 * 轮询 outline / thread，直到出现本轮回答或 ask。
 * 只在原生 SSE 不可用时兜底；正常情况下不会走到这里。
 */
export async function waitForAnswer(fetchImpl, { jwt, orgId, threadId, clientId = "", ads = false, signal, timeoutMs = ANSWER_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || ANSWER_TIMEOUT_MS)
  let lastError = null
  let thread = null
  while (Date.now() < deadline) {
    try {
      const items = await getOutline(fetchImpl, jwt, orgId, threadId, { signal, clientId, ads })
      const answer = answerFromOutline(items)
      if (answer) return { text: answer, items, thread }
    } catch (error) {
      lastError = error
    }
    try {
      thread = await getThread(fetchImpl, jwt, orgId, threadId, { signal, clientId, ads })
      const ask = askError(thread)
      if (ask) throw ask
      if (String(thread?.status ?? "") === "failed") {
        throw upstreamError("Capy 本机线程执行失败（status=failed）", 502, {
          code: "upstream_error",
          detail: thread?.preview ?? "",
        })
      }
    } catch (error) {
      if (Number(error?.status) === 402 || Number(error?.status) === 401) throw error
      lastError = error
    }
    await sleep(POLL_MS, signal)
  }
  if (lastError) throw lastError
  throw upstreamError("等待 Capy 本机线程回答超时（10 分钟）", 504, { code: CODES.upstreamTimeout })
}

// ---------------------------------------------------------------------------
// 原生 SSE：/api/v1/threads/{id}/stream
// ---------------------------------------------------------------------------

/** 极简 SSE 解析器：喂一段文本，吐完整帧；返回剩余未完成的文本。 */
export function feedSse(buffer, chunk) {
  let text = buffer + chunk
  const frames = []
  let match
  while ((match = /\r?\n\r?\n/u.exec(text)) !== null) {
    const raw = text.slice(0, match.index)
    text = text.slice(match.index + match[0].length)
    const frame = { event: "", data: "", id: "" }
    for (const line of raw.split(/\r?\n/u)) {
      if (!line || line.startsWith(":")) continue
      const colon = line.indexOf(":")
      const field = colon >= 0 ? line.slice(0, colon) : line
      const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /u, "") : ""
      if (field === "event") frame.event = value
      else if (field === "data") frame.data = frame.data ? `${frame.data}\n${value}` : value
      else if (field === "id") frame.id = value
    }
    if (frame.event || frame.data) frames.push(frame)
  }
  return { frames, rest: text }
}

function parseJson(value) {
  try { return JSON.parse(value) } catch { return null }
}

function regionError(message) {
  return upstreamError(
    message
    || "免费广告模型只允许 US/CA/UK/AU/NZ/IE 地区。请把 Capy 请求的出口 IP 切到这些地区后重试。",
    403,
    { code: "region_unsupported" },
  )
}

/**
 * 跟公共 API 的原生 SSE，边收 assistant 帧边回调。
 *
 * @returns {Promise<{ ok: boolean, status: number, text: string, streamed: boolean }>}
 *   ok=false 表示流不可用（401/404），调用方可以退回 outline 轮询。
 */
export async function streamThread(fetchImpl, {
  apiKey,
  threadId,
  signal,
  onDelta,
  timeoutMs = ANSWER_TIMEOUT_MS,
  idleMs = STREAM_IDLE_MS,
} = {}) {
  if (!apiKey) return { ok: false, status: 401, text: "", streamed: false }

  const controller = new AbortController()
  let timedOut = false
  let idleTimedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(5000, Number(timeoutMs) || ANSWER_TIMEOUT_MS))
  let idleTimer = null
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { idleTimedOut = true; controller.abort() }, Math.max(15_000, Number(idleMs) || STREAM_IDLE_MS))
  }
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  try {
    armIdle()
    const response = await fetchImpl(
      `${API_BASE}/threads/${encodeURIComponent(threadId)}/stream?until=run`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: "text/event-stream" },
        signal: controller.signal,
      },
    )
    if (!response.ok) {
      return { ok: false, status: response.status, text: "", streamed: false }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const partial = new Map()
    let finalText = ""
    let lastText = ""
    let streamed = false
    let buffer = ""
    let done = false

    const emit = (chunk) => {
      if (!chunk) return
      streamed = true
      try { onDelta?.(chunk) } catch {}
    }

    while (!done) {
      let read
      try {
        read = await reader.read()
      } catch (error) {
        if (signal?.aborted) throw error
        if (timedOut) {
          throw upstreamError("等待 Capy 原生流超时（10 分钟）", 504, { code: CODES.upstreamTimeout })
        }
        if (idleTimedOut) {
          throw upstreamError("Capy 原生流 90 秒没有数据，连接可能已断开", 504, { code: CODES.upstreamTimeout })
        }
        throw upstreamError(`读取 Capy 原生流失败：${error?.message ?? error}`, 503, { code: CODES.upstreamUnavailable })
      }
      if (read.done) break
      armIdle()
      const parsed = feedSse(buffer, decoder.decode(read.value, { stream: true }))
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        if (frame.event === "assistant") {
          const data = parseJson(frame.data)
          const callId = String(data?.callId ?? "")
          const piece = String(data?.text ?? "")
          if (!callId || !piece) continue
          const previous = partial.get(callId) ?? ""
          // 服务端有时发增量，有时一次发完整文本；两种都兼容。
          const delta = piece.startsWith(previous) ? piece.slice(previous.length) : piece
          partial.set(callId, piece.startsWith(previous) ? piece : previous + piece)
          lastText = partial.get(callId)
          emit(delta)
          continue
        }
        if (frame.event === "transcript") {
          const data = parseJson(frame.data)
          if (data?.source !== "assistant") continue
          finalText = String(data?.text ?? "")
          const previous = lastText
          if (!streamed && finalText) {
            emit(finalText)
          } else if (finalText && previous && finalText.startsWith(previous) && finalText.length > previous.length) {
            // live 帧只给了一部分，用 transcript 补齐尾部。
            emit(finalText.slice(previous.length))
          }
          lastText = finalText
          continue
        }
        if (frame.event === "error") {
          const data = parseJson(frame.data)
          const code = String(data?.code ?? "")
          const message = String(data?.message ?? "Capy 原生流返回错误")
          if (code === "region_unsupported") throw regionError(message)
          if (code === "unauthorized") {
            throw upstreamError(message, 401, { code: CODES.signInRequired, detail: code })
          }
          if (code === "forbidden") {
            throw upstreamError(message, 403, { code: "upstream_error", detail: code })
          }
          throw upstreamError(message, 502, { code: "upstream_error", detail: code })
        }
        if (frame.event === "done") {
          done = true
          break
        }
      }
    }

    try { await reader.cancel() } catch {}
    return { ok: true, status: response.status, text: finalText || lastText, streamed }
  } finally {
    clearTimeout(timer)
    clearTimeout(idleTimer)
    signal?.removeEventListener?.("abort", onAbort)
  }
}

export async function interruptThread(fetchImpl, jwt, orgId, threadId, { clientId = "", ads = false } = {}) {
  try {
    await requestJson(
      fetchImpl,
      `${APP_BASE}/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(threadId)}/interrupt`,
      {
        method: "POST",
        headers: appHeaders(jwt, clientId, { ads }),
        body: "{}",
        timeoutMs: 10_000,
      },
    )
  } catch {
    // 取消是 best-effort。
  }
}

function openAiChunk(id, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function openAiCompletion(id, model, text) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

function withToolIds(calls) {
  return (Array.isArray(calls) ? calls : []).map((call) => ({
    id: toolCallId(),
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }))
}

function openAiToolCompletion(id, model, calls) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: null, tool_calls: withToolIds(calls) },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

function openAiToolChunk(id, model, calls) {
  const toolCalls = withToolIds(calls).map((call, index) => ({ index, ...call }))
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
  })}\n\n`
}

/**
 * 跑一轮本机设备线程，返回最终文本。
 * 优先原生 SSE；不可用时退回 outline 轮询。
 *
 * @returns {{ thread, text, session, streamed }}
 */
export async function runThread(fetchImpl, auth, {
  prompt,
  modelId = DEFAULT_MODEL,
  reasoningMode = "",
  promptVariant = "",
  attachments = [],
  headless,
  signal,
  onThread,
  onDelta,
  onVariantFallback,
  timeoutMs,
} = {}) {
  const session = await resolveDeviceSession(fetchImpl, auth, { signal, headless })
  const ads = isAdsModel(modelId)
  const files = await uploadAttachments(fetchImpl, auth?.access, attachments, { signal })

  let thread
  let variant = promptVariant === "minimal" ? "minimal" : ""
  try {
    thread = await createDeviceThread(fetchImpl, {
      jwt: session.jwt,
      orgId: session.orgId,
      deviceId: session.device.id,
      clientId: session.clientId,
      message: prompt,
      modelId: modelId || DEFAULT_MODEL,
      reasoningMode,
      promptVariant: variant,
      files,
      signal,
    })
  } catch (error) {
    if (variant === "minimal" && error?.code === "prompt_variant_forbidden") {
      onVariantFallback?.()
      variant = ""
      thread = await createDeviceThread(fetchImpl, {
        jwt: session.jwt,
        orgId: session.orgId,
        deviceId: session.device.id,
        clientId: session.clientId,
        message: prompt,
        modelId: modelId || DEFAULT_MODEL,
        reasoningMode,
        promptVariant: "",
        files,
        signal,
      })
    } else {
      throw error
    }
  }
  onThread?.(thread, session)

  // 先看一眼线程状态：credits / desktop 阻塞可以立刻返回，不用等流。
  const detail = await getThread(fetchImpl, session.jwt, session.orgId, thread.id, {
    signal,
    clientId: session.clientId,
    ads,
  }).catch(() => null)
  const blocked = askError(detail)
  if (blocked) throw blocked

  const apiKey = typeof auth?.access === "string" ? auth.access.trim() : ""
  let result = null
  if (apiKey) {
    try {
      result = await streamThread(fetchImpl, {
        apiKey,
        threadId: thread.id,
        signal,
        onDelta,
        timeoutMs,
      })
    } catch (error) {
      if (error?.name === "AbortError") throw error
      // 已经吐过内容就不能再轮询，否则会重复；直接把错误交给上层。
      if (Number(error?.status) === 403 && error?.code === "region_unsupported") throw error
      // 401/403/404 或流不可用：退回轮询。
      if (Number(error?.status) === 401 || Number(error?.status) === 403 || Number(error?.status) === 404) {
        result = null
      } else {
        throw error
      }
    }
  }

  if (result?.ok && result.text) {
    return { thread, text: result.text, session, streamed: result.streamed }
  }

  // 流没有文本（key 失效 / 端点不可用 / 线程被阻塞）：兜底轮询。
  const fallback = await waitForAnswer(fetchImpl, {
    jwt: session.jwt,
    orgId: session.orgId,
    threadId: thread.id,
    clientId: session.clientId,
    ads,
    signal,
    timeoutMs,
  })
  if (fallback.text && !result?.streamed) onDelta?.(fallback.text)
  return { thread, text: fallback.text, session, streamed: result?.streamed ?? false }
}

/**
 * 处理一次 OpenAI chat 请求。stream=true 返回 SSE Response，否则返回 JSON。
 */
export async function chatCompletions({
  fetchImpl,
  auth,
  body,
  stream,
  signal,
  modelId,
  reasoningMode,
  promptVariant = "",
  headless,
  onThread,
  onVariantFallback,
}) {
  const prepared = await collectAttachments(body?.messages, { fetchImpl, signal })
  const toolsEnabled = TOOL_SHIM && hasTools(body)
  const prompt = buildPrompt(prepared.messages, {
    tools: toolsEnabled ? body?.tools : [],
    toolChoice: body?.tool_choice,
  })
  const model = modelId || DEFAULT_MODEL
  const id = `chatcmpl-${idSuffix()}`

  if (!stream) {
    const result = await runThread(fetchImpl, auth, {
      prompt,
      modelId: model,
      reasoningMode,
      promptVariant,
      attachments: prepared.attachments,
      headless,
      signal,
      onThread,
      onVariantFallback,
    })
    const parsed = toolsEnabled ? parseToolCalls(result.text) : null
    if (toolsEnabled && !parsed) warnToolFallback()
    const payload = parsed
      ? openAiToolCompletion(id, model, parsed.calls)
      : openAiCompletion(id, model, result.text)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  let threadId = ""
  let sessionInfo = null
  const streamBody = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder()
      const push = (text) => {
        try { streamController.enqueue(encoder.encode(text)) } catch {}
      }
      let emitted = false
      let buffered = ""
      try {
        push(openAiChunk(id, model, { role: "assistant", content: "" }))
        const result = await runThread(fetchImpl, auth, {
          prompt,
          modelId: model,
          reasoningMode,
          promptVariant,
          attachments: prepared.attachments,
          headless,
          signal: controller.signal,
          onThread: (thread, session) => {
            threadId = String(thread?.id ?? "")
            sessionInfo = session
            onThread?.(thread, session)
          },
          onDelta: (text) => {
            if (!text) return
            if (toolsEnabled) {
              buffered += text
              return
            }
            emitted = true
            push(openAiChunk(id, model, { content: text }))
          },
          onVariantFallback,
        })
        if (toolsEnabled) {
          // 工具调用需要看到完整输出才能解析，所以这一段不边到边转发。
          const finalText = buffered || result.text
          const parsed = parseToolCalls(finalText)
          if (parsed) {
            push(openAiToolChunk(id, model, parsed.calls))
            push(openAiChunk(id, model, {}, "tool_calls"))
          } else {
            warnToolFallback()
            if (finalText) push(openAiChunk(id, model, { content: finalText }))
            push(openAiChunk(id, model, {}, "stop"))
          }
        } else {
          if (!emitted && result.text) {
            push(openAiChunk(id, model, { content: result.text }))
          }
          push(openAiChunk(id, model, {}, "stop"))
        }
        push("data: [DONE]\n\n")
      } catch (error) {
        if (controller.signal.aborted) {
          if (threadId && sessionInfo) {
            await interruptThread(fetchImpl, sessionInfo.jwt, sessionInfo.orgId, threadId, {
              clientId: sessionInfo.clientId,
            })
          }
          return
        }
        const status = chatErrorStatus(error)
        const payload = {
          error: {
            message: String(error?.message ?? error),
            type: status === 401 ? "authentication_error" : "upstream_error",
            code: errorCode(error),
            status,
          },
        }
        push(`data: ${JSON.stringify(payload)}\n\n`)
        push("data: [DONE]\n\n")
      } finally {
        try { streamController.close() } catch {}
        signal?.removeEventListener?.("abort", onAbort)
      }
    },
    cancel() {
      controller.abort()
      if (threadId && sessionInfo) {
        interruptThread(fetchImpl, sessionInfo.jwt, sessionInfo.orgId, threadId, {
          clientId: sessionInfo.clientId,
        })
      }
    },
  })

  return new Response(streamBody, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

// 兼容旧内部引用
export { authHeaders }

export const _internal = Object.freeze({
  textOf,
  appHeaders,
  openAiChunk,
  openAiCompletion,
  openAiToolCompletion,
  openAiToolChunk,
  withToolIds,
  idSuffix,
  feedSse,
  parseJson,
  parseRefresh,
  PICKUP_TIMEOUT_MS: 0,
  ANSWER_TIMEOUT_MS,
  STREAM_IDLE_MS,
})
