import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  decodeDataFrame,
  encodeDataFrame,
  pairHeadlessDevice,
  resultForInvocation,
  waitForDevice,
} from "../src/headless.mjs"

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

test("数据帧：4 字节 streamId + body 往返", () => {
  const frame = encodeDataFrame(42, Buffer.from("hello"))
  assert.equal(frame.readUInt32BE(0), 42)
  const decoded = decodeDataFrame(new Uint8Array(frame))
  assert.equal(decoded.streamId, 42)
  assert.equal(Buffer.from(decoded.bytes).toString(), "hello")
  assert.equal(decodeDataFrame(new Uint8Array([1, 2])), null)
})

test("最小 machine server：worktree_list / worktree_ensure / volume_* / 默认失败", () => {
  const list = resultForInvocation("worktree_list", {})
  assert.equal(list.status, "succeeded")
  assert.deepEqual(list.result, { kind: "worktree_list", entries: [] })

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capy-headless-"))
  const root = path.join(dir, "jam_test")
  const ensured = resultForInvocation("worktree_ensure", { root }, { worktreeBase: dir })
  assert.equal(ensured.status, "succeeded")
  assert.equal(ensured.result.root, root)
  assert.equal(fs.existsSync(root), true)

  const landed = resultForInvocation("volume_landed", {
    mounts: [{ mountPath: "~/.capy/drive/x", digest: "a".repeat(64) }],
  })
  assert.equal(landed.status, "succeeded")
  assert.equal(landed.result.mounts[0].current, true)

  const probe = resultForInvocation("volume_probe", {
    mounts: [{ mountPath: "~/.capy/drive/y", digest: "b".repeat(64) }],
  })
  assert.equal(probe.status, "succeeded")
  assert.equal(probe.result.mounts[0].state, "current")

  const refused = resultForInvocation("terminal", {})
  assert.equal(refused.status, "failed")
  assert.equal(refused.error.code, "MachineServer.Unavailable")

  const outside = resultForInvocation("worktree_ensure", { root: path.join(dir, "..", "escape") }, { worktreeBase: dir })
  assert.equal(outside.status, "failed")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("pairHeadlessDevice：code → approve → poll 拿到 capyd_ token", async () => {
  const token = `capyd_${"x".repeat(43)}`
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase()
    calls.push(`${method} ${new URL(url).pathname}`)
    if (url.endsWith("/app/devices/code")) {
      return json({
        userCode: "ABCD-EFGH",
        deviceCode: "device-code-1",
        verificationUrl: "https://capy.ai/settings/devices/link#code=ABCD-EFGH",
        expiresInSeconds: 300,
        pollIntervalSeconds: 1,
      })
    }
    if (url.endsWith("/app/orgs/org_1/devices/code/approve")) {
      const body = JSON.parse(init.body)
      assert.equal(body.userCode, "ABCD-EFGH")
      return json({ status: "approved" })
    }
    if (url.endsWith("/app/devices/code/poll")) {
      return json({
        status: "approved",
        orgName: "test",
        enrolled: {
          orgId: "org_1",
          device: { id: "device_new", name: "magpie-headless" },
          token,
        },
      })
    }
    return json({ _tag: "capy/RouteNotFound" }, 404)
  }
  const cred = await pairHeadlessDevice(fetchImpl, {
    jwt: "jwt",
    orgId: "org_1",
    persist: false,
  })
  assert.deepEqual(cred, {
    orgId: "org_1",
    deviceId: "device_new",
    name: "magpie-headless",
    token,
  })
  assert.deepEqual(calls, [
    "POST /app/devices/code",
    "POST /app/orgs/org_1/devices/code/approve",
    "POST /app/devices/code/poll",
  ])
})

test("waitForDevice 轮询到 connected", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return json([
      { id: "device_other", connected: false },
      { id: "device_new", name: "magpie-headless", connected: calls >= 2 },
    ])
  }
  const hit = await waitForDevice(fetchImpl, "jwt", "org_1", "device_new", { timeoutMs: 5000 })
  assert.equal(hit.id, "device_new")
  assert.equal(hit.connected, true)
  assert.ok(calls >= 2)
})
