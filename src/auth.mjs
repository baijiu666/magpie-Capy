// 登录 / 续期：把 Capy 的 Clerk 会话换成长期可用的组织级 API key。
//
// 登录只有一条路径：src/browser.mjs 从 CDP 读 __client Cookie + sessionId + orgId
// （可能已顺手 mint key）。无头设备在首次使用时用同一个 Clerk 会话自动注册。
//
// 关键（2026-11-19 实测）：
//   · Clerk 的 session JWT 只有在 **Origin + __client Cookie** 认证路径下才带
//     `azp: https://capy.ai`；带 azp 的 token 才能调 api.capy.ai/app/*。
//   · 用 azp token 调 POST /app/orgs/{orgId}/api-keys 换 `capy_…`（长期、组织级）。
//   · 公网 /api/v1/* 只认 API key，不认 Clerk token。

import crypto from "node:crypto"

import {
  API_BASE,
  API_KEY_NAME,
  APP_BASE,
  BASE,
  FAPI_BASE,
  PROJECT_CODE,
  PROJECT_NAME,
} from "./constants.mjs"
import { CODES, isAuthFailure, upstreamError } from "./errors.mjs"
import { authHeaders, jwtPayload, requestJson } from "./http.mjs"

const REFRESH_VERSION = 1
const PROJECT_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

function randomProjectCode() {
  let out = "M"
  for (let i = 0; i < 3; i += 1) {
    out += PROJECT_CODE_ALPHABET[Math.floor(Math.random() * PROJECT_CODE_ALPHABET.length)]
  }
  return out
}

function accountNameOf(me, fallback = "") {
  const email = String(me?.email ?? "").trim()
  if (email) return email
  const first = String(me?.firstName ?? "").trim()
  const last = String(me?.lastName ?? "").trim()
  const full = `${first}${last ? ` ${last}` : ""}`.trim()
  return full || fallback
}

export function apiKeyOf(auth) {
  const access = typeof auth?.access === "string" ? auth.access.trim() : ""
  return /^capy_[A-Za-z0-9_-]{20,}$/u.test(access) ? access : ""
}

export function parseRefresh(raw) {
  if (raw && typeof raw === "object") return raw
  const text = String(raw ?? "").trim()
  if (!text.startsWith("{")) return null
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== "object") return null
    if (!value.clientJwt || !value.sessionId) return null
    return value
  } catch {
    return null
  }
}

export function encodeRefresh(value) {
  return JSON.stringify({
    v: REFRESH_VERSION,
    clientJwt: value.clientJwt,
    sessionId: value.sessionId,
    orgId: value.orgId || "",
    projectId: value.projectId || "",
    deviceId: value.deviceId || "",
    clientId: value.clientId || "",
    userId: value.userId || "",
  })
}

/** 本机 32 hex 客户端 id（桌面/网页端用同一个 localStorage 值；插件自己生成一个稳定的）。 */
export function newClientId() {
  return crypto.randomBytes(16).toString("hex")
}

async function appJson(fetchImpl, jwt, route, init = {}) {
  const { response, body, text } = await requestJson(fetchImpl, `${APP_BASE}${route}`, {
    ...init,
    headers: authHeaders(jwt, init.headers || {}),
    timeoutMs: init.timeoutMs ?? 30_000,
  })
  if (!response.ok) {
    if (response.status === 401) {
      throw upstreamError("Capy 会话已失效，请重新登录", 401, {
        code: CODES.signInRequired,
        detail: text.slice(0, 200),
      })
    }
    const tag = typeof body?._tag === "string" ? body._tag : ""
    throw upstreamError(
      String(body?.message ?? tag ?? `Capy 拒绝了请求（HTTP ${response.status}）`),
      response.status,
      { code: "upstream_error", detail: text.slice(0, 200) },
    )
  }
  return body
}

/**
 * 用 Clerk client JWT 签一个带 azp 的 60s 会话 JWT。
 * 注意：Origin 与 Authorization 不能同时出现（Clerk 会 400）。
 */
export async function mintSessionJwt(fetchImpl, { clientJwt, sessionId, signal } = {}) {
  const client = String(clientJwt ?? "").trim()
  const sid = String(sessionId ?? "").trim()
  if (!client || !sid) {
    throw upstreamError("Capy 登录凭据不完整（缺少 client JWT 或 sessionId）", 401, {
      code: CODES.signInRequired,
    })
  }
  const { response, body, text } = await requestJson(
    fetchImpl,
    `${FAPI_BASE}/v1/client/sessions/${encodeURIComponent(sid)}/tokens`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: `__client=${client}` },
      body: "{}",
      signal,
      timeoutMs: 20_000,
    },
  )
  if (!response.ok) {
    throw upstreamError(
      `Capy 会话换票失败（HTTP ${response.status}）。请重新登录 Capy（浏览器登录）。`,
      401,
      { code: CODES.signInRequired, detail: text.slice(0, 200) },
    )
  }
  const jwt = typeof body?.jwt === "string" ? body.jwt : body?.response?.jwt
  const claims = jwtPayload(jwt)
  if (!jwt || !claims) {
    throw upstreamError("Capy 会话换票返回的不是 JWT", 502, { code: "upstream_error" })
  }
  if (claims.azp !== BASE) {
    throw upstreamError(
      "Capy 会话换票没有拿到 azp（浏览器登录态可能不完整），请重新登录",
      401,
      { code: CODES.signInRequired, detail: `azp=${claims.azp ?? "missing"}` },
    )
  }
  return jwt
}

export async function fetchMe(fetchImpl, jwt, { signal } = {}) {
  return appJson(fetchImpl, jwt, "/me", { method: "GET", signal })
}

export async function listOrganizations(fetchImpl, jwt, { signal } = {}) {
  const body = await appJson(fetchImpl, jwt, "/organizations", { method: "GET", signal })
  return Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : []
}

export async function listProjects(fetchImpl, jwt, orgId, { signal } = {}) {
  const body = await appJson(fetchImpl, jwt, `/orgs/${encodeURIComponent(orgId)}/projects`, {
    method: "GET",
    signal,
  })
  return (Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [])
    .filter((item) => item && item.deleted !== true)
}

export async function createProject(fetchImpl, jwt, orgId, { name = PROJECT_NAME, code = PROJECT_CODE, signal } = {}) {
  const payload = { name, code: String(code || PROJECT_CODE).toUpperCase() }
  const body = await appJson(fetchImpl, jwt, `/orgs/${encodeURIComponent(orgId)}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  })
  if (!body?.id) {
    throw upstreamError("Capy 创建项目没有返回 projectId", 502, { code: "upstream_error" })
  }
  return body
}

/**
 * 公共 API 的 /threads 必须挂在一个真实项目下，而公共 API 没有建项目接口。
 * 这里用会话鉴权（/app）保证至少有一个项目：优先用户指定的，其次 Magpie 项目，
 * 再其次任意项目；一个都没有就自动建一个。
 */
export async function ensureProject(fetchImpl, jwt, orgId, { projectId = "", signal } = {}) {
  const wanted = String(projectId ?? "").trim()
  const projects = await listProjects(fetchImpl, jwt, orgId, { signal })
  if (wanted) {
    const hit = projects.find((item) => item.id === wanted)
    if (hit) return hit.id
  }
  const magpie = projects.find((item) => /magpie/iu.test(String(item.name ?? "")) || item.code === PROJECT_CODE)
  if (magpie) return magpie.id
  if (projects.length) return projects[0].id

  try {
    const created = await createProject(fetchImpl, jwt, orgId, { signal })
    return created.id
  } catch (error) {
    // 短码冲突时换一个再试一次。
    if (Number(error?.status) === 400 || Number(error?.status) === 409) {
      const created = await createProject(fetchImpl, jwt, orgId, {
        code: randomProjectCode(),
        signal,
      })
      return created.id
    }
    throw error
  }
}

export async function mintApiKey(fetchImpl, jwt, orgId, { name = API_KEY_NAME, signal } = {}) {
  const body = await appJson(fetchImpl, jwt, `/orgs/${encodeURIComponent(orgId)}/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
    signal,
  })
  const plaintext = typeof body?.plaintext === "string" ? body.plaintext.trim() : ""
  if (!plaintext.startsWith("capy_")) {
    throw upstreamError("Capy 没有返回 API Key 明文", 502, { code: "upstream_error" })
  }
  return {
    plaintext,
    keyId: String(body?.key?.id ?? ""),
    tokenHint: String(body?.key?.tokenHint ?? ""),
  }
}

export async function validateApiKey(fetchImpl, apiKey, { signal } = {}) {
  if (!apiKey) return { ok: false, status: 401 }
  try {
    const { response } = await requestJson(fetchImpl, `${API_BASE}/models`, {
      headers: authHeaders(apiKey),
      signal,
      timeoutMs: 20_000,
    })
    return { ok: response.ok, status: response.status }
  } catch (error) {
    // 网络错误不说明 key 失效。
    if (isAuthFailure(error)) return { ok: false, status: 401 }
    return { ok: true, status: 0, error }
  }
}

/**
 * 把一份 Capy 浏览器登录态变成 magpie 可保存的账号记录。
 *
 * @param {object} cred
 * @param {string} cred.clientJwt
 * @param {string} cred.sessionId
 * @param {string} [cred.orgId]
 * @param {string} [cred.userId]
 * @param {string} [cred.accountId]
 * @param {string} [cred.source]
 * @param {string} [cred.apiKey] 浏览器登录时可顺手 mint 的 key
 * @param {string} [cred.projectId]
 */
export async function completeLogin(fetchImpl, cred, { signal, expiresMs = 7 * 24 * 3600_000 } = {}) {
  if (!cred?.clientJwt || !cred?.sessionId) {
    throw upstreamError("没有拿到 Capy 登录凭据，请重新登录", 401, { code: CODES.signInRequired })
  }

  const jwt = await mintSessionJwt(fetchImpl, {
    clientJwt: cred.clientJwt,
    sessionId: cred.sessionId,
    signal,
  })
  const me = await fetchMe(fetchImpl, jwt, { signal })
  const orgs = await listOrganizations(fetchImpl, jwt, { signal }).catch(() => [])

  const preferred = String(me?.preferences?.preferredOrgId ?? "").trim()
  const fromCred = String(cred.orgId ?? "").trim()
  const orgId =
    (fromCred && orgs.some((item) => item?.id === fromCred) ? fromCred : "") ||
    (preferred && orgs.some((item) => item?.id === preferred) ? preferred : "") ||
    String(orgs[0]?.id ?? fromCred).trim()
  if (!orgId) {
    throw upstreamError("这个 Capy 账号没有组织（org），请先在 Capy 里完成初始化", 409, {
      code: "invalid_request",
    })
  }

  // 不再绑定 Capy 桌面端设备；headless 设备在首次使用时自动注册。
  const projectId = String(cred.projectId || "").trim()
  const clientId = String(cred.clientId || "").trim() || newClientId()

  let apiKey = String(cred.apiKey ?? "").trim()
  let keyId = ""
  if (!apiKey) {
    const minted = await mintApiKey(fetchImpl, jwt, orgId, { signal })
    apiKey = minted.plaintext
    keyId = minted.keyId
  }
  const check = await validateApiKey(fetchImpl, apiKey, { signal })
  if (!check.ok) {
    throw upstreamError("刚签发的 Capy API Key 无法访问 /api/v1/models，请稍后重试", 502, {
      code: "upstream_error",
      detail: `models HTTP ${check.status}`,
    })
  }

  const userId = String(me?.id || cred.userId || "").trim()
  const deviceId = String(cred.deviceId || "").trim()
  const deviceName = ""
  const refresh = encodeRefresh({
    clientJwt: cred.clientJwt,
    sessionId: cred.sessionId,
    orgId,
    projectId,
    deviceId,
    clientId,
    userId,
  })
  const name = accountNameOf(me, String(cred.accountId ?? "").trim())
  const metadata = {
    ...(String(me?.email ?? "").trim() ? { email: String(me.email).trim() } : {}),
    ...(name ? { name } : {}),
    userId,
    orgId,
    ...(projectId ? { projectId } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {}),
    clientId,
    ...(keyId ? { keyId } : {}),
    source: cred.source || "capy",
  }

  return {
    type: "success",
    access: apiKey,
    refresh,
    expires: Date.now() + Math.max(60_000, Number(expiresMs) || 7 * 24 * 3600_000),
    ...(name ? { accountId: name } : {}),
    ...(userId ? { uid: userId } : {}),
    metadata,
  }
}

/**
 * 续期：API key 长期有效，但可能被吊销。先校验；失效就用保存的 Clerk 会话重新签。
 * 不再依赖 Capy 桌面端；Clerk 会话失效时直接要求重新浏览器登录。
 * 返回的字段会合并进 magpie 的账号记录。
 */
export async function refreshCredential(fetchImpl, auth, { signal } = {}) {
  const cred = parseRefresh(auth?.refresh)
  const current = apiKeyOf(auth)

  let keyToReuse = current
  if (current) {
    const check = await validateApiKey(fetchImpl, current, { signal })
    if (check.ok) {
      return {
        access: current,
        expires: Date.now() + 7 * 24 * 3600_000,
      }
    }
    if (check.status !== 401) {
      // 网络抖动：保持原样，交给宿主 30 秒后重试。
      return undefined
    }
    keyToReuse = ""
  }
  if (!cred) {
    throw Object.assign(new Error("Capy 登录已失效，请重新登录"), { signIn: "expired" })
  }

  try {
    // 带着现有 API key 走 completeLogin：key 还有效就复用，不会每次续期都新建一把。
    const renewed = await completeLogin(fetchImpl, {
      ...cred,
      deviceId: cred.deviceId || auth?.metadata?.deviceId || "",
      projectId: cred.projectId || auth?.metadata?.projectId || "",
      orgId: cred.orgId || auth?.metadata?.orgId || "",
      clientId: cred.clientId || auth?.metadata?.clientId || "",
      apiKey: keyToReuse || undefined,
      source: auth?.metadata?.source || "refresh",
    }, { signal })
    const { type: _type, ...rest } = renewed
    return rest
  } catch (error) {
    if (isAuthFailure(error)) {
      throw Object.assign(new Error("Capy 登录已失效，请重新登录"), { signIn: "expired" })
    }
    return undefined
  }
}

export const _internal = Object.freeze({
  accountNameOf,
  randomProjectCode,
  REFRESH_VERSION,
})
