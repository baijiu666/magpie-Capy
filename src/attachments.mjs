// 图片 / 文件附件：OpenAI content parts → Capy 文件上传 → jam 的 files[]。
//
// Capy 的官方通道（2026-11-19 实测）：
//   1. POST /api/v1/files  {"files":[{name,mediaType,sizeBytes}]}  → {targets:[{fileId,url}]}
//   2. PUT <presigned url>  bytes，Content-Type / Content-Length 必须与声明一致，不带 Authorization
//   3. POST /app/orgs/{org}/jams 时带
//      files:[{fileId,name,mediaType,sizeBytes}]
//
// 实测：particle/particle-1（免费）看到红圆图片后正确回答 "Red"。
// 所以插件把 image_url 的 data URL / 公网 URL 都转成 Capy 附件，不再写“图片已省略”。

import crypto from "node:crypto"

import { API_BASE } from "./constants.mjs"
import { CODES, fromUpstream, upstreamError } from "./errors.mjs"
import { authHeaders, requestJson, withTimeout } from "./http.mjs"

export const MAX_ATTACHMENTS = 8
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024
const REMOTE_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 60_000
const CACHE_TTL_MS = 60 * 60_000
const CACHE_MAX = 64

const CACHE = new Map() // key -> { at, file }

const EXT_BY_TYPE = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/json": "json",
})

const IMAGE_EXT_BY_TYPE = /^image\//u
const PRIVATE_HOST = /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|::1$|\[::1\]$|\[::\]$|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|.*\.local$)/iu

const DATA_URL = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/u
const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u

function extFor(mediaType, name = "") {
  const fromName = String(name).split(".").pop()?.toLowerCase() ?? ""
  if (fromName && /^[a-z0-9]{1,8}$/u.test(fromName)) return fromName
  return EXT_BY_TYPE[String(mediaType).toLowerCase()] || "bin"
}

function safeName(name, mediaType, index) {
  const base = String(name ?? "").split(/[\\/]/u).pop()?.replace(/[\u0000-\u001f<>:"|?*]/gu, "").trim()
  if (base) return base.slice(0, 200)
  return `attachment-${index + 1}.${extFor(mediaType)}`
}

function mediaTypeOf(value, fallback = "application/octet-stream") {
  const text = String(value ?? "").split(";")[0].trim().toLowerCase()
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(text) ? text : fallback
}

function assertSize(bytes, label) {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw upstreamError(
      `附件 ${label} 太大（${(bytes.length / 1024 / 1024).toFixed(1)} MB，单文件上限 20 MB）`,
      400,
      { code: CODES.invalidRequest },
    )
  }
}

function decodeDataUrl(value, fallbackType) {
  const match = DATA_URL.exec(String(value ?? ""))
  if (!match) return null
  const mediaType = mediaTypeOf(match[1], fallbackType)
  const bytes = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8")
  return { mediaType, bytes }
}

function decodeMaybeBase64(value, mediaType) {
  const text = String(value ?? "").trim()
  if (!text || !BARE_BASE64.test(text) || text.length % 4 !== 0) return null
  try {
    return Buffer.from(text, "base64")
  } catch {
    return null
  }
}

function assertPublicUrl(raw) {
  let url
  try { url = new URL(String(raw)) } catch {
    throw upstreamError("附件 URL 不是合法地址", 400, { code: CODES.invalidRequest })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw upstreamError("附件只支持 http/https URL 或 data URL", 400, { code: CODES.invalidRequest })
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw upstreamError("附件 URL 指向本机/内网地址，已拒绝（防止 SSRF）", 400, { code: CODES.invalidRequest })
  }
  return url
}

async function readLimited(response, maxBytes) {
  const length = Number(response.headers.get("content-length") || 0)
  if (length && length > maxBytes) {
    throw upstreamError(
      `远程附件太大（${(length / 1024 / 1024).toFixed(1)} MB，上限 20 MB）`,
      400,
      { code: CODES.invalidRequest },
    )
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch {}
      throw upstreamError("远程附件超过 20 MB 上限", 400, { code: CODES.invalidRequest })
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function loadRemote(fetchImpl, raw, { signal, fallbackType, name } = {}) {
  const url = assertPublicUrl(raw)
  const timeout = withTimeout(signal, REMOTE_TIMEOUT_MS)
  try {
    let response
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { accept: "image/*,application/pdf,*/*;q=0.8" },
        signal: timeout.signal,
        redirect: "follow",
      })
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.timedOut()) {
        throw upstreamError("下载远程附件超时", 504, { code: CODES.upstreamTimeout, cause: error })
      }
      throw upstreamError(`下载远程附件失败：${error?.message ?? error}`, 502, {
        code: CODES.upstreamError,
        cause: error,
      })
    }
    if (!response.ok) {
      throw upstreamError(`下载远程附件失败（HTTP ${response.status}）`, 400, {
        code: CODES.invalidRequest,
      })
    }
    const mediaType = mediaTypeOf(response.headers.get("content-type"), fallbackType)
    const bytes = await readLimited(response, MAX_ATTACHMENT_BYTES)
    return {
      mediaType,
      bytes,
      name: safeName(name || url.pathname.split("/").pop(), mediaType, 0),
    }
  } finally {
    timeout.cleanup()
  }
}

async function resolveSource(fetchImpl, source, { signal, fallbackType, name, index } = {}) {
  const raw = typeof source === "string" ? source : String(source?.url ?? source?.data ?? "")
  if (!raw) return null
  if (raw.startsWith("data:")) {
    const decoded = decodeDataUrl(raw, fallbackType)
    if (!decoded) {
      throw upstreamError("附件 data URL 无法解析", 400, { code: CODES.invalidRequest })
    }
    assertSize(decoded.bytes, name || `#${index + 1}`)
    return {
      ...decoded,
      name: safeName(name, decoded.mediaType, index),
    }
  }
  if (/^https?:\/\//iu.test(raw)) {
    const loaded = await loadRemote(fetchImpl, raw, { signal, fallbackType, name })
    assertSize(loaded.bytes, loaded.name)
    return loaded
  }
  const bare = decodeMaybeBase64(raw, fallbackType)
  if (bare) {
    assertSize(bare, name || `#${index + 1}`)
    return {
      mediaType: fallbackType,
      bytes: bare,
      name: safeName(name, fallbackType, index),
    }
  }
  throw upstreamError("附件内容不是 data URL / http(s) URL / base64", 400, {
    code: CODES.invalidRequest,
  })
}

function partSource(part) {
  if (!part || typeof part !== "object") return null
  if (part.type === "image_url" || part.type === "input_image" || part.type === "image") {
    const value = part.image_url ?? part.url ?? part.data
    return {
      kind: "image",
      source: typeof value === "object" && value !== null ? value : { url: value },
      name: part.name ?? part.filename ?? part.file?.filename ?? "",
      mediaType: mediaTypeOf(
        part.media_type ?? part.mime_type ?? part.file?.media_type ?? part.file?.mime_type,
        "image/png",
      ),
    }
  }
  if (part.type === "file" || part.type === "input_file") {
    const file = part.file ?? part
    const name = file.filename ?? file.name ?? part.filename ?? part.name ?? ""
    const source = file.file_data ?? file.data ?? file.url ?? file.file_url ?? file.file_id
    return {
      kind: "file",
      source,
      name,
      mediaType: mediaTypeOf(file.media_type ?? file.mime_type ?? file.type, "application/octet-stream"),
    }
  }
  return null
}

/**
 * 从 OpenAI messages 里抽出图片/文件附件。
 * 返回新的 messages（附件 part 换成可读标记）和待上传的附件。
 */
export async function collectAttachments(messages, { fetchImpl = fetch, signal } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const cleaned = []
  const attachments = []
  let total = 0

  for (let mi = 0; mi < list.length; mi += 1) {
    const message = list[mi]
    const content = message?.content
    if (typeof content !== "string" && !Array.isArray(content)) {
      cleaned.push(message)
      continue
    }
    if (typeof content === "string") {
      cleaned.push(message)
      continue
    }

    const parts = []
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part)
        continue
      }
      const type = String(part?.type ?? "")
      if (type === "text" || type === "input_text" || type === "output_text") {
        parts.push(String(part?.text ?? ""))
        continue
      }
      const info = partSource(part)
      if (!info) continue
      if (attachments.length >= MAX_ATTACHMENTS) {
        throw upstreamError(`一次最多 ${MAX_ATTACHMENTS} 个附件`, 400, { code: CODES.invalidRequest })
      }
      if (info.source == null || info.source === "") {
        throw upstreamError("附件缺少内容（file_id 形式暂不支持，请用 data URL 或裸 base64）", 400, {
          code: CODES.invalidRequest,
        })
      }
      const attachment = await resolveSource(fetchImpl, info.source, {
        signal,
        fallbackType: info.kind === "image" ? "image/png" : info.mediaType,
        name: info.name,
        index: attachments.length,
      })
      if (!attachment) continue
      if (info.kind === "image" && !IMAGE_EXT_BY_TYPE.test(attachment.mediaType)) {
        throw upstreamError(
          `图片附件的类型是 ${attachment.mediaType}，不是 image/*；请检查 URL 或 data URL`,
          400,
          { code: CODES.invalidRequest },
        )
      }
      total += attachment.bytes.length
      if (total > MAX_TOTAL_BYTES) {
        throw upstreamError("附件总大小超过 60 MB", 400, { code: CODES.invalidRequest })
      }
      attachments.push(attachment)
      const isImage = IMAGE_EXT_BY_TYPE.test(attachment.mediaType)
      parts.push(`${isImage ? "[图片" : "[附件"}: ${attachment.name}]`)
    }
    cleaned.push({ ...message, content: parts.join("\n") })
  }

  return { messages: cleaned, attachments }
}

function cacheKeyOf(apiKey, attachment) {
  const hash = crypto.createHash("sha256")
    .update(attachment.mediaType)
    .update("\u0000")
    .update(attachment.bytes)
    .digest("hex")
  return `${String(apiKey ?? "").slice(-12)}:${hash}`
}

function cacheGet(key) {
  const hit = CACHE.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    CACHE.delete(key)
    return null
  }
  return hit.file
}

function cacheSet(key, file) {
  CACHE.set(key, { at: Date.now(), file })
  if (CACHE.size > CACHE_MAX) {
    for (const [oldKey, item] of CACHE) {
      if (Date.now() - item.at > CACHE_TTL_MS || CACHE.size > CACHE_MAX) CACHE.delete(oldKey)
      if (CACHE.size <= CACHE_MAX) break
    }
  }
}

/**
 * 上传附件到 Capy，返回 jam 的 files[]（fileId/name/mediaType/sizeBytes）。
 * 同一个 API key + 同一份字节会复用上次的 fileId（1 小时）。
 */
export async function uploadAttachments(fetchImpl, apiKey, attachments, { signal } = {}) {
  const list = Array.isArray(attachments) ? attachments : []
  if (!list.length) return []
  if (!apiKey) {
    throw upstreamError("Capy 未登录：上传附件需要 API Key", 401, { code: CODES.signInRequired })
  }

  const results = new Array(list.length)
  const pending = []
  list.forEach((attachment, index) => {
    const key = cacheKeyOf(apiKey, attachment)
    const hit = cacheGet(key)
    if (hit) results[index] = hit
    else pending.push({ attachment, index, key })
  })
  if (!pending.length) return results

  const { response, body, text } = await requestJson(fetchImpl, `${API_BASE}/files`, {
    method: "POST",
    headers: authHeaders(apiKey, { "content-type": "application/json" }),
    body: JSON.stringify({
      files: pending.map(({ attachment }) => ({
        name: attachment.name,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.bytes.length,
      })),
    }),
    signal,
    timeoutMs: 30_000,
  })
  if (!response.ok) throw fromUpstream(response.status, body, text.slice(0, 300))
  const targets = Array.isArray(body?.targets) ? body.targets : []
  if (targets.length !== pending.length) {
    throw upstreamError("Capy 没有返回足够的文件上传目标", 502, { code: "upstream_error" })
  }

  for (let i = 0; i < pending.length; i += 1) {
    const { attachment, index, key } = pending[i]
    const target = targets[i]
    if (!target?.fileId || !target?.url) {
      throw upstreamError("Capy 文件上传目标缺少 fileId/url", 502, { code: "upstream_error" })
    }
    const timeout = withTimeout(signal, UPLOAD_TIMEOUT_MS)
    try {
      let put
      try {
        put = await fetchImpl(target.url, {
          method: "PUT",
          headers: {
            "content-type": attachment.mediaType,
            "content-length": String(attachment.bytes.length),
          },
          body: attachment.bytes,
          signal: timeout.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw error
        if (timeout.timedOut()) {
          throw upstreamError("上传附件到 Capy 超时", 504, { code: CODES.upstreamTimeout, cause: error })
        }
        throw upstreamError(`上传附件到 Capy 失败：${error?.message ?? error}`, 502, {
          code: CODES.upstreamError,
          cause: error,
        })
      }
      if (!put.ok) {
        throw upstreamError(`上传附件到 Capy 失败（HTTP ${put.status}）`, 502, {
          code: CODES.upstreamError,
        })
      }
    } finally {
      timeout.cleanup()
    }
    const file = {
      fileId: String(target.fileId),
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.bytes.length,
    }
    results[index] = file
    cacheSet(key, file)
  }

  return results
}

export function clearAttachmentCache() {
  CACHE.clear()
}

export const _internal = Object.freeze({
  IMAGE_EXT_BY_TYPE,
  PRIVATE_HOST,
  DATA_URL,
  safeName,
  mediaTypeOf,
  decodeDataUrl,
  parseDataUrl: decodeDataUrl,
  partSource,
  assertPublicUrl,
})
