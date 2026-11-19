// 代理支持：Capy 的地区限制按「出口 IP」判，不按请求头判。
//
// 浏览器和 Capy 桌面端会自动走 Windows 系统代理，但 Node/Bun 的 fetch 不会。
// 插件必须自己把代理显式传给 fetch：
//   · Bun 1.1+：fetch(url, { proxy: "http://127.0.0.1:7890" })   ← magpie 运行时
//   · Node 18+：undici.ProxyAgent 作为 dispatcher（如果宿主装了 undici）
//   · 都没有：直连，并给出一次警告（不是静默失败）
//
// 代理地址优先级：
//   options.proxy（显式）> MAGPIE_CAPY_PROXY > HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
//   > Windows「Internet 选项」里的系统代理。
//
// 不读 PAC（AutoConfigURL）：PAC 是 JS 脚本，静态解析不可靠；需要 PAC 的用户
// 直接把代理地址写进 MAGPIE_CAPY_PROXY。

import { execFileSync } from "node:child_process"

const REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
const PROXY_KEYS = [
  "MAGPIE_CAPY_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
]
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"])

let cachedSystemProxy = { at: 0, value: "" }
const SYSTEM_PROXY_TTL_MS = 60_000

function regQuery(name) {
  const reg = process.platform === "win32"
    ? `${process.env.SystemRoot || "C:\\Windows"}\\System32\\reg.exe`
    : ""
  if (!reg) return ""
  try {
    const out = execFileSync(reg, ["query", REG_PATH, "/v", name], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const match = new RegExp(`${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "imu").exec(out)
    return match?.[1]?.trim() ?? ""
  } catch {
    return ""
  }
}

export function normalizeProxyUrl(raw) {
  let text = String(raw ?? "").trim().replace(/^"|"$/g, "")
  if (!text) return ""
  if (text === "off" || text === "false" || text === "none") return ""
  // 系统代理常见写法：http=127.0.0.1:7890;https=127.0.0.1:7890
  if (/^[a-z]+=/iu.test(text) && text.includes(";")) {
    const map = {}
    for (const part of text.split(";")) {
      const [key, value] = part.split("=")
      if (key && value) map[key.trim().toLowerCase()] = value.trim()
    }
    text = map.https || map.http || ""
  }
  if (!text) return ""
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) text = `http://${text}`
  try {
    const url = new URL(text)
    if (!url.hostname) return ""
    return url.toString().replace(/\/$/u, "")
  } catch {
    return ""
  }
}

function systemProxy() {
  if (process.platform !== "win32") return ""
  if (Date.now() - cachedSystemProxy.at < SYSTEM_PROXY_TTL_MS) return cachedSystemProxy.value
  const enabled = regQuery("ProxyEnable").toLowerCase()
  const server = regQuery("ProxyServer")
  const value = /0x0*1\b|^1$/iu.test(enabled) || (!enabled && server) ? normalizeProxyUrl(server) : ""
  cachedSystemProxy = { at: Date.now(), value }
  return value
}

function hostMatchesNoProxy(host, noProxy) {
  const rules = String(noProxy ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
  if (!rules.length) return false
  const plain = String(host ?? "").toLowerCase()
  for (const rule of rules) {
    if (rule === "*") return true
    const value = rule.replace(/^\./u, "")
    if (plain === value || plain.endsWith(`.${value}`)) return true
  }
  return false
}

/**
 * 解析代理地址。
 * @param {object} [options]
 * @param {string|false} [options.proxy] 显式代理；false 关闭自动探测。
 * @param {object} [options.env]
 * @returns {string} 形如 http://127.0.0.1:7890；没有代理时返回 ""
 */
export function resolveProxyUrl({ proxy, env = process.env } = {}) {
  if (proxy === false) return ""
  if (typeof proxy === "string" && proxy.trim()) return normalizeProxyUrl(proxy)
  for (const key of PROXY_KEYS) {
    const value = normalizeProxyUrl(env?.[key])
    if (value) return value
  }
  return systemProxy()
}

/**
 * 给 fetch 套上代理。
 * Bun 用 fetch 的 proxy 选项；Node 尝试 undici.ProxyAgent；都不行就直连并警告一次。
 *
 * @param {typeof fetch} baseFetch
 * @param {string} proxyUrl
 * @param {{ onWarn?: (message: string) => void }} [options]
 * @returns {typeof fetch}
 */
export function createProxyFetch(baseFetch, proxyUrl, { onWarn } = {}) {
  const base = typeof baseFetch === "function" ? baseFetch : fetch
  const url = normalizeProxyUrl(proxyUrl)
  if (!url) return base

  let undiciAgent = null
  let undiciTried = false
  let warned = false
  const warn = (message) => {
    if (warned) return
    warned = true
    try { onWarn?.(message) } catch {}
  }
  const proxyConnectionError = (error) => (
    /ECONNREFUSED|ConnectionRefused|Unable to connect|proxy connect|proxy server/iu.test(
      String(error?.message ?? error),
    )
  )

  return async function proxyFetch(input, init = {}) {
    const target = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input?.url ?? "")
    let targetHost = ""
    try { targetHost = new URL(target).hostname } catch {}
    if (targetHost && (LOCAL_HOSTS.has(targetHost) || hostMatchesNoProxy(targetHost, process.env.NO_PROXY || process.env.no_proxy))) {
      return base(input, init)
    }

    // Bun：原生支持 fetch({ proxy })，这是 magpie 实际运行时走的路径。
    if (typeof Bun !== "undefined") {
      try {
        return await base(input, { ...init, proxy: url })
      } catch (error) {
        if (proxyConnectionError(error)) {
          warn(`代理 ${url} 连接失败，本次直连`)
          return base(input, init)
        }
        // 宿主包装过的 fetch 可能不认识 proxy；退回全局 fetch。
        try {
          return await fetch(input, { ...init, proxy: url })
        } catch (inner) {
          if (proxyConnectionError(inner)) {
            warn(`代理 ${url} 连接失败，本次直连`)
            return base(input, init)
          }
          throw error
        }
      }
    }

    // Node：undici.ProxyAgent 作为 dispatcher。
    if (!undiciTried) {
      undiciTried = true
      try {
        const undici = await import("undici")
        if (typeof undici?.ProxyAgent === "function") {
          undiciAgent = new undici.ProxyAgent(url)
        }
      } catch {}
    }
    if (undiciAgent) {
      try {
        return await base(input, { ...init, dispatcher: undiciAgent })
      } catch (error) {
        // 有些 fetch 实现不认 dispatcher；再试一次显式 proxy 字段。
        try {
          return await base(input, { ...init, proxy: url })
        } catch {
          throw error
        }
      }
    }

    warn(
      `检测到代理 ${url}，但当前 Node 运行时不支持 fetch 代理（未安装 undici）。`
      + "请改用 magpie 自带 Bun 运行时，或设置 NODE_OPTIONS=--use-env-proxy 后重启。",
    )
    return base(input, init)
  }
}

export function clearProxyCache() {
  cachedSystemProxy = { at: 0, value: "" }
}

export const _internal = Object.freeze({
  REG_PATH,
  PROXY_KEYS,
  normalizeProxyUrl,
  systemProxy,
  hostMatchesNoProxy,
  regQuery,
})
