import test from "node:test"
import assert from "node:assert/strict"

import { buildUsage, computeUsage } from "../src/usage.mjs"

test("buildUsage：无余额（remainingDollars:null, unlimited:false）→ used=100，让账号沉底", () => {
  const usage = buildUsage(
    { totals: { totalDollars: 0 }, tokens: { inputTokens: 10, outputTokens: 2 } },
    { currency: "USD", remainingDollars: null, unlimited: false, periodStart: null, periodEnd: null },
  )
  assert.equal(usage.windows[0].name, "余额")
  assert.equal(usage.windows[0].used, 100)
  assert.match(usage.windows[0].display, /无可用余额/u)
})

test("buildUsage：有余额 → used=0；只保留 Token aside，不再显示本期消费", () => {
  const usage = buildUsage(
    { totals: { totalDollars: 3.5 }, tokens: { inputTokens: 1500, outputTokens: 200 } },
    { currency: "USD", remainingDollars: 12.25, unlimited: false, periodEnd: "2026-12-01T00:00:00.000Z" },
  )
  assert.equal(usage.windows[0].used, 0)
  assert.match(usage.windows[0].display, /\$12\.25/u)
  assert.equal(usage.windows[0].resetsAt, "2026-12-01T00:00:00.000Z")
  assert.ok(usage.windows.every((item) => item.name !== "本期消费"))
  const aside = usage.windows.filter((item) => item.aside)
  assert.equal(aside.length, 1)
  assert.match(aside[0].name, /Token/u)
  assert.ok(aside.every((item) => item.used === 0 && typeof item.display === "string"))
})

test("buildUsage：unlimited → 无限额度", () => {
  const usage = buildUsage({ totals: { totalDollars: 1 } }, { currency: "USD", unlimited: true })
  assert.equal(usage.windows[0].display, "无限额度")
  assert.equal(usage.windows[0].used, 0)
})

test("每条窗口都有有限 used（路由排序的硬要求）", () => {
  const cases = [
    buildUsage({}, { unlimited: false, remainingDollars: null }),
    buildUsage({}, { unlimited: false, remainingDollars: 0 }),
    buildUsage({}, { unlimited: false, remainingDollars: 5 }),
    buildUsage({ totals: { totalDollars: 0.1 } }, { unlimited: true }),
  ]
  for (const usage of cases) {
    for (const window of usage.windows) {
      assert.equal(Number.isFinite(window.used), true, `${window.name} 缺 used`)
    }
  }
})

test("computeUsage 401 → signIn expired", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ _tag: "capy/Unauthorized" }), { status: 401 })
  const usage = await computeUsage({ fetchImpl, apiKey: "capy_key_usage", cacheKey: "u401" })
  assert.equal(usage.signIn, "expired")
  assert.deepEqual(usage.windows, [])
})

test("computeUsage 网络错误 → error 文本，不抛", async () => {
  const fetchImpl = async () => { throw new Error("offline") }
  const usage = await computeUsage({ fetchImpl, apiKey: "capy_key_usage2", cacheKey: "uerr" })
  assert.match(usage.error, /offline|连接 Capy 失败/u)
  assert.deepEqual(usage.windows, [])
})
