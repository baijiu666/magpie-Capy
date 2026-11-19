# Capy 桌面端设备隧道 / 机器协议（0.9.2 取证）

> 目的：回答「为什么必须连接 Capy 桌面端」以及「能不能做一个无头设备」。
> 取证对象：`Capy-0.9.2-x64.exe` 解包后的 `out/main/main.js`（Electron 主进程）。
> 本文只记录协议形状，不包含任何凭据。

## 0. 一句话结论

**桌面端不是登录器，它是 Capy 的「执行设备」：** 线程绑到 device 后，Worktree、终端、文件、
Git、浏览器、Drive/checkpoint 都由这台设备上的 machine server 执行。免费模型不消耗 credits，
但必须有一个在线 device；浏览器登录只提供身份 + API Key，不提供算力。

**关窗口 ≠ 退出。** 桌面端关闭主窗口会隐藏到托盘，device tunnel 保持连接，线程仍然可用。
实测：关窗口后进程仍在、`/devices` 仍 `connected:true`、网关对话仍返回 `pong`。

## 1. 设备隧道

```
wss://device-tunnel-production.cloud.capy.ai/tunnel
```

### 1.1 客户端 → 服务端：hello

```json
{
  "type": "hello",
  "contractVersion": 2,
  "deviceId": "device_…",
  "hostname": "…",
  "os": "win32",
  "workspaces": [],
  "worktreeBase": "C:\\Users\\…\\.capy\\worktrees",
  "clientVersion": "desktop 0.9.2",
  "drive": true,
  "driveEngineVersion": 4,
  "hardware": { "…": "…" }
}
```

### 1.2 服务端 → 客户端：session-config

```json
{
  "type": "session-config",
  "backingId": "…",
  "bearer": "…",
  "transferSecret": "…",
  "pushReports": true,
  "presignedParts": true,
  "driveEngine": true
}
```

客户端随后回：

```json
{ "type": "ready" }
```

### 1.3 其他帧

- `workspaces-changed`
- `push-report`
- `preference-changed`
- `checkpoint-ready` / `checkpoint-acknowledged` / `checkpoint-mint`
- machine server 的 `invoke` / `pty` / `transfer`

## 2. Machine server（真正的工作量）

`session-config.endpoint` + `bearer` 建立 machine server 会话，然后由它处理：

| 域 | 内容 |
|---|---|
| Workspace / Worktree | 创建、链接、worktree base、root、branches |
| Terminal / PTY | `invoke`、`pty`、streamId、输出流 |
| File / Transfer | 读写、上传下载、presigned parts、大小限制 |
| Git | status/log/diff、shadow repo、checkpoint |
| Browser | Chromium runtime、CDP、截图、visual check |
| Drive | 队列、mount、operation、checkpoint 同步 |
| Checkpoint | snapshot、manifest、ack、mint |

这就是为什么「纯 Node 无头设备」不是一个小的兼容层：**隧道握手很简单，machine server 的
RPC 面很大**。云端 agent 一旦决定用工具（读文件、跑终端、Git、浏览器），这些调用都会落到
machine server。

## 3. 本机凭据

| 文件 | 内容 |
|---|---|
| `%APPDATA%\Capy\device-credentials.json` | `{version, backend?, orgs:{orgId:{userId, deviceId, ciphertext}}}`；`ciphertext` 是 device custody（加密） |
| `%APPDATA%\Capy\device-ids.json` | 已知 deviceId |
| `%APPDATA%\Capy\session-credential.json` | Clerk client JWT（DPAPI + AES-GCM） |
| `Local State` | Chromium `os_crypt.encrypted_key`（DPAPI） |

桌面端用 `IIe(credentialsPath)` 读 custody，隧道客户端 `xEe()` 拿 `custody + identity` 建连。
custody 的具体解密/换 token 还在主进程闭包里，未完整提取；要复刻无头设备，这是第一个要补的洞。

## 4. 可行的替代方案

1. **官方托盘模式（推荐，已验证）**
   - 打开一次 Capy 桌面端；
   - 关闭主窗口（X）→ 隐藏到托盘，进程与 device tunnel 保留；
   - 插件照常使用，不需要窗口。
2. **开机自启 + 托盘**
   - 在 Capy 设置里开启 launch at login / 保持运行；
   - 设备长期在线，插件无感。
3. **纯无头设备（未完成，工作量大）**
   - 已拿到 tunnel hello / session-config / ready 形状；
   - 还缺：custody 解密与 tunnel token、machine server 的 RPC 实现；
   - 适合只做纯文本、且能容忍工具不可用的场景；需要单独立项验证服务端是否接受 stub。

## 5. 证据位置

- `out/main/main.js`：
  - `wss://device-tunnel-production.cloud.capy.ai/tunnel`
  - `Lre/Ure/Mre` schema：`hello` / `session-config` / `ready`
  - `vIe(...)`：device daemon 启动
  - `IIe(...)`：device-credentials custody reader
  - `capy/machine-server/*`：machine server 各子系统
  - 主窗口 `close` handler：`preventDefault` → `hide()` → 托盘通知
