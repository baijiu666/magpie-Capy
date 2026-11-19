// 错误词表与出口。宿主只认 status，人只认 message；每条错误都带稳定的 code。

export const CODES = Object.freeze({
  invalidRequest: "invalid_request",
  modelNotFound: "model_not_found",
  rateLimited: "rate_limited",
  signInRequired: "sign_in_required",
  insufficientQuota: "insufficient_quota",
  upstreamUnavailable: "upstream_unavailable",
  upstreamTimeout: "upstream_timeout",
  upstreamError: "upstream_error",
  internalError: "internal_error",
  notImplemented: "not_implemented",
})

const STATUS_BY_CODE = Object.freeze({
  [CODES.invalidRequest]: 400,
  [CODES.modelNotFound]: 404,
  [CODES.rateLimited]: 429,
  [CODES.signInRequired]: 401,
  [CODES.insufficientQuota]: 402,
  [CODES.upstreamUnavailable]: 503,
  [CODES.upstreamTimeout]: 504,
  [CODES.upstreamError]: 502,
  [CODES.internalError]: 502,
  [CODES.notImplemented]: 501,
})

export class CapyError extends Error {
  constructor(message, status, { code = "", cause = null, retryAfter = 0, detail = "" } = {}) {
    super(message)
    this.name = "CapyError"
    this.status = Number(status) || 502
    this.code = code || codeForStatus(this.status)
    this.cause = cause
    this.retryAfter = Number(retryAfter) || 0
    this.detail = detail
  }
}

export function codeForStatus(status) {
  if (status === 400) return CODES.invalidRequest
  if (status === 401) return CODES.signInRequired
  if (status === 402) return CODES.insufficientQuota
  if (status === 404) return CODES.modelNotFound
  if (status === 429) return CODES.rateLimited
  if (status === 503) return CODES.upstreamUnavailable
  if (status === 504) return CODES.upstreamTimeout
  if (status >= 500) return CODES.upstreamUnavailable
  return CODES.upstreamError
}

export function upstreamError(message, status = 502, options = {}) {
  return new CapyError(message, status, options)
}

export function internalError(message = "插件内部错误", detail = "") {
  return new CapyError(message, 502, { code: CODES.internalError, detail })
}

export function notImplemented(url = "") {
  return new CapyError(
    `该端点没有实现：${url}。本插件只提供 /chat/completions 与 /models。`,
    501,
    { code: CODES.notImplemented },
  )
}

/** 上游 JSON 错误（{_tag, message, ...}）→ CapyError。 */
export function fromUpstream(status, body, fallback = "") {
  const tag = typeof body?._tag === "string" ? body._tag : ""
  const message = String(body?.message ?? body?.detail ?? fallback ?? "").trim()
  const retryAfter = Number(body?.retryAfterSeconds ?? body?.retry_after) || 0

  if (status === 401 || tag === "capy/Unauthorized") {
    return new CapyError("Capy API Key 无效或已被吊销，请重新登录", 401, {
      code: CODES.signInRequired,
      detail: message || tag,
    })
  }
  if (status === 402 || tag === "capy/PaidFeatureUnavailable") {
    return new CapyError(
      message || "Capy 额度不足（没有余额或套餐），请先在 Capy 里充值。",
      402,
      { code: CODES.insufficientQuota, detail: tag },
    )
  }
  if (status === 403 || tag === "capy/Forbidden") {
    return new CapyError(
      message || "Capy 拒绝了这个请求（可能需要支持的地区或付费套餐）。",
      403,
      { code: CODES.upstreamError, detail: tag },
    )
  }
  if (status === 429 || tag === "capy/RateLimited") {
    return new CapyError(message || "Capy 限流，请稍后再试", 429, {
      code: CODES.rateLimited,
      retryAfter,
      detail: tag,
    })
  }
  if (status === 404 || /NotFound$/u.test(tag)) {
    return new CapyError(message || "Capy 资源不存在", 404, {
      code: CODES.modelNotFound,
      detail: tag,
    })
  }
  if (status === 400 && /ModelSelection/iu.test(tag)) {
    return new CapyError(message || "Capy 不接受这个模型", 400, {
      code: CODES.modelNotFound,
      detail: tag,
    })
  }
  if (status === 400) {
    return new CapyError(message || "Capy 认为请求不合法", 400, {
      code: CODES.invalidRequest,
      detail: tag,
    })
  }
  if (status === 503 || tag === "capy/StreamUnavailable") {
    return new CapyError(message || "Capy 流服务暂不可用，请重试", 503, {
      code: CODES.upstreamUnavailable,
      detail: tag,
    })
  }
  if (status >= 500) {
    return new CapyError(message || `Capy 上游错误（HTTP ${status}）`, 503, {
      code: CODES.upstreamUnavailable,
      detail: tag,
    })
  }
  return new CapyError(message || `Capy 上游错误（HTTP ${status}）`, 502, {
    code: CODES.upstreamError,
    detail: tag,
  })
}

export function isAuthFailure(error) {
  return Number(error?.status) === 401 || error?.code === CODES.signInRequired
}

export function chatErrorStatus(error) {
  if (Number.isFinite(Number(error?.status)) && Number(error.status) > 0) return Number(error.status)
  return STATUS_BY_CODE[error?.code] || 502
}

export function errorCode(error) {
  return error?.code || CODES.upstreamError
}

export function signInHeaders(error) {
  // 401 = API Key 失效：让宿主把这个账号标成「需要重新登录」。
  if (Number(error?.status) === 401) return { "x-magpie-sign-in": "expired" }
  return {}
}

export function retryAfterHeader(error) {
  const seconds = Number(error?.retryAfter)
  return Number.isFinite(seconds) && seconds > 0 ? { "retry-after": String(Math.ceil(seconds)) } : {}
}

export function errorResponse(message, status, code = codeForStatus(status), headers = {}) {
  const body = {
    error: {
      message: String(message || ""),
      type: code === CODES.signInRequired ? "authentication_error" : "upstream_error",
      code,
      status,
    },
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

/** 已经 200 的流里出错：补一帧 OpenAI error chunk，再 [DONE]。 */
export function sseErrorChunk(error) {
  const status = chatErrorStatus(error)
  const payload = {
    error: {
      message: String(error?.message ?? error),
      type: status === 401 ? "authentication_error" : "upstream_error",
      code: errorCode(error),
      status,
    },
  }
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}
