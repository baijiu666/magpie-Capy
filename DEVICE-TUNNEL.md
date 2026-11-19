# Capy 无头设备 / device tunnel 取证（0.9.2）

> 目的：记录「不启动 Capy 桌面端，怎么跑 Capy 设备线程」的协议。
> 取证对象：`Capy-0.9.2-x64.exe` 解包后的 `out/main/main.js`（Electron 主进程）。
> 本文只记录协议形状，不包含任何凭据。

## 0. 结论

Capy 桌面端不是登录器，它是一台 **device**：Worktree、终端、文件、Git、浏览器、Drive/checkpoint
都由设备的 machine server 执行。插件 0.5.0 用**无头设备**替代桌面端：

1. 浏览器登录拿 Clerk 会话；
2. 自动走设备码配对，注册 `magpie-headless`，拿 `capyd_…` token；
3. 连 device tunnel；
4. 实现最小 machine server（够文本/图片对话）；
5. device token 用 Windows DPAPI 加密存在本机。

**不需要 Capy 桌面端、不需要 `%APPDATA%\Capy` 的登录凭据。**

## 1. 设备码配对（无需桌面端）

```http
POST /app/devices/code
{ "hostname": "…", "os": "win32", "arch": "x86_64" }
→ { userCode, deviceCode, verificationUrl, expiresInSeconds, pollIntervalSeconds }

POST /app/orgs/{orgId}/devices/code/approve
{ "userCode": "…", "name": "magpie-headless" }
→ { "status": "approved" }

POST /app/devices/code/poll
{ "deviceCode": "…" }
→ {
    "status": "approved",
    "orgName": "…",
    "enrolled": {
      "orgId": "org_…",
      "device": { "id": "device_…", "name": "magpie-headless", … },
      "token": "capyd_…"
    }
  }
```

`code/approve` 需要 Clerk 会话（`Authorization: Bearer <azp JWT>` + `Origin: https://capy.ai`）。
插件自动 approve，不需要用户打开浏览器批准页。

## 2. Device tunnel

```
wss://device-tunnel-production.cloud.capy.ai/tunnel
Authorization: Bearer capyd_…
```

### 2.1 hello

```json
{
  "type": "hello",
  "contractVersion": 2,
  "deviceId": "device_…",
  "hostname": "…",
  "os": "win32",
  "workspaces": [],
  "worktreeBase": "C:\\Users\\…\\.capy\\worktrees",
  "clientVersion": "magpie-headless 0.1"
}
```

### 2.2 session-config → ready

```json
{
  "type": "session-config",
  "backingId": "…",
  "bearer": "…",
  "transferSecret": "…",
  "pushReports": true,
  "presignedParts": true,
  "driveEngine": false
}
```

客户端回：

```json
{ "type": "workspaces-changed", "workspaces": [] }
{ "type": "ready" }
```

服务端随后把设备标记为 `connected: true`（`GET /app/orgs/{orgId}/devices`）。

## 3. Machine server RPC（HTTP-over-WebSocket）

服务端帧：

```json
{ "type": "open", "streamId": 2, "kind": "invoke", "method": "POST",
  "path": "/v1/invocations?wait=25000", "headers": { … } }
```

随后一个二进制帧：`streamId(4B BE) + body`，再：

```json
{ "type": "close", "streamId": 2 }
```

设备回：

```json
{ "type": "response", "streamId": 2, "status": 200,
  "headers": { "content-type": "application/json", "content-length": "…" } }
```

再发二进制 `streamId + response body`，最后 `{ "type": "close", "streamId": 2 }`。

### 3.1 已实现的最小 handler

| handler | 返回 |
|---|---|
| `worktree_ensure` | `{root, created, checkouts: []}`，并创建目录 |
| `worktree_list` | `{kind:"worktree_list", entries: []}` |
| `volume_landed` | mounts current |
| `volume_probe` | mounts current |
| `POST /v1/git/capture` | `{repos: []}` |
| 其他（terminal/browser/write/transfer） | `{status:"failed", error:{code:"MachineServer.Unavailable"}}` |

## 4. 实测

- 无 Capy 桌面端、无 `device-credentials.json`；
- 设备码配对 → `magpie-headless` `connected:true`；
- 建线程 `primaryMachine.kind:"device"`；
- `particle-1` 回答 `pong` **8.9 秒**；`done` 11.5 秒。

## 5. 本机状态

| 文件 | 内容 |
|---|---|
| `%LOCALAPPDATA%\magpie-capy\headless-device.json` | `{version, orgId, deviceId, name, tokenCiphertext}`；token 用 Windows DPAPI 加密 |
| `~/.capy/worktrees/jam_*` | 无头设备创建的 Worktree |

旧版桌面端路径（`device-credentials.json` / `Local State` / `session-credential.json`）已不再读取。
