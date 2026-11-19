import test from "node:test"
import assert from "node:assert/strict"

import {
  hasTools,
  parseToolCalls,
  toolCallId,
  toolDefsOf,
  toolInstruction,
} from "../src/tools.mjs"

const tools = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
}]

test("hasTools / toolDefsOf 读 OpenAI tools", () => {
  assert.equal(hasTools({ tools }), true)
  assert.equal(hasTools({ tools, tool_choice: "none" }), false)
  assert.equal(hasTools({ tools: [] }), false)
  assert.equal(toolDefsOf(tools)[0].name, "get_weather")
})

test("toolInstruction 包含工具名和 JSON 调用格式", () => {
  const text = toolInstruction(tools)
  assert.match(text, /get_weather/)
  assert.match(text, /tool_calls/)
  assert.match(text, /arguments/)
  assert.match(toolInstruction(tools, { type: "function", function: { name: "get_weather" } }), /must call the tool "get_weather"/)
})

test("parseToolCalls 解析标准 tool_calls", () => {
  const parsed = parseToolCalls('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}')
  assert.equal(parsed.calls.length, 1)
  assert.equal(parsed.calls[0].name, "get_weather")
  assert.equal(JSON.parse(parsed.calls[0].arguments).city, "Paris")
})

test("parseToolCalls 解析代码围栏 / 前后有说明 / 单个 {name,arguments}", () => {
  const fenced = parseToolCalls('```json\n{"tool_calls":[{"name":"a","arguments":{}}]}\n```')
  assert.equal(fenced.calls[0].name, "a")

  const prose = parseToolCalls('Sure, I will call it.\n{"tool_calls":[{"name":"b","arguments":{"x":1}}]}\nDone.')
  assert.equal(prose.calls[0].name, "b")

  const single = parseToolCalls('{"name":"c","arguments":{"y":2}}')
  assert.equal(single.calls[0].name, "c")
  assert.equal(JSON.parse(single.calls[0].arguments).y, 2)
})

test("parseToolCalls 对普通文本返回 null", () => {
  assert.equal(parseToolCalls("pong"), null)
  assert.equal(parseToolCalls("这不是工具调用，只是 JSON：{\"a\":1}"), null)
})

test("toolCallId 以 call_ 开头", () => {
  assert.match(toolCallId(), /^call_[a-z0-9]+$/u)
})
