import test from "node:test"
import assert from "node:assert/strict"

import {
  completeLogin,
  encodeRefresh,
  ensureProject,
  mintApiKey,
  mintSessionJwt,
  parseRefresh,
  refreshCredential,
  validateApiKey,
} from "../src/auth.mjs"
import { CODES } from "../src/errors.mjs"

const AZP = "https://capy.ai"

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

const sessionJwt = jwt({ azp: AZP, sid: "sess_1", sub: "user_1", exp: 9999999999 })
const key = `capy_${"a".repeat(43)}`

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function router(routes) {
  return async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase()
    const keyName = `${method} ${url}`
    for (const [pattern, handler] of routes) {
      if (pattern instanceof RegExp ? pattern.test(keyName) : keyName === pattern) {
        return handler(init, url)
      }
    }
    return json({ _tag: "capy/RouteNotFound" }, 404)
  }
}

test("mintSessionJwt 必须拿到带 azp 的 JWT", async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers, body: init.body }
    return json({ jwt: sessionJwt })
  }
  const result = await mintSessionJwt(fetchImpl, { clientJwt: "client.jwt.x", sessionId: "sess_1" })
  assert.equal(result, sessionJwt)
  assert.equal(seen.url, "https://clerk.capy.ai/v1/client/sessions/sess_1/tokens")
  assert.equal(seen.headers.origin, AZP)
  assert.match(seen.headers.cookie, /^__client=/)
  assert.equal(seen.body, "{}")
})

test("mintSessionJwt 没有 azp 时报 401（不能用它调 /app）", async () => {
  const noAzp = jwt({ sid: "sess_1", sub: "user_1" })
  const fetchImpl = async () => json({ jwt: noAzp })
  await assert.rejects(
    mintSessionJwt(fetchImpl, { clientJwt: "client.jwt.x", sessionId: "sess_1" }),
    (error) => error.status === 401 && error.code === CODES.signInRequired,
  )
})

test("completeLogin：换票 → 读账号 → 签 API key → 校验（不建项目、不绑定设备）", async () => {
  const calls = []
  const fetchImpl = router([
    [/^POST https:\/\/clerk\.capy\.ai\/v1\/client\/sessions\/sess_1\/tokens$/u, () => {
      calls.push("mint")
      return json({ jwt: sessionJwt })
    }],
    [/^GET https:\/\/api\.capy\.ai\/app\/me$/u, () => {
      calls.push("me")
      return json({ id: "user_1", email: "a@b.c", preferences: { preferredOrgId: "org_1" } })
    }],
    [/^GET https:\/\/api\.capy\.ai\/app\/organizations$/u, () => {
      calls.push("orgs")
      return json([{ id: "org_1" }])
    }],
    [/^POST https:\/\/api\.capy\.ai\/app\/orgs\/org_1\/api-keys$/u, () => {
      calls.push("mintKey")
      return json({ key: { id: "key_1", tokenHint: "capy_…" }, plaintext: key })
    }],
    [/^GET https:\/\/api\.capy\.ai\/api\/v1\/models$/u, () => {
      calls.push("models")
      return json({ items: [{ id: "m" }], default: { modelId: "m" } })
    }],
  ])

  const account = await completeLogin(fetchImpl, {
    clientJwt: "client.jwt.x",
    sessionId: "sess_1",
    orgId: "org_1",
    source: "test",
  })
  assert.equal(account.type, "success")
  assert.equal(account.access, key)
  assert.equal(account.accountId, "a@b.c")
  assert.equal(account.uid, "user_1")
  assert.equal(account.metadata.orgId, "org_1")
  assert.equal(account.metadata.deviceId, undefined)
  assert.equal(account.metadata.deviceName, undefined)
  assert.equal(account.metadata.projectId, undefined)
  assert.match(account.metadata.clientId, /^[0-9a-f]{32}$/u)
  const refresh = parseRefresh(account.refresh)
  assert.equal(refresh.clientJwt, "client.jwt.x")
  assert.equal(refresh.orgId, "org_1")
  assert.equal(refresh.deviceId, "")
  assert.equal(refresh.clientId, account.metadata.clientId)
  assert.ok(account.expires > Date.now())
  assert.deepEqual(calls, ["mint", "me", "orgs", "mintKey", "models"])
})

test("ensureProject 优先复用已有 Magpie 项目", async () => {
  const fetchImpl = async () => json([
    { id: "project_other", name: "Other", code: "OTHR" },
    { id: "project_magpie", name: "Magpie", code: "MAGP" },
  ])
  const projectId = await ensureProject(fetchImpl, "jwt", "org_1")
  assert.equal(projectId, "project_magpie")
})

test("ensureProject 指定的项目被删后回退到列表第一个", async () => {
  const fetchImpl = async () => json([{ id: "project_1", name: "X", code: "XXXX" }])
  const projectId = await ensureProject(fetchImpl, "jwt", "org_1", { projectId: "project_gone" })
  assert.equal(projectId, "project_1")
})

test("mintApiKey 没有 plaintext 时报 502", async () => {
  const fetchImpl = async () => json({ key: { id: "key_1" } })
  await assert.rejects(
    mintApiKey(fetchImpl, "jwt", "org_1"),
    (error) => error.status === 502 && /明文/u.test(error.message),
  )
})

test("validateApiKey 401 → 未通过；网络错误不算失效", async () => {
  const unauthorized = async () => json({ _tag: "capy/Unauthorized" }, 401)
  assert.equal((await validateApiKey(unauthorized, key)).ok, false)

  const network = async () => { throw new Error("ECONNRESET") }
  const result = await validateApiKey(network, key)
  assert.equal(result.ok, true)
  assert.equal(result.status, 0)
})

test("refreshCredential：当前 key 有效 → 续期同一个 key", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/v1/models")) return json({ items: [{ id: "m" }] })
    return json({ _tag: "capy/RouteNotFound" }, 404)
  }
  const auth = {
    access: key,
    refresh: encodeRefresh({ clientJwt: "client.jwt.x", sessionId: "sess_1", orgId: "org_1", projectId: "project_1" }),
  }
  const renewed = await refreshCredential(fetchImpl, auth)
  assert.equal(renewed.access, key)
  assert.ok(renewed.expires > Date.now())
})

test("refreshCredential：key 失效 → 用 Clerk 会话重新签发", async () => {
  let modelCalls = 0
  const fetchImpl = router([
    [/^GET https:\/\/api\.capy\.ai\/api\/v1\/models$/u, () => {
      modelCalls += 1
      if (modelCalls === 1) return json({ _tag: "capy/Unauthorized" }, 401)
      return json({ items: [{ id: "m" }] })
    }],
    [/^POST https:\/\/clerk\.capy\.ai\/v1\/client\/sessions\/sess_1\/tokens$/u, () => json({ jwt: sessionJwt })],
    [/^GET https:\/\/api\.capy\.ai\/app\/me$/u, () => json({ id: "user_1", email: "a@b.c" })],
    [/^GET https:\/\/api\.capy\.ai\/app\/organizations$/u, () => json([{ id: "org_1" }])],
    [/^GET https:\/\/api\.capy\.ai\/app\/orgs\/org_1\/devices$/u, () => json([{ id: "device_1", name: "baijiu", connected: true }])],
    [/^POST https:\/\/api\.capy\.ai\/app\/orgs\/org_1\/api-keys$/u, () => json({ key: { id: "key_2" }, plaintext: key })],
  ])
  const auth = {
    access: key,
    refresh: encodeRefresh({
      clientJwt: "client.jwt.x",
      sessionId: "sess_1",
      orgId: "org_1",
      deviceId: "device_1",
      clientId: "c".repeat(32),
    }),
  }
  const renewed = await refreshCredential(fetchImpl, auth)
  assert.equal(renewed.access, key)
  assert.equal(renewed.metadata.deviceId, "device_1")
  assert.ok(modelCalls >= 2)
})

test("parseRefresh 拒绝空 / 非 JSON / 缺字段", () => {
  assert.equal(parseRefresh(""), null)
  assert.equal(parseRefresh("not-json"), null)
  assert.equal(parseRefresh(JSON.stringify({ sessionId: "s" })), null)
  assert.equal(parseRefresh(JSON.stringify({ clientJwt: "c", sessionId: "s" })).clientJwt, "c")
})
