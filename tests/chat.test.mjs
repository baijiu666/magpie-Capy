import test from "node:test"
import assert from "node:assert/strict"

import {
  _internal as chatInternal,
  answerFromOutline,
  buildPrompt,
  chatCompletions,
  createDeviceThread,
  feedSse,
  flattenMessages,
  newJamId,
  resolveDeviceSession,
  runThread,
  streamThread,
  ulid,
  waitForAnswer,
} from "../src/chat.mjs"
import { CODES } from "../src/errors.mjs"

const AZP = "https://capy.ai"

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

const sessionJwt = jwt({ azp: AZP, sid: "sess_1", sub: "user_1", exp: 9999999999 })
const auth = {
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
  metadata: { orgId: "org_1", deviceId: "device_1", clientId: "c".repeat(32), userId: "user_1" },
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function appRouter({ credits = false } = {}) {
  let jamId = "jam_1"
  return async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase()
    if (url.endsWith("/v1/client/sessions/sess_1/tokens")) return json({ jwt: sessionJwt })
    if (url.endsWith("/app/orgs/org_1/devices")) {
      return json([{ id: "device_1", name: "baijiu", connected: true }])
    }
    if (url.endsWith("/app/orgs/org_1/jams") && method === "POST") {
      const body = JSON.parse(init.body)
      jamId = body.jamId || newJamId()
      return json({
        id: jamId,
        status: "idle",
        projectId: null,
        primaryMachine: { kind: "device", machineId: "machine_1", name: "baijiu" },
        model: body.model,
      })
    }
    if (url.includes(`/app/orgs/org_1/jams/${jamId}/events/outline`)) {
      return json({ items: credits ? [] : [{ id: "e1", text: "prompt", answer: "pong" }] })
    }
    if (url.includes(`/app/orgs/org_1/jams/${jamId}`)) {
      return json({
        id: jamId,
        status: credits ? "idle" : "idle",
        ...(credits ? { ask: { kind: "credits", text: "Add credits" } } : {}),
      })
    }
    if (url.includes(`/app/orgs/org_1/jams/${jamId}/interrupt`)) {
      return json({ id: "ok", deduped: false })
    }
    return json({ _tag: "capy/RouteNotFound" }, 404)
  }
}

test("buildPrompt 保留 system / user / assistant / tool 的角色标记", () => {
  const text = flattenMessages([
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "tool", name: "read", content: "file body" },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ])
  assert.match(text, /<system>\nbe terse\n<\/system>/)
  assert.match(text, /<user>\nhello\n<\/user>/)
  assert.match(text, /<assistant>\nhi\n<\/assistant>/)
  assert.match(text, /<tool name="read">\nfile body\n<\/tool>/)
  assert.match(text, /<user>\ncontinue\n<\/user>/)
})

test("buildPrompt 单条 user 消息原样发送（不额外包提示词）", () => {
  assert.equal(flattenMessages([{ role: "user", content: "  Reply with pong  " }]), "Reply with pong")
  assert.equal(
    flattenMessages([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
    ]),
    "<system>\nbe terse\n</system>\n\n<user>\nhello\n</user>",
  )
})

test("buildPrompt 最后一条是 assistant 时要求续写", () => {
  const text = flattenMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "partial" },
  ])
  assert.match(text, /Continue the last assistant message/)
})

test("flattenMessages 空 messages / 只有 system 报 400", () => {
  assert.throws(() => flattenMessages([]), (error) => error.status === 400 && error.code === CODES.invalidRequest)
  assert.throws(
    () => flattenMessages([{ role: "system", content: "x" }]),
    (error) => error.status === 400 && error.code === CODES.invalidRequest,
  )
})

test("ulid 是 26 位 Crockford base32；jamId 带 jam_ 前缀", () => {
  const value = ulid()
  assert.equal(value.length, 26)
  assert.match(value, /^[0-9A-HJKMNP-TV-Z]{26}$/u)
  assert.match(newJamId(), /^jam_[0-9A-HJKMNP-TV-Z]{26}$/u)
})

test("createDeviceThread 发 projectless + device/worktree + 真 ULID", async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), headers: init.headers }
    return json({
      id: seen.body.jamId,
      status: "idle",
      projectId: null,
      primaryMachine: { kind: "device" },
    })
  }
  const thread = await createDeviceThread(fetchImpl, {
    jwt: "jwt",
    orgId: "org_1",
    deviceId: "device_1",
    clientId: "c".repeat(32),
    message: "hello",
    modelId: "particle/particle-1",
    reasoningMode: "medium",
  })
  assert.equal(thread.primaryMachine.kind, "device")
  assert.equal(seen.url, "https://api.capy.ai/app/orgs/org_1/jams")
  assert.equal(seen.body.projectId, undefined)
  assert.equal(seen.body.device.deviceId, "device_1")
  assert.deepEqual(seen.body.device.workspace, { kind: "worktree" })
  assert.equal(seen.body.model.modelId, "particle/particle-1")
  assert.equal(seen.body.model.reasoningMode, "medium")
  assert.match(seen.body.jamId, /^jam_[0-9A-HJKMNP-TV-Z]{26}$/u)
  assert.match(seen.body.requestId, /^[0-9A-HJKMNP-TV-Z]{26}$/u)
  assert.equal(seen.body.clientKey, seen.body.requestId)
  assert.equal(seen.headers["x-capy-client-surface"], "desktop")
  assert.doesNotMatch(seen.headers["x-capy-client-features"], /ads-models/u)
})

test("createDeviceThread 对 free-with-ads 模型声明 ads-models 能力位", async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { body: JSON.parse(init.body), headers: init.headers }
    return json({
      id: seen.body.jamId,
      status: "idle",
      projectId: null,
      primaryMachine: { kind: "device" },
    })
  }
  await createDeviceThread(fetchImpl, {
    jwt: "jwt",
    orgId: "org_1",
    deviceId: "device_1",
    message: "hello",
    modelId: "zai/glm-5.3-flash-ads",
  })
  assert.match(seen.headers["x-capy-client-features"], /ads-models/u)
  assert.equal(seen.body.model.modelId, "zai/glm-5.3-flash-ads")
})

test("createDeviceThread 传 promptVariant=minimal；403 时给出可重试的错误", async () => {
  let seen = null
  const okFetch = async (url, init) => {
    seen = JSON.parse(init.body)
    return json({
      id: seen.jamId,
      status: "idle",
      projectId: null,
      primaryMachine: { kind: "device" },
    })
  }
  await createDeviceThread(okFetch, {
    jwt: "jwt",
    orgId: "org_1",
    deviceId: "device_1",
    message: "hello",
    promptVariant: "minimal",
  })
  assert.equal(seen.promptVariant, "minimal")

  const forbidden = async () => json({ _tag: "capy/Forbidden" }, 403)
  await assert.rejects(
    createDeviceThread(forbidden, {
      jwt: "jwt",
      orgId: "org_1",
      deviceId: "device_1",
      message: "hello",
      promptVariant: "minimal",
    }),
    (error) => error.status === 403 && error.code === "prompt_variant_forbidden",
  )
})

test("feedSse 解析 assistant / transcript 帧（含 CRLF）", () => {
  const first = feedSse("", "event: assistant\r\ndata: {\"callId\":\"c1\",\"text\":\"po\"}\r\n\r\n")
  assert.equal(first.frames.length, 1)
  assert.equal(first.frames[0].event, "assistant")
  assert.equal(first.rest, "")
  const second = feedSse("", "event: assistant\ndata: {\"callId\":\"c1\",\"text\":\"pong\"}\n\n")
  assert.equal(second.frames[0].event, "assistant")
})

test("streamThread 边收 assistant 帧边回调，并用 transcript 校正最终文本", async () => {
  const fetchImpl = async () => new Response([
    "event: status\ndata: {\"status\":\"working\"}\n\n",
    "event: assistant\ndata: {\"callId\":\"c1\",\"text\":\"po\"}\n\n",
    "event: assistant\ndata: {\"callId\":\"c1\",\"text\":\"pong\"}\n\n",
    "event: transcript\ndata: {\"source\":\"assistant\",\"text\":\"pong\",\"callId\":\"c1\"}\n\n",
    "event: done\ndata: {}\n\n",
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
  const deltas = []
  const result = await streamThread(fetchImpl, {
    apiKey: `capy_${"a".repeat(43)}`,
    threadId: "jam_1",
    onDelta: (text) => deltas.push(text),
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, "pong")
  assert.deepEqual(deltas, ["po", "ng"])
})

test("streamThread 把 region_unsupported 归一成 403", async () => {
  const fetchImpl = async () => new Response(
    "event: error\ndata: {\"code\":\"region_unsupported\",\"message\":\"only US\"}\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
  await assert.rejects(
    streamThread(fetchImpl, { apiKey: `capy_${"a".repeat(43)}`, threadId: "jam_1" }),
    (error) => error.status === 403 && error.code === "region_unsupported",
  )
})

test("createDeviceThread 如果上游回云端机器，明确报错（不假装本机）", async () => {
  const fetchImpl = async () => json({
    id: "jam_1",
    primaryMachine: { kind: "cloud" },
  })
  await assert.rejects(
    createDeviceThread(fetchImpl, { jwt: "j", orgId: "org_1", deviceId: "device_1", message: "x" }),
    (error) => error.status === 503 && /本机设备/u.test(error.message),
  )
})

test("resolveDeviceSession 选中已连接设备；没有设备时 503", async () => {
  const session = await resolveDeviceSession(appRouter(), auth)
  assert.equal(session.orgId, "org_1")
  assert.equal(session.device.id, "device_1")

  const noDevice = async (url) => {
    if (url.endsWith("/v1/client/sessions/sess_1/tokens")) return json({ jwt: sessionJwt })
    if (url.endsWith("/app/orgs/org_1/devices")) return json([])
    return json({}, 404)
  }
  await assert.rejects(
    resolveDeviceSession(noDevice, auth),
    (error) => error.status === 503 && /桌面端/u.test(error.message),
  )
})

test("waitForAnswer 从 outline 取最终 answer", async () => {
  const result = await waitForAnswer(appRouter(), {
    jwt: "jwt",
    orgId: "org_1",
    threadId: "jam_1",
    timeoutMs: 5000,
  })
  assert.equal(result.text, "pong")
})

test("answerFromOutline 取最后一条有 answer 的轮次", () => {
  assert.equal(answerFromOutline([
    { text: "a", answer: "first" },
    { text: "b", answer: "second" },
  ]), "second")
  assert.equal(answerFromOutline([]), "")
})

test("runThread：换票 → 建本机线程 → 等回答", async () => {
  const result = await runThread(appRouter(), auth, { prompt: "ping", modelId: "particle/particle-1" })
  assert.equal(result.text, "pong")
  assert.equal(result.thread.primaryMachine.kind, "device")
})

test("runThread：minimal 提示词 403 时自动降级并重试", async () => {
  const attempts = []
  let jamId = ""
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase()
    if (url.endsWith("/v1/client/sessions/sess_1/tokens")) return json({ jwt: sessionJwt })
    if (url.endsWith("/app/orgs/org_1/devices")) return json([{ id: "device_1", name: "baijiu", connected: true }])
    if (url.endsWith("/app/orgs/org_1/jams") && method === "POST") {
      const body = JSON.parse(init.body)
      attempts.push(body.promptVariant)
      if (body.promptVariant === "minimal") return json({ _tag: "capy/Forbidden" }, 403)
      jamId = body.jamId
      return json({
        id: jamId,
        status: "idle",
        projectId: null,
        primaryMachine: { kind: "device" },
      })
    }
    if (url.includes(`/app/orgs/org_1/jams/${jamId}/events/outline`)) {
      return json({ items: [{ id: "e1", text: "ping", answer: "pong" }] })
    }
    if (url.includes(`/app/orgs/org_1/jams/${jamId}`)) return json({ id: jamId, status: "idle" })
    return json({ _tag: "capy/RouteNotFound" }, 404)
  }
  let fellBack = false
  const result = await runThread(fetchImpl, auth, {
    prompt: "ping",
    modelId: "particle/particle-1",
    promptVariant: "minimal",
    onVariantFallback: () => { fellBack = true },
  })
  assert.equal(result.text, "pong")
  assert.equal(fellBack, true)
  assert.deepEqual(attempts, ["minimal", undefined])
})

test("chatCompletions（非流式）返回 OpenAI JSON", async () => {
  const response = await chatCompletions({
    fetchImpl: appRouter(),
    auth,
    body: { messages: [{ role: "user", content: "ping" }] },
    stream: false,
    modelId: "particle/particle-1",
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.choices[0].message.content, "pong")
})

test("chatCompletions（流式）发 role + content + stop + [DONE]", async () => {
  const response = await chatCompletions({
    fetchImpl: appRouter(),
    auth,
    body: { messages: [{ role: "user", content: "ping" }] },
    stream: true,
    modelId: "particle/particle-1",
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /"role":"assistant"/)
  assert.match(text, /"content":"pong"/)
  assert.match(text, /"finish_reason":"stop"/)
  assert.match(text, /data: \[DONE\]/)
})

test("buildPrompt 带 tools 时附加工具说明", () => {
  const text = buildPrompt([{ role: "user", content: "weather?" }], {
    tools: [{
      type: "function",
      function: { name: "get_weather", parameters: { type: "object", properties: {} } },
    }],
  })
  assert.match(text, /weather\?/)
  assert.match(text, /# Tools/)
  assert.match(text, /get_weather/)
})

test("openAiToolCompletion / openAiToolChunk 输出标准 tool_calls", async () => {
  const completion = chatInternal.openAiToolCompletion("id", "m", [
    { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
  ])
  assert.equal(completion.choices[0].finish_reason, "tool_calls")
  assert.equal(completion.choices[0].message.content, null)
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "get_weather")

  const chunk = chatInternal.openAiToolChunk("id", "m", [
    { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
  ])
  assert.match(chunk, /"tool_calls"/)
  assert.match(chunk, /get_weather/)
})

test("chatCompletions 余额不足时抛 402（非流式）", async () => {
  await assert.rejects(
    chatCompletions({
      fetchImpl: appRouter({ credits: true }),
      auth,
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      modelId: "particle/particle-1",
    }),
    (error) => error.status === 402 && error.code === CODES.insufficientQuota,
  )
})
