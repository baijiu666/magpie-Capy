// 无头设备：不启动 Capy 桌面端，也不读 Capy 桌面端的任何文件。
//
// 登录只用 Clerk 会话。首次使用时自动走 Capy 的设备码配对：
//   POST /app/devices/code                  {hostname, os, arch} → userCode/deviceCode
//   POST /app/orgs/{org}/devices/code/approve {userCode, name}   → approved
//   POST /app/devices/code/poll             {deviceCode}         → enrolled {device.id, token:"capyd_…"}
//
// 然后连 device tunnel：
//   wss://device-tunnel-production.cloud.capy.ai/tunnel
//   Authorization: Bearer <capyd_…>
//   hello → session-config → workspaces-changed → ready
//
// 服务端随后在同一 WebSocket 上发 machine server 的 HTTP-over-WS 请求：
//   open {streamId, kind:"invoke", method, path, headers}
//   binary {streamId(4B BE) + body}
//   close {streamId}
// 设备回 response + binary body + close。
//
// 本实现只做最小 machine server：
//   worktree_list / worktree_ensure / volume_landed / volume_probe / git capture
// 终端/浏览器/写文件等工具快速返回 Unavailable。适合纯文本/图片对话。

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { APP_BASE } from "./constants.mjs"
import { CODES, fromUpstream, upstreamError } from "./errors.mjs"
import { requestJson, sleep } from "./http.mjs"

export const TUNNEL_URL = "wss://device-tunnel-production.cloud.capy.ai/tunnel"
export const CONTRACT_VERSION = 2
export const HEADLESS_NAME = "magpie-headless"

const READY_TIMEOUT_MS = 15_000
const CONNECT_POLL_MS = 400
const STATE_VERSION = 1
const DPAPI_TIMEOUT_MS = 15_000

function stateDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
  return path.join(base, "magpie-capy")
}
function stateFile() {
  return path.join(stateDir(), "headless-device.json")
}

function powershell(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: DPAPI_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
  ).trim()
}

export function dpapiProtect(text) {
  if (process.platform !== "win32") throw new Error("DPAPI 只在 Windows 可用")
  const encoded = Buffer.from(String(text), "utf8").toString("base64")
  const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String('${encoded}')
$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($p)`
  return powershell(script)
}

export function dpapiUnprotect(base64) {
  if (process.platform !== "win32") throw new Error("DPAPI 只在 Windows 可用")
  const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String('${String(base64)}')
$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($p)`
  const out = powershell(script)
  return Buffer.from(out, "base64").toString("utf8")
}

export function loadHeadlessState() {
  try {
    const doc = JSON.parse(fs.readFileSync(stateFile(), "utf8"))
    if (doc?.version !== STATE_VERSION || !doc?.orgId || !doc?.deviceId || !doc?.tokenCiphertext) return null
    const token = dpapiUnprotect(doc.tokenCiphertext)
    if (!token.startsWith("capyd_")) return null
    return { orgId: String(doc.orgId), deviceId: String(doc.deviceId), name: String(doc.name || HEADLESS_NAME), token }
  } catch {
    return null
  }
}

export function saveHeadlessState(credential) {
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = stateFile()
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({
    version: STATE_VERSION,
    orgId: credential.orgId,
    deviceId: credential.deviceId,
    name: credential.name || HEADLESS_NAME,
    tokenCiphertext: dpapiProtect(credential.token),
  }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function codeHeaders(jwt, clientId = "") {
  return {
    authorization: `Bearer ${jwt}`,
    origin: "https://capy.ai",
    referer: "https://capy.ai/",
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Capy/0.9.2 Chrome/140.0.0.0 Electron/45.2.3 Safari/537.36",
    "x-capy-client-surface": "desktop",
    "x-capy-client-features": "message-edit,visual",
    "x-capy-client-timezone": (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } catch { return "UTC" }
    })(),
    ...(clientId ? { "x-capy-client-id": clientId } : {}),
  }
}

async function appPost(fetchImpl, pathName, jwt, payload, { clientId = "", signal } = {}) {
  const { response, body, text } = await requestJson(fetchImpl, `${APP_BASE}${pathName}`, {
    method: "POST",
    headers: codeHeaders(jwt, clientId),
    body: JSON.stringify(payload),
    signal,
    timeoutMs: 30_000,
  })
  if (!response.ok) throw fromUpstream(response.status, body, text.slice(0, 300))
  return { body, response }
}

/**
 * 用浏览器登录的 Clerk 会话自动注册一台无头设备。
 * 不需要 Capy 桌面端，也不需要 device-credentials.json。
 */
export async function pairHeadlessDevice(fetchImpl, {
  jwt,
  orgId,
  clientId = "",
  name = HEADLESS_NAME,
  persist = true,
  signal,
} = {}) {
  if (!jwt || !orgId) throw upstreamError("无头设备配对缺少 Clerk 会话或 orgId", 401, { code: CODES.signInRequired })
  if (process.platform !== "win32") {
    throw upstreamError("无头设备目前只支持 Windows（设备 token 用 DPAPI 保存）", 400, { code: CODES.invalidRequest })
  }
  const arch = process.arch === "arm64" ? "arm64" : "x86_64"
  const start = await appPost(fetchImpl, "/devices/code", jwt, {
    hostname: os.hostname(),
    os: "win32",
    arch,
  }, { clientId, signal })
  const userCode = String(start.body?.userCode || "").trim()
  const deviceCode = String(start.body?.deviceCode || "").trim()
  const interval = Math.max(1, Number(start.body?.pollIntervalSeconds) || 5)
  if (!userCode || !deviceCode) {
    throw upstreamError("Capy 设备码接口没有返回 userCode/deviceCode", 502, { code: "upstream_error" })
  }
  const approve = await appPost(
    fetchImpl,
    `/orgs/${encodeURIComponent(orgId)}/devices/code/approve`,
    jwt,
    { userCode, name },
    { clientId, signal },
  ).catch((error) => {
    const verify = String(start.body?.verificationUrl || "").trim()
    throw upstreamError(
      `Capy 设备码自动批准失败：${String(error?.message ?? error)}`
      + (verify ? `。请在浏览器打开 ${verify} 手动批准后重试。` : ""),
      403,
      { code: "device_pair_failed" },
    )
  })
  if (String(approve.body?.status || "") !== "approved") {
    throw upstreamError("Capy 设备码没有被批准", 403, { code: "device_pair_failed" })
  }

  for (let i = 0; i < 10; i += 1) {
    const poll = await appPost(fetchImpl, "/devices/code/poll", jwt, { deviceCode }, { clientId, signal })
    const status = String(poll.body?.status || "")
    if (status === "approved") {
      const enrolled = poll.body?.enrolled
      const deviceId = String(enrolled?.device?.id || "").trim()
      const token = String(enrolled?.token || "").trim()
      if (!deviceId || !token.startsWith("capyd_")) {
        throw upstreamError("Capy 设备码批准了，但没有返回 deviceId/token", 502, { code: "upstream_error" })
      }
      const credential = {
        orgId: String(enrolled.orgId || orgId),
        deviceId,
        name: String(enrolled.device?.name || name),
        token,
      }
      if (persist) {
        try { saveHeadlessState(credential) } catch {}
      }
      return credential
    }
    if (status === "denied" || status === "expired") {
      throw upstreamError(`Capy 设备码配对${status === "denied" ? "被拒绝" : "已过期"}`, 403, {
        code: "device_pair_failed",
      })
    }
    await sleep(interval * 1000, signal)
  }
  throw upstreamError("等待 Capy 设备码批准超时", 504, { code: CODES.upstreamTimeout })
}

export function encodeDataFrame(streamId, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const frame = Buffer.alloc(4 + body.length)
  frame.writeUInt32BE(streamId >>> 0, 0)
  body.copy(frame, 4)
  return frame
}

export function decodeDataFrame(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.length < 4) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { streamId: view.getUint32(0), bytes: bytes.subarray(4) }
}

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return String(value)
  }
  return ""
}

export function resultForInvocation(handler, params = {}, { worktreeBase = "" } = {}) {
  const name = String(handler || "")
  if (name === "worktree_ensure") {
    const root = String(params.root || "")
    if (root && worktreeBase) {
      const base = path.resolve(worktreeBase)
      const resolved = path.resolve(root)
      if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
        return { status: "failed", error: { code: "MachineServer.Refused", message: "worktree root outside worktreeBase" } }
      }
    }
    let created = false
    if (root) {
      created = !fs.existsSync(root)
      fs.mkdirSync(root, { recursive: true })
    }
    return { status: "succeeded", result: { root, created, checkouts: [] } }
  }
  if (name === "worktree_list") {
    return { status: "succeeded", result: { kind: "worktree_list", entries: [] } }
  }
  if (name === "volume_landed") {
    return {
      status: "succeeded",
      result: {
        kind: "volume_landed",
        mounts: (params.mounts || []).map((mount) => ({
          mountPath: mount.mountPath,
          current: true,
          ...(mount.digest ? { digest: mount.digest } : {}),
        })),
        landing: false,
        checkpoints: false,
        directories: [],
        unretained: [],
        handback: true,
      },
    }
  }
  if (name === "volume_probe") {
    return {
      status: "succeeded",
      result: {
        mounts: (params.mounts || []).map((mount) => ({
          mountPath: mount.mountPath,
          state: "current",
          ...(mount.digest ? { digest: mount.digest } : {}),
        })),
      },
    }
  }
  return {
    status: "failed",
    error: {
      code: "MachineServer.Unavailable",
      message: `无头设备未实现 ${name || "unknown"}；终端/浏览器/写文件等工具不会执行。`,
    },
  }
}

export class HeadlessDevice {
  constructor({
    credential,
    worktreeBase = path.join(os.homedir(), ".capy", "worktrees"),
    WebSocketImpl = globalThis.WebSocket,
    logger = console,
    readyTimeoutMs = READY_TIMEOUT_MS,
  } = {}) {
    if (!credential?.token || !credential?.deviceId || !credential?.orgId) {
      throw new Error("HeadlessDevice 需要 credential {orgId, deviceId, token}")
    }
    if (typeof WebSocketImpl !== "function") throw new Error("当前运行时不支持 WebSocket")
    this.credential = credential
    this.orgId = credential.orgId
    this.deviceId = credential.deviceId
    this.name = credential.name || HEADLESS_NAME
    this.worktreeBase = worktreeBase
    this.WebSocketImpl = WebSocketImpl
    this.logger = logger
    this.readyTimeoutMs = readyTimeoutMs
    this.ws = null
    this.ready = false
    this.closed = false
    this.connectPromise = null
    this.readyResolve = null
    this.readyReject = null
    this.streams = new Map()
    this.results = new Map()
  }

  async ensure(timeoutMs = this.readyTimeoutMs) {
    if (this.ready && this.ws && this.ws.readyState === 1) return this
    if (this.connectPromise) return await this.connectPromise
    this.connectPromise = this.#connect(timeoutMs)
    try {
      await this.connectPromise
      return this
    } finally {
      this.connectPromise = null
    }
  }

  async #connect(timeoutMs) {
    this.closed = false
    this.ready = false
    let ws
    try {
      ws = new this.WebSocketImpl(TUNNEL_URL, {
        headers: { authorization: `Bearer ${this.credential.token}` },
      })
    } catch (error) {
      throw new Error(`当前运行时无法带 Authorization 连接设备隧道：${error?.message ?? error}`)
    }
    this.ws = ws
    ws.binaryType = "arraybuffer"
    const ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    const timer = setTimeout(() => {
      this.readyReject?.(new Error(`连接 Capy 设备隧道超时（${Math.round(timeoutMs / 1000)}s）`))
      try { ws.close(4000, "ready timeout") } catch {}
    }, Math.max(3000, Number(timeoutMs) || READY_TIMEOUT_MS))
    timer.unref?.()

    ws.addEventListener("open", () => {
      this.#send({
        type: "hello",
        contractVersion: CONTRACT_VERSION,
        deviceId: this.deviceId,
        hostname: os.hostname(),
        os: process.platform === "win32" ? "win32" : process.platform,
        workspaces: [],
        worktreeBase: this.worktreeBase,
        clientVersion: "magpie-headless 0.1",
      })
    })
    ws.addEventListener("message", (event) => this.#onMessage(event))
    ws.addEventListener("close", (event) => {
      this.ready = false
      this.ws = null
      clearTimeout(timer)
      if (!this.readyResolve) return
      this.readyReject?.(new Error(`Capy 设备隧道已关闭（${event.code}${event.reason ? `：${event.reason}` : ""}）`))
    })
    ws.addEventListener("error", () => {
      this.readyReject?.(new Error("Capy 设备隧道连接失败"))
    })
    try {
      await ready
    } finally {
      clearTimeout(timer)
      this.readyResolve = null
      this.readyReject = null
    }
    this.ready = true
    return this
  }

  #send(frame) {
    if (!this.ws || this.ws.readyState !== 1) return false
    try {
      this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  #sendBinary(bytes) {
    if (!this.ws || this.ws.readyState !== 1) return false
    try {
      this.ws.send(new Uint8Array(bytes))
      return true
    } catch {
      return false
    }
  }

  #respond(streamId, status, payload, extraHeaders = {}) {
    const body = Buffer.from(JSON.stringify(payload))
    this.#send({
      type: "response",
      streamId,
      status,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        ...extraHeaders,
      },
    })
    this.#sendBinary(encodeDataFrame(streamId, body))
    this.#send({ type: "close", streamId })
    const stream = this.streams.get(streamId)
    if (stream) stream.responded = true
  }

  #onMessage(event) {
    if (typeof event.data === "string") {
      this.#onControl(event.data)
      return
    }
    let bytes
    if (event.data instanceof ArrayBuffer) bytes = new Uint8Array(event.data)
    else if (ArrayBuffer.isView(event.data)) bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
    else return
    const frame = decodeDataFrame(bytes)
    if (!frame) return
    const stream = this.streams.get(frame.streamId)
    if (!stream) return
    stream.body = Buffer.concat([stream.body, Buffer.from(frame.bytes)])
    const length = Number(headerValue(stream.headers, "content-length") || 0)
    if (!length || stream.body.length >= length) this.#handleStream(stream)
  }

  #onControl(text) {
    let frame
    try { frame = JSON.parse(text) } catch { return }
    const type = String(frame?.type || "")
    if (type === "ping") {
      this.#send({ type: "pong" })
      return
    }
    if (type === "session-config") {
      this.session = {
        backingId: frame.backingId,
        bearer: frame.bearer,
        transferSecret: frame.transferSecret,
      }
      this.#send({ type: "workspaces-changed", workspaces: [] })
      this.#send({ type: "ready" })
      this.readyResolve?.()
      return
    }
    if (type === "open") {
      this.streams.set(frame.streamId, {
        streamId: frame.streamId,
        kind: frame.kind,
        method: frame.method,
        path: frame.path,
        headers: frame.headers || {},
        body: Buffer.alloc(0),
        responded: false,
      })
      return
    }
    if (type === "close") {
      const stream = this.streams.get(frame.streamId)
      if (stream && !stream.responded) {
        if (String(stream.path || "").startsWith("/v1/invocations/")) {
          const id = String(stream.path).split("?")[0].split("/").pop()
          const cached = this.results.get(id)
          if (cached) this.#respond(frame.streamId, 200, cached)
          else this.#respond(frame.streamId, 404, { status: "failed", error: { code: "NotFound", message: "unknown invocation" } })
        } else {
          this.#respond(frame.streamId, 200, {})
        }
      }
      this.streams.delete(frame.streamId)
      return
    }
    if (type === "reset") {
      this.streams.delete(frame.streamId)
      return
    }
  }

  #handleStream(stream) {
    if (stream.responded) return
    const text = stream.body.toString("utf8")
    const pathName = String(stream.path || "").split("?")[0]
    if (pathName === "/v1/git/capture") {
      this.#respond(stream.streamId, 200, { repos: [] })
      return
    }
    if (pathName.startsWith("/v1/invocations/")) {
      const id = pathName.split("/").pop()
      const cached = this.results.get(id)
      this.#respond(stream.streamId, cached ? 200 : 404, cached || { status: "failed", error: { code: "NotFound", message: "unknown invocation" } })
      return
    }
    if (pathName !== "/v1/invocations") {
      this.#respond(stream.streamId, 404, { status: "failed", error: { code: "NotFound", message: `headless device: ${pathName}` } })
      return
    }
    let request
    try { request = JSON.parse(text) } catch {
      this.#respond(stream.streamId, 400, { status: "failed", error: { code: "BadRequest", message: "invalid JSON" } })
      return
    }
    let payload
    try {
      payload = resultForInvocation(request.handler, request.params || {}, { worktreeBase: this.worktreeBase })
    } catch (error) {
      payload = { status: "failed", error: { code: "MachineServer.Failed", message: String(error?.message ?? error) } }
    }
    if (request.invocationId) this.results.set(String(request.invocationId), payload)
    this.#respond(stream.streamId, 200, payload)
  }

  close() {
    this.closed = true
    this.ready = false
    try { this.ws?.close(1000, "headless device closed") } catch {}
    this.ws = null
  }
}

export async function waitForDevice(fetchImpl, jwt, orgId, deviceId, { timeoutMs = 15_000, signal } = {}) {
  const deadline = Date.now() + Math.max(3000, Number(timeoutMs) || 15_000)
  while (Date.now() < deadline) {
    const { response, body } = await (async () => {
      const res = await fetchImpl(`${APP_BASE}/orgs/${encodeURIComponent(orgId)}/devices`, {
        headers: { authorization: `Bearer ${jwt}`, origin: "https://capy.ai" },
        signal,
      })
      const data = await res.json().catch(() => null)
      return { response: res, body: data }
    })()
    if (response.ok && Array.isArray(body)) {
      const hit = body.find((item) => String(item?.id) === String(deviceId))
      if (hit?.connected === true) return hit
    }
    await sleep(CONNECT_POLL_MS, signal)
  }
  return null
}

export const _internal = Object.freeze({
  TUNNEL_URL,
  CONTRACT_VERSION,
  HEADLESS_NAME,
  encodeDataFrame,
  decodeDataFrame,
  resultForInvocation,
  headerValue,
  stateFile,
  dpapiProtect,
  dpapiUnprotect,
})
