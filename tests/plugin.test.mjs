import test from "node:test"
import assert from "node:assert/strict"

import { CapyAuthPlugin, _internal } from "../index.mjs"

const AZP = "https://capy.ai"
const sessionJwt = (() => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify({ azp: AZP, sid: "sess_1", sub: "user_1", exp: 9999999999 })).toString("base64url")
  return `${header}.${body}.sig`
})()

const fakeAuth = {
  access: `capy_${"a".repeat(43)}`,
  refresh: JSON.stringify({
    v: 1,
    clientJwt: "client.jwt.x",
    sessionId: "sess_1",
    orgId: "org_1",
    deviceId: "device_1",
    clientId: "c".repeat(32),
    userId: "user_1",
  }),
  expires: Date.now() + 86400_000,
  accountId: "a@b.c",
  uid: "user_1",
  metadata: {
    orgId: "org_1",
    deviceId: "device_1",
    deviceName: "baijiu",
    clientId: "c".repeat(32),
    userId: "user_1",
    source: "test",
  },
}

const catalogBody = {
  items: [
    { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", reasoningModes: ["low", "medium", "high"] },
    { id: "openai/gpt-5.5", name: "GPT-5.5", reasoningModes: ["none", "high"] },
  ],
  default: { modelId: "anthropic/claude-haiku-4-5" },
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function sseResponse(chunks) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })
}

function fetchForTests({ credits = false } = {}) {
  let jamId = "jam_1"
  return async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase()
    if (url.endsWith("/v1/client/sessions/sess_1/tokens")) return json({ jwt: sessionJwt })
    if (url.endsWith("/api/v1/models")) return json(catalogBody)
    if (url.endsWith("/app/orgs/org_1/devices")) {
      return json([{ id: "device_1", name: "baijiu", connected: true }])
    }
    if (url.endsWith("/app/orgs/org_1/jams") && method === "POST") {
      const body = JSON.parse(init.body)
      jamId = body.jamId
      return json({
        id: jamId,
        status: "idle",
        projectId: null,
        primaryMachine: { kind: "device", machineId: "machine_1", name: "baijiu" },
        model: body.model,
      })
    }
    if (url.includes(`/app/orgs/org_1/jams/${jamId}/events/outline`)) {
      return json({ items: credits ? [] : [{ id: "e1", text: "ping", answer: "pong" }] })
    }
    if (url.includes(`/app/orgs/org_1/jams/${jamId}`) && !url.includes("/interrupt")) {
      return json({
        id: jamId,
        status: "idle",
        ...(credits ? { ask: { kind: "credits", text: "Add credits" } } : {}),
      })
    }
    if (url.endsWith("/api/v1/usage")) {
      return json({ totals: { totalDollars: 0 }, tokens: { inputTokens: 10, outputTokens: 2 } })
    }
    if (url.endsWith("/api/v1/usage/balance")) {
      return json({ currency: "USD", remainingDollars: null, unlimited: false })
    }
    return json({ _tag: "capy/RouteNotFound" }, 404)
  }
}

const fakeHeadless = async () => ({ deviceId: "device_1", name: "baijiu" })

test("config 声明 provider + 64 个静态模型", async () => {
  const plugin = await CapyAuthPlugin({}, { proxy: false, headless: fakeHeadless, fetch: fetchForTests() })
  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider.capy.name, "Capy")
  assert.equal(cfg.provider.capy.npm, "@ai-sdk/openai-compatible")
  assert.equal(cfg.provider.capy.api, "https://api.capy.ai/api/v1")
  assert.equal(Object.keys(cfg.provider.capy.models).length, 64)
})

test("auth.methods 只有一条：浏览器登录", async () => {
  const plugin = await CapyAuthPlugin({}, { proxy: false, headless: fakeHeadless, fetch: fetchForTests() })
  assert.equal(plugin.auth.provider, "capy")
  assert.equal(plugin.auth.methods.length, 1)
  assert.match(plugin.auth.methods[0].label, /浏览器/u)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(plugin.auth.checkin, undefined)
})

test("loader：GET /models 返回 OpenAI 形状", async () => {
  const plugin = await CapyAuthPlugin({}, { proxy: false, headless: fakeHeadless, fetch: fetchForTests() })
  const loader = await plugin.auth.loader(async () => fakeAuth)
  const response = await loader.fetch("https://api.capy.ai/api/v1/models", { method: "GET" })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.length, 4)
  assert.equal(body.data[0].object, "model")
})

test("loader：/chat/completions（非流式）返回 assistant 文本", async () => {
  const plugin = await CapyAuthPlugin({}, { proxy: false, headless: fakeHeadless, fetch: fetchForTests() })
  const loader = await plugin.auth.loader(async () => fakeAuth)
  const response = await loader.fetch("https://api.capy.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.object, "chat.completion")
  assert.equal(body.choices[0].message.role, "assistant")
  assert.equal(body.choices[0].message.content, "pong")
})

test("loader：本机设备线程被 credits 拦住时 402 + insufficient_quota（非流式）", async () => {
  const plugin = await CapyAuthPlugin({}, { proxy: false, headless: fakeHeadless, fetch: fetchForTests({ credits: true }) })
  const loader = await plugin.auth.loader(async () => fakeAuth)
  const response = await loader.fetch("https://api.capy.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    }),
  })
  assert.equal(response.status, 402)
  const body = await response.json()
  assert.equal(body.error.code, "insufficient_quota")
})

test("loader：未知端点 501，未知模型 404", async () => {
  const plugin = await CapyAuthPlugin({}, { proxy: false, headless: fakeHeadless, fetch: fetchForTests() })
  const loader = await plugin.auth.loader(async () => fakeAuth)

  const missing = await loader.fetch("https://api.capy.ai/api/v1/embeddings", { method: "POST", body: "{}" })
  assert.equal(missing.status, 501)

  const badModel = await loader.fetch("https://api.capy.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    }),
  })
  assert.equal(badModel.status, 404)
  const body = await badModel.json()
  assert.equal(body.error.code, "model_not_found")
})

test("usage 钩子：无余额 → used=100 的余额窗口", async () => {
  const plugin = await CapyAuthPlugin({}, { proxy: false, headless: fakeHeadless, fetch: fetchForTests() })
  const usage = await plugin.auth.usage(async () => fakeAuth)
  assert.equal(usage.windows[0].name, "余额")
  assert.equal(usage.windows[0].used, 100)
  assert.ok(usage.windows.every((item) => Number.isFinite(item.used)))
})

test("provider.models：有登录态时返回实时目录", async () => {
  const plugin = await CapyAuthPlugin({}, { proxy: false, headless: fakeHeadless, fetch: fetchForTests() })
  const models = await plugin.provider.models({}, { auth: fakeAuth })
  assert.equal(Object.keys(models).length, 4)
  assert.equal(models["openai/gpt-5.5"].providerID, "capy")
})

test("loginErrorText 对 401 / 通用错误给中文文案", () => {
  assert.match(_internal.loginErrorText({ status: 401 }), /重新登录/u)
  assert.match(_internal.loginErrorText(new Error("没有找到 Chromium 浏览器")), /没有找到 Chromium 浏览器/u)
})
