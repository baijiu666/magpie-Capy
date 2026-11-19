// 本机导入：从已登录的 Capy 桌面端（Electron，Windows）读登录凭据。
//
// 数据目录：%APPDATA%\Capy（appDataDir 可覆盖）
//   · Local State              os_crypt.encrypted_key = "DPAPI" 前缀 + Windows DPAPI blob
//   · session-credential.json  { version, userId, sessionId, ciphertext }
//   · device-credentials.json  { version, orgs: { [orgId]: { userId, deviceId, ciphertext } } }
//
// 解密链路：DPAPI(CurrentUser) 解出 32 字节 AES key → AES-256-GCM 解 "v10" 密文 → Clerk client JWT。
// 全程只读：不往 Capy 目录写任何东西，密钥与令牌只在内存里过一遍，也不打日志。
//
// 只支持 Windows：DPAPI 换不掉（macOS 的钥匙串是另一套实现），所以其他系统直接报
// unsupported_platform，而不是让用户看到一句含糊的「解密失败」。
//
// 依赖注入：readCapyInstall({ appDataDir, platform, dpapiDecrypt })。
// dpapiDecrypt(blob: Buffer) 收到的是去掉 "DPAPI" 前缀后的 blob，应返回 32 字节密钥
// （Buffer / Uint8Array / 64 位十六进制字符串均可）；同步、异步都支持。

import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CAPY_DIR_NAME = "Capy"
const LOCAL_STATE_FILE = "Local State"
const SESSION_FILE = "session-credential.json"
const DEVICE_FILE = "device-credentials.json"

const DPAPI_PREFIX = "DPAPI"
const V10_PREFIX = "v10"
const NONCE_BYTES = 12
const TAG_BYTES = 16
const AES_KEY_BYTES = 32
const DPAPI_TIMEOUT_MS = 15_000
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

const DPAPI_FAIL_MESSAGE =
  "Windows DPAPI 解密 Capy 本地密钥失败。请确认当前 Windows 用户就是登录 Capy 的用户，" +
  "然后在 Capy 桌面端重新登录后重试。"

/** 本机导入的错误码：宿主按 code 分支，message 直接给用户看。 */
export class CapyLocalImportError extends Error {
  constructor(code, message, { cause, detail } = {}) {
    super(String(message ?? ""))
    this.name = "CapyLocalImportError"
    this.code = String(code || "malformed")
    if (cause !== undefined) this.cause = cause
    if (detail !== undefined) this.detail = String(detail)
  }
}

function fail(code, message, extra) {
  return new CapyLocalImportError(code, message, extra)
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : ""
}

function notInstalled(dir) {
  return fail(
    "not_installed",
    `未找到 Capy 客户端的数据目录（${dir}）。请先安装并登录 Capy 桌面端后重试。`,
  )
}

function notSignedIn(message) {
  return fail(
    "not_signed_in",
    message || "Capy 客户端尚未登录或登录态已失效。请先在 Capy 桌面端登录后重试。",
  )
}

function malformed(message, cause) {
  return fail("malformed", message, { cause })
}

function decryptFailed(message, cause) {
  return fail("decrypt_failed", message || DPAPI_FAIL_MESSAGE, { cause })
}

// ---------------------------------------------------------------------------
// 路径与文件
// ---------------------------------------------------------------------------

function looksLikeCapyDir(dir) {
  return (
    fs.existsSync(path.join(dir, LOCAL_STATE_FILE)) ||
    fs.existsSync(path.join(dir, SESSION_FILE)) ||
    fs.existsSync(path.join(dir, DEVICE_FILE))
  )
}

/**
 * 解析 Capy 数据目录。
 * 优先级：capyDir（精确目录）> appDataDir（Capy 目录，或含 Capy 子目录的漫游目录）
 * > appDataRoot / env.APPDATA 下的 Capy > ~/AppData/Roaming/Capy。
 */
export function resolveCapyDir(options = {}) {
  const explicitDir = stringValue(options.capyDir)
  if (explicitDir) return path.resolve(explicitDir)

  const appData = stringValue(options.appDataDir)
  if (appData) {
    const dir = path.resolve(appData)
    if (looksLikeCapyDir(dir)) return dir
    // 也接受直接传 %APPDATA%：下面只要有一个 Capy 数据文件就算数。
    const nested = path.join(dir, CAPY_DIR_NAME)
    return looksLikeCapyDir(nested) ? nested : dir
  }

  const env = options.env && typeof options.env === "object" ? options.env : process.env
  const root = stringValue(options.appDataRoot) || stringValue(env?.APPDATA)
  if (root) return path.join(path.resolve(root), CAPY_DIR_NAME)

  let home = ""
  try { home = os.homedir() } catch {}
  return path.join(home, "AppData", "Roaming", CAPY_DIR_NAME)
}

function assertWindows(options) {
  const platform = typeof options.platform === "string" && options.platform
    ? options.platform
    : process.platform
  if (platform !== "win32") {
    throw fail(
      "unsupported_platform",
      "本机导入目前只支持 Windows：Capy 的本地凭据用 Windows DPAPI 加密，其他系统无法解密。",
    )
  }
}

function assertCapyDir(dir) {
  let stat = null
  try {
    stat = fs.statSync(dir)
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw notInstalled(dir)
    throw malformed(`无法访问 Capy 数据目录：${dir}`, error)
  }
  if (!stat.isDirectory()) throw notInstalled(dir)
}

function readTextFile(file, missingCode, missingMessage) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") throw fail(missingCode, missingMessage, { cause: error })
    throw malformed(`无法读取 Capy 的 ${path.basename(file)}，请确认当前用户有权限访问该文件。`, error)
  }
}

function readJsonObject(file, missingCode, missingMessage) {
  const text = readTextFile(file, missingCode, missingMessage)
  let value = null
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw malformed(`Capy 的 ${path.basename(file)} 不是有效的 JSON（文件可能已损坏）。`, error)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformed(`Capy 的 ${path.basename(file)} 结构无法识别（应为 JSON 对象）。`)
  }
  return value
}

function decodeBase64(value, label) {
  const text = stringValue(value)
  if (!text || text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) {
    throw malformed(`Capy 的 ${label} 不是有效的 base64 数据。`)
  }
  return Buffer.from(text, "base64")
}

// ---------------------------------------------------------------------------
// 三个凭据文件
// ---------------------------------------------------------------------------

function readSession(dir) {
  const value = readJsonObject(
    path.join(dir, SESSION_FILE),
    "not_signed_in",
    "Capy 客户端尚未登录（找不到 session-credential.json）。请先在 Capy 桌面端登录后重试。",
  )
  const userId = stringValue(value.userId)
  const sessionId = stringValue(value.sessionId)
  const ciphertext = stringValue(value.ciphertext)
  if (!userId || !sessionId || !ciphertext) {
    throw malformed("Capy 的 session-credential.json 缺少 userId / sessionId / ciphertext（文件可能已损坏）。")
  }
  if (!userId.startsWith("user_")) {
    throw malformed("Capy 的 session-credential.json 里 userId 格式不对（应以 user_ 开头）。")
  }
  if (!sessionId.startsWith("sess_")) {
    throw malformed("Capy 的 session-credential.json 里 sessionId 格式不对（应以 sess_ 开头）。")
  }
  return { userId, sessionId, ciphertext }
}

function readDevice(dir) {
  const value = readJsonObject(
    path.join(dir, DEVICE_FILE),
    "not_signed_in",
    "Capy 客户端尚未登录（找不到 device-credentials.json）。请先在 Capy 桌面端登录后重试。",
  )
  const orgs = value.orgs
  if (!orgs || typeof orgs !== "object" || Array.isArray(orgs)) {
    throw malformed("Capy 的 device-credentials.json 缺少 orgs（文件可能已损坏）。")
  }
  const orgId = Object.keys(orgs)[0] || ""
  if (!orgId) throw notSignedIn("Capy 客户端里还没有已登录的组织。请先在 Capy 桌面端登录后重试。")
  if (!orgId.startsWith("org_")) {
    throw malformed("Capy 的 device-credentials.json 里 orgId 格式不对（应以 org_ 开头）。")
  }
  const entry = orgs[orgId]
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw malformed("Capy 的 device-credentials.json 里组织信息结构无法识别。")
  }
  const deviceId = stringValue(entry.deviceId)
  if (!deviceId) throw malformed("Capy 的 device-credentials.json 缺少 deviceId。")

  // 设备凭据的 ciphertext 用不到（只需要 orgId / deviceId），按约定不解密。
  return { orgId, deviceId, entry }
}

function readDpapiBlob(dir) {
  const value = readJsonObject(
    path.join(dir, LOCAL_STATE_FILE),
    "malformed",
    "Capy 客户端缺少 Local State 文件（客户端可能尚未完成初始化）。请启动一次 Capy 后重试。",
  )
  const encoded = stringValue(value?.os_crypt?.encrypted_key)
  if (!encoded) {
    throw malformed("Capy 的 Local State 缺少 os_crypt.encrypted_key（客户端版本可能已变化）。")
  }
  const raw = decodeBase64(encoded, "os_crypt.encrypted_key")
  if (raw.length <= DPAPI_PREFIX.length) {
    throw malformed("Capy 的 os_crypt.encrypted_key 长度异常（文件可能已损坏）。")
  }
  if (raw.subarray(0, DPAPI_PREFIX.length).toString("latin1") !== DPAPI_PREFIX) {
    throw decryptFailed("Capy 的本地密钥不是 Windows DPAPI 格式，当前系统无法解密。")
  }
  return raw.subarray(DPAPI_PREFIX.length)
}

// ---------------------------------------------------------------------------
// 解密
// ---------------------------------------------------------------------------

/**
 * Windows DPAPI（CurrentUser）解密钥。
 * PowerShell 5.1 没有 [Convert]::ToHexString，也没有 AesGcm，所以用 ProtectedData + 手工转十六进制。
 * base64 只含 A-Z a-z 0-9 + / =，嵌进单引号里不会破坏脚本；blob 本身是密文，不是秘密。
 */
export function dpapiDecryptWindows(blob) {
  const keyBlob = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? [])
  if (keyBlob.length === 0) throw decryptFailed("Capy 的 DPAPI 密钥数据为空。")
  const encoded = keyBlob.toString("base64")

  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$blob = [Convert]::FromBase64String('${encoded}')
if ($blob.Length -eq 0) { throw 'DPAPI blob is empty' }
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
-join ($plain | ForEach-Object { $_.ToString('x2') })`

  let stdout = ""
  try {
    stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, encoding: "utf8", timeout: DPAPI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    )
  } catch (error) {
    throw decryptFailed(DPAPI_FAIL_MESSAGE, error)
  }

  const hex = String(stdout ?? "").replace(/^\uFEFF/u, "").trim()
  if (!/^[0-9a-fA-F]{64}$/u.test(hex)) {
    throw decryptFailed("Windows DPAPI 返回的密钥格式异常（应为 32 字节 AES 密钥）。")
  }
  return Buffer.from(hex, "hex")
}

/** 注入的 dpapiDecrypt 可能返回 Buffer / Uint8Array / 十六进制字符串；统一成 32 字节。 */
function coerceAesKey(value) {
  let key = null
  if (Buffer.isBuffer(value)) {
    key = value
  } else if (ArrayBuffer.isView(value)) {
    key = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  } else if (value instanceof ArrayBuffer) {
    key = Buffer.from(value)
  } else if (typeof value === "string" && /^[0-9a-fA-F]{64}$/u.test(value.trim())) {
    key = Buffer.from(value.trim(), "hex")
  }
  if (!key) throw decryptFailed("DPAPI 返回的 AES 密钥格式无法识别。")
  if (key.length !== AES_KEY_BYTES) {
    throw decryptFailed(`DPAPI 返回的 AES 密钥长度为 ${key.length} 字节，应为 32 字节。`)
  }
  return key
}

/** "v10" + 12 字节 nonce + AES-256-GCM 密文 + 16 字节 tag。 */
export function decryptSessionCiphertext(ciphertext, key) {
  const raw = decodeBase64(ciphertext, "session-credential.json 里的 ciphertext")
  if (raw.length < V10_PREFIX.length + NONCE_BYTES + TAG_BYTES) {
    throw malformed("Capy 的 session-credential.json 里 ciphertext 长度异常（文件可能已损坏）。")
  }
  if (raw.subarray(0, V10_PREFIX.length).toString("latin1") !== V10_PREFIX) {
    throw malformed("Capy 的会话密文不是 v10 格式（客户端版本可能已变化）。")
  }
  const nonce = raw.subarray(V10_PREFIX.length, V10_PREFIX.length + NONCE_BYTES)
  const body = raw.subarray(V10_PREFIX.length + NONCE_BYTES, raw.length - TAG_BYTES)
  const tag = raw.subarray(raw.length - TAG_BYTES)

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8").trim()
    if (!plaintext) throw malformed("Capy 的会话密文解密结果为空。")
    return plaintext
  } catch (error) {
    if (error instanceof CapyLocalImportError) throw error
    throw decryptFailed(
      "无法解密 Capy 的登录凭据（AES-256-GCM 校验失败）。请在 Capy 桌面端重新登录后重试。",
      error,
    )
  }
}

// ---------------------------------------------------------------------------
// Clerk client JWT
// ---------------------------------------------------------------------------

function decodeJwtPayload(token) {
  const text = stringValue(token)
  const parts = text.split(".")
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw malformed("Capy 登录凭据不是有效的 JWT（应为 3 段点分隔字符串）。")
  }
  let payload = null
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch (error) {
    throw malformed("Capy 登录凭据的 JWT payload 无法解析。", error)
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw malformed("Capy 登录凭据的 JWT payload 不是对象。")
  }
  return payload
}

function claimsOf(payload) {
  const clientId = stringValue(payload.id)
  const rotatingToken = stringValue(payload.rotating_token)
  if (!clientId || !rotatingToken) {
    throw malformed(
      "Capy 客户端令牌缺少 id 或 rotating_token（Clerk 令牌格式可能已变化）。" +
      "请更新插件或在 Capy 桌面端重新登录后重试。",
    )
  }
  const exp = Number(payload.exp)
  return Number.isFinite(exp) && exp > 0
    ? { clientId, rotatingToken, exp }
    : { clientId, rotatingToken }
}

/**
 * 解 Clerk client token（不验签，只读声明）。返回值只含非敏感字段，调用方不要打日志。
 * payload 实测为 { id, rotating_token }，个别部署可能额外带 exp。
 */
export function decodeClientJwt(clientJwt) {
  return claimsOf(decodeJwtPayload(clientJwt))
}

// accountId 尽量取「人看得懂」的名字：Clerk 令牌里如果有 email / username 就用，
// 否则退回 userId（client token 实测只有 id / rotating_token，不会为这个再发网络请求）。
const ACCOUNT_NAME_KEYS = ["email", "username", "preferred_username", "name"]
const ACCOUNT_NAME_HOLDERS = ["user", "profile", "account"]

function accountNameFrom(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 1) return ""
  for (const key of ACCOUNT_NAME_KEYS) {
    const found = stringValue(value[key])
    if (found) return found
  }
  for (const holder of ACCOUNT_NAME_HOLDERS) {
    const found = accountNameFrom(value[holder], depth + 1)
    if (found) return found
  }
  return ""
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function prepareInstall(options) {
  assertWindows(options)
  const dir = resolveCapyDir(options)
  assertCapyDir(dir)
  const session = readSession(dir)
  const device = readDevice(dir)
  const dpapiBlob = readDpapiBlob(dir)
  return { dir, session, device, dpapiBlob }
}

function assembleResult(ctx, aesKey) {
  const clientJwt = decryptSessionCiphertext(ctx.session.ciphertext, aesKey)
  const payload = decodeJwtPayload(clientJwt)
  claimsOf(payload) // 只做形状校验：缺 id / rotating_token 直接报 malformed

  const accountId =
    accountNameFrom(payload) ||
    accountNameFrom(ctx.device.entry) ||
    ctx.session.userId

  return {
    ok: true,
    userId: ctx.session.userId,
    sessionId: ctx.session.sessionId,
    orgId: ctx.device.orgId,
    deviceId: ctx.device.deviceId,
    clientJwt,
    accountId,
    source: "capy-desktop",
  }
}

/**
 * 读取本机已登录的 Capy 桌面端凭据。
 * 失败时抛 CapyLocalImportError（code: not_installed / not_signed_in /
 * unsupported_platform / decrypt_failed / malformed），message 为中文用户文案。
 */
export async function readCapyInstall(options = {}) {
  const ctx = prepareInstall(options)
  const decrypt = typeof options.dpapiDecrypt === "function"
    ? options.dpapiDecrypt
    : dpapiDecryptWindows

  let key = null
  try {
    key = await decrypt(ctx.dpapiBlob)
  } catch (error) {
    if (error instanceof CapyLocalImportError) throw error
    throw decryptFailed(DPAPI_FAIL_MESSAGE, error)
  }
  return assembleResult(ctx, coerceAesKey(key))
}

/** 同步版本（默认 DPAPI 实现本来就是 execFileSync）。注入异步 dpapiDecrypt 会报错。 */
export function readCapyInstallSync(options = {}) {
  const ctx = prepareInstall(options)
  const decrypt = typeof options.dpapiDecryptSync === "function"
    ? options.dpapiDecryptSync
    : typeof options.dpapiDecrypt === "function"
      ? options.dpapiDecrypt
      : dpapiDecryptWindows

  let key = null
  try {
    key = decrypt(ctx.dpapiBlob)
  } catch (error) {
    if (error instanceof CapyLocalImportError) throw error
    throw decryptFailed(DPAPI_FAIL_MESSAGE, error)
  }
  if (key && typeof key.then === "function") {
    throw decryptFailed("同步读取不支持异步的 DPAPI 解密函数，请改用 readCapyInstall()。")
  }
  return assembleResult(ctx, coerceAesKey(key))
}

export const _internal = Object.freeze({
  CAPY_DIR_NAME,
  DPAPI_PREFIX,
  V10_PREFIX,
  decodeJwtPayload,
  decryptSessionCiphertext,
  coerceAesKey,
  resolveCapyDir,
  dpapiDecryptWindows,
})
