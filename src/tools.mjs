// OpenAI tools → Capy agent 的兼容桥。
//
// Capy 的线程协议没有 OpenAI 原生 tool 通道（CreateJamRequest / SendMessageRequest
// 都没有 tools 字段，agent 的 tool_call 事件只给一行摘要，没有 arguments）。
// 所以这里做的是**提示词级 best effort**：
//   1. 把 body.tools 的 name/description/parameters 写进提示词；
//   2. 要求模型需要调用时只输出一个 JSON：
//      {"tool_calls":[{"name":"...","arguments":{...}}]}
//   3. 插件解析这段 JSON，转成 OpenAI 的 tool_calls（非流式/流式都支持）。
//
// 实测 particle/particle-1 能按这个格式调用一个 get_weather 工具。复杂 schema
// 或多工具选择可能不稳定；它不改变 Capy agent 自己的内部工具。

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu

function functionOf(tool) {
  const fn = tool?.function ?? tool
  if (!fn || typeof fn !== "object") return null
  const name = String(fn.name ?? "").trim()
  if (!name) return null
  return {
    name,
    description: String(fn.description ?? "").trim(),
    parameters: fn.parameters ?? fn.input_schema ?? fn.inputSchema ?? { type: "object", properties: {} },
  }
}

export function toolDefsOf(tools) {
  return (Array.isArray(tools) ? tools : []).map(functionOf).filter(Boolean)
}

export function hasTools(body) {
  if (String(body?.tool_choice ?? "") === "none") return false
  return toolDefsOf(body?.tools).length > 0
}

function forcedName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return ""
  return String(toolChoice?.function?.name ?? toolChoice?.name ?? "").trim()
}

/** 追加到 prompt 末尾的工具说明；没有工具时返回 ""。 */
export function toolInstruction(tools, toolChoice = "auto") {
  const defs = toolDefsOf(tools)
  if (!defs.length) return ""
  const forced = forcedName(toolChoice)
  const required = forced || String(toolChoice ?? "") === "required"
  const lines = [
    "# Tools",
    "You can call these tools when the user's request needs them:",
    JSON.stringify(defs, null, 2),
    "",
    "To call a tool, reply with exactly one JSON object and nothing else:",
    "{\"tool_calls\":[{\"name\":\"<tool_name>\",\"arguments\":{}}]}",
    "Do not wrap the JSON in a code fence. Do not add text before or after it.",
    "If no tool is needed, answer normally in text.",
  ]
  if (forced) lines.push(`You must call the tool "${forced}" now.`)
  else if (required) lines.push("You must call at least one tool now.")
  return lines.join("\n")
}

function normalizeArguments(value) {
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return "{}"
    try {
      const parsed = JSON.parse(text)
      return JSON.stringify(parsed ?? {})
    } catch {
      return text
    }
  }
  if (value === undefined || value === null) return "{}"
  try { return JSON.stringify(value) } catch { return "{}" }
}

function normalizeCalls(value) {
  let raw = []
  if (Array.isArray(value?.tool_calls)) raw = value.tool_calls
  else if (Array.isArray(value?.calls)) raw = value.calls
  else if (Array.isArray(value)) raw = value
  else if (value && typeof value === "object" && (value.name || value.function?.name)) raw = [value]
  const calls = []
  for (const item of raw) {
    const fn = item?.function ?? item
    const name = String(fn?.name ?? "").trim()
    if (!name) continue
    const args = fn?.arguments ?? fn?.parameters ?? fn?.input ?? {}
    calls.push({ name, arguments: normalizeArguments(args) })
  }
  return calls.length ? calls : null
}

function tryJson(text) {
  const trimmed = String(text ?? "").trim()
  if (!trimmed) return null
  const unfenced = FENCE.exec(trimmed)?.[1]?.trim() ?? trimmed
  try {
    return JSON.parse(unfenced)
  } catch {
    return null
  }
}

/** 从 `{` 开始找平衡的 JSON 对象（处理字符串里的括号/转义）。 */
function balancedObjects(text) {
  const out = []
  const source = String(text ?? "")
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i]
      if (inString) {
        if (escape) escape = false
        else if (ch === "\\") escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth += 1
      else if (ch === "}") {
        depth -= 1
        if (depth === 0) {
          out.push(source.slice(start, i + 1))
          start = i
          break
        }
      }
    }
  }
  return out
}

/**
 * 解析模型的工具调用输出。
 * @returns {{ calls: Array<{name: string, arguments: string}> } | null}
 *   arguments 是 JSON 字符串，符合 OpenAI tool_calls 的形状。
 */
export function parseToolCalls(text) {
  const direct = normalizeCalls(tryJson(text))
  if (direct) return { calls: direct }
  for (const candidate of balancedObjects(text)) {
    const calls = normalizeCalls(tryJson(candidate))
    if (calls) return { calls }
  }
  return null
}

/** 生成 OpenAI tool_call id；调用方负责填 index。 */
export function toolCallId() {
  return `call_${Math.random().toString(36).slice(2, 12)}`
}

export const _internal = Object.freeze({
  functionOf,
  normalizeArguments,
  normalizeCalls,
  tryJson,
  balancedObjects,
  FENCE,
})
