import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { browserProfileDir, browserProfilePath, launchArgs, sessionClaimsOf } from "../../src/adapters/capy/browser-login.ts";

test("登录浏览器固定复用 magpie 缓存下的同一份配置", () => {
  expect(browserProfilePath({})).toBe(path.join(os.homedir(), ".cache", "magpie", "capy-browser-profile"));
});

test("MAGPIE_CAPY_PROFILE 可以覆盖登录浏览器的配置目录", () => {
  const custom = path.join(os.tmpdir(), `capy-profile-test-${process.pid}-${Date.now()}`);
  expect(browserProfilePath({ MAGPIE_CAPY_PROFILE: custom })).toBe(custom);
  const dir = browserProfileDir({ MAGPIE_CAPY_PROFILE: custom });
  expect(fs.statSync(dir).isDirectory()).toBe(true);
  fs.rmSync(custom, { recursive: true, force: true });
});

test("启动参数去掉自动化特征，Turnstile 才不会把登录当机器人", () => {
  const args = launchArgs(9222, "C:/tmp/capy-profile");
  expect(args).toContain("--disable-blink-features=AutomationControlled");
  expect(args).toContain("--user-data-dir=C:/tmp/capy-profile");
  expect(args).toContain("--remote-debugging-port=9222");
  expect(args).toContain("--disable-extensions");
});

function jwtWith(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.sig`;
}

test("页面崩掉时从 __session 里取出 sessionId / userId", () => {
  const token = jwtWith({ sid: "sess_abc", sub: "user_xyz", azp: "http://localhost" });
  expect(sessionClaimsOf(token)).toEqual({ sessionId: "sess_abc", userId: "user_xyz" });
});

test("__session 缺字段或不是 JWT 时不猜", () => {
  expect(sessionClaimsOf("")).toBeNull();
  expect(sessionClaimsOf("not-a-jwt")).toBeNull();
  expect(sessionClaimsOf(jwtWith({ sub: "user_only" }))).toBeNull();
});
