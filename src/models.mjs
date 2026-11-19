// Capy /api/v1/models 的静态快照（2026-11-19，62 个）。未登录时 config 钩子必须有内容。
// 字段来源：GET https://api.capy.ai/api/v1/models；加/删模型请同步本文件与 README。
//
// 另外两个「free with ads」模型不在公共 /models 里（只在 App 内可选），
// 单独放在 EXTRA_FREE_MODELS：定价页确认 $0.00，ID 来自 App 模型选择器。

export const DEFAULT_MODEL_ID = "particle/particle-1"

// Capy 定价页（2026-11-19）：
//   Particle-1                        $0.00
//   GLM-5.3-Flash (free with ads)     zai/glm-5.3-flash-ads       $0.00
//   DeepSeek V4.1 Flash (free with ads) deepseek/deepseek-v4.1-flash-ads $0.00
// 其余模型都收费；插件只做 free 布尔标记，不显示倍率/单价。
export const EXTRA_FREE_MODELS = Object.freeze([
  {
    "id": "zai/glm-5.3-flash-ads",
    "name": "GLM-5.3-Flash (Free with ads)",
    "reasoningModes": ["low", "high", "max"],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "free": true,
    "billing": "Capy API · free with ads",
  },
  {
    "id": "deepseek/deepseek-v4.1-flash-ads",
    "name": "DeepSeek V4.1 Flash (Free with ads)",
    "reasoningModes": ["none", "low", "high", "max"],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "free": true,
    "billing": "Capy API · free with ads",
  },
])

export const CATALOG_SNAPSHOT = Object.freeze([
  {
    "id": "anthropic/claude-fable-5",
    "name": "Claude Fable 5",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-fable-5-1",
    "name": "Claude Fable 5.1",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-fable-5-2",
    "name": "Claude Fable 5.2",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-haiku-4-5",
    "name": "Claude Haiku 4.5",
    "reasoningModes": [
      "none",
      "instant",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-haiku-5-5",
    "name": "Claude Haiku 5.5",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-opus-4-5",
    "name": "Claude Opus 4.5",
    "reasoningModes": [
      "none",
      "instant",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-opus-4-6",
    "name": "Claude Opus 4.6",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-opus-4-7",
    "name": "Claude Opus 4.7",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-opus-4-8",
    "name": "Claude Opus 4.8",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-opus-5",
    "name": "Claude Opus 5",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-opus-5-5",
    "name": "Claude Opus 5.5",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-sonnet-4-6",
    "name": "Claude Sonnet 4.6",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-sonnet-5",
    "name": "Claude Sonnet 5",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "anthropic/claude-sonnet-5-5",
    "name": "Claude Sonnet 5.5",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "deepseek/deepseek-v4-flash-0731",
    "name": "DeepSeek V4 Flash 0731",
    "reasoningModes": [
      "none",
      "low",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "deepseek/deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "reasoningModes": [
      "none",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "deepseek/deepseek-v4.1-flash-1017",
    "name": "DeepSeek V4.1 Flash 1017",
    "reasoningModes": [
      "none",
      "low",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "google/gemini-3.6-flash",
    "name": "Gemini 3.6 Flash",
    "reasoningModes": [
      "minimal",
      "low",
      "medium",
      "high"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "google/gemini-3.7-flash",
    "name": "Gemini 3.7 Flash",
    "reasoningModes": [
      "low",
      "medium",
      "high"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "google/gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "reasoningModes": [
      "low",
      "medium",
      "high"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "google/gemini-4-argon",
    "name": "Gemini 4 Argon",
    "reasoningModes": [
      "low",
      "medium",
      "high"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "google/gemini-4-carbon",
    "name": "Gemini 4 Carbon",
    "reasoningModes": [
      "low",
      "medium",
      "high"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "google/gemini-4-hydrogen",
    "name": "Gemini 4 Hydrogen",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "google/gemini-4-neon",
    "name": "Gemini 4 Neon",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "meituan/longcat-2.0",
    "name": "LongCat-2.0",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "meta/muse-glimmer-30b",
    "name": "Muse Glimmer 30B",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "meta/muse-spark-1.3",
    "name": "Muse Spark 1.3",
    "reasoningModes": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "minimax/minimax-m3",
    "name": "MiniMax M3",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "minimax/minimax-m3.1-flash",
    "name": "MiniMax M3.1 Flash",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "moonshotai/kimi-k3",
    "name": "Kimi K3",
    "reasoningModes": [
      "none",
      "low",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "moonshotai/kimi-k3.1-pro",
    "name": "Kimi K3.1 Pro",
    "reasoningModes": [
      "none",
      "low",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "nvidia/nemotron-3.5-lightning-30b-a3b",
    "name": "Nemotron 3.5 Lightning",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "name": "Nemotron 3.5 Super VL",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-5.3-codex",
    "name": "GPT-5.3 Codex",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-5.4",
    "name": "GPT-5.4",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-5.4-mini",
    "name": "GPT-5.4 Mini",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-5.5",
    "name": "GPT-5.5",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-5.5-pro",
    "name": "GPT-5.5 Pro",
    "reasoningModes": [
      "medium",
      "high",
      "xhigh"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-5.6-luna",
    "name": "GPT-5.6 Luna",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-5.6-sol",
    "name": "GPT-5.6 Sol",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-5.6-terra",
    "name": "GPT-5.6 Terra",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-6-astra",
    "name": "GPT-6 Astra",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": true,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-6-luna",
    "name": "GPT-6 Luna",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-6-sol",
    "name": "GPT-6 Sol",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-6.1-sol",
    "name": "GPT-6.1 Sol",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": true,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-6.1-terra",
    "name": "GPT-6.1 Terra",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-6.2-astra",
    "name": "GPT-6.2 Astra",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": true,
    "billing": "Capy API"
  },
  {
    "id": "openai/gpt-6.2-sol",
    "name": "GPT-6.2 Sol",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": true,
    "pro": true,
    "ultrafast": true,
    "billing": "Capy API"
  },
  {
    "id": "particle/particle-1",
    "name": "Particle-1",
    "reasoningModes": [
      "none",
      "low",
      "medium",
      "high"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "qwen/qwen3.8-flash",
    "name": "Qwen3.8 Flash",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "qwen/qwen3.8-max",
    "name": "Qwen3.8 Max",
    "reasoningModes": [
      "low",
      "medium",
      "xhigh"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "tencent/hy3",
    "name": "Hy3",
    "reasoningModes": [
      "none",
      "low",
      "high"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "tencent/hy4",
    "name": "Hy4",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "tencent/hy4-preview",
    "name": "Hy4 Preview",
    "reasoningModes": [
      "none",
      "low",
      "high"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "thinkingmachines/inkling-2-small",
    "name": "Inkling 2 Small",
    "reasoningModes": [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "xai/grok-4.5",
    "name": "Grok 4.5",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "xai/grok-4.6",
    "name": "Grok 4.6",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "xai/grok-4.7",
    "name": "Grok 4.7",
    "reasoningModes": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "fast": true,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "xiaomi/mimo-v2.6-flash",
    "name": "MiMo-V2.6 Flash",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "xiaomi/mimo-v2.6-pro",
    "name": "MiMo-V2.6 Pro",
    "reasoningModes": [
      "none"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "zai/glm-5.3",
    "name": "GLM-5.3",
    "reasoningModes": [
      "low",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  },
  {
    "id": "zai/glm-5.3-flash",
    "name": "GLM-5.3-Flash",
    "reasoningModes": [
      "low",
      "high",
      "max"
    ],
    "fast": false,
    "pro": false,
    "ultrafast": false,
    "billing": "Capy API"
  }
])
