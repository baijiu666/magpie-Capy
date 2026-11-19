// magpie 插件：Capy（https://capy.ai，Scrapybara 的云端 coding agent）
//
// 上游是 Capy 的**公共 API**（https://api.capy.ai/api/v1），不是 OpenAI 兼容网关：
//   · 登录：浏览器登录 / 本机 Capy 客户端导入；两者最终都换成一个组织级 API key（capy_…）
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
import { CapyLocalImportError, readCapyInstall } from "./src/local.mjs"
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
  if (error instanceof CapyLocalImportError) return error.message
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
  const readLocalImpl = typeof options?.readLocal === "function" ? options.readLocal : readCapyInstall
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
      const renewed = await refreshCredential(fetchImpl, auth, {
        readLocal: readLocalImpl,
        forceSession: true,
      }).catch(() => null)
      if (!renewed?.access) throw error
      const merged = { ...auth, ...renewed, metadata: { ...(auth?.metadata ?? {}), ...(renewed.metadata ?? {}) } }
      return await run(merged)
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
          label: "从本机 Capy 客户端导入（推荐）",
          async authorize() {
            // authorize 里不能 await 用户/网络：读文件与换票都放 callback。
            const probe = Promise.resolve()
              .then(async () => {
                const local = await readLocalImpl()
                return await completeLogin(fetchImpl, {
                  clientJwt: local.clientJwt,
                  sessionId: local.sessionId,
                  userId: local.userId,
                  orgId: local.orgId,
                  accountId: local.accountId,
                  source: "capy-desktop",
                })
              })
            probe.catch(() => {})
            return {
              url: BASE,
              opened: true,
              method: "auto",
              instructions: "正在读取本机 Capy 登录态（需要已安装并登录 Capy 桌面端）…",
              async callback() {
                try {
                  return await probe
                } catch (error) {
                  return { type: "failed", error: loginErrorText(error) }
                }
              },
            }
          },
        },

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
                    + "请安装 Chrome 或 Edge，或设置 MAGPIE_CAPY_BROWSER 指向浏览器 exe；"
                    + "也可以改用「从本机 Capy 客户端导入」。",
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
                + "登录成功后会自动读完登录态并关闭窗口，不需要复制任何东西。",
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
          return await refreshCredential(fetchImpl, auth, { readLocal: readLocalImpl })
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
          return await computeUsage({
            fetchImpl,
            apiKey: auth.access,
            cacheKey: cacheKeyOf(auth),
          })
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
