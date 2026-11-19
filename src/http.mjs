// 最小 HTTP 工具：超时、错误归一、JSON 解析。Bun / Node 24 通用。

import { CODES, upstreamError } from "./errors.mjs"

export const TIMEOUTS = Object.freeze({
  json: 30_000,
  streamConnect: 30_000,
  sseIdle: 60_000,
})

function abortError() {
  const error = new Error("请求已取消")
  error.name = "AbortError"
  return error
}

/** 组合外部 signal 与超时；返回 { signal, cleanup, timedOut() }。 */
export function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, Number(timeoutMs) || 30_000))
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
    },
  }
}

/**
 * fetch + 超时 + 把网络错误归一成 CapyError。
 * 返回 { response, body }；body 是解析后的 JSON（解析失败为 null）。
 */
export async function requestJson(fetchImpl, url, {
  method = "GET",
  headers = {},
  body,
  signal,
  timeoutMs = TIMEOUTS.json,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const timeout = withTimeout(signal, timeoutMs)
  try {
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: timeout.signal,
      })
    } catch (error) {
      if (signal?.aborted) throw abortError()
      if (timeout.timedOut()) {
        throw upstreamError("连接 Capy 超时，请检查网络/代理后重试", 504, {
          code: CODES.upstreamTimeout,
          cause: error,
        })
      }
      throw upstreamError(`连接 Capy 失败：${error?.message ?? error}`, 503, {
        code: CODES.upstreamUnavailable,
        cause: error,
      })
    }
    const text = await response.text()
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    if (text.length > maxBytes) {
      throw upstreamError("Capy 响应过大", 502, { code: CODES.upstreamError })
    }
    return { response, body: parsed, text }
  } finally {
    timeout.cleanup()
  }
}

export function jsonHeaders(token, extra = {}) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  }
}

export function authHeaders(token, extra = {}) {
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }
}

/** 安全解析 JWT payload（不验签）。 */
export function jwtPayload(token) {
  const part = String(token ?? "").trim().split(".")[1]
  if (!part) return null
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return value && typeof value === "object" ? value : null
  } catch {
    return null
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }, Math.max(0, Number(ms) || 0))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })
}

export { abortError }
