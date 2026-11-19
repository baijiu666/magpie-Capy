import assert from "node:assert/strict"
import test from "node:test"

import { _internal } from "../src/browser.mjs"

const {
  CAPY_URL,
  browserArgs,
  browserCandidates,
  findBrowser,
  findClientJwt,
  findCookie,
  isClientJwt,
  parseDevToolsPort,
  pickOrg,
  pickPageTarget,
} = _internal

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwtOf = (payload) => `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.signature`
const CLIENT_JWT = jwtOf({ id: "client_abc", exp: 9_999_999_999 })
const OTHER_CLIENT_JWT = jwtOf({ id: "client_other" })

test("parseDevToolsPort 从 DevToolsActivePort 首行读端口", () => {
  assert.equal(parseDevToolsPort("9222\n/devtools/browser/abc"), 9222)
  assert.equal(parseDevToolsPort("  9333 \r\nws://127.0.0.1/devtools/browser/x"), 9333)
  assert.equal(parseDevToolsPort("\uFEFF9444\n/devtools/browser/x"), 9444)
})

test("parseDevToolsPort 拒绝无效端口", () => {
  for (const raw of [null, undefined, "", "0", "-1", "abc", "65536", "9222extra", "1.5"]) {
    assert.equal(parseDevToolsPort(raw), 0)
  }
  assert.equal(parseDevToolsPort(65_535), 65_535)
})

test("isClientJwt 只认 payload.id=client_ 的三段 JWT", () => {
  assert.equal(isClientJwt(CLIENT_JWT), true)
  assert.equal(isClientJwt(jwtOf({ id: "user_abc" })), false)
  assert.equal(isClientJwt(jwtOf({ sid: "client_abc" })), false)
  assert.equal(isClientJwt(jwtOf({ id: "" })), false)
  assert.equal(isClientJwt("a.b"), false)
  assert.equal(isClientJwt("a.b.c.d"), false)
  assert.equal(isClientJwt(""), false)
  assert.equal(isClientJwt(null), false)
  assert.equal(isClientJwt(`${b64url({ alg: "none" })}.!!!.sig`), false)
})

test("findCookie 优先 capy.ai 顶级域，接受 .capy.ai 和子域", () => {
  const cookies = [
    { name: "__client", value: "sub", domain: "clerk.capy.ai" },
    { name: "__client", value: "apex", domain: "capy.ai" },
    { name: "__client", value: "dotted", domain: ".capy.ai" },
  ]
  assert.equal(findCookie(cookies, "__client"), "apex")
  assert.equal(findCookie([{ name: "__client", value: "dotted", domain: ".capy.ai" }], "__client"), "dotted")
  assert.equal(findCookie([{ name: "__client", value: "sub", domain: "clerk.capy.ai" }], "__client"), "sub")
  assert.equal(findCookie([{ name: "__client", value: '"quoted"', domain: ".capy.ai" }], "__client"), "quoted")
  assert.equal(findCookie([{ name: "__client", value: "upper", domain: "CAPY.AI" }], "__client"), "upper")
})

test("findCookie 拒绝非 capy.ai 域和空值", () => {
  assert.equal(findCookie([{ name: "__client", value: "x", domain: "evilcapy.ai" }], "__client"), "")
  assert.equal(findCookie([{ name: "__client", value: "x", domain: "capy.ai.evil.com" }], "__client"), "")
  assert.equal(findCookie([{ name: "__client", value: "", domain: ".capy.ai" }], "__client"), "")
  assert.equal(findCookie([{ name: "other", value: "x", domain: ".capy.ai" }], "__client"), "")
  assert.equal(findCookie(null, "__client"), "")
  assert.equal(findCookie([], "__client"), "")
})

test("findClientJwt 跳过非法 __client，优先顶级域", () => {
  const cookies = [
    { name: "__client", value: "not-a-jwt", domain: ".capy.ai" },
    { name: "__client", value: OTHER_CLIENT_JWT, domain: "clerk.capy.ai" },
    { name: "__client", value: CLIENT_JWT, domain: ".capy.ai" },
  ]
  assert.equal(findClientJwt(cookies), CLIENT_JWT)
  assert.equal(findClientJwt([{ name: "__client", value: "nope", domain: ".capy.ai" }]), "")
  assert.equal(findClientJwt(null), "")
})

test("pickOrg 优先 localStorage 选中的组织，否则第一项", () => {
  const ids = ["org_a", "org_b"]
  assert.equal(pickOrg(ids, ["org_b"]), "org_b")
  assert.equal(pickOrg(ids, [null, "org_b"]), "org_b")
  assert.equal(pickOrg(ids, ["org_x"]), "org_a")
  assert.equal(pickOrg(ids), "org_a")
})

test("pickOrg 接受 JSON 字符串和对象形式的存储值", () => {
  assert.equal(pickOrg(["org_a", "org_b"], ['"org_b"']), "org_b")
  assert.equal(pickOrg(["org_a", "org_b"], ['{"id":"org_b"}']), "org_b")
  assert.equal(pickOrg(["org_a", "org_b"], [{ orgId: "org_b" }]), "org_b")
  assert.equal(pickOrg(["org_a", "org_b"], ["org_b", "org_a"]), "org_b")
})

test("pickOrg 处理对象数组和空列表", () => {
  assert.equal(pickOrg([{ id: "org_c" }, { id: "org_d" }], ["org_d"]), "org_d")
  assert.equal(pickOrg([], ["org_a"]), "")
  assert.equal(pickOrg(null, ["org_a"]), "")
})

test("MAGPIE_CAPY_BROWSER 覆盖候选列表", () => {
  const candidates = browserCandidates("linux", { MAGPIE_CAPY_BROWSER: "/opt/custom/chrome", PATH: "" }, () => "")
  assert.equal(candidates[0], "/opt/custom/chrome")
  const quoted = browserCandidates("linux", { MAGPIE_CAPY_BROWSER: '"/opt/custom/chrome"', PATH: "" }, () => "")
  assert.equal(quoted[0], "/opt/custom/chrome")
})

test("Windows 候选顺序：Chrome 在 Edge 前，且去重", () => {
  const env = {
    PROGRAMFILES: "C:\\PF",
    "PROGRAMFILES(X86)": "C:\\PF86",
    LOCALAPPDATA: "C:\\LA",
    APPDATA: "C:\\AR",
  }
  const candidates = browserCandidates("win32", env, () => "")
  const chrome = candidates.findIndex((file) => /Google[\\/]Chrome/u.test(file))
  const edge = candidates.findIndex((file) => /msedge\.exe$/iu.test(file))
  assert.ok(chrome >= 0, "应包含 Chrome")
  assert.ok(edge > chrome, "Edge 应排在 Chrome 之后")
  assert.equal(new Set(candidates).size, candidates.length)
})

test("Windows 注册表结果会追加且去重", () => {
  const env = {
    PROGRAMFILES: "C:\\PF",
    "PROGRAMFILES(X86)": "C:\\PF86",
    LOCALAPPDATA: "C:\\LA",
    APPDATA: "C:\\AR",
  }
  const custom = "D:\\Custom\\Chrome\\chrome.exe"
  const candidates = browserCandidates("win32", env, (exe) => (exe === "chrome.exe" ? custom : ""))
  assert.ok(candidates.includes(custom))
  assert.equal(new Set(candidates).size, candidates.length)
})

test("darwin 候选包含 Chrome 和 Edge", () => {
  const candidates = browserCandidates("darwin", {}, () => "")
  assert.ok(candidates.some((file) => /Google Chrome/u.test(file)))
  assert.ok(candidates.some((file) => /Microsoft Edge/u.test(file)))
})

test("pickPageTarget 优先 capy.ai/app，其次 capy.ai，最后其他页面", () => {
  const targets = [
    { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
    { type: "page", url: "https://capy.ai/sign-in", webSocketDebuggerUrl: "ws://signin" },
    { type: "page", url: "https://capy.ai/app", webSocketDebuggerUrl: "ws://app" },
  ]
  assert.equal(pickPageTarget(targets).webSocketDebuggerUrl, "ws://app")
  assert.equal(pickPageTarget([targets[1], targets[0]]).webSocketDebuggerUrl, "ws://signin")
  assert.equal(pickPageTarget([targets[0]]).webSocketDebuggerUrl, "ws://blank")
  assert.equal(pickPageTarget([]), null)
  assert.equal(pickPageTarget([{ type: "iframe", url: "https://capy.ai/app", webSocketDebuggerUrl: "ws://iframe" }]), null)
})

test("浏览器登录默认打开 Capy 官方 /sign-in", () => {
  assert.equal(CAPY_URL, "https://capy.ai/sign-in")
  assert.ok(browserArgs("C:\\Temp\\profile").includes("https://capy.ai/sign-in"))
})

test("browserArgs 用临时 profile、0 调试端口、可见窗口", () => {
  const args = browserArgs("C:\\Temp\\profile", 0, "https://capy.ai/app")
  assert.ok(args.includes("--user-data-dir=C:\\Temp\\profile"))
  assert.ok(args.includes("--remote-debugging-port=0"))
  assert.ok(args.includes("--no-first-run"))
  assert.ok(args.includes("--no-default-browser-check"))
  assert.ok(args.includes("--disable-blink-features=AutomationControlled"))
  assert.ok(args.includes("https://capy.ai/app"))
  assert.equal(args.some((arg) => /headless/iu.test(arg)), false)
})

test("findBrowser 返回字符串（找不到也不能抛）", () => {
  assert.equal(typeof findBrowser(), "string")
})
