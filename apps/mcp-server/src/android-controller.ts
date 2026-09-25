import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  androidCommandRequestSchema,
  androidPollRequestSchema,
  androidPollResponseSchema,
  androidResultRequestSchema,
  androidResultResponseSchema,
  androidSnapshotSchema,
  androidImageSchema,
  androidUiNodeSchema,
  type AndroidCommandRequest,
  type AndroidPollRequest,
  type AndroidPollResponse,
  type AndroidResultRequest,
} from "../../../packages/protocol/src/android.ts";

const DEFAULT_POLL_WAIT_MS = 25_000;
const DEFAULT_OFFLINE_AFTER_MS = 90_000;
const MAX_TIMER_MS = 2_147_000_000;
const DEADLINE_PERSIST_RETRY_MS = 250;
const DEFAULT_MAX_DETAILED_COMMANDS = 256;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PHONE_POLL_RESPONSE_BYTES = 16 * 1024 * 1024;
const PHONE_POLL_RESPONSE_MARGIN_BYTES = 64 * 1024;
const SEEN_FILTER_BYTES = 128 * 1024;
const SEEN_FILTER_HASHES = 6;
const androidOperations = ["observe", "tap", "swipe", "set_text", "node_action", "global_action", "open_app", "shell"] as const;
type AndroidOperation = (typeof androidOperations)[number];
function isAndroidOperation(value: unknown): value is AndroidOperation {
  return typeof value === "string" && (androidOperations as readonly string[]).includes(value);
}

const configSchema = z.object({
  host: z.string().min(1), port: z.number().int().min(0).max(65535), stateDir: z.string().min(1),
  maxBodyBytes: z.number().int().positive().nullable().optional(),
  devices: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), token: z.string().min(32).regex(/^\S+$/) }).strict()).min(1),
}).strict();

type InternalStatus = "queued" | "dispatched" | "completed" | "error" | "outcome_unknown" | "cancelled" | "expired";
type TerminalStatus = Exclude<InternalStatus, "queued" | "dispatched">;

type PersistedCommand = {
  commandId: string;
  fingerprint: string;
  operation?: AndroidOperation;
  status: InternalStatus;
  deliveryId?: string;
  sessionId?: string;
  expiresAt?: number;
  dispatchedAt?: number;
  resultDigest?: string;
};

type PersistedStore = { version: 1; commands: PersistedCommand[] };

type CommandResult = {
  commandId: string;
  status: TerminalStatus;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

type CommandLookup = CommandResult | {
  commandId: string;
  status: InternalStatus;
  fingerprint?: string;
  deliveryId?: string;
  sessionId?: string;
  compacted?: boolean;
} | {
  commandId: string;
  status: "history_unavailable";
  compacted: true;
  noReplay: true;
  reason: "terminal_history_compacted_or_filter_match";
};

type RuntimeCommand = PersistedCommand & {
  request?: AndroidCommandRequest;
  result?: CommandResult;
  resolves?: Array<(result: CommandResult) => void>;
  timer?: ReturnType<typeof setTimeout>;
  unknownSynthetic?: boolean;
  cancelRequested?: boolean;
};

export type AndroidControllerDeviceConfig = { name: string; token: string };
export type AndroidControllerConfig = {
  host: string;
  port: number;
  stateDir: string;
  devices: AndroidControllerDeviceConfig[];
  maxBodyBytes?: number | null;
};
export type AndroidControllerOptions = { pollWaitMs?: number; offlineAfterMs?: number; maxDetailedCommands?: number };

export type AndroidDeviceDescriptor = {
  name: string;
  url: `android-reverse://${string}`;
  transport: "android-reverse";
  contexts: { system: false; user: true; desktop: false };
};

export type AndroidDeviceStatus = {
  name: string;
  transport: "android-reverse";
  online: boolean;
  readiness: "ready" | "offline" | "screen_off" | "keyguard_locked" | "accessibility_unavailable" | "paused" | "user_locked";
  readinessReason: string;
  observedAt: number | null;
  lastPollAt: number | null;
  state: AndroidPollRequest["state"] | null;
  queuedCommands: number;
  activeCommandId: string | null;
};

type Device = {
  config: AndroidControllerDeviceConfig;
  tokenDigest: Buffer;
  filePath: string;
  seenFilePath: string;
  seenFilter: Buffer;
  commands: Map<string, RuntimeCommand>;
  queue: string[];
  sessionId: string | null;
  controlGeneration: number | null;
  state: AndroidPollRequest["state"] | null;
  observedAt: number | null;
  lastPollAt: number | null;
  poll?: PollWaiter;
  active?: RuntimeCommand;
};

type PollWaiter = { req: IncomingMessage; res: ServerResponse; timer: ReturnType<typeof setTimeout>; startedAtMonotonicMs: number };

export class AndroidControllerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "AndroidControllerError";
    this.code = code;
    this.status = status;
  }
}

function sha256(value: string): Buffer { return createHash("sha256").update(value).digest(); }

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function digest(value: unknown): string { return sha256(stableJson(value)).toString("hex"); }

type AndroidObserveRequest = Extract<AndroidCommandRequest, { operation: "observe" }>;

const legacyObserveRequests = (() => {
  const values = new Map<string, AndroidObserveRequest>();
  for (const image of [false, true]) {
    for (const tree of [false, true]) {
      for (let maxNodes = 1; maxNodes <= 1000; maxNodes++) {
        const request: AndroidObserveRequest = { operation: "observe", image, tree, maxNodes };
        values.set(digest(request), request);
      }
    }
  }
  return values;
})();

function recoveredObserveRequest(item: PersistedCommand): AndroidObserveRequest | undefined {
  return legacyObserveRequests.get(item.fingerprint);
}

function recoveredOperation(item: PersistedCommand): AndroidOperation | undefined {
  if (item.operation) return item.operation;
  // Pre-operation M18 journals still contain the SHA-256 fingerprint of the
  // canonical request. Observe has a finite canonical input space, so we can
  // migrate it exactly without persisting screenshots/text or weakening legacy
  // action compatibility.
  return recoveredObserveRequest(item)?.operation;
}

function isTerminal(status: InternalStatus): status is TerminalStatus {
  return status !== "queued" && status !== "dispatched";
}

function safeFileName(name: string): string { return `android-${sha256(name).toString("hex").slice(0, 24)}.json`; }

function seenIndexes(commandId: string): number[] {
  const value = sha256(commandId);
  const bitCount = SEEN_FILTER_BYTES * 8;
  const first = value.readUInt32BE(0);
  const rawStep = value.readUInt32BE(4);
  const step = rawStep % 2 === 0 ? rawStep + 1 : rawStep;
  return Array.from({ length: SEEN_FILTER_HASHES }, (_, index) => (first + index * step + index * index) % bitCount);
}

function seenHas(filter: Buffer, commandId: string): boolean {
  return seenIndexes(commandId).every((bit) => (filter[bit >> 3]! & (1 << (bit & 7))) !== 0);
}

function seenAdd(filter: Buffer, commandId: string): void {
  for (const bit of seenIndexes(commandId)) filter[bit >> 3] = filter[bit >> 3]! | (1 << (bit & 7));
}

function loadSeenFilter(filePath: string): Buffer {
  if (!existsSync(filePath)) return Buffer.alloc(SEEN_FILTER_BYTES);
  const value = readFileSync(filePath);
  if (value.length !== SEEN_FILTER_BYTES) throw new Error("Invalid Android seen-command filter; refusing replay-unsafe recovery");
  return Buffer.from(value);
}

function ensurePrivateDir(stateDir: string): void {
  if (!path.isAbsolute(stateDir)) throw new Error("Android stateDir must be absolute");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const mode = statSync(stateDir).mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077) !== 0) throw new Error("Android stateDir must not be group/world accessible");
}

function atomicWriteBytes(filePath: string, value: Buffer): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tempPath, "wx", 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tempPath, filePath);
    chmodSync(filePath, 0o600);
    if (process.platform !== "win32") {
      const dir = openSync(path.dirname(filePath), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally {
    try { unlinkSync(tempPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tempPath, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tempPath, filePath);
    chmodSync(filePath, 0o600);
    // POSIX directory sync persists the identity rename before dispatch.
    // Windows cannot open/fsync directory handles through this Node API.
    if (process.platform !== "win32") {
      const dir = openSync(path.dirname(filePath), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally {
    try { unlinkSync(tempPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function parseAuth(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

function authMatches(token: string, presented: string | null): boolean {
  if (!presented) return false;
  const expected = sha256(token);
  const actual = sha256(presented);
  return timingSafeEqual(expected, actual);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage, maxBodyBytes: number | null): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (maxBodyBytes !== null && bytes > maxBodyBytes) throw new AndroidControllerError("payload_too_large", "Android request body is too large", 413);
    chunks.push(buffer);
  }
  if (!chunks.length) throw new AndroidControllerError("invalid_json", "Android request body is empty", 400);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AndroidControllerError("invalid_json", "Android request body is not valid JSON", 400); }
}

function protocolError(error: z.ZodError): AndroidControllerError {
  const detail = error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  return new AndroidControllerError("protocol_mismatch", detail || "Android protocol validation failed", 400);
}

function commandResult(command: RuntimeCommand): CommandResult {
  if (command.result) return command.result;
  if (command.status === "completed" || command.status === "error") return { commandId: command.commandId, status: command.status, ok: command.status === "completed", result: { payloadRetained: false } };
  if (command.status === "cancelled") return { commandId: command.commandId, status: "cancelled", ok: false, error: { code: "cancelled", message: "Command was cancelled before dispatch" } };
  if (command.status === "expired") return { commandId: command.commandId, status: "expired", ok: false, error: { code: "expired", message: "Command expired before dispatch" } };
  return { commandId: command.commandId, status: "outcome_unknown", ok: false, error: { code: "outcome_unknown", message: "The command may have affected the device; it will not be replayed" } };
}

function isLoopbackOrTailscale(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export function parseAndroidControllerConfig(value: unknown): AndroidControllerConfig {
  const config = configSchema.parse(value);
  if (!isLoopbackOrTailscale(config.host)) throw new Error("Android controller host must be loopback or a literal Tailscale IPv4 address");
  if (!path.isAbsolute(config.stateDir)) throw new Error("Android controller stateDir must be absolute");
  const names = new Set<string>();
  const tokens = new Set<string>();
  for (const device of config.devices) {
    const key = device.name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate Android device name: ${device.name}`);
    names.add(key);
    if (tokens.has(device.token)) throw new Error("Android devices must use independent credentials");
    tokens.add(device.token);
  }
  return config;
}

export function loadAndroidControllerConfig(env: NodeJS.ProcessEnv = process.env): AndroidControllerConfig | undefined {
  const source = env.RCMCP_ANDROID_CONFIG;
  if (!source) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(source, "utf8")); }
  catch { throw new Error("RCMCP_ANDROID_CONFIG must point to readable JSON"); }
  return parseAndroidControllerConfig(value);
}

export class AndroidController {
  private readonly stateDir: string;
  private readonly devicesByName = new Map<string, Device>();
  private readonly pollWaitMs: number;
  private readonly offlineAfterMs: number;
  private readonly maxDetailedCommands: number;
  private server: Server | null = null;
  private closed = false;
  readonly config: AndroidControllerConfig;

  constructor(config: AndroidControllerConfig, options: AndroidControllerOptions = {}) {
    this.config = parseAndroidControllerConfig(config);
    this.stateDir = this.config.stateDir;
    ensurePrivateDir(this.stateDir);
    this.pollWaitMs = Number.isFinite(options.pollWaitMs) && (options.pollWaitMs ?? 0) >= 1 ? Math.floor(options.pollWaitMs!) : DEFAULT_POLL_WAIT_MS;
    this.offlineAfterMs = Number.isFinite(options.offlineAfterMs) && (options.offlineAfterMs ?? 0) >= 1 ? Math.floor(options.offlineAfterMs!) : DEFAULT_OFFLINE_AFTER_MS;
    this.maxDetailedCommands = Number.isFinite(options.maxDetailedCommands) && (options.maxDetailedCommands ?? 0) >= 1 ? Math.floor(options.maxDetailedCommands!) : DEFAULT_MAX_DETAILED_COMMANDS;
    for (const deviceConfig of this.config.devices) {
      const filePath = path.join(this.stateDir, safeFileName(deviceConfig.name));
      const seenFilePath = `${filePath}.seen`;
      const device: Device = {
        config: deviceConfig, tokenDigest: sha256(deviceConfig.token), filePath, seenFilePath, seenFilter: loadSeenFilter(seenFilePath),
        commands: new Map(), queue: [], sessionId: null, controlGeneration: null, state: null, observedAt: null, lastPollAt: null,
      };
      this.loadDevice(device);
      this.devicesByName.set(deviceConfig.name, device);
    }
  }

  private loadDevice(device: Device): void {
    if (!existsSync(device.filePath)) return;
    const parsed = JSON.parse(readFileSync(device.filePath, "utf8")) as PersistedStore;
    if (parsed?.version !== 1 || !Array.isArray(parsed.commands)) throw new Error(`Invalid Android command store for ${device.config.name}`);
    let changed = false;
    for (const item of parsed.commands) {
      if (!item || !z.string().uuid().safeParse(item.commandId).success || !/^[a-f0-9]{64}$/.test(item.fingerprint)
        || !["queued", "dispatched", "completed", "error", "outcome_unknown", "cancelled", "expired"].includes(item.status)
        || device.commands.has(item.commandId)) throw new Error("Invalid Android command journal; no commands may be replayed");
      if (item.resultDigest !== undefined && !/^[a-f0-9]{64}$/.test(item.resultDigest)) throw new Error("Invalid Android result digest in journal");
      if (item.operation !== undefined && !isAndroidOperation(item.operation)) throw new Error("Invalid Android operation in journal");
      if (item.deliveryId !== undefined && (!z.string().uuid().safeParse(item.deliveryId).success || !z.string().uuid().safeParse(item.sessionId).success)) {
        throw new Error("Invalid Android delivery binding in journal");
      }
      const status: InternalStatus = item.status === "queued" ? "cancelled" : item.status === "dispatched" ? "outcome_unknown" : item.status;
      const operation = recoveredOperation(item);
      const recoveredRequest = operation === "observe" ? recoveredObserveRequest(item) : undefined;
      if (item.status !== status || operation !== item.operation) changed = true;
      device.commands.set(item.commandId, {
        ...item, ...(operation ? { operation } : {}), ...(recoveredRequest ? { request: recoveredRequest } : {}), status,
        ...(status === "outcome_unknown" && !item.resultDigest ? { unknownSynthetic: true } : {}),
      });
    }
    const compacted = this.compactDevice(device);
    if (changed || compacted) this.persist(device);
  }

  private compactDevice(device: Device): boolean {
    if (device.commands.size <= this.maxDetailedCommands) return false;
    const victims: string[] = [];
    let remaining = device.commands.size;
    for (const [commandId, command] of device.commands) {
      if (remaining <= this.maxDetailedCommands) break;
      if (!isTerminal(command.status) || command.resolves?.length || device.active === command) continue;
      victims.push(commandId);
      remaining--;
    }
    if (!victims.length) return false;
    // Build the replacement filter off to the side. A failed write must not
    // poison the live process with tombstones that were never made durable.
    const nextSeenFilter = Buffer.from(device.seenFilter);
    for (const commandId of victims) seenAdd(nextSeenFilter, commandId);
    // Persist the fail-closed seen filter before deleting detailed records. A
    // crash between these two writes can only create a false positive, never a
    // replay hole.
    atomicWriteBytes(device.seenFilePath, nextSeenFilter);
    device.seenFilter = nextSeenFilter;
    for (const commandId of victims) device.commands.delete(commandId);
    return true;
  }

  private persist(device: Device): void {
    const store: PersistedStore = {
      version: 1,
      commands: [...device.commands.values()].map(({ commandId, fingerprint, operation, status, deliveryId, sessionId, expiresAt, dispatchedAt, resultDigest }) => ({
        commandId, fingerprint, ...(operation ? { operation } : {}), status, ...(deliveryId ? { deliveryId } : {}), ...(sessionId ? { sessionId } : {}),
        ...(expiresAt ? { expiresAt } : {}), ...(dispatchedAt ? { dispatchedAt } : {}), ...(resultDigest ? { resultDigest } : {}),
      })),
    };
    atomicWrite(device.filePath, store);
  }

  private find(name: string): Device {
    const device = [...this.devicesByName.values()].find(item => item.config.name.toLowerCase() === name.toLowerCase());
    if (!device) throw new AndroidControllerError("unknown_device", `Unknown Android device: ${name}`, 404);
    return device;
  }

  private online(device: Device): boolean {
    if (this.closed || device.sessionId === null || device.lastPollAt === null) return false;
    const now = Date.now();
    if (now - device.lastPollAt <= this.offlineAfterMs) return true;
    const active = device.active;
    return active?.status === "dispatched"
      && active.sessionId === device.sessionId
      && (active.expiresAt ?? 0) > now;
  }

  descriptors(): AndroidDeviceDescriptor[] {
    return [...this.devicesByName.values()].map((device) => ({ name: device.config.name, url: `android-reverse://${device.config.name}`, transport: "android-reverse", contexts: { system: false, user: true, desktop: false } }));
  }

  descriptor(name: string): AndroidDeviceDescriptor { return this.descriptors().find((item) => item.name.toLowerCase() === name.toLowerCase()) ?? (() => { throw new AndroidControllerError("unknown_device", `Unknown Android device: ${name}`, 404); })(); }

  status(name?: string): AndroidDeviceStatus | AndroidDeviceStatus[] {
    const values = [...this.devicesByName.values()].map((device): AndroidDeviceStatus => {
      const state = device.state;
      let readiness: AndroidDeviceStatus["readiness"] = "offline";
      let readinessReason = "No recent authenticated poll";
      if (this.online(device)) {
        if (!state?.userUnlocked) { readiness = "user_locked"; readinessReason = "Android user is not unlocked"; }
        else if (state.paused) { readiness = "paused"; readinessReason = "Local pause is active"; }
        else if (!state.accessibility) { readiness = "accessibility_unavailable"; readinessReason = "Accessibility service is unavailable"; }
        else if (state.keyguardLocked) { readiness = "keyguard_locked"; readinessReason = "Secure keyguard is locked"; }
        else if (!state.screenOn) { readiness = "screen_off"; readinessReason = "Screen is off; input availability is not claimed"; }
        else { readiness = "ready"; readinessReason = "Authenticated poll and required UI capability are available"; }
      }
      return { name: device.config.name, transport: "android-reverse", online: this.online(device), readiness, readinessReason, observedAt: device.observedAt, lastPollAt: device.lastPollAt, state, queuedCommands: device.queue.length, activeCommandId: device.active?.commandId ?? null };
    });
    return name === undefined ? values : values.find((item) => item.name.toLowerCase() === name.toLowerCase()) ?? (() => { throw new AndroidControllerError("unknown_device", `Unknown Android device: ${name}`, 404); })();
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.closed) throw new Error("Closed Android controller cannot restart; construct a new instance");
    this.server = createServer((req, res) => { void this.handleHttp(req, res); });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.config.port, this.config.host);
    });
  }

  address(): { address: string; family: string; port: number } | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    return { address: address.address, family: address.family, port: address.port };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    this.server = null;
    let failure: unknown;
    const rememberFailure = (error: unknown) => { failure ??= error; };

    try {
      for (const device of this.devicesByName.values()) {
        try {
          this.finishPoll(device, { version: 1, serverTime: Date.now(), command: null });
        } catch (error) {
          rememberFailure(error);
        }
        for (const command of device.commands.values()) {
          try {
            if (command.status === "queued") this.cancelQueued(device, command, "cancelled");
            else if (command.status === "dispatched") this.finishUnknown(command, "Controller shut down before result");
          } catch (error) {
            // Transactional command transitions restore their pre-close state on
            // persistence failure. Record the failure, continue draining timers,
            // and still close the listener below so shutdown cannot hang.
            rememberFailure(error);
          } finally {
            if (command.timer) clearTimeout(command.timer);
          }
        }
        device.sessionId = null;
      }
    } finally {
      if (server) {
        try {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          });
        } catch (error) {
          rememberFailure(error);
        }
      }
    }

    if (failure !== undefined) throw failure;
  }

  private authenticate(device: Device, request: IncomingMessage): void {
    const presented = parseAuth(request.headers.authorization);
    const expected = device.tokenDigest;
    const actual = presented ? sha256(presented) : Buffer.alloc(expected.length);
    if (!timingSafeEqual(expected, actual)) throw new AndroidControllerError(presented ? "forbidden" : "unauthorized", "Android credential rejected", presented ? 403 : 401);
  }

  private finishPoll(device: Device, response: unknown): void {
    const poll = device.poll;
    if (!poll) return;
    clearTimeout(poll.timer);
    device.poll = undefined;
    if (!poll.res.writableEnded) json(poll.res, 200, {
      ...(response as Record<string, unknown>),
      serverTime: Date.now(),
      serverWaitMs: Math.max(0, Math.floor(performance.now() - poll.startedAtMonotonicMs)),
    });
  }

  private markSessionLost(device: Device, sessionId: string): void {
    if (device.sessionId !== sessionId) return;
    if (device.active && !isTerminal(device.active.status)) this.finishUnknown(device.active, "The phone session disconnected after dispatch");
    device.active = undefined;
    device.sessionId = null;
    if (device.poll) this.finishPoll(device, { version: 1, serverTime: Date.now(), command: null });
  }

  private cancelQueuedForControlGenerationChange(device: Device): void {
    for (const commandId of [...device.queue]) {
      const command = device.commands.get(commandId);
      if (command?.status === "queued") this.requestQueuedCancellation(device, command);
    }
  }

  private resultForPoll(command: RuntimeCommand): AndroidPollResponse {
    return { version: 1, serverTime: Date.now(), serverWaitMs: 0, command: { commandId: command.commandId, deliveryId: command.deliveryId!, expiresAt: command.expiresAt!, request: command.request! } };
  }

  private dispatchNext(device: Device): void {
    if (this.closed || device.active || !device.poll || !device.sessionId) return;
    while (device.queue.length) {
      const command = device.commands.get(device.queue[0]!);
      if (!command) { device.queue.shift(); continue; }
      if (command.status !== "queued") { device.queue.shift(); continue; }
      if (command.cancelRequested) {
        // A caller/session cancellation that could not yet be journaled must
        // block dispatch. finishCommand recursively advances the queue after
        // the terminal cancellation becomes durable.
        try {
          this.cancelQueued(device, command, "cancelled");
        } catch {
          this.armQueuedCancellationRetry(device, command);
        }
        return;
      }
      if ((command.expiresAt ?? Number.MAX_SAFE_INTEGER) <= Date.now()) {
        // finishCommand recursively advances the queue. Return because that
        // recursive dispatch may consume the only waiting poll and/or install
        // a new active command.
        this.finishCommand(device, command, "expired", false, { code: "expired", message: "Command expired before dispatch" });
        return;
      }
      const previous = {
        queue: device.queue,
        status: command.status,
        deliveryId: command.deliveryId,
        sessionId: command.sessionId,
        dispatchedAt: command.dispatchedAt,
      };
      device.queue = device.queue.slice(1);
      command.status = "dispatched";
      command.deliveryId = randomUUID();
      command.sessionId = device.sessionId;
      command.dispatchedAt = Date.now();
      // This synchronous journal write is intentionally before the poll response.
      // If it fails, restore a fully queued command so the next poll can retry
      // dispatch without losing or ambiguously half-delivering the request.
      try {
        this.persist(device);
      } catch (persistError) {
        device.queue = previous.queue;
        command.status = previous.status;
        command.deliveryId = previous.deliveryId;
        command.sessionId = previous.sessionId;
        command.dispatchedAt = previous.dispatchedAt;
        throw persistError;
      }
      device.active = command;
      this.armTimer(device, command);
      this.finishPoll(device, this.resultForPoll(command));
      return;
    }
  }

  private armTimer(device: Device, command: RuntimeCommand, retryDelayMs?: number): void {
    if (command.timer) clearTimeout(command.timer);
    const remaining = retryDelayMs ?? Math.max(0, (command.expiresAt ?? Date.now()) - Date.now());
    command.timer = setTimeout(() => this.handleDeadline(device, command), Math.min(MAX_TIMER_MS, remaining));
    command.timer.unref?.();
  }

  private handleDeadline(device: Device, command: RuntimeCommand): void {
    if (this.closed || isTerminal(command.status)) return;
    try {
      if (command.status === "queued") {
        this.finishCommand(device, command, "expired", false, { code: "expired", message: "Command expired before dispatch" });
      } else if (command.status === "dispatched") {
        this.finishUnknown(command, "Command deadline elapsed after dispatch");
      }
    } catch {
      // Persistence failure must never escape the timer callback and crash the
      // MCP process. finishCommand/finishUnknown restore the recoverable
      // pre-transition state; retry the durable transition at a bounded pace.
      if (!this.closed && !isTerminal(command.status)) this.armTimer(device, command, DEADLINE_PERSIST_RETRY_MS);
    }
  }

  private finishUnknown(command: RuntimeCommand, message: string): void {
    const device = [...this.devicesByName.values()].find((candidate) => candidate.commands.get(command.commandId) === command);
    if (!device || isTerminal(command.status)) return;
    const previousUnknownSynthetic = command.unknownSynthetic;
    command.unknownSynthetic = true;
    try {
      this.finishCommand(device, command, "outcome_unknown", false, { code: "outcome_unknown", message });
    } catch (error) {
      command.unknownSynthetic = previousUnknownSynthetic;
      throw error;
    }
  }

  private finishCommand(device: Device, command: RuntimeCommand, status: TerminalStatus, ok: boolean, error?: { code: string; message: string }, result?: Record<string, unknown>): void {
    if (isTerminal(command.status) && command.result && command.status !== "outcome_unknown") return;
    const previous = {
      status: command.status,
      result: command.result,
      resultDigest: command.resultDigest,
      queue: device.queue,
      active: device.active,
    };
    const completedResult: CommandResult = { commandId: command.commandId, status, ok, ...(result ? { result } : {}), ...(error ? { error } : {}) };
    device.queue = device.queue.filter(id => id !== command.commandId);
    command.status = status;
    command.result = completedResult;
    command.resultDigest = command.unknownSynthetic ? undefined : digest(completedResult);
    // Keep only controller-synthesized uncertainty active until a late
    // authoritative result or a new execution session. A phone-submitted
    // outcome_unknown is already terminal and must release the serial slot.
    if (device.active === command && (status !== "outcome_unknown" || !command.unknownSynthetic)) device.active = undefined;
    try {
      // The terminal state must be durable before callers are released or the
      // phone is ACKed. On failure restore the exact dispatch state so an
      // identical result retry can complete the original caller.
      this.persist(device);
    } catch (persistError) {
      command.status = previous.status;
      command.result = previous.result;
      command.resultDigest = previous.resultDigest;
      device.queue = previous.queue;
      device.active = previous.active;
      throw persistError;
    }
    if (command.timer) clearTimeout(command.timer);
    for (const resolve of command.resolves ?? []) resolve(completedResult);
    command.resolves = undefined;
    // Large screenshots/UI trees are caller payloads, not controller history.
    command.result = undefined;
    // Retention is secondary to the already-durable terminal transition. If
    // compaction cannot persist, retain/recover the detailed record instead of
    // turning a successful result acknowledgement into a retry loop.
    try { if (this.compactDevice(device)) this.persist(device); } catch { /* retry on a future terminal transition */ }
    this.dispatchNext(device);
  }

  private cancelQueued(device: Device, command: RuntimeCommand, status: "cancelled" | "expired"): void {
    // finishCommand owns queue removal so its transactional snapshot can restore
    // exact queued membership if the terminal journal write fails.
    this.finishCommand(device, command, status, false, { code: status, message: status === "cancelled" ? "Command was cancelled before dispatch" : "Command expired before dispatch" });
  }

  private requestQueuedCancellation(device: Device, command: RuntimeCommand): void {
    if (command.status !== "queued") return;
    command.cancelRequested = true;
    try {
      this.cancelQueued(device, command, "cancelled");
    } catch {
      // Keep the caller attached and the command non-dispatchable until the
      // terminal cancellation can be journaled. A restart is also fail-closed:
      // persisted queued entries are recovered as cancelled.
      this.armQueuedCancellationRetry(device, command);
    }
  }

  private armQueuedCancellationRetry(device: Device, command: RuntimeCommand): void {
    if (command.timer) clearTimeout(command.timer);
    command.timer = setTimeout(() => {
      if (this.closed || isTerminal(command.status) || command.status !== "queued") return;
      try {
        this.cancelQueued(device, command, "cancelled");
      } catch {
        this.armQueuedCancellationRetry(device, command);
      }
    }, DEADLINE_PERSIST_RETRY_MS);
    command.timer.unref?.();
  }

  private handlePollDisconnect(device: Device, sessionId: string): void {
    if (device.sessionId !== sessionId) return;

    // Invalidate liveness immediately so work submitted after a local STOP /
    // transport teardown is rejected instead of being queued for a future
    // replacement session.
    device.sessionId = null;

    if (device.active && device.active.sessionId === sessionId && !isTerminal(device.active.status)) {
      try {
        this.finishUnknown(device.active, "The phone long poll disconnected after dispatch");
      } catch {
        // Session is already offline, so no further dispatch is possible.
        // Reuse the bounded deadline retry path for the durable uncertainty.
        this.armTimer(device, device.active, DEADLINE_PERSIST_RETRY_MS);
      }
    }

    // Commands admitted while this session was considered online but not yet
    // dispatched must never cross the session boundary.
    for (const commandId of [...device.queue]) {
      const command = device.commands.get(commandId);
      if (command?.status === "queued") this.requestQueuedCancellation(device, command);
    }
  }

  private waitForExisting(command: RuntimeCommand, signal?: AbortSignal): Promise<CommandResult> {
    if (!signal) return new Promise<CommandResult>((resolve) => { (command.resolves ??= []).push(resolve); });
    if (signal.aborted) return Promise.resolve({
      commandId: command.commandId, status: "cancelled", ok: false,
      error: { code: "wait_cancelled", message: "Caller stopped waiting; the shared Android command continues" },
    });
    return new Promise<CommandResult>((resolve) => {
      const waiter = (result: CommandResult) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        command.resolves = command.resolves?.filter((candidate) => candidate !== waiter);
        signal.removeEventListener("abort", onAbort);
        resolve({ commandId: command.commandId, status: "cancelled", ok: false,
          error: { code: "wait_cancelled", message: "Caller stopped waiting; the shared Android command continues" } });
      };
      (command.resolves ??= []).push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private executeForDevice(device: Device, commandId: string, requestValue: unknown, deadline: number, signal?: AbortSignal): Promise<CommandResult> {
    if (!z.string().uuid().safeParse(commandId).success) throw new AndroidControllerError("invalid_command_id", "Android commandId must be a UUID", 400);
    const request = androidCommandRequestSchema.safeParse(requestValue);
    if (!request.success) throw protocolError(request.error);
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new AndroidControllerError("invalid_deadline", "Android command deadline must be a positive epoch-millisecond integer", 400);
    const deliveryProbe = {
      version: 1,
      serverTime: Number.MAX_SAFE_INTEGER,
      serverWaitMs: this.pollWaitMs,
      command: {
        commandId,
        deliveryId: "00000000-0000-4000-8000-000000000000",
        expiresAt: deadline,
        request: request.data,
      },
    };
    if (Buffer.byteLength(JSON.stringify(deliveryProbe), "utf8")
        > DEFAULT_MAX_PHONE_POLL_RESPONSE_BYTES - PHONE_POLL_RESPONSE_MARGIN_BYTES) {
      throw new AndroidControllerError("request_too_large", "Android command cannot fit in the companion poll-response budget", 413);
    }
    const fingerprint = digest(request.data);
    const existing = device.commands.get(commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new AndroidControllerError("command_conflict", "commandId is already bound to different input", 409);
      if (existing.result) return Promise.resolve(existing.result);
      if (isTerminal(existing.status)) return Promise.resolve(commandResult(existing));
      return this.waitForExisting(existing, signal);
    }
    if (seenHas(device.seenFilter, commandId)) {
      throw new AndroidControllerError("command_tombstoned", "commandId was compacted after a terminal outcome and will not be replayed", 409);
    }
    if (!this.online(device)) throw new AndroidControllerError("offline", "Android device has no recent authenticated poll", 409);
    const command: RuntimeCommand = { commandId, fingerprint, operation: request.data.operation, status: "queued", request: request.data, expiresAt: deadline };
    device.commands.set(commandId, command);
    device.queue.push(commandId);
    // The identity tombstone is durable before the command can be dispatched.
    // If persistence fails, roll back the in-memory submission so a command
    // already rejected to the caller cannot later escape from the queue.
    try {
      this.persist(device);
    } catch (error) {
      device.queue = device.queue.filter((id) => id !== commandId);
      device.commands.delete(commandId);
      throw error;
    }
    const promise = new Promise<CommandResult>((resolve) => { command.resolves = [resolve]; });
    this.armTimer(device, command);
    const onAbort = () => {
      if (command.status === "queued") {
        this.requestQueuedCancellation(device, command);
      } else if (command.status === "dispatched") {
        try {
          this.finishUnknown(command, "Caller cancelled after dispatch; effect status is unknown");
        } catch {
          // Do not reject a still-live command merely because the terminal
          // journal write is temporarily unavailable.
          this.armTimer(device, command, DEADLINE_PERSIST_RETRY_MS);
        }
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.dispatchNext(device);
    } catch {
      // The queued identity is already durable and dispatchNext restores the
      // exact queued state when its dispatch journal write fails. Keep the
      // original caller attached; the next authenticated poll retries the same
      // commandId instead of turning a storage failure into a replay hazard.
    }
    return promise.finally(() => signal?.removeEventListener("abort", onAbort));
  }

  execute(commandId: string, request: unknown, deadline: number, signal?: AbortSignal): Promise<CommandResult>;
  execute(device: string, commandId: string, request: unknown, deadline: number, signal?: AbortSignal): Promise<CommandResult>;
  execute(first: string, second: string | unknown, third: unknown, fourth?: number | AbortSignal, fifth?: AbortSignal): Promise<CommandResult> {
    const explicitDevice = typeof second === "string" && typeof third !== "string" && typeof fourth === "number";
    const deviceName = explicitDevice ? first : this.devicesByName.size === 1 ? [...this.devicesByName.keys()][0]! : undefined;
    const commandId = explicitDevice ? second as string : first;
    const request = explicitDevice ? third : second;
    const deadline = explicitDevice ? fourth as number : third as number;
    const signal = explicitDevice ? fifth : fourth instanceof AbortSignal ? fourth : undefined;
    if (!deviceName) throw new AndroidControllerError("device_required", "An Android device name is required when multiple devices are configured", 400);
    return this.executeForDevice(this.find(deviceName), commandId, request, deadline, signal);
  }

  lookup(commandId: string): CommandLookup | null;
  lookup(device: string, commandId: string): CommandLookup | null;
  lookup(first: string, second?: string): CommandLookup | null {
    const deviceName = second === undefined ? this.devicesByName.size === 1 ? [...this.devicesByName.keys()][0]! : undefined : first;
    const commandId = second === undefined ? first : second;
    if (!deviceName) throw new AndroidControllerError("device_required", "An Android device name is required when multiple devices are configured", 400);
    const device = this.find(deviceName);
    const command = device.commands.get(commandId);
    if (!command) return seenHas(device.seenFilter, commandId)
      ? { commandId, status: "history_unavailable", compacted: true, noReplay: true, reason: "terminal_history_compacted_or_filter_match" }
      : null;
    if (command.result) return command.result;
    return { commandId: command.commandId, status: command.status, fingerprint: command.fingerprint, ...(command.deliveryId ? { deliveryId: command.deliveryId } : {}), ...(command.sessionId ? { sessionId: command.sessionId } : {}) };
  }

  private async handlePoll(device: Device, body: unknown, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestStartedAtMonotonicMs = performance.now();
    const parsed = androidPollRequestSchema.safeParse(body);
    if (!parsed.success) throw protocolError(parsed.error);
    const poll = parsed.data;
    if (poll.device !== device.config.name) throw new AndroidControllerError("device_mismatch", "Poll device does not match the authenticated device", 403);
    if (device.poll) throw new AndroidControllerError("poll_in_progress", "Only one poll may be active per Android device", 409);
    const controlGenerationChanged = device.controlGeneration !== null
      && poll.state.controlGeneration !== device.controlGeneration;
    if (device.sessionId && (device.sessionId !== poll.sessionId || controlGenerationChanged)) {
      this.markSessionLost(device, device.sessionId);
    }
    if (controlGenerationChanged) this.cancelQueuedForControlGenerationChange(device);
    device.sessionId = poll.sessionId;
    device.controlGeneration = poll.state.controlGeneration;
    device.state = poll.state;
    device.observedAt = Date.now();
    device.lastPollAt = Date.now();
    if (device.active && device.active.sessionId !== poll.sessionId) this.finishUnknown(device.active, "A new phone session replaced the dispatched command");
    this.dispatchNext(device);
    if (res.writableEnded) return;
    const response: AndroidPollResponse = { version: 1, serverTime: Date.now(), serverWaitMs: 0, command: null };
    const queued = device.active;
    if (queued && queued.sessionId === poll.sessionId) {
      json(res, 200, { ...response, serverTime: Date.now(), serverWaitMs: Math.max(0, Math.floor(performance.now() - requestStartedAtMonotonicMs)) });
      return;
    }
    const timer = setTimeout(() => this.finishPoll(device, response), this.pollWaitMs);
    timer.unref?.();
    device.poll = { req, res, timer, startedAtMonotonicMs: requestStartedAtMonotonicMs };
    res.once("close", () => {
      if (device.poll?.res === res) {
        clearTimeout(timer);
        device.poll = undefined;
        this.handlePollDisconnect(device, poll.sessionId);
      }
    });
    try {
      this.dispatchNext(device);
    } catch (error) {
      // Server-side failures are rendered as HTTP errors. Remove this waiter
      // before that response closes so only a real client-side disconnect
      // invalidates the authenticated phone session.
      if (device.poll?.res === res) {
        clearTimeout(timer);
        device.poll = undefined;
      }
      throw error;
    }
  }

  private async handleResult(device: Device, body: unknown): Promise<void> {
    const parsed = androidResultRequestSchema.safeParse(body);
    if (!parsed.success) throw protocolError(parsed.error);
    const result = parsed.data;
    if (result.device !== device.config.name) throw new AndroidControllerError("device_mismatch", "Result device does not match the authenticated device", 403);
    const command = device.commands.get(result.commandId);
    if (!command) {
      // A terminal command may already have been compacted after its first
      // accepted result. ACK a retry that hits the durable fail-closed seen
      // filter so a lost HTTP acknowledgement cannot disable the companion.
      if (seenHas(device.seenFilter, result.commandId)) return;
      throw new AndroidControllerError("unknown_command", "Result commandId is not known", 404);
    }
    if (command.deliveryId !== result.deliveryId || command.sessionId !== result.sessionId) throw new AndroidControllerError("delivery_conflict", "Result is not bound to the dispatched session and delivery", 409);
    if (command.status === "queued" || command.status === "cancelled" || command.status === "expired") throw new AndroidControllerError("not_dispatched", "A command that was not dispatched cannot submit a result", 409);
    const resultValue = result.result;
    const operation = command.request?.operation ?? command.operation;
    // Pre-operation journals are migrated at load time when their canonical
    // fingerprint identifies an observe request. Unknown legacy non-observe
    // actions remain compatible; any payload that presents a snapshot is still
    // validated as observation data.
    const snapshotPresented = operation === undefined && resultValue !== undefined && Object.prototype.hasOwnProperty.call(resultValue, "snapshot");
    if (result.ok && (operation === "observe" || snapshotPresented) && !androidSnapshotSchema.safeParse(resultValue?.snapshot).success) {
      throw new AndroidControllerError("invalid_observation", "Completed observation lacks valid snapshot metadata", 400);
    }
    if (result.ok && operation === "observe") {
      const observeRequest = command.request?.operation === "observe" ? command.request : recoveredObserveRequest(command);
      if (!observeRequest) {
        throw new AndroidControllerError("invalid_observation", "Observation request metadata is unavailable for result validation", 400);
      }
      if (observeRequest.image && !androidImageSchema.safeParse(resultValue?.image).success) {
        throw new AndroidControllerError("invalid_observation", "Completed observation lacks the requested image or explicit image-unavailable result", 400);
      }
      if (observeRequest.tree) {
        const nodes = z.array(androidUiNodeSchema).max(observeRequest.maxNodes).safeParse(resultValue?.nodes);
        const fieldsTruncated = resultValue?.fieldsTruncated;
        if (!nodes.success || typeof resultValue?.treeTruncated !== "boolean"
          || (fieldsTruncated !== undefined && typeof fieldsTruncated !== "boolean")) {
          throw new AndroidControllerError("invalid_observation", "Completed observation lacks the requested validated UI tree", 400);
        }
      }
    }
    const outcome: CommandResult = {
      commandId: result.commandId,
      status: result.status,
      ok: result.ok,
      ...(resultValue ? { result: resultValue } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    const resultDigest = digest(outcome);
    if (command.resultDigest && command.resultDigest !== resultDigest) throw new AndroidControllerError("result_conflict", "A different result was already recorded for this delivery", 409);
    if (command.resultDigest) return;
    command.unknownSynthetic = false;
    this.finishCommand(device, command, result.status, result.ok, result.error, resultValue);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return; }
      const route = new URL(req.url ?? "/", "http://android-controller").pathname;
      if (route !== "/android/v1/poll" && route !== "/android/v1/result") { json(res, 404, { error: "not_found" }); return; }
      if (this.closed) throw new AndroidControllerError("closed", "Android controller is closing", 503);
      const presented = parseAuth(req.headers.authorization);
      if (!presented) throw new AndroidControllerError("unauthorized", "Android credential rejected", 401);
      const actual = sha256(presented);
      let device: Device | undefined;
      for (const candidate of this.devicesByName.values()) if (timingSafeEqual(candidate.tokenDigest, actual)) device = candidate;
      if (!device) throw new AndroidControllerError("forbidden", "Android credential rejected", 403);
      const raw = await readJson(req, this.config.maxBodyBytes === null ? null : this.config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (typeof raw !== "object" || raw === null || (raw as {device?:unknown}).device !== device.config.name) {
        throw new AndroidControllerError("device_mismatch", "Request is not bound to the authenticated device", 403);
      }
      if (route === "/android/v1/poll") { await this.handlePoll(device, raw, req, res); return; }
      if (route === "/android/v1/result") { await this.handleResult(device, raw); json(res, 200, androidResultResponseSchema.parse({ version: 1, accepted: true })); return; }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof AndroidControllerError) { json(res, error.status, { error: error.code, message: error.message }); return; }
      json(res, 500, { error: "internal_error" });
    }
  }
}
