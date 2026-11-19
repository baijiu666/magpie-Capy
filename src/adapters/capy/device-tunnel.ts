import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountSession } from "../../domain/account.ts";
import { accountKey } from "../../domain/account.ts";
import { CapyError } from "../../domain/errors.ts";
import type { HeadlessCredential, DeviceRuntimePort } from "../../ports/device-runtime.ts";
import type { DeviceInfo } from "../../ports/capy-app.ts";
import type { ClockPort, LoggerPort, SecretStorePort } from "../../ports/platform.ts";
import type { CapyAppPort } from "../../ports/capy-app.ts";
import { dpapiProtect, dpapiUnprotect } from "../platform/dpapi.ts";
import { CONTRACT_VERSION, DEVICE_TUNNEL } from "./endpoints.ts";

const HEADLESS_NAME = "magpie-headless";
const READY_TIMEOUT_MS = 15_000;
const CONNECT_POLL_MS = 400;
const STATE_VERSION = 1;

function deviceOs(): string {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function deviceArch(): string {
  return process.arch === "arm64" ? "arm64" : "x86_64";
}

function stateDir(): string {
  const override = String(process.env.MAGPIE_CAPY_STATE_DIR ?? "").trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "magpie-capy");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "magpie-capy");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "magpie-capy");
}

export class FileSecretStore implements SecretStorePort {
  private readonly baseDir: string;

  constructor(baseDir = stateDir()) {
    this.baseDir = baseDir;
  }

  async load(account: string): Promise<HeadlessCredential | null> {
    try {
      const doc = JSON.parse(fs.readFileSync(this.fileOf(account), "utf8")) as Record<string, unknown>;
      if (doc.version !== STATE_VERSION) return null;
      const orgId = String(doc.orgId ?? "");
      const deviceId = String(doc.deviceId ?? "");
      const name = String(doc.name ?? HEADLESS_NAME);
      const token = typeof doc.token === "string"
        ? doc.token
        : typeof doc.tokenCiphertext === "string"
          ? dpapiUnprotect(Buffer.from(doc.tokenCiphertext, "base64")).toString("utf8")
          : "";
      if (!orgId || !deviceId || !token.startsWith("capyd_")) return null;
      return { orgId, deviceId, name, token };
    } catch {
      return null;
    }
  }

  async save(account: string, credential: HeadlessCredential): Promise<void> {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const file = this.fileOf(account);
    const tmp = `${file}.${process.pid}.tmp`;
    const secret = process.platform === "win32"
      ? { tokenCiphertext: dpapiProtect(credential.token) }
      : { token: credential.token };
    fs.writeFileSync(tmp, JSON.stringify({
      version: STATE_VERSION,
      orgId: credential.orgId,
      deviceId: credential.deviceId,
      name: credential.name,
      ...secret,
    }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (process.platform !== "win32") {
      try { fs.chmodSync(file, 0o600); } catch {}
    }
  }

  async clear(account: string): Promise<void> {
    try { fs.unlinkSync(this.fileOf(account)); } catch {}
  }

  private fileOf(account: string): string {
    const safe = account.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120);
    return path.join(this.baseDir, `headless-${safe}.json`);
  }
}

interface TunnelFrame {
  readonly type?: string;
  readonly [key: string]: unknown;
}

interface StreamState {
  readonly streamId: number;
  readonly kind: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  body: Buffer;
}

function headerValue(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return "";
}

function encodeDataFrame(streamId: number, body: Buffer): Buffer {
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(streamId >>> 0, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeDataFrame(bytes: Uint8Array): { streamId: number; body: Uint8Array } | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { streamId: view.getUint32(0), body: bytes.subarray(4) };
}

function machineResult(handler: string, params: Record<string, unknown>, worktreeBase: string): {
  readonly status: "succeeded" | "failed";
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
} {
  if (handler === "worktree_ensure") {
    const root = String(params.root ?? "");
    let created = false;
    if (root) {
      const base = path.resolve(worktreeBase);
      const resolved = path.resolve(root);
      if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
        return { status: "failed", error: { code: "MachineServer.Refused", message: "worktree root outside worktreeBase" } };
      }
      created = !fs.existsSync(resolved);
      fs.mkdirSync(resolved, { recursive: true });
    }
    return { status: "succeeded", result: { root, created, checkouts: [] } };
  }
  if (handler === "worktree_list") {
    return { status: "succeeded", result: { kind: "worktree_list", entries: [] } };
  }
  if (handler === "volume_landed") {
    const mounts = Array.isArray(params.mounts) ? params.mounts : [];
    return {
      status: "succeeded",
      result: {
        kind: "volume_landed",
        mounts: mounts.map((mount) => ({
          mountPath: String((mount as Record<string, unknown>)?.mountPath ?? ""),
          current: true,
        })),
        landing: false,
        checkpoints: false,
        directories: [],
        unretained: [],
        handback: true,
      },
    };
  }
  if (handler === "volume_probe") {
    const mounts = Array.isArray(params.mounts) ? params.mounts : [];
    return {
      status: "succeeded",
      result: {
        mounts: mounts.map((mount) => ({
          mountPath: String((mount as Record<string, unknown>)?.mountPath ?? ""),
          state: "current",
        })),
      },
    };
  }
  return {
    status: "failed",
    error: {
      code: "MachineServer.Unavailable",
      message: `无头设备未实现 ${handler || "unknown"}；终端/浏览器/写文件等工具不会执行。`,
    },
  };
}

class HeadlessDevice {
  private readonly credential: HeadlessCredential;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly worktreeBase: string;
  private ws: WebSocket | null = null;
  private ready = false;
  private connectPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly streams = new Map<number, StreamState>();

  constructor(options: {
    readonly credential: HeadlessCredential;
    readonly WebSocketImpl?: typeof WebSocket;
    readonly worktreeBase?: string;
  }) {
    this.credential = options.credential;
    const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
    if (typeof Impl !== "function") {
      throw new CapyError("upstream_unavailable", "当前运行时没有 WebSocket（需要 Bun / Node 22+）");
    }
    this.WebSocketImpl = Impl;
    this.worktreeBase = options.worktreeBase ?? path.join(os.homedir(), ".capy", "worktrees");
  }

  get info(): DeviceInfo {
    return {
      id: this.credential.deviceId,
      name: this.credential.name,
      connected: this.ready,
    };
  }

  async ensure(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.ready && this.ws?.readyState === 1) return;
    if (this.connectPromise) return await this.connectPromise;
    this.connectPromise = this.connect(timeoutMs);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  close(): void {
    this.ready = false;
    try { this.ws?.close(1000, "headless closed"); } catch {}
    this.ws = null;
  }

  private async connect(timeoutMs: number): Promise<void> {
    this.ready = false;
    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(DEVICE_TUNNEL, {
        headers: { authorization: `Bearer ${this.credential.token}` },
      } as unknown as string[]);
    } catch (error) {
      throw tunnelError(error, "连接 Capy 设备隧道失败");
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timer = setTimeout(() => {
      const failure = new Error(`连接 Capy 设备隧道超时（${Math.round(timeoutMs / 1000)}s）`);
      (failure as Error & { code?: string }).code = "device_connect_timeout";
      this.readyReject?.(failure);
      try { ws.close(4000, "ready timeout"); } catch {}
    }, Math.max(3000, timeoutMs));
    timer.unref?.();

    ws.addEventListener("open", () => {
      this.send({
        type: "hello",
        contractVersion: CONTRACT_VERSION,
        deviceId: this.credential.deviceId,
        hostname: os.hostname(),
        os: deviceOs(),
        workspaces: [],
        worktreeBase: this.worktreeBase,
        clientVersion: "magpie-headless 1.0",
      });
    });
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", (event) => {
      this.ready = false;
      this.ws = null;
      clearTimeout(timer);
      if (!this.readyResolve) return;
      const reason = String(event.reason || "");
      const rejected = [4001, 4003, 4401, 4403].includes(Number(event.code))
        || /auth|token|unauthor|forbidden/iu.test(reason);
      const failure = new Error(`Capy 设备隧道已关闭（${event.code}${reason ? `：${reason}` : ""}）`);
      (failure as Error & { code?: string }).code = rejected ? "device_token_rejected" : "device_connect_failed";
      this.readyReject?.(failure);
    });
    ws.addEventListener("error", () => {
      const failure = new Error("Capy 设备隧道连接失败");
      (failure as Error & { code?: string }).code = "device_connect_failed";
      this.readyReject?.(failure);
    });

    try {
      await ready;
    } finally {
      clearTimeout(timer);
      this.readyResolve = null;
      this.readyReject = null;
    }
    this.ready = true;
  }

  private send(frame: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private sendBinary(bytes: Buffer): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(bytes); } catch {}
  }

  private onMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      this.onControl(event.data);
      return;
    }
    const raw = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : ArrayBuffer.isView(event.data)
        ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
        : null;
    if (!raw) return;
    const frame = decodeDataFrame(raw);
    if (!frame) return;
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    stream.body = Buffer.concat([stream.body, Buffer.from(frame.body)]);
    const length = Number(headerValue(stream.headers, "content-length") || 0);
    if (!length || stream.body.length >= length) this.handleStream(stream);
  }

  private onControl(text: string): void {
    let frame: TunnelFrame;
    try { frame = JSON.parse(text) as TunnelFrame; } catch { return; }
    const type = String(frame.type ?? "");
    if (type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (type === "session-config") {
      this.send({ type: "workspaces-changed", workspaces: [] });
      this.send({ type: "ready" });
      this.readyResolve?.();
      return;
    }
    if (type === "open") {
      const streamId = Number(frame.streamId);
      if (!Number.isInteger(streamId)) return;
      this.streams.set(streamId, {
        streamId,
        kind: String(frame.kind ?? "invoke"),
        method: String(frame.method ?? "POST"),
        path: String(frame.path ?? ""),
        headers: (frame.headers && typeof frame.headers === "object"
          ? frame.headers as Record<string, string>
          : {}),
        body: Buffer.alloc(0),
      });
      return;
    }
    if (type === "close") {
      const streamId = Number(frame.streamId);
      const stream = this.streams.get(streamId);
      if (stream) this.handleStream(stream);
    }
  }

  private handleStream(stream: StreamState): void {
    this.streams.delete(stream.streamId);
    let payload: unknown = null;
    try { payload = stream.body.length > 0 ? JSON.parse(stream.body.toString("utf8")) : null; } catch {}
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    let result: unknown;
    if (stream.path.startsWith("/v1/git/capture")) {
      result = { repos: [] };
    } else if (stream.path.startsWith("/v1/invocations")) {
      const handler = String(record.handler ?? "");
      const params = record.params && typeof record.params === "object"
        ? record.params as Record<string, unknown>
        : {};
      result = machineResult(handler, params, this.worktreeBase);
    } else {
      result = {
        status: "failed",
        error: { code: "MachineServer.Unavailable", message: `未实现的路径 ${stream.path}` },
      };
    }
    this.respond(stream.streamId, 200, result);
  }

  private respond(streamId: number, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload));
    this.send({
      type: "response",
      streamId,
      status,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
      },
    });
    this.sendBinary(encodeDataFrame(streamId, body));
    this.send({ type: "close", streamId });
  }
}

function tunnelError(error: unknown, prefix: string): Error {
  const message = `${prefix}：${error instanceof Error ? error.message : String(error)}`;
  const failure = new Error(message, { cause: error });
  (failure as Error & { code?: string }).code = /40[13]|unauthor|forbidden/iu.test(message)
    ? "device_token_rejected"
    : "device_connect_failed";
  return failure;
}

function tokenRejected(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "device_token_rejected";
}

export class HeadlessDeviceRuntime implements DeviceRuntimePort {
  private readonly app: CapyAppPort;
  private readonly store: SecretStorePort;
  private readonly clock: ClockPort;
  private readonly logger: LoggerPort | undefined;
  private readonly devices = new Map<string, HeadlessDevice>();
  private readonly inflight = new Map<string, Promise<DeviceInfo>>();

  constructor(options: {
    readonly app: CapyAppPort;
    readonly store: SecretStorePort;
    readonly clock: ClockPort;
    readonly logger?: LoggerPort;
  }) {
    this.app = options.app;
    this.store = options.store;
    this.clock = options.clock;
    this.logger = options.logger;
  }

  async ensure(session: AccountSession, signal?: AbortSignal): Promise<DeviceInfo> {
    const key = accountKey(session);
    const hit = this.inflight.get(key);
    if (hit) return await hit;
    const task = this.ensureOne(session, signal);
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  close(): void {
    for (const device of this.devices.values()) device.close();
    this.devices.clear();
  }

  private async ensureOne(session: AccountSession, signal?: AbortSignal): Promise<DeviceInfo> {
    const key = accountKey(session);
    const existing = this.devices.get(key);
    if (existing) {
      try {
        await existing.ensure();
        return this.infoOf(existing);
      } catch {
        existing.close();
        this.devices.delete(key);
      }
    }

    const jwt = await this.app.sessionJwt(session.clerk, signal);
    let credential = await this.store.load(key);
    if (!credential || credential.orgId !== session.orgId) {
      credential = await this.pair(session, jwt, signal);
    }

    let device: HeadlessDevice;
    try {
      device = await this.connect(credential, signal);
    } catch (error) {
      if (!tokenRejected(error)) throw error;
      credential = await this.pair(session, jwt, signal);
      device = await this.connect(credential, signal);
    }
    const connected = await this.waitConnected(jwt, session.orgId, credential.deviceId, signal);
    if (!connected) {
      device.close();
      throw new CapyError("upstream_unavailable", "无头设备已连上隧道，但服务端没有标记 connected");
    }
    this.devices.set(key, device);
    return { id: credential.deviceId, name: credential.name, connected: true };
  }

  private infoOf(device: HeadlessDevice): DeviceInfo {
    return device.info;
  }

  private async connect(credential: HeadlessCredential, signal?: AbortSignal): Promise<HeadlessDevice> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const device = new HeadlessDevice({ credential });
      try {
        await device.ensure();
        return device;
      } catch (error) {
        lastError = error;
        this.logger?.warn("capy device connect failed", {
          attempt,
          code: String((error as { code?: unknown } | null)?.code ?? ""),
          message: errorText(error),
        });
        device.close();
        if (tokenRejected(error) || attempt === 3) break;
        await this.clock.sleep(800 * attempt, signal);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new CapyError("upstream_unavailable", `无头设备连接失败：${String(lastError)}`);
  }

  private async pair(session: AccountSession, jwt: string, signal?: AbortSignal): Promise<HeadlessCredential> {
    const start = await this.app.startDeviceCode(jwt, {
      hostname: os.hostname(),
      os: deviceOs(),
      arch: deviceArch(),
    }, signal);
    try {
      await this.app.approveDeviceCode(jwt, session.orgId, start.userCode, HEADLESS_NAME, signal);
    } catch (error) {
      const hint = start.verificationUrl ? `；可在浏览器打开 ${start.verificationUrl} 手动批准` : "";
      throw new CapyError("device_pair_failed", `Capy 设备码自动批准失败：${errorText(error)}${hint}`);
    }
    for (let i = 0; i < 10; i += 1) {
      let poll;
      try {
        poll = await this.app.pollDeviceCode(jwt, start.deviceCode, signal);
      } catch (error) {
        if ((error as { status?: unknown } | null)?.status === 401) throw error;
        await this.clock.sleep(start.pollIntervalSeconds * 1000, signal);
        continue;
      }
      if (poll.status === "approved") {
        const credential: HeadlessCredential = {
          orgId: poll.enrolled.orgId || session.orgId,
          deviceId: poll.enrolled.deviceId,
          name: poll.enrolled.name || HEADLESS_NAME,
          token: poll.enrolled.token,
        };
        await this.store.save(accountKey(session), credential);
        return credential;
      }
      if (poll.status === "denied" || poll.status === "expired") {
        throw new CapyError("device_pair_failed", `Capy 设备码配对${poll.status === "denied" ? "被拒绝" : "已过期"}`);
      }
      await this.clock.sleep(start.pollIntervalSeconds * 1000, signal);
    }
    throw new CapyError("upstream_timeout", "等待 Capy 设备码批准超时");
  }

  private async waitConnected(
    jwt: string,
    orgId: string,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const devices = await this.app.listDevices(jwt, orgId, signal).catch(() => []);
      const hit = devices.find((device) => device.id === deviceId);
      if (hit?.connected) return true;
      await this.clock.sleep(CONNECT_POLL_MS, signal);
    }
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
