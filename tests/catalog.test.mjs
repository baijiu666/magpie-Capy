import test from "node:test"
import assert from "node:assert/strict"

import {
  fetchCatalog,
  isAdsModel,
  isFreeModel,
  modelEntry,
  modelsResponse,
  reasoningModeOf,
  resolveModel,
  staticModels,
} from "../src/catalog.mjs"
import { CODES } from "../src/errors.mjs"
import { TOOL_SHIM } from "../src/constants.mjs"

const catalog = {
  models: {
    "anthropic/claude-haiku-4-5": modelEntry({
      id: "anthropic/claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoningModes: ["low", "medium", "high"],
    }),
    "openai/gpt-5.5": modelEntry({
      id: "openai/gpt-5.5",
      name: "GPT-5.5",
      reasoningModes: ["none", "high"],
    }),
  },
  defaultModelId: "anthropic/claude-haiku-4-5",
}

test("resolveModel：精确匹配 / 带 capy 前缀 / 短名 / 展示名", () => {
  assert.equal(resolveModel("anthropic/claude-haiku-4-5", catalog), "anthropic/claude-haiku-4-5")
  assert.equal(resolveModel("capy/anthropic/claude-haiku-4-5", catalog), "anthropic/claude-haiku-4-5")
  assert.equal(resolveModel("gpt-5.5", catalog), "openai/gpt-5.5")
  assert.equal(resolveModel("Claude Haiku 4.5", catalog), "anthropic/claude-haiku-4-5")
})

test("resolveModel：空 model 用默认；未知 model 必须 404（绝不静默替换）", () => {
  assert.equal(resolveModel("", catalog), "anthropic/claude-haiku-4-5")
  assert.throws(
    () => resolveModel("gpt-4o", catalog),
    (error) => error.status === 404 && error.code === CODES.modelNotFound,
  )
})

test("resolveModel：free-with-ads 模型现在可直接解析（插件走 App 设备线程）", () => {
  const models = staticModels()
  assert.equal(
    resolveModel("deepseek/deepseek-v4.1-flash-ads", { models, defaultModelId: "particle/particle-1" }),
    "deepseek/deepseek-v4.1-flash-ads",
  )
  assert.equal(
    resolveModel("zai/glm-5.3-flash-ads", { models, defaultModelId: "particle/particle-1" }),
    "zai/glm-5.3-flash-ads",
  )
  assert.equal(isAdsModel("zai/glm-5.3-flash-ads"), true)
  assert.equal(isAdsModel("particle/particle-1"), false)
})

test("reasoningModeOf 只返回该模型支持的档位", () => {
  assert.equal(reasoningModeOf({ reasoning_effort: "HIGH" }, "openai/gpt-5.5", catalog), "high")
  assert.equal(reasoningModeOf({ reasoning_effort: "max" }, "openai/gpt-5.5", catalog), "")
  assert.equal(reasoningModeOf({}, "openai/gpt-5.5", catalog), "")
})

test("staticModels 未登录也有 64 个模型，图片/附件/工具能力写全", () => {
  const models = staticModels()
  assert.equal(Object.keys(models).length, 64)
  const entry = models["anthropic/claude-haiku-4-5"]
  assert.equal(entry.capabilities.input.image, true)
  assert.equal(entry.capabilities.attachment, true)
  assert.equal(entry.capabilities.toolcall, TOOL_SHIM)
  assert.equal(entry.tool_call, TOOL_SHIM)
  assert.deepEqual(entry.modalities.input, ["text", "image"])
  assert.ok(entry.variants.medium)
})

test("三个 $0.00 模型标 free，其余标 false", () => {
  const models = staticModels()
  assert.equal(models["particle/particle-1"].free, true)
  assert.equal(models["zai/glm-5.3-flash-ads"].free, true)
  assert.equal(models["deepseek/deepseek-v4.1-flash-ads"].free, true)
  assert.equal(models["openai/gpt-5.5"].free, false)
  assert.equal(isFreeModel("particle/particle-1"), true)
  assert.equal(isFreeModel("openai/gpt-5.5"), false)
  assert.equal(modelEntry({ id: "deepseek/deepseek-v4.1-flash-ads" }).free, true)
})

test("三个免费模型排在目录最前（避免 /v1/models 截断时消失）", () => {
  const models = Object.values(staticModels())
  assert.deepEqual(models.slice(0, 3).map((item) => item.id).sort(), [
    "deepseek/deepseek-v4.1-flash-ads",
    "particle/particle-1",
    "zai/glm-5.3-flash-ads",
  ])
  assert.ok(models.slice(0, 3).every((item) => item.free === true))
})

test("provider.models 条目是 OpenCode Model 形状", () => {
  const entry = modelEntry({
    id: "x/y",
    name: "Y",
    reasoningModes: ["low"],
  })
  assert.equal(entry.providerID, "capy")
  assert.equal(entry.capabilities.toolcall, TOOL_SHIM)
  assert.equal(entry.capabilities.attachment, true)
  assert.equal(entry.capabilities.input.image, true)
  assert.equal(entry.api.url, "https://api.capy.ai/api/v1")
  assert.ok(entry.variants.low)
})

test("modelsResponse 返回 OpenAI /v1/models 形状（静态表也带 id）", async () => {
  const response = modelsResponse(staticModels())
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.object, "list")
  assert.equal(body.data.length, 64)
  assert.ok(body.data.every((item) => typeof item.id === "string" && item.id.includes("/")))
})

test("fetchCatalog 解析 {items, default} 并缓存；401 归一成 signInRequired", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(JSON.stringify({
      items: [{ id: "a/b", name: "B", reasoningModes: ["low"] }],
      default: { modelId: "a/b" },
    }), { status: 200 })
  }
  const first = await fetchCatalog(fetchImpl, { apiKey: "capy_key_1" })
  // 实时目录 1 个 + 公共 /models 不返回的 2 个 free-with-ads 模型
  assert.equal(Object.keys(first.models).length, 3)
  assert.equal(first.models["zai/glm-5.3-flash-ads"].free, true)
  assert.equal(first.models["deepseek/deepseek-v4.1-flash-ads"].free, true)
  assert.equal(first.defaultModelId, "a/b")
  await fetchCatalog(fetchImpl, { apiKey: "capy_key_1" })
  assert.equal(calls, 1, "第二次应命中缓存")

  const unauthorized = async () => new Response(JSON.stringify({ _tag: "capy/Unauthorized" }), { status: 401 })
  await assert.rejects(
    fetchCatalog(unauthorized, { apiKey: "capy_key_2" }),
    (error) => error.status === 401 && error.code === CODES.signInRequired,
  )
})
