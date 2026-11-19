// 浏览器 CDP 登录：打开一个临时 Chromium profile，让用户在 Capy 官方页面登录，
// 插件再从 DevTools 协议读取登录态。不复制粘贴 Cookie、不读用户日常浏览器配置。
//
// Capy 的登录态分三层：
//   1. Clerk 页面运行时：window.Clerk.session.id（sess_…）/ window.Clerk.user.id（user_…）；
//   2. Cookie：__client（HttpOnly）——Clerk 客户端 JWT，payload.id 以 client_ 开头；
//   3. 业务组织：api.capy.ai/app/organizations，用 Clerk session token 换 orgId。
// 最后顺手尝试创建一把 magpie-plugin API Key（失败不影响登录）。
//
// 只用临时 profile：既不复用用户日常浏览器的登录态，也不把 magpie 的会话写进那个 profile。
// 依赖 Node 24 自带的 WebSocket / fetch；没有第三方包。

import { execFileSync, spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const CAPY_ORIGIN = "https://capy.ai"
export const CAPY_URL = `${CAPY_ORIGIN}/sign-in`
export const CAPY_API = "https://api.capy.ai"
export const API_KEY_NAME = "magpie-plugin"

const COOKIE_DOMAIN = "capy.ai"
const CLIENT_COOKIE = "__client"
const DEBUG_PORT_FILE = "DevToolsActivePort"
const POLL_MS = 500
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function loginError(code, message) {
  const error = new Error(message)
  error.name = "CapyBrowserLoginError"
  error.code = code
  return error
}

function cancelledError() {
  return loginError("login_cancelled", "Capy 登录已取消。请重新发起登录。")
}

function assertActive(signal, closed) {
  if (closed || signal?.aborted) throw cancelledError()
}

function browserExited(child) {
  return Boolean(child) && (child.exitCode !== null || child.signalCode !== null)
}

// ── 浏览器发现 ────────────────────────────────────────────────────────────────

const WIN_REGISTRY_BROWSERS = [
  "chrome.exe",
  "360ChromeX.exe",
  "360chrome.exe",
  "360se.exe",
  "QQBrowser.exe",
  "brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "SogouExplorer.exe",
  "2345Explorer.exe",
  "liebao.exe",
  "Maxthon.exe",
  "UCBrowser.exe",
  "Quark.exe",
  "msedge.exe",
]

function which(name, env = process.env, platformName = process.platform) {
  const path = String(env.PATH || "")
  const sep = platformName === "win32" ? ";" : ":"
  for (const dir of path.split(sep)) {
    if (!dir) continue
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return ""
}

function registryAppPath(exe) {
  const roots = ["HKCU", "HKLM"]
  const tails = [
    `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ]
  // 用绝对路径，避免 Git Bash PATH 里的 reg 包装吃掉反斜杠。
  const reg = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe")
  for (const root of roots) {
    for (const tail of tails) {
      try {
        const out = execFileSync(reg, ["query", `${root}\\${tail}`, "/ve"], {
          encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        })
        const match = /REG_SZ\s+(.+?)\s*$/m.exec(out)
        const file = match?.[1]?.trim().replace(/^"|"$/g, "")
        if (file && existsSync(file)) return file
      } catch {}
    }
  }
  return ""
}

function winBrowserPaths(env) {
  const local = env.LOCALAPPDATA || ""
  const roaming = env.APPDATA || ""
  const pf = env.PROGRAMFILES || "C:\\Program Files"
  const pf86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
  const under = (root, parts) => (root ? join(root, ...parts) : "")
  return [
    under(pf, ["Google", "Chrome", "Application", "chrome.exe"]),
    under(pf86, ["Google", "Chrome", "Application", "chrome.exe"]),
    under(local, ["Google", "Chrome", "Application", "chrome.exe"]),
    under(local, ["Chromium", "Application", "chrome.exe"]),
    under(pf, ["Chromium", "Application", "chrome.exe"]),
    under(pf86, ["Chromium", "Application", "chrome.exe"]),
    under(pf, ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
    under(local, ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
    under(local, ["Vivaldi", "Application", "vivaldi.exe"]),
    under(local, ["Programs", "Opera", "opera.exe"]),
    under(local, ["360ChromeX", "Chrome", "Application", "360ChromeX.exe"]),
    under(local, ["360Chrome", "Chrome", "Application", "360chrome.exe"]),
    under(pf, ["360Chrome", "Chrome", "Application", "360chrome.exe"]),
    under(roaming, ["secoresdk", "360se6", "Application", "360se.exe"]),
    under(local, ["360se", "Application", "360se.exe"]),
    under(local, ["Tencent", "QQBrowser", "Application", "QQBrowser.exe"]),
    under(pf, ["Tencent", "QQBrowser", "QQBrowser.exe"]),
    under(local, ["SogouExplorer", "SogouExplorer.exe"]),
    under(local, ["2345Explorer", "2345Explorer.exe"]),
    under(local, ["liebao", "liebao.exe"]),
    under(local, ["UCBrowser", "Application", "UCBrowser.exe"]),
    under(local, ["Quark", "Quark.exe"]),
    under(pf86, ["Microsoft", "Edge", "Application", "msedge.exe"]),
    under(pf, ["Microsoft", "Edge", "Application", "msedge.exe"]),
  ].filter(Boolean)
}

export function browserCandidates(platformName = process.platform, env = process.env, lookup = registryAppPath) {
  const candidates = []
  const override = String(env.MAGPIE_CAPY_BROWSER || "").trim().replace(/^"|"$/g, "")
  if (override) candidates.push(override)
  if (platformName === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    )
  } else if (platformName === "win32") {
    candidates.push(...winBrowserPaths(env))
    for (const exe of WIN_REGISTRY_BROWSERS) {
      const found = lookup(exe)
      if (found) candidates.push(found)
    }
  } else {
    for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      const found = which(name, env, platformName)
      if (found) candidates.push(found)
    }
  }
  return [...new Set(candidates)]
}

/** 先查常见安装路径（快），都没有再翻注册表。 */
export function findBrowser() {
  const plain = browserCandidates(process.platform, process.env, () => "")
  const hit = plain.find((file) => existsSync(file))
  if (hit) return hit
  if (process.platform === "win32") {
    for (const exe of WIN_REGISTRY_BROWSERS) {
      const found = registryAppPath(exe)
      if (found) return found
    }
  }
  return ""
}

// ── 纯函数（方便测试） ────────────────────────────────────────────────────────

/** 从 DevToolsActivePort 文本里读端口；无效返回 0。 */
export function parseDevToolsPort(raw) {
  const first = String(raw ?? "").replace(/^\uFEFF/u, "").split(/\r?\n/u)[0].trim()
  if (!/^\d+$/u.test(first)) return 0
  const port = Number(first)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0
}

function normalizeCookieValue(value) {
  if (typeof value !== "string") return ""
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).trim()
  return text
}

function normalizeDomain(domain) {
  return String(domain ?? "").replace(/^\./u, "").trim().toLowerCase()
}

function cookieDomainMatches(domain, expected = COOKIE_DOMAIN) {
  const host = normalizeDomain(domain)
  return host === expected || host.endsWith(`.${expected}`)
}

/**
 * 从 CDP cookie 列表里找指定名字的 cookie。
 * domain 先认 capy.ai / .capy.ai；子域（如 clerk.capy.ai）作为兜底。
 */
export function findCookie(cookies, name, domain = COOKIE_DOMAIN) {
  const list = Array.isArray(cookies) ? cookies : []
  const wanted = String(name ?? "")
  let subdomainValue = ""
  for (const cookie of list) {
    if (!cookie || String(cookie.name ?? "") !== wanted) continue
    const value = normalizeCookieValue(cookie.value)
    if (!value) continue
    if (!cookieDomainMatches(cookie.domain, domain)) continue
    const host = normalizeDomain(cookie.domain)
    if (host === domain) return value
    if (!subdomainValue) subdomainValue = value
  }
  return subdomainValue
}

function decodeBase64UrlJson(segment) {
  if (!segment) return null
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
    const value = JSON.parse(Buffer.from(padded, "base64").toString("utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function jwtPayload(value) {
  if (typeof value !== "string") return null
  const parts = value.trim().split(".")
  if (parts.length !== 3) return null
  return decodeBase64UrlJson(parts[1])
}

/** Clerk 客户端 JWT：三段式，payload.id 以 client_ 开头。 */
export function isClientJwt(value) {
  const payload = jwtPayload(value)
  return Boolean(payload && typeof payload.id === "string" && payload.id.startsWith("client_"))
}

/** 在 cookie 列表里挑第一把合法的 __client JWT（优先 capy.ai 顶级域）。 */
export function findClientJwt(cookies, name = CLIENT_COOKIE, domain = COOKIE_DOMAIN) {
  const list = Array.isArray(cookies) ? cookies : []
  const wanted = String(name ?? "")
  const apex = []
  const subdomain = []
  for (const cookie of list) {
    if (!cookie || String(cookie.name ?? "") !== wanted) continue
    const value = normalizeCookieValue(cookie.value)
    if (!value || !isClientJwt(value)) continue
    if (!cookieDomainMatches(cookie.domain, domain)) continue
    const host = normalizeDomain(cookie.domain)
    if (host === domain) apex.push(value)
    else subdomain.push(value)
  }
  return apex[0] || subdomain[0] || ""
}

function normalizeStoredOrg(value) {
  if (typeof value !== "string") {
    if (value && typeof value === "object") {
      const id = value.id ?? value.orgId ?? value.organizationId ?? value.selectedOrgId
      return typeof id === "string" ? id.trim() : ""
    }
    return ""
  }
  const raw = value.trim()
  if (!raw) return ""
  if (raw.startsWith("{") || raw.startsWith("[") || raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === "string") return parsed.trim()
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const id = parsed.id ?? parsed.orgId ?? parsed.organizationId ?? parsed.selectedOrgId
        return typeof id === "string" ? id.trim() : ""
      }
    } catch {}
  }
  return raw
}

/**
 * 从组织列表里选 orgId：优先 localStorage 里选中的组织，其次第一项。
 * @param {Array<string|{id?:string}>} orgIds
 * @param {unknown[]|unknown} stored localStorage 里的值（按优先级）
 */
export function pickOrg(orgIds, stored = []) {
  const ids = []
  for (const item of Array.isArray(orgIds) ? orgIds : []) {
    const id = typeof item === "string" ? item : item?.id
    const text = String(id ?? "").trim()
    if (text && !ids.includes(text)) ids.push(text)
  }
  if (ids.length === 0) return ""
  for (const hint of Array.isArray(stored) ? stored : [stored]) {
    const id = normalizeStoredOrg(hint)
    if (id && ids.includes(id)) return id
  }
  return ids[0]
}

/** 页面上可能同时有多个 page target；优先 capy.ai/app，其次 capy.ai，再次普通页面。 */
export function pickPageTarget(targets) {
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => (
    target && target.type === "page" && typeof target.webSocketDebuggerUrl === "string" && target.webSocketDebuggerUrl
  ))
  if (pages.length === 0) return null
  const rank = (target) => {
    let hostname = ""
    let pathname = ""
    try {
      const parsed = new URL(String(target.url || ""))
      hostname = parsed.hostname.toLowerCase()
      pathname = parsed.pathname
    } catch {}
    if (hostname === COOKIE_DOMAIN || hostname.endsWith(`.${COOKIE_DOMAIN}`)) {
      return pathname.startsWith("/app") ? 0 : 1
    }
    return hostname ? 2 : 3
  }
  let best = pages[0]
  let bestRank = rank(best)
  for (let index = 1; index < pages.length; index += 1) {
    const currentRank = rank(pages[index])
    if (currentRank < bestRank) {
      best = pages[index]
      bestRank = currentRank
    }
  }
  return best
}

export function browserArgs(profile, port = 0, url = CAPY_URL) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    // 关掉 AutomationControlled 的 Blink 特性，降低 Clerk 风控把窗口判成自动化的概率。
    "--disable-blink-features=AutomationControlled",
    url,
  ]
}

// ── CDP ──────────────────────────────────────────────────────────────────────

function cdpConnect(url) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(loginError("browser_launch_failed", "当前 Node 运行时不支持 WebSocket（需要 Node 22 及以上）"))
      return
    }
    let socket = null
    try {
      socket = new WebSocket(url)
    } catch {
      reject(loginError("browser_launch_failed", "连不上浏览器的调试端口"))
      return
    }
    const pending = new Map()
    let next = 1
    let opened = false
    let closed = false
    const failAll = (error) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer)
        waiter.rej(error)
      }
      pending.clear()
    }
    const openTimer = setTimeout(() => {
      if (opened) return
      closed = true
      try { socket.close() } catch {}
      reject(loginError("browser_launch_failed", "连不上浏览器的调试端口"))
    }, 10_000)
    socket.onopen = () => {
      clearTimeout(openTimer)
      if (closed) {
        try { socket.close() } catch {}
        return
      }
      opened = true
      resolve({
        send(method, params = {}) {
          if (closed) return Promise.reject(new Error("浏览器调试连接已关闭"))
          const id = next++
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id)
              rej(new Error(`浏览器调试命令超时：${method}`))
            }, 10_000)
            pending.set(id, {
              res: (value) => { clearTimeout(timer); res(value) },
              rej: (error) => { clearTimeout(timer); rej(error) },
            })
            try {
              socket.send(JSON.stringify({ id, method, params }))
            } catch (error) {
              pending.delete(id)
              clearTimeout(timer)
              rej(error)
            }
          })
        },
        close() {
          closed = true
          try { socket.close() } catch {}
        },
      })
    }
    socket.onmessage = (event) => {
      let message = null
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data))
      } catch {
        return
      }
      if (!message || !message.id) return
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.rej(new Error(message.error.message || "浏览器调试命令失败"))
      else waiter.res(message.result)
    }
    socket.onerror = () => {
      clearTimeout(openTimer)
      const error = new Error("连不上浏览器的调试端口")
      if (!opened) {
        closed = true
        reject(error)
      }
      failAll(error)
    }
    socket.onclose = () => {
      clearTimeout(openTimer)
      const error = new Error("浏览器调试连接已关闭")
      if (!opened) {
        closed = true
        reject(error)
      }
      failAll(error)
    }
  })
}

async function cdpJson(port, pathname, timeoutMs = 3000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function browserClient(port) {
  const info = await cdpJson(port, "/json/version", 3000)
  if (!info?.webSocketDebuggerUrl) return null
  return cdpConnect(info.webSocketDebuggerUrl)
}

async function pageClient(port) {
  const targets = await cdpJson(port, "/json/list", 3000)
  const target = pickPageTarget(targets)
  if (!target?.webSocketDebuggerUrl) return null
  return cdpConnect(target.webSocketDebuggerUrl)
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result?.exceptionDetails) return undefined
  return result?.result?.value
}

function parseJsonValue(value) {
  if (value && typeof value === "object") return value
  if (typeof value !== "string" || !value) return null
  try { return JSON.parse(value) } catch { return null }
}

async function collectCookies(client, sink) {
  try { await client.send("Network.enable") } catch {}
  try {
    const result = await client.send("Network.getAllCookies")
    for (const cookie of Array.isArray(result?.cookies) ? result.cookies : []) sink.push(cookie)
  } catch {}
  if (!findClientJwt(sink)) {
    try {
      const result = await client.send("Storage.getCookies")
      for (const cookie of Array.isArray(result?.cookies) ? result.cookies : []) sink.push(cookie)
    } catch {}
  }
}

/** 读 __client JWT：先页面会话的 Network.getAllCookies，再浏览器级 Storage.getCookies。 */
async function readClientJwt(port, page) {
  const cookies = []
  if (page) await collectCookies(page, cookies)
  let jwt = findClientJwt(cookies)
  if (jwt) return jwt
  let browser = null
  try {
    browser = await browserClient(port)
    if (!browser) return ""
    await collectCookies(browser, cookies)
    return findClientJwt(cookies)
  } catch {
    return findClientJwt(cookies)
  } finally {
    browser?.close()
  }
}

// ── 页面内取证 ────────────────────────────────────────────────────────────────

const CLERK_STATE_EXPRESSION = `(() => {
  try {
    const clerk = window.Clerk
    if (!clerk || !clerk.session || !clerk.user) return JSON.stringify({ ready: false })
    const sessionId = typeof clerk.session.id === "string" ? clerk.session.id : ""
    const userId = typeof clerk.user.id === "string" ? clerk.user.id : ""
    const email = clerk.user.primaryEmailAddress && clerk.user.primaryEmailAddress.emailAddress
    const username = clerk.user.username
    const accountId = (typeof email === "string" && email)
      ? email
      : (typeof username === "string" ? username : "")
    return JSON.stringify({ ready: Boolean(sessionId && userId), sessionId, userId, accountId })
  } catch (error) {
    return JSON.stringify({ ready: false })
  }
})()`

async function readClerkState(client) {
  const value = parseJsonValue(await evaluate(client, CLERK_STATE_EXPRESSION))
  if (!value || value.ready !== true) return null
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : ""
  const userId = typeof value.userId === "string" ? value.userId : ""
  if (!sessionId || !userId) return null
  return {
    sessionId,
    userId,
    accountId: typeof value.accountId === "string" ? value.accountId : "",
  }
}

function organizationsExpression() {
  return `(async () => {
    try {
      const clerk = window.Clerk
      if (!clerk || !clerk.session || typeof clerk.session.getToken !== "function") {
        return JSON.stringify({ ok: false, status: 0, ids: [], error: "Clerk session 不可用" })
      }
      const token = await clerk.session.getToken()
      if (!token) return JSON.stringify({ ok: false, status: 0, ids: [], error: "Clerk token 不可用" })
      const response = await fetch(${JSON.stringify(`${CAPY_API}/app/organizations`)}, {
        headers: { authorization: "Bearer " + token },
        credentials: "include",
      })
      const text = await response.text()
      let data = null
      try { data = JSON.parse(text) } catch {}
      const list = Array.isArray(data)
        ? data
        : (data && Array.isArray(data.organizations) ? data.organizations : [])
      const ids = list
        .map((item) => (typeof item === "string" ? item : (item && typeof item.id === "string" ? item.id : "")))
        .filter(Boolean)
      let selected = null
      let last = null
      try {
        selected = localStorage.getItem("capy-web:selected-org")
        last = localStorage.getItem("capy-web:last-selected-org")
      } catch (error) {}
      return JSON.stringify({
        ok: response.ok,
        status: response.status,
        ids,
        selected,
        last,
        error: response.ok ? "" : "HTTP " + response.status,
      })
    } catch (error) {
      return JSON.stringify({ ok: false, status: 0, ids: [], error: String(error && error.message ? error.message : error) })
    }
  })()`
}

async function readOrganizations(client) {
  return parseJsonValue(await evaluate(client, organizationsExpression()))
}

function mintApiKeyExpression(orgId) {
  const endpoint = `${CAPY_API}/app/orgs/${encodeURIComponent(orgId)}/api-keys`
  return `(async () => {
    try {
      const clerk = window.Clerk
      if (!clerk || !clerk.session || typeof clerk.session.getToken !== "function") {
        return JSON.stringify({ ok: false, status: 0, error: "Clerk session 不可用" })
      }
      const token = await clerk.session.getToken()
      if (!token) return JSON.stringify({ ok: false, status: 0, error: "Clerk token 不可用" })
      const response = await fetch(${JSON.stringify(endpoint)}, {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: ${JSON.stringify(API_KEY_NAME)} }),
      })
      const text = await response.text()
      let data = null
      try { data = JSON.parse(text) } catch {}
      const plaintext = data && typeof data.plaintext === "string" ? data.plaintext : ""
      return JSON.stringify({
        ok: response.ok && Boolean(plaintext),
        status: response.status,
        plaintext: response.ok ? plaintext : "",
        error: response.ok
          ? (plaintext ? "" : "响应里没有 plaintext")
          : "HTTP " + response.status,
      })
    } catch (error) {
      return JSON.stringify({ ok: false, status: 0, error: String(error && error.message ? error.message : error) })
    }
  })()`
}

async function mintApiKeyForOrg(client, orgId) {
  return parseJsonValue(await evaluate(client, mintApiKeyExpression(orgId)))
}

function apiKeyFailureText(info) {
  const status = Number(info?.status) || 0
  if (status === 401 || status === 403) {
    return `没有权限创建 API Key（HTTP ${status}），已改用浏览器会话登录态`
  }
  if (status) return `创建 API Key 失败（HTTP ${status}），已改用浏览器会话登录态`
  return "创建 API Key 失败，已改用浏览器会话登录态"
}

// ── 浏览器启动 ────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error("拿不到空闲端口"))))
    })
  })
}

async function waitForDevToolsPort(profile, timeoutMs, assertAlive) {
  const file = join(profile, DEBUG_PORT_FILE)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!assertAlive()) return 0
    if (existsSync(file)) {
      try {
        const port = parseDevToolsPort(readFileSync(file, "utf8"))
        if (port) return port
      } catch {}
    }
    await sleep(150)
  }
  return 0
}

async function waitForCdp(port, timeoutMs, assertAlive) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!assertAlive()) return false
    const info = await cdpJson(port, "/json/version", 1500)
    if (info?.webSocketDebuggerUrl) return true
    await sleep(200)
  }
  return false
}

async function launchChild(exe, profile, port, { mode, signal, isClosed }) {
  const child = spawn(exe, browserArgs(profile, port), { stdio: "ignore", windowsHide: false })
  let spawnFailure = null
  let exitedAt = 0
  child.once("error", (error) => { spawnFailure = error })
  const assertAlive = () => {
    assertActive(signal, isClosed())
    if (spawnFailure) {
      const reason = spawnFailure.code || spawnFailure.message || "未知错误"
      throw loginError(
        "browser_launch_failed",
        `浏览器启动失败（${exe}）：${reason}。请检查 MAGPIE_CAPY_BROWSER，或安装 Chrome / Edge 后重试。`,
      )
    }
    if (browserExited(child)) {
      // 有些国产浏览器会先退出启动器、再由真实进程接管；给 3 秒交接时间。
      if (!exitedAt) exitedAt = Date.now()
      if (Date.now() - exitedAt > 3000) return false
    } else {
      exitedAt = 0
    }
    return true
  }
  let keep = false
  try {
    if (mode === "auto") {
      const detected = await waitForDevToolsPort(profile, 15_000, assertAlive)
      if (!detected) return null
      if (!(await waitForCdp(detected, 10_000, assertAlive))) return null
      keep = true
      return { child, port: detected, profile }
    }
    if (!(await waitForCdp(port, 15_000, assertAlive))) return null
    keep = true
    return { child, port, profile }
  } finally {
    if (!keep) {
      try { child.kill("SIGTERM") } catch {}
    }
  }
}

async function launchBrowser(exe, profiles, { signal, isClosed }) {
  // 首选 --remote-debugging-port=0，端口由浏览器自己挑，从 DevToolsActivePort 读。
  const autoProfile = mkdtempSync(join(tmpdir(), "magpie-capy-"))
  profiles.push(autoProfile)
  const auto = await launchChild(exe, autoProfile, 0, { mode: "auto", signal, isClosed })
  if (auto) return auto

  // 浏览器吞掉了 0 端口（或策略不允许）时，退回固定空闲端口并重试。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertActive(signal, isClosed())
    const profile = mkdtempSync(join(tmpdir(), "magpie-capy-"))
    profiles.push(profile)
    let port = 0
    try { port = await freePort() } catch { continue }
    const fixed = await launchChild(exe, profile, port, { mode: "fixed", signal, isClosed })
    if (fixed) return fixed
  }
  throw loginError(
    "browser_launch_failed",
    "浏览器没有打开调试端口。请用 Chrome / Edge 重试，或设置 MAGPIE_CAPY_BROWSER 指向浏览器 exe。",
  )
}

function scheduleProfileCleanup(profile) {
  if (!profile) return
  const cleanup = (attempt = 0) => {
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch (error) {
      if (attempt < 2) setTimeout(() => cleanup(attempt + 1), 800).unref?.()
      else console.warn(`[magpie-capy] 临时浏览器 profile 清理失败（已重试 3 次）：${error.message}`)
    }
  }
  setTimeout(() => cleanup(), 1500).unref?.()
}

function formatWait(ms) {
  if (ms >= 60_000) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`
  return `${Math.max(1, Math.round(ms / 1000))} 秒`
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

/**
 * 打开临时 Chromium 浏览器，等用户登录 Capy，然后从 CDP 读登录态。
 *
 * @param {object} [options]
 * @param {string} [options.browser] 浏览器 exe；默认自动发现，也可用 MAGPIE_CAPY_BROWSER。
 * @param {string} [options.url] 登录起始页，默认 https://capy.ai/app。
 * @param {number} [options.timeoutMs] 等待登录的时长，默认 5 分钟。
 * @param {AbortSignal} [options.signal] 取消登录；取消后会杀掉浏览器并清理临时 profile。
 * @param {boolean} [options.mintApiKey] 登录成功后是否尝试创建 magpie-plugin API Key，默认 true。
 * @param {(session: { close: () => void, browser: string, port: number, profile: string }) => void} [options.onLaunch]
 *   浏览器启动后回调；调用 session.close() 等价于取消登录。
 * @returns {Promise<{
 *   clientJwt: string, sessionId: string, userId: string, accountId: string, orgId: string,
 *   apiKey?: string, apiKeyError?: string, orgError?: string, source: "capy-browser"
 * }>}
 */
export async function chromiumLogin({
  browser,
  url = CAPY_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  mintApiKey = true,
  onLaunch,
} = {}) {
  const exe = browser || findBrowser()
  if (!exe) {
    throw loginError(
      "browser_not_found",
      "没有找到 Chromium 内核浏览器（Chrome / Edge / 360极速 / QQ 等）。请安装 Chrome 或 Edge，或设置 MAGPIE_CAPY_BROWSER 指向浏览器 exe。",
    )
  }
  assertActive(signal, false)

  const profiles = []
  let session = null
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try { session?.child.kill("SIGTERM") } catch {}
  }

  try {
    session = await launchBrowser(exe, profiles, { signal, isClosed: () => closed })
    if (typeof onLaunch === "function") {
      onLaunch({ close, browser: exe, port: session.port, profile: session.profile })
    }

    const wait = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
    const deadline = Date.now() + wait
    let sawSignedIn = false
    let sawCookiesProblem = false
    let deadPolls = 0

    while (Date.now() < deadline) {
      assertActive(signal, closed)
      let page = null
      try {
        page = await pageClient(session.port)
        if (!page) {
          // 用户可能直接关掉了窗口；连续几次都没有页面且进程已退出，就别干等到超时。
          deadPolls = browserExited(session.child) ? deadPolls + 1 : 0
          if (deadPolls >= 10) {
            throw loginError("login_cancelled", "Capy 登录浏览器已关闭，请重新发起登录。")
          }
        } else {
          deadPolls = 0
          const state = await readClerkState(page)
          if (state) {
            sawSignedIn = true
            const clientJwt = await readClientJwt(session.port, page)
            if (!clientJwt) {
              sawCookiesProblem = true
            } else {
              let orgInfo = null
              try { orgInfo = await readOrganizations(page) } catch {}
              const orgId = pickOrg(orgInfo?.ids, [orgInfo?.selected, orgInfo?.last])
              const result = {
                clientJwt,
                sessionId: state.sessionId,
                userId: state.userId,
                accountId: state.accountId,
                orgId,
                source: "capy-browser",
              }
              if (!orgId) {
                result.orgError = "没有读到 Capy 组织（/app/organizations 为空，设备凭据里也没有）"
              } else if (mintApiKey) {
                let minted = null
                try {
                  minted = await mintApiKeyForOrg(page, orgId)
                } catch {
                  minted = null
                }
                if (minted?.ok && typeof minted.plaintext === "string" && minted.plaintext) {
                  result.apiKey = minted.plaintext
                } else {
                  result.apiKeyError = apiKeyFailureText(minted)
                }
              }
              return result
            }
          }
        }
      } catch (error) {
        if (signal?.aborted || closed) throw cancelledError()
        if (error?.code === "login_cancelled") throw error
        // 页面还在加载、CDP 短暂断开等：下一轮再试。
      } finally {
        page?.close()
      }
      await sleep(POLL_MS)
      assertActive(signal, closed)
    }

    assertActive(signal, closed)
    if (sawSignedIn || sawCookiesProblem) {
      throw loginError(
        "cookies_unreadable",
        "已在 Capy 登录，但读不到 __client 登录 Cookie。请让浏览器停留在 capy.ai 页面后重试；如果反复失败，请改用 API Key 登录。",
      )
    }
    throw loginError(
      "login_timeout",
      `等待 Capy 登录超时（${formatWait(wait)}）。请重新发起登录，并在打开的浏览器窗口里完成登录。`,
    )
  } finally {
    try { session?.child.kill("SIGTERM") } catch {}
    for (const profile of profiles) scheduleProfileCleanup(profile)
  }
}

export const _internal = {
  CAPY_ORIGIN,
  CAPY_URL,
  CAPY_API,
  API_KEY_NAME,
  WIN_REGISTRY_BROWSERS,
  browserCandidates,
  findBrowser,
  parseDevToolsPort,
  findCookie,
  findClientJwt,
  isClientJwt,
  pickOrg,
  pickPageTarget,
  browserArgs,
  normalizeCookieValue,
  normalizeStoredOrg,
  cookieDomainMatches,
  jwtPayload,
  loginError,
  cancelledError,
}
