// magpie 插件：Capy（https://capy.ai，Scrapybara 的云端 coding agent）
//
// 上游是 Capy 的 App + 公共 API，不依赖 Capy 桌面端：
//   · 登录：浏览器登录 → Clerk 会话 + 组织级 API Key（capy_…）
//   · 设备：首次使用自动走设备码配对，注册 magpie-headless，连 device tunnel
//   · 对话：POST /threads 新建线程 → GET /threads/{id}/stream?until=run（SSE）
//   · 目录：GET /models；额度：GET /usage + /usage/balance
//
// 协议取证：解包 Capy-0.9.2-x64.exe → app.asar + renderer 资源；OpenAPI 在
// https://docs.capy.ai/openapi.json。关键结论都在 src/*.mjs 的注释里。

import {
  API_BASE,
  BASE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MODEL,
  ICON,
  PROVIDER,
  PROVIDER_NAME,
  REFRESH_LEAD_MS,
  SDK,
} from "./src/constants.mjs"
import {
  apiKeyOf,
  completeLogin,
  mintSessionJwt,
  parseRefresh,
  refreshCredential,
} from "./src/auth.mjs"
import { chromiumLogin, findBrowser } from "./src/browser.mjs"
import {
  clearCatalogCache,
  fetchCatalog,
  modelsResponse,
  reasoningModeOf,
  resolveModel,
  staticModels,
} from "./src/catalog.mjs"
import { chatCompletions } from "./src/chat.mjs"
import {
  HEADLESS_NAME,
  HeadlessDevice,
  loadHeadlessState,
  pairHeadlessDevice,
  saveHeadlessState,
  waitForDevice,
} from "./src/headless.mjs"
import { createProxyFetch, resolveProxyUrl } from "./src/proxy.mjs"
import {
  CODES,
  chatErrorStatus,
  errorCode,
  errorResponse,
  isAuthFailure,
  retryAfterHeader,
  signInHeaders,
} from "./src/errors.mjs"
import { clearUsageCache, computeUsage } from "./src/usage.mjs"

function cacheKeyOf(auth) {
  return apiKeyOf(auth).slice(-32) || String(auth?.uid || auth?.accountId || "").slice(-64)
}

async function readJsonBody(input, init) {
  if (typeof init?.body === "string") return JSON.parse(init.body)
  if (init?.body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(init.body))
  if (init?.body && typeof init.body.getReader === "function") {
    return JSON.parse(await new Response(init.body).text())
  }
  if (input instanceof Request) return JSON.parse(await input.text())
  return {}
}

function loginErrorText(error) {
  const status = Number(error?.status) || 0
  const code = String(error?.code ?? "")
  if (status === 401) return "Capy 登录已失效，请重新登录"
  if (status === 402) return "Capy 余额不足，请先在 Capy 里充值"
  if (status === 403) return String(error?.message || "Capy 拒绝了这个请求（可能需要支持的地区或套餐）")
  if (code === "browser_not_found") return error.message
  if (code === "login_timeout") return error.message
  if (code === "login_cancelled") return error.message
  if (code === "cookies_unreadable") return error.message
  return String(error?.message ?? error)
}

export const CapyAuthPlugin = async (_ctx = {}, options = {}) => {
  const baseFetch = typeof options?.fetch === "function" ? options.fetch : fetch
  // 地区限制按出口 IP 判；Node/Bun 的 fetch 不会自动读 Windows 系统代理，这里显式套上。
  // 测试/离线场景传 proxy:false 可关闭自动探测。
  const proxyUrl = resolveProxyUrl({ proxy: options?.proxy, env: options?.env })
  const fetchImpl = createProxyFetch(baseFetch, proxyUrl, {
    onWarn: (message) => {
      try { console.warn(`[magpie-capy] ${message}`) } catch {}
    },
  })
  const findBrowserImpl = typeof options?.findBrowser === "function" ? options.findBrowser : findBrowser
  const chromiumLoginImpl = typeof options?.chromiumLogin === "function" ? options.chromiumLogin : chromiumLogin

  let maxConcurrency = DEFAULT_MAX_CONCURRENCY

  // Capy 的 minimal 提示词档位当前对普通账号 403（实测）。auto 模式先试一次；
  // 一旦 403 就记住，后续请求直接走 default，不重复付这个失败请求。
  const configuredVariant = String(
    options?.promptVariant
    ?? process.env.MAGPIE_CAPY_PROMPT_VARIANT
    ?? "auto",
  ).trim().toLowerCase()
  let minimalUnsupported = configuredVariant === "default" || configuredVariant === "off"
  const promptVariantNow = () => {
    if (configuredVariant === "minimal") return "minimal"
    if (configuredVariant === "default" || configuredVariant === "off") return ""
    return minimalUnsupported ? "" : "minimal"
  }
  const onVariantFallback = () => { minimalUnsupported = true }

  async function loadCatalog(auth) {
    if (!auth?.access) return { models: staticModels(), defaultModelId: DEFAULT_MODEL }
    try {
      return await fetchCatalog(fetchImpl, { apiKey: auth.access })
    } catch (error) {
      if (isAuthFailure(error)) throw error
      return { models: staticModels(), defaultModelId: DEFAULT_MODEL }
    }
  }

  /** 401 时用保存的 Clerk 会话重新签一个 key，再重试一次。 */
  async function withRecovery(auth, run) {
    try {
      return await run(auth)
    } catch (error) {
      if (!isAuthFailure(error)) throw error
      const renewed = await refreshCredential(fetchImpl, auth).catch(() => null)
      if (!renewed?.access) throw error
      const merged = { ...auth, ...renewed, metadata: { ...(auth?.metadata ?? {}), ...(renewed.metadata ?? {}) } }
      return await run(merged)
    }
  }

  // 无头设备：首次使用自动注册 magpie-headless，之后复用 DPAPI 加密的本地状态。
  // MAGPIE_CAPY_HEADLESS=off 可以关闭。
  const injectedHeadless = typeof options?.headless === "function" ? options.headless : null
  const headlessMode = String(
    typeof options?.headless === "string"
      ? options.headless
      : process.env.MAGPIE_CAPY_HEADLESS
        ?? "auto",
  ).trim().toLowerCase()
  const headlessEnabled = Boolean(injectedHeadless)
    || !["off", "0", "false", "no", "desktop"].includes(headlessMode)
  let headlessDevice = null
  let headlessInfo = null
  let headlessStarting = null

  async function startHeadless(auth, { jwt, orgId, signal } = {}) {
    if (injectedHeadless) return await injectedHeadless({ jwt, orgId, signal })
    if (!headlessEnabled) return null
    if (process.platform !== "win32") return null
    if (typeof Bun === "undefined") return null
    if (!jwt || !orgId) {
      throw new Error("无头设备需要 Clerk 会话与 orgId")
    }
    if (headlessDevice && headlessInfo?.orgId === orgId) {
      try {
        await headlessDevice.ensure()
        return headlessInfo
      } catch {
        try { headlessDevice.close() } catch {}
        headlessDevice = null
        headlessInfo = null
      }
    }
    if (headlessStarting) return await headlessStarting

    headlessStarting = (async () => {
      const cred = parseRefresh(auth?.refresh)
      const clientId = String(cred?.clientId || auth?.metadata?.clientId || "").trim()
      let state = loadHeadlessState()
      if (!state || state.orgId !== orgId) {
        state = await pairHeadlessDevice(fetchImpl, { jwt, orgId, clientId, signal })
        saveHeadlessState(state)
      }
      let device = new HeadlessDevice({ credential: state })
      try {
        await device.ensure()
      } catch (error) {
        // token 被吊销或设备状态过期：重新配对一次。
        device.close()
        state = await pairHeadlessDevice(fetchImpl, { jwt, orgId, clientId, signal })
        saveHeadlessState(state)
        device = new HeadlessDevice({ credential: state })
        await device.ensure()
      }
      const hit = await waitForDevice(fetchImpl, jwt, orgId, state.deviceId, { timeoutMs: 15_000, signal })
      if (!hit) {
        device.close()
        throw new Error("无头设备已连上隧道，但服务端没有把它标记为 connected")
      }
      headlessDevice = device
      headlessInfo = state
      return { deviceId: state.deviceId, name: state.name || HEADLESS_NAME }
    })()
    try {
      return await headlessStarting
    } finally {
      headlessStarting = null
    }
  }

  // 额度卡片的「无头设备」状态；15 秒缓存。
  const deviceCache = new Map()
  const DEVICE_TTL_MS = 15_000
  async function deviceStatus(auth) {
    if (!auth?.refresh) return { connected: false, unknown: true }
    const key = apiKeyOf(auth).slice(-16) || String(auth?.uid || "").slice(-16)
    const hit = deviceCache.get(key)
    if (hit && Date.now() - hit.at < DEVICE_TTL_MS) return hit.value
    const cred = parseRefresh(auth.refresh)
    if (!cred?.clientJwt || !cred?.sessionId) return { connected: false, unknown: true }
    try {
      const jwt = await mintSessionJwt(fetchImpl, {
        clientJwt: cred.clientJwt,
        sessionId: cred.sessionId,
      })
      const orgId = String(cred.orgId || auth?.metadata?.orgId || "").trim()
      if (!orgId) return { connected: false, unknown: true }
      const info = await startHeadless(auth, { jwt, orgId })
      const value = {
        connected: Boolean(info),
        name: String(info?.name || ""),
      }
      deviceCache.set(key, { at: Date.now(), value })
      return value
    } catch {
      return { connected: false, unknown: true }
    }
  }

  return {
    // ═══ ① provider + 静态模型表 ═══════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: API_BASE,
        models: staticModels(),
        searches: false,
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      get maxConcurrency() {
        return maxConcurrency
      },
      refreshLead: REFRESH_LEAD_MS,

      // ═══ ② 登录 ═══════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: "浏览器登录（Google / GitHub / Passkey / 邮箱）",
          async authorize() {
            const controller = new AbortController()
            const login = Promise.resolve()
              .then(async () => {
                if (!findBrowserImpl()) {
                  throw Object.assign(new Error(
                    "没有找到 Chromium 内核浏览器（Chrome / Edge / 360极速 / QQ 等）。"
                    + "请安装 Chrome 或 Edge，或设置 MAGPIE_CAPY_BROWSER 指向浏览器 exe。",
                  ), { code: "browser_not_found" })
                }
                const browser = await chromiumLoginImpl({
                  signal: controller.signal,
                  mintApiKey: true,
                })
                return await completeLogin(fetchImpl, {
                  clientJwt: browser.clientJwt,
                  sessionId: browser.sessionId,
                  userId: browser.userId,
                  orgId: browser.orgId,
                  accountId: browser.accountId,
                  apiKey: browser.apiKey,
                  projectId: browser.projectId,
                  source: "capy-browser",
                })
              })
            login.catch(() => {})
            return {
              url: `${BASE}/sign-in`,
              opened: true,
              method: "auto",
              instructions:
                "已打开 Capy 官方登录页。用页面上的任意一种方式登录："
                + "Google、GitHub、Passkey（Windows Hello / 指纹 / PIN）或邮箱验证码。"
                + "登录成功后会自动读完登录态并关闭窗口，不需要复制任何东西。"
                + "首次对话会自动注册一台 magpie-headless 设备，不需要 Capy 桌面端。",
              close: () => controller.abort(),
              async callback(_value, { signal } = {}) {
                const onAbort = () => controller.abort()
                signal?.addEventListener?.("abort", onAbort, { once: true })
                try {
                  return await login
                } catch (error) {
                  return { type: "failed", error: loginErrorText(error) }
                } finally {
                  signal?.removeEventListener?.("abort", onAbort)
                  controller.abort()
                }
              },
            }
          },
        },
      ],

      // ═══ ③ 续期：API key 长期有效，定期校验；失效就用 Clerk 会话重签 ═══
      async refresh(auth) {
        try {
          return await refreshCredential(fetchImpl, auth)
        } catch (error) {
          if (isAuthFailure(error) || error?.signIn === "expired") {
            throw Object.assign(new Error("Capy 登录已失效，请重新登录"), { signIn: "expired" })
          }
          return undefined
        }
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return {}

        return {
          baseURL: API_BASE,
          apiKey: "",
          headers: {},

          async fetch(input, init = {}) {
            const fresh = await getAuth()
            if (!fresh?.access) {
              return errorResponse("Capy 未登录：请重新登录", 401, CODES.signInRequired)
            }

            const request = input instanceof Request ? input : null
            const url = typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : (request?.url ?? "")
            const method = String(init?.method ?? request?.method ?? "GET").toUpperCase()
            const path = url.split("?")[0]

            if (method === "GET" && /\/models$/u.test(path)) {
              try {
                const catalog = await loadCatalog(fresh)
                return modelsResponse(catalog.models)
              } catch (error) {
                return errorResponse(
                  String(error?.message ?? error),
                  chatErrorStatus(error),
                  errorCode(error),
                  { ...signInHeaders(error), ...retryAfterHeader(error) },
                )
              }
            }
            if (!/\/chat\/completions$/u.test(path)) {
              return errorResponse(
                `该端点没有实现：${method} ${url}。本插件只提供 /chat/completions 与 /models。`,
                501,
                CODES.notImplemented,
              )
            }

            let body
            try {
              body = await readJsonBody(input, init)
            } catch {
              return errorResponse("请求体不是合法的 JSON", 400, CODES.invalidRequest)
            }

            const signal = init?.signal ?? request?.signal
            const stream = body?.stream !== false
            const requestedModel = body?.model

            try {
              const result = await withRecovery(fresh, async (current) => {
                const catalog = await loadCatalog(current)
                const modelId = resolveModel(requestedModel, catalog)
                const reasoningMode = reasoningModeOf(body, modelId, catalog)
                return await chatCompletions({
                  fetchImpl,
                  auth: current,
                  body,
                  stream,
                  signal,
                  modelId,
                  reasoningMode,
                  promptVariant: promptVariantNow(),
                  onVariantFallback,
                  headless: ({ jwt, orgId, signal: requestSignal }) => startHeadless(current, {
                    jwt,
                    orgId,
                    signal: requestSignal,
                  }),
                })
              })
              return result
            } catch (error) {
              signal?.throwIfAborted?.()
              return errorResponse(
                String(error?.message ?? error),
                chatErrorStatus(error),
                errorCode(error),
                { ...signInHeaders(error), ...retryAfterHeader(error) },
              )
            }
          },
        }
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return { error: "未登录", windows: [] }
        try {
          const usage = await computeUsage({
            fetchImpl,
            apiKey: auth.access,
            cacheKey: cacheKeyOf(auth),
          })
          if (!usage.error) {
            const status = await deviceStatus(auth)
            usage.windows = [
              ...(usage.windows || []),
              {
                name: "无头设备",
                // 只是展示项；aside 不参与路由排序，但 used 仍必须是有限值。
                used: status.connected ? 0 : 100,
                aside: true,
                display: status.unknown
                  ? "状态未知（重新登录 / 检查网络）"
                  : status.connected
                    ? `已连接${status.name ? ` · ${status.name}` : ""}`
                    : "未连接（自动注册失败，看插件日志）",
              },
            ]
          }
          return usage
        } catch (error) {
          if (isAuthFailure(error)) {
            return { error: "Capy 登录已失效，请重新登录", windows: [], signIn: "expired" }
          }
          return { error: String(error?.message ?? error), windows: [] }
        }
      },
    },

    // ═══ ⑥ 每账号模型目录 ═══════════════════════════════════════════
    provider: {
      id: PROVIDER,
      async models(_fallback, { auth } = {}) {
        if (!auth?.access) return staticModels()
        try {
          const catalog = await fetchCatalog(fetchImpl, { apiKey: auth.access })
          return catalog.models
        } catch {
          return staticModels()
        }
      },
    },
  }
}

export default CapyAuthPlugin

// 诊断口：脚本 / 测试可以复用这些内部件，但不会改变插件行为。
export const _internal = Object.freeze({
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  API_BASE,
  SDK,
  ICON,
  DEFAULT_MODEL,
  staticModels,
  resolveModel,
  reasoningModeOf,
  modelsResponse,
  cacheKeyOf,
  readJsonBody,
  loginErrorText,
  resolveProxyUrl,
  createProxyFetch,
  clearCaches: () => {
    clearCatalogCache()
    clearUsageCache()
  },
  isAuthFailure,
})
