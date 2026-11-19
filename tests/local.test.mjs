// 本机导入的单元测试。
//
// 合成数据全部写在 os.tmpdir() 下，用固定的假 AES key + 假 dpapiDecrypt，
// 但密文仍按真实的 "v10" + AES-256-GCM 格式生成，所以整条解密链路都被走到。
// 最后一个用例只读本机真实 Capy，失败时只打印 {userId, sessionId, orgId, deviceId, jwtLength}。

import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CapyLocalImportError,
  decodeClientJwt,
  readCapyInstall,
  readCapyInstallSync,
} from "../src/local.mjs"

const KEY = crypto.createHash("sha256").update("magpie-capy-test-key").digest()

const USER_ID = "user_01TESTUSER000000000000000"
const SESSION_ID = "sess_01TESTSESSION0000000000000"
const ORG_ID = "org_01TESTORG00000000000000000"
const DEVICE_ID = "device_01TESTDEVICE000000000000"
const CLIENT_ID = "client_test_client"
const ROTATING_TOKEN = "rotating_test_token"

function rawJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.signature`
}

function clientJwt(extra = {}) {
  return rawJwt({ id: CLIENT_ID, rotating_token: ROTATING_TOKEN, ...extra })
}

/** 按 Capy 的格式加密："v10" + 12 字节 nonce + 密文 + 16 字节 tag。 */
function encryptV10(plaintext, key = KEY) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, body, tag]).toString("base64")
}

function dpapiKeyFile(blob = Buffer.from("fake-dpapi-blob")) {
  return Buffer.concat([Buffer.from("DPAPI", "latin1"), blob]).toString("base64")
}

/** 在指定目录写入一整套合成凭据（happy path 默认值可逐项覆盖）。 */
function seedInstall(dir, options = {}) {
  const jwt = options.jwt ?? clientJwt()
  const userId = options.userId ?? USER_ID

  fs.writeFileSync(
    path.join(dir, "Local State"),
    options.localState ?? JSON.stringify({
      os_crypt: { encrypted_key: options.encryptedKey ?? dpapiKeyFile() },
    }),
  )

  if (options.session !== null) {
    fs.writeFileSync(
      path.join(dir, "session-credential.json"),
      options.session ?? JSON.stringify({
        version: 1,
        userId,
        sessionId: options.sessionId ?? SESSION_ID,
        ciphertext: options.ciphertext ?? encryptV10(jwt),
      }),
    )
  }

  if (options.device !== null) {
    const orgId = options.orgId ?? ORG_ID
    fs.writeFileSync(
      path.join(dir, "device-credentials.json"),
      options.device ?? JSON.stringify({
        version: 1,
        orgs: {
          [orgId]: {
            userId,
            deviceId: options.deviceId ?? DEVICE_ID,
            // 按约定不解密设备凭据，故意放一个非 base64 的值。
            ciphertext: "设备凭据无需解密",
          },
        },
      }),
    )
  }

  return { dir, jwt }
}

function writeInstall(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capy-local-"))
  return seedInstall(dir, options)
}

function cleanup(t, dir) {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
}

function snapshotDir(dir) {
  return fs.readdirSync(dir).sort().map((name) => {
    const stat = fs.statSync(path.join(dir, name))
    return { name, size: stat.size, mtimeMs: stat.mtimeMs }
  })
}

function capyError(code) {
  return (error) => {
    assert.ok(
      error instanceof CapyLocalImportError,
      `应为 CapyLocalImportError，实际为 ${error?.name}: ${error?.message}`,
    )
    assert.equal(error.code, code)
    assert.match(error.message, /[\u4e00-\u9fff]/u, "用户可见的错误文案应为中文")
    return true
  }
}

const fakeDpapi = { dpapiDecrypt: () => KEY }

/** 默认使用假 DPAPI；platform 等选项可逐项覆盖。 */
function read(dir, extra = {}) {
  return readCapyInstall({ appDataDir: dir, ...fakeDpapi, ...extra })
}

test("happy path：完整读出 userId / sessionId / orgId / deviceId / clientJwt", async (t) => {
  const { dir, jwt } = writeInstall()
  cleanup(t, dir)
  const before = snapshotDir(dir)

  let received = null
  const result = await readCapyInstall({
    appDataDir: dir,
    dpapiDecrypt: (blob) => {
      received = Buffer.from(blob)
      return KEY
    },
  })

  assert.ok(Buffer.isBuffer(received), "dpapiDecrypt 应收到 Buffer")
  assert.equal(received.toString("utf8"), "fake-dpapi-blob", "DPAPI 前缀应在调用前剥掉")

  assert.deepEqual(Object.keys(result), [
    "ok",
    "userId",
    "sessionId",
    "orgId",
    "deviceId",
    "clientJwt",
    "accountId",
    "source",
  ])
  assert.equal(result.ok, true)
  assert.equal(result.userId, USER_ID)
  assert.equal(result.sessionId, SESSION_ID)
  assert.equal(result.orgId, ORG_ID)
  assert.equal(result.deviceId, DEVICE_ID)
  assert.equal(result.clientJwt, jwt)
  assert.equal(result.accountId, USER_ID)
  assert.equal(result.source, "capy-desktop")

  const claims = decodeClientJwt(result.clientJwt)
  assert.equal(claims.clientId, CLIENT_ID)
  assert.equal(claims.rotatingToken, ROTATING_TOKEN)

  // 只读：文件内容、大小、mtime 都不变。
  assert.deepEqual(snapshotDir(dir), before)
})

test("accountId 优先取 Clerk 令牌里的邮箱（拿不到则退回 userId）", async (t) => {
  const { dir } = writeInstall({ jwt: clientJwt({ email: "capy@example.com" }) })
  cleanup(t, dir)

  const result = await read(dir)
  assert.equal(result.accountId, "capy@example.com")
  assert.equal(result.userId, USER_ID)
})

test("多组织：取 device-credentials.json 里的第一个组织", async (t) => {
  const first = "org_01FIRST0000000000000000000"
  const second = "org_01SECOND000000000000000000"
  const { dir } = writeInstall({
    device: JSON.stringify({
      version: 1,
      orgs: {
        [first]: { userId: USER_ID, deviceId: "device_first", ciphertext: "不解密" },
        [second]: { userId: USER_ID, deviceId: "device_second", ciphertext: "不解密" },
      },
    }),
  })
  cleanup(t, dir)

  const result = await read(dir)
  assert.equal(result.orgId, first)
  assert.equal(result.deviceId, "device_first")
})

test("readCapyInstallSync 与异步版本结果一致；拒绝异步 DPAPI 实现", (t) => {
  const { dir, jwt } = writeInstall()
  cleanup(t, dir)

  const result = readCapyInstallSync({ appDataDir: dir, dpapiDecrypt: () => KEY })
  assert.equal(result.clientJwt, jwt)
  assert.equal(result.sessionId, SESSION_ID)
  assert.equal(result.orgId, ORG_ID)

  assert.throws(
    () => readCapyInstallSync({ appDataDir: dir, dpapiDecrypt: async () => KEY }),
    capyError("decrypt_failed"),
  )
})

test("Capy 未安装：数据目录不存在 → not_installed", async () => {
  const missing = path.join(os.tmpdir(), `capy-missing-${crypto.randomUUID()}`)
  await assert.rejects(read(missing), capyError("not_installed"))
})

test("未登录：缺 session-credential.json → not_signed_in", async (t) => {
  const { dir } = writeInstall({ session: null })
  cleanup(t, dir)
  await assert.rejects(read(dir), capyError("not_signed_in"))
})

test("未登录：缺 device-credentials.json → not_signed_in", async (t) => {
  const { dir } = writeInstall({ device: null })
  cleanup(t, dir)
  await assert.rejects(read(dir), capyError("not_signed_in"))
})

test("未加入组织：orgs 为空 → not_signed_in", async (t) => {
  const { dir } = writeInstall({ device: JSON.stringify({ version: 1, orgs: {} }) })
  cleanup(t, dir)
  await assert.rejects(read(dir), capyError("not_signed_in"))
})

test("DPAPI 解出错误密钥 → decrypt_failed", async (t) => {
  const { dir } = writeInstall()
  cleanup(t, dir)
  await assert.rejects(read(dir, { dpapiDecrypt: () => Buffer.alloc(32, 7) }), capyError("decrypt_failed"))
})

test("DPAPI 调用抛错 / 返回长度不对的密钥 → decrypt_failed", async (t) => {
  const { dir } = writeInstall()
  cleanup(t, dir)

  await assert.rejects(
    read(dir, { dpapiDecrypt: () => { throw new Error("boom") } }),
    capyError("decrypt_failed"),
  )
  await assert.rejects(read(dir, { dpapiDecrypt: () => Buffer.alloc(16) }), capyError("decrypt_failed"))
})

test("AES-GCM tag 被篡改 → decrypt_failed", async (t) => {
  const jwt = clientJwt()
  const raw = Buffer.from(encryptV10(jwt), "base64")
  raw[raw.length - 1] ^= 0xff
  const { dir } = writeInstall({ jwt, ciphertext: raw.toString("base64") })
  cleanup(t, dir)

  await assert.rejects(read(dir), capyError("decrypt_failed"))
})

test("解密结果不是 JWT / 缺 rotating_token → malformed", async (t) => {
  const notJwt = writeInstall({ jwt: "not-a-jwt" })
  cleanup(t, notJwt.dir)
  await assert.rejects(read(notJwt.dir), capyError("malformed"))

  const missingClaim = writeInstall({ jwt: rawJwt({ id: CLIENT_ID }) })
  cleanup(t, missingClaim.dir)
  await assert.rejects(read(missingClaim.dir), capyError("malformed"))
})

test("会话密文不是 v10 格式 → malformed", async (t) => {
  const raw = Buffer.from(encryptV10(clientJwt()), "base64")
  raw.write("v11", 0, "latin1")
  const { dir } = writeInstall({ ciphertext: raw.toString("base64") })
  cleanup(t, dir)

  await assert.rejects(read(dir), capyError("malformed"))
})

test("Local State 损坏 / 密钥不是 DPAPI 格式 → malformed / decrypt_failed", async (t) => {
  const badState = writeInstall({ localState: "{ 这不是 JSON" })
  cleanup(t, badState.dir)
  await assert.rejects(read(badState.dir), capyError("malformed"))

  const notDpapi = writeInstall({
    encryptedKey: Buffer.concat([Buffer.from("v10", "latin1"), crypto.randomBytes(32)]).toString("base64"),
  })
  cleanup(t, notDpapi.dir)
  await assert.rejects(read(notDpapi.dir), capyError("decrypt_failed"))
})

test("device-credentials.json 损坏 → malformed", async (t) => {
  const { dir } = writeInstall({ device: "{ 这也不是 JSON" })
  cleanup(t, dir)
  await assert.rejects(read(dir), capyError("malformed"))
})

test("非 Windows 平台 → unsupported_platform", async (t) => {
  const { dir } = writeInstall()
  cleanup(t, dir)

  await assert.rejects(read(dir, { platform: "darwin" }), capyError("unsupported_platform"))
  await assert.rejects(read(dir, { platform: "linux" }), capyError("unsupported_platform"))
  assert.throws(
    () => readCapyInstallSync({ appDataDir: dir, platform: "darwin", dpapiDecrypt: () => KEY }),
    capyError("unsupported_platform"),
  )
})

test("appDataDir 也接受包含 Capy 子目录的漫游目录", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capy-roaming-"))
  cleanup(t, root)
  const capyDir = path.join(root, "Capy")
  fs.mkdirSync(capyDir)
  const { jwt } = seedInstall(capyDir)

  const result = await read(root)
  assert.equal(result.clientJwt, jwt)
  assert.equal(result.orgId, ORG_ID)
})

test("decodeClientJwt：只返回非敏感字段，缺字段报 malformed", () => {
  const withExp = decodeClientJwt(clientJwt({ exp: 1_900_000_000 }))
  assert.deepEqual(withExp, { clientId: CLIENT_ID, rotatingToken: ROTATING_TOKEN, exp: 1_900_000_000 })

  assert.deepEqual(decodeClientJwt(clientJwt()), {
    clientId: CLIENT_ID,
    rotatingToken: ROTATING_TOKEN,
  })

  assert.throws(() => decodeClientJwt("nope"), capyError("malformed"))
  assert.throws(() => decodeClientJwt(rawJwt({ id: CLIENT_ID })), capyError("malformed"))
})

test("真实机器：读取已登录的 Capy 桌面端（只读）", { skip: process.platform !== "win32" }, async (t) => {
  let result = null
  try {
    result = await readCapyInstall()
  } catch (error) {
    if (error?.code === "not_installed" || error?.code === "not_signed_in") {
      t.skip(`本机 Capy 不可用：${error.code}`)
      return
    }
    throw error
  }

  // 只打印脱敏摘要（绝不打印 clientJwt 本身）。
  console.log(JSON.stringify({
    userId: result.userId,
    sessionId: result.sessionId,
    orgId: result.orgId,
    deviceId: result.deviceId,
    jwtLength: result.clientJwt.length,
  }))

  assert.equal(result.ok, true)
  assert.equal(result.source, "capy-desktop")
  assert.match(result.userId, /^user_/u)
  assert.match(result.sessionId, /^sess_/u)
  assert.match(result.orgId, /^org_/u)
  assert.ok(result.deviceId.length > 0)
  assert.equal(result.clientJwt.split(".").length, 3)
  assert.ok(result.clientJwt.length > 100)
})
