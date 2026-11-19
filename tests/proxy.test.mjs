import test from "node:test"
import assert from "node:assert/strict"

import {
  createProxyFetch,
  normalizeProxyUrl,
  resolveProxyUrl,
  _internal,
} from "../src/proxy.mjs"

test("normalizeProxyUrl：裸 host:port / 系统代理串 / off", () => {
  assert.equal(normalizeProxyUrl("127.0.0.1:7890"), "http://127.0.0.1:7890")
  assert.equal(normalizeProxyUrl("http=127.0.0.1:7890;https=127.0.0.1:7891"), "http://127.0.0.1:7891")
  assert.equal(normalizeProxyUrl("off"), "")
  assert.equal(normalizeProxyUrl(""), "")
})

test("resolveProxyUrl：显式 > 环境变量；proxy:false 关闭", () => {
  assert.equal(
    resolveProxyUrl({ env: { HTTPS_PROXY: "127.0.0.1:7890" } }),
    "http://127.0.0.1:7890",
  )
  assert.equal(
    resolveProxyUrl({ proxy: "http://10.0.0.1:1080", env: { HTTPS_PROXY: "127.0.0.1:7890" } }),
    "http://10.0.0.1:1080",
  )
  assert.equal(resolveProxyUrl({ proxy: false, env: { HTTPS_PROXY: "127.0.0.1:7890" } }), "")
})

test("NO_PROXY 匹配本地/后缀", () => {
  assert.equal(_internal.hostMatchesNoProxy("api.capy.ai", "capy.ai"), true)
  assert.equal(_internal.hostMatchesNoProxy("api.capy.ai", ".capy.ai"), true)
  assert.equal(_internal.hostMatchesNoProxy("api.capy.ai", "*"), true)
  assert.equal(_internal.hostMatchesNoProxy("api.capy.ai", "example.com"), false)
})

test("createProxyFetch 在 Bun 下把 proxy 传给 fetch", async () => {
  const previous = globalThis.Bun
  globalThis.Bun = {}
  try {
    let seen = null
    const base = async (input, init) => {
      seen = init
      return new Response("ok")
    }
    const wrapped = createProxyFetch(base, "http://127.0.0.1:7890")
    await wrapped("https://api.capy.ai/api/v1/models", { method: "GET" })
    assert.equal(seen.proxy, "http://127.0.0.1:7890")
  } finally {
    if (previous === undefined) delete globalThis.Bun
    else globalThis.Bun = previous
  }
})

test("createProxyFetch 没有代理时直接调用原 fetch", async () => {
  let calls = 0
  const base = async () => {
    calls += 1
    return new Response("ok")
  }
  const wrapped = createProxyFetch(base, "")
  await wrapped("https://api.capy.ai/api/v1/models", {})
  assert.equal(calls, 1)
})
