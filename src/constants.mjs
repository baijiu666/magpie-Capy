// Capy（https://capy.ai）的固定事实：端点、provider 身份、静态模型表、图标。
//
// 两套 API，鉴权完全不同：
//   · app API   https://api.capy.ai/app/*      ← Clerk 会话 JWT（必须带 azp=https://capy.ai）
//   · 公共 API  https://api.capy.ai/api/v1/*   ← 组织级 API key（capy_…）
// 插件对外只依赖公共 API；会话 JWT 只在登录/续期时用来签发 API key。

import { CATALOG_SNAPSHOT, DEFAULT_MODEL_ID } from "./models.mjs"

export const PROVIDER = "capy"
export const PROVIDER_NAME = "Capy"

export const BASE = "https://capy.ai"
export const APP_BASE = "https://api.capy.ai/app"
export const API_BASE = "https://api.capy.ai/api/v1"
export const FAPI_BASE = "https://clerk.capy.ai"

export const SDK = "@ai-sdk/openai-compatible"
export const DEFAULT_MODEL = DEFAULT_MODEL_ID || "particle/particle-1"

// 工具调用兼容桥：默认开启，让客户端可以正常发送 OpenAI tools。
// 但 Capy agent 会优先用自己的终端/浏览器/目录工具，并会明确拒绝“只输出 JSON”
// 的约定（三个免费模型实测都这样）。模型配合时桥返回 tool_calls；不配合时退回文本。
// 想关掉：MAGPIE_CAPY_TOOL_SHIM=0（或 off/false）。
const TOOL_SHIM_ENV = String(process.env.MAGPIE_CAPY_TOOL_SHIM ?? "").trim().toLowerCase()
export const TOOL_SHIM = !["0", "off", "false", "no"].includes(TOOL_SHIM_ENV)

// 登录时签发的 API key 名字（服务端只存 tokenHint，同名可重复创建）。
export const API_KEY_NAME = "magpie-plugin"

// 自动创建的 Capy 项目名/短码。公共 API 的 /threads 必须挂在一个真实项目下。
export const PROJECT_NAME = "Magpie"
export const PROJECT_CODE = "MAGP"

// API key 没有 exp；用 expires 让 magpie 定期走一次 refresh，顺便校验 key 是否被吊销。
export const ACCESS_TTL_MS = 7 * 24 * 3600_000
export const REFRESH_LEAD_MS = 24 * 3600_000

export const DEFAULT_MAX_CONCURRENCY = 2

// 插件卡片的图标（也用 auth.icon）。Capy 的 favicon，PNG。
export const ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAEfklEQVR4nOxbi5HiMAx9u3eFsJVgOoFKMJUwV0lMJ1wlHAoROIo/ckic7N29GQ9rx0msZ0mW5exPLAfTlW33Szh1vxaV8BPLwN7LMdB+FH1mxwfqo8FrxlNw97LDzPhEXVgI4Y0xsNaG+lK/G3RkjUZNDbAQak+CH4+vpt1uB+ecvI8aZtOEWgRYZIRnfHwEh3TCTD6hFgE3vxITnkAaQJoQADU6xGH8x0CJGj7A9ioJ4QnkE6gE0HTPsn73rv3W/TZe3UKBuTTA4KHyRl643W7ZmxNa0OsGnYNMas7UGmDwmgUjL0a8/fAhYQ0IvUsD1pwgfmAamHs5dy/aBDvchTqfz9CCneFms2nL9XqN9uVn7/d7fH19hVYSg4e2Dy68awIGEVXngVHZbrfaWc3idHpEy6RN9EzyJ/LZkeW0vQRBwjsEWITD2ejAaiHhQxxETDGGAIPIrC8tuI9IPEHoaUGpE7QIODgSuGmatqxB+AyMXynZDUY9e2pdXwIR+2ds/YqWgOCsr0XdJS6Xi7qvxgcMhF/jrPtI2D+ht6/IacBA+LXbOS+TWqQI+HbCEzL233bxK7FVwOIbCk9QmKbzKyFjsRABzncRnpHwAYO8QsgEBomLWsKz+ko7Lg2nqZ/CFFpIAmyvUsnb02BJ6NiguV2riQkCtrLBJ8DCm31e5+cGCa7dJmtB2hKBkQ3RULiG2pcKP9GYjF/xvcUzVVND9UM7ttj2mfqWCq/dDLEJWCyMFOkTa6OBRwBnhBr/ZTJzQ6pKs0WsTjUYyvLwLHE2Z0pkIsJf/AeNwMAjQM6EVFXe+q4dCRNw8JIi1MvC8/6hrK182NpJyGSVHTwCVAkR6amVaevFULIdJif4XDRj9s0m4RNBJJBmUBt5bX4pByB+IFI7lM5EgT12iADDldQgQySE6iGQQ1oRAT2UpMSiJORQU3hFPsD5FfJuowKgTNalBQc2NbNHinH1OhRpACO0W/OFXGrrXDr7hB4BZDtjZmstyVGFaQ6WB1oGHQohncwahFfmAq1sGGiABn6/tQivmP0gQ5/yQo6Etc0+jUe5KrlQ4yASzKlSSZRVA0rVp04udIF9wPNiqQYksi+zI3EMLmFjF1gDejSmWF2DCfBeRCl8UkWYAAdPC8imYg/3BZ46l6fBCOFtqsOn6PyqRLSA4wROXdUEJ2YKYHMdZNzYOw5b0yFowaw/b4EixpEfSf2+lz1XeMu75FJHY6APn1IfSclb7uUAZYAnCbjiES7u/QEsQQK993A4lJ72Ojxm/qq9IbZ1shBHZLXSYLlTotStGPFRdep0eBAhkiaUnr9rwd59hK23t2PkF+WpnKBFYA0lxzglEW8KTqCBjE5Q5rMaie8B24tdLKBdLfwT4JECPx+FRIirhYYAgkWChF7HQHAUSpS+iWyAo4WWAKCAhBnhMMGs+yghgGFRnwiHiQVnjCGAYTE/EQ4zCc54hwCGxbREOMwstI8pCGAYDP8TNAfX/V4gdqS1MCUBIZhIu8NKMDcBq4fqdPhvxn8C8I/jDwAAAP//6w8I9gAAAAZJREFUAwDFTOemoPtiCAAAAABJRU5ErkJggg=="
