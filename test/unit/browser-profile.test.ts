import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { browserProfileDir, browserProfilePath, launchArgs } from "../../src/adapters/capy/browser-login.ts";

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
