// 额度卡片：GET /api/v1/usage + GET /api/v1/usage/balance。
//
// Capy 的余额是美元（1 credit = $0.001），没有「总量」可算百分比：
//   · remainingDollars 为数字 → 有余额；为 null 且 unlimited=false → 没余额（agent 不跑）
//   · unlimited=true → 无限
// 每条窗口都必须给有限 used（路由排序的输入）；没有上限的展示项标 aside。

import { API_BASE } from "./constants.mjs"
import { CODES, isAuthFailure } from "./errors.mjs"
import { authHeaders, requestJson } from "./http.mjs"

const CACHE_TTL = 60_000
const cache = new Map()

export function clearUsageCache() {
  cache.clear()
}

function money(value, currency = "USD") {
  const number = Number(value)
  if (!Number.isFinite(number)) return ""
  const symbol = currency === "USD" ? "$" : `${currency} `
  return `${symbol}${number.toFixed(number >= 100 ? 0 : 2)}`
}

function isoOf(value) {
  if (value === null || value === undefined || value === "") return undefined
  if (typeof value === "number") {
    const ms = value > 1e12 ? value : value * 1000
    return new Date(ms).toISOString()
  }
  const text = String(value).trim()
  const direct = new Date(text)
  if (!Number.isNaN(direct.getTime())) return direct.toISOString()
  return undefined
}

function tokensText(tokens) {
  const input = Number(tokens?.inputTokens)
  const output = Number(tokens?.outputTokens)
  if (!Number.isFinite(input) && !Number.isFinite(output)) return ""
  const compact = (value) => {
    if (!Number.isFinite(value)) return "0"
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
    return String(value)
  }
  return `输入 ${compact(input)} / 输出 ${compact(output)} tokens`
}

export function buildUsage(usage, balance) {
  const windows = []
  const currency = String(balance?.currency || "USD").toUpperCase()
  const unlimited = balance?.unlimited === true
  const remaining = balance?.remainingDollars
  const hasRemaining = remaining !== null && remaining !== undefined && Number.isFinite(Number(remaining))
  const resetsAt = isoOf(balance?.periodEnd)

  if (unlimited) {
    windows.push({
      name: "余额",
      used: 0,
      display: "无限额度",
      unit: currency,
    })
  } else if (hasRemaining) {
    const value = Number(remaining)
    windows.push({
      name: "余额",
      // 没有 total 可以算占比：有余额记 0（可路由），没余额记 100（沉底）。
      used: value > 0 ? 0 : 100,
      display: value > 0 ? `${money(value, currency)} 可用` : "余额已用尽",
      unit: currency,
      ...(resetsAt ? { resetsAt } : {}),
    })
  } else {
    windows.push({
      name: "余额",
      used: 100,
      display: "无可用余额 / 未订阅",
      ...(resetsAt ? { resetsAt } : {}),
    })
  }

  const tokens = tokensText(usage?.tokens)
  if (tokens) {
    windows.push({
      name: "Token",
      used: 0,
      aside: true,
      display: tokens,
      unit: "tokens",
    })
  }

  return {
    plan: unlimited ? "Unlimited" : undefined,
    balance: hasRemaining ? money(Number(remaining), currency) : undefined,
    windows,
  }
}

async function fetchJson(fetchImpl, apiKey, path, signal) {
  const { response, body, text } = await requestJson(fetchImpl, `${API_BASE}${path}`, {
    headers: authHeaders(apiKey),
    signal,
    timeoutMs: 20_000,
  })
  if (!response.ok) {
    if (response.status === 401) {
      throw Object.assign(new Error("Capy API Key 失效"), { status: 401, code: CODES.signInRequired })
    }
    throw Object.assign(
      new Error(String(body?.message ?? `Capy 用量接口失败（HTTP ${response.status}）`)),
      { status: response.status >= 500 ? 503 : response.status, code: "upstream_error", detail: text.slice(0, 200) },
    )
  }
  return body
}

export async function computeUsage({ fetchImpl, apiKey, signal, cacheKey = "" } = {}) {
  const key = cacheKey || String(apiKey).slice(-32)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value
  try {
    const [usage, balance] = await Promise.all([
      fetchJson(fetchImpl, apiKey, "/usage", signal),
      fetchJson(fetchImpl, apiKey, "/usage/balance", signal),
    ])
    const value = buildUsage(usage, balance)
    cache.set(key, { at: Date.now(), value })
    if (cache.size > 64) {
      for (const [oldKey, item] of cache) {
        if (Date.now() - item.at > CACHE_TTL) cache.delete(oldKey)
      }
    }
    return value
  } catch (error) {
    if (isAuthFailure(error) || Number(error?.status) === 401) {
      return { error: "Capy API Key 已失效，请重新登录", windows: [], signIn: "expired" }
    }
    return { error: String(error?.message ?? error), windows: [] }
  }
}

export const _internal = Object.freeze({ money, isoOf, tokensText })
