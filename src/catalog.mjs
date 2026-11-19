// 模型目录：GET /api/v1/models → {items:[{id,name,reasoningModes,fast,pro,ultrafast,...}], default}。
// 模型 id 形如 `anthropic/claude-haiku-4-5`，创建线程时放在 model.modelId。

import { API_BASE, DEFAULT_MODEL, PROVIDER, SDK, TOOL_SHIM } from "./constants.mjs"
import { CODES, upstreamError } from "./errors.mjs"
import { authHeaders, requestJson } from "./http.mjs"
import { CATALOG_SNAPSHOT, EXTRA_FREE_MODELS } from "./models.mjs"

const CACHE_TTL = 10 * 60_000

// Capy 定价页明确 $0.00 的三个模型（2026-11-19）：
//   particle/particle-1                  免费、无广告，本机设备线程实测可跑
//   zai/glm-5.3-flash-ads                免费、App 内广告
//   deepseek/deepseek-v4.1-flash-ads     免费、App 内广告
// 只标记厂商明确免费的模型；不要从 rate/billing 反推。
export const FREE_MODEL_IDS = new Set([
  "particle/particle-1",
  "zai/glm-5.3-flash-ads",
  "deepseek/deepseek-v4.1-flash-ads",
])

export const ADS_MODEL_IDS = new Set([
  "zai/glm-5.3-flash-ads",
  "deepseek/deepseek-v4.1-flash-ads",
])

export function isFreeModel(id) {
  return FREE_MODEL_IDS.has(String(id ?? "").trim())
}

export function isAdsModel(id) {
  return ADS_MODEL_IDS.has(String(id ?? "").trim())
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s._-]+/gu, "")
}

function modesOf(raw) {
  const list = Array.isArray(raw?.reasoningModes) ? raw.reasoningModes : []
  return [...new Set(list.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean))]
}

export function variantsOf(modes) {
  return modes.length ? Object.fromEntries(modes.map((mode) => [mode, {}])) : {}
}

/** 免费模型排在最前：magpie 的 /v1/models 每条路由只展示前 24 个。 */
export function freeFirst(items) {
  return [...items].sort((a, b) => Number(isFreeModel(b?.id)) - Number(isFreeModel(a?.id)))
}

export function staticModelList() {
  return freeFirst([...CATALOG_SNAPSHOT, ...EXTRA_FREE_MODELS]).map((item) => ({
    id: String(item.id),
    name: String(item.name || item.id),
    reasoningModes: modesOf(item),
    fast: item.fast === true,
    pro: item.pro === true,
    ultrafast: item.ultrafast === true,
    free: isFreeModel(item.id),
  }))
}

/** config 钩子里的静态模型表（未登录也要有内容）。 */
export function staticModels() {
  return Object.fromEntries(staticModelList().map((model) => {
    const modes = model.reasoningModes
    return [model.id, {
      id: model.id,
      name: model.name,
      free: isFreeModel(model.id),
      tool_call: TOOL_SHIM,
      attachment: true,
      ...(modes.length ? { reasoning: true, variants: variantsOf(modes) } : {}),
      modalities: { input: ["text", "image"], output: ["text"] },
      capabilities: {
        temperature: false,
        reasoning: modes.length > 0,
        attachment: true,
        toolcall: TOOL_SHIM,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
    }]
  }))
}

/** provider.models 返回的单条模型（OpenCode Model 形状）。 */
export function modelEntry(raw, providerId = PROVIDER) {
  const id = String(raw?.id ?? "").trim()
  if (!id) return null
  const name = String(raw?.name ?? "").trim() || id
  const modes = modesOf(raw)
  const variants = variantsOf(modes)
  return {
    id,
    providerID: providerId,
    name,
    free: isFreeModel(id),
    tool_call: TOOL_SHIM,
    attachment: true,
    api: { id, url: API_BASE, npm: SDK },
    status: "active",
    headers: {},
    options: {},
    limit: {},
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: {
      temperature: false,
      reasoning: modes.length > 0,
      attachment: true,
      toolcall: TOOL_SHIM,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    ...(Object.keys(variants).length ? { variants } : {}),
  }
}

export function modelMapOf(models) {
  const out = {}
  for (const raw of Array.isArray(models) ? models : []) {
    const entry = modelEntry(raw)
    if (entry) out[entry.id] = entry
  }
  return out
}

/** OpenAI /v1/models 的形状。 */
export function modelsResponse(entries = staticModels()) {
  return new Response(JSON.stringify({
    object: "list",
    data: Object.entries(entries).map(([key, model]) => ({
      id: model.id || key,
      object: "model",
      created: 0,
      owned_by: PROVIDER,
      name: model.name || key,
    })),
  }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } })
}

const cache = new Map()

export function clearCatalogCache() {
  cache.clear()
}

export async function fetchCatalog(fetchImpl, { apiKey, signal } = {}) {
  if (!apiKey) {
    throw upstreamError("Capy 未登录：没有 API Key", 401, { code: CODES.signInRequired })
  }
  const key = String(apiKey).slice(-32)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value

  const { response, body, text } = await requestJson(fetchImpl, `${API_BASE}/models`, {
    headers: authHeaders(apiKey),
    signal,
    timeoutMs: 20_000,
  })
  if (!response.ok) {
    if (response.status === 401) {
      throw upstreamError("Capy API Key 失效，请重新登录", 401, {
        code: CODES.signInRequired,
        detail: text.slice(0, 200),
      })
    }
    throw upstreamError(`Capy 模型目录读取失败（HTTP ${response.status}）`, response.status >= 500 ? 503 : 502, {
      code: response.status >= 500 ? CODES.upstreamUnavailable : CODES.upstreamError,
      detail: text.slice(0, 200),
    })
  }
  const live = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : []
  // 公共 /models 不返回 free-with-ads 模型；插件目录里补上，否则 App 里能选的
  // 两个免费模型在 magpie 里会消失。
  const seen = new Set(live.map((item) => String(item?.id ?? "")))
  const items = freeFirst([...live, ...EXTRA_FREE_MODELS.filter((item) => !seen.has(item.id))])
  const models = modelMapOf(items)
  if (!Object.keys(models).length) {
    throw upstreamError("Capy 模型目录为空", 502, { code: "upstream_error" })
  }
  const value = {
    models,
    defaultModelId: String(body?.default?.modelId ?? "").trim() || DEFAULT_MODEL,
    raw: items,
  }
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 64) {
    for (const [oldKey, item] of cache) {
      if (Date.now() - item.at > CACHE_TTL) cache.delete(oldKey)
    }
  }
  return value
}

/** 请求里的 model → catalog 里的 id。未知模型必须 404，绝不静默换成默认模型。 */
export function resolveModel(requested, catalog, fallback = DEFAULT_MODEL) {
  const raw = typeof requested === "string"
    ? requested
    : typeof requested?.id === "string"
      ? requested.id
      : typeof requested?.modelId === "string"
        ? requested.modelId
        : ""
  const wanted = raw.trim()
  const entries = Object.values(catalog?.models ?? {})
  if (!wanted) {
    const fallbackEntry = catalog?.models?.[fallback] || entries[0]
    if (!fallbackEntry) throw upstreamError("Capy 模型目录为空", 502, { code: "upstream_error" })
    return fallbackEntry.id
  }

  const strip = (value) => value.replace(/^capy\//iu, "")
  const target = strip(wanted)
  const exact = entries.find((item) => item.id === wanted) || entries.find((item) => item.id === target)
  if (exact) return exact.id

  const short = target.split("/").pop()
  const byShort = entries.find((item) => item.id.split("/").pop() === short)
  if (byShort) return byShort.id

  const norm = normalize(target)
  const byName = entries.find((item) => normalize(item.name) === norm)
    || entries.find((item) => normalize(item.id) === norm)
    || entries.find((item) => normalize(item.id.split("/").pop()) === norm)
  if (byName) return byName.id

  throw upstreamError(
    `Capy 不认识模型 "${wanted}"。可用模型见 GET /v1/models。`,
    404,
    { code: CODES.modelNotFound, detail: wanted },
  )
}

/** 从模型目录取推理档位（reasoning_effort）是否合法。 */
export function reasoningModeOf(body, modelId, catalog) {
  const raw = body?.reasoning_effort
    ?? body?.reasoning?.effort
    ?? body?.providerOptions?.capy?.reasoningMode
    ?? ""
  const mode = String(raw ?? "").trim().toLowerCase()
  if (!mode) return ""
  const entry = catalog?.models?.[modelId]
  const modes = entry
    ? (Array.isArray(entry.reasoningModes) ? modesOf(entry) : Object.keys(entry.variants ?? {}))
    : []
  if (!modes.length) return ""
  const lowered = modes.map((item) => String(item).toLowerCase())
  return lowered.includes(mode) ? mode : ""
}
