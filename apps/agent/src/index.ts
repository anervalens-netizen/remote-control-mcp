import { registerFilesystemManageRoute } from "./filesystem-routes.ts";
import { timeoutMsField } from "../../../packages/protocol/src/deadline.ts";
import { registerBrowserRoutes } from "./browser-routes.ts";
import Fastify from "fastify";
import os from "node:os";
import process from "node:process";
import { z } from "zod";
import { fsList, fsRead, fsWrite, isValidBase64Data } from "./filesystem.ts";
import { receiveDirectTransfer, openRawFile } from "./direct-transfer.ts";
import { registerExtraRoutes } from "./extra-routes.ts";
import { killProcess, listProcesses, startProcess } from "./processes.ts";
import { ptyInput, ptyList, ptyOutput, ptyRemove, ptyResize, ptyStart, ptyTerminate } from "./pty.ts";
import { runCommand } from "./exec.ts";
import { registerDesktopRoutes } from "./desktop-routes.ts";
import { runtimeStatus } from "./runtime.ts";
import { recoverMoveCaptures } from "./filesystem-atomic.ts";

const host = process.env.RCMCP_AGENT_HOST ?? "127.0.0.1";
const port = Number(process.env.RCMCP_AGENT_PORT ?? "45231");
const token = process.env.RCMCP_AGENT_TOKEN;
const allowUnauthenticated = process.env.RCMCP_ALLOW_UNAUTHENTICATED === "1";

const moveCaptureRecovery = await recoverMoveCaptures();
if (moveCaptureRecovery.errors.length > 0 || moveCaptureRecovery.retained > 0) {
  console.error("Remote Control MCP move-capture recovery:", moveCaptureRecovery);
}

if (!token && !allowUnauthenticated) {
  throw new Error("RCMCP_AGENT_TOKEN is required unless RCMCP_ALLOW_UNAUTHENTICATED=1");
}

const execSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  env: z.record(z.string(), z.string()).optional(),
  maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
});
const fsReadSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  tailBytes: z.number().int().nonnegative().max(64 * 1024 * 1024).optional(),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(100_000).optional(),
  maxBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
}).superRefine((value, ctx) => {
  const lineMode = value.startLine !== undefined || value.lineCount !== undefined || value.maxBytes !== undefined;
  if (value.tailBytes !== undefined && (value.offset !== undefined || value.length !== undefined || lineMode)) {
    ctx.addIssue({ code: "custom", message: "tailBytes cannot be combined with byte or line-range options" });
  }
  if (lineMode && (value.length !== undefined || value.tailBytes !== undefined)) {
    ctx.addIssue({ code: "custom", message: "line-range options cannot be combined with length/tail options" });
  }
  if (lineMode && value.encoding === "base64") ctx.addIssue({ code: "custom", message: "line-range reads require UTF-8 encoding" });
});
const fsWriteSchema = z.object({
  path: z.string().min(1),
  data: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  mode: z.enum(["rewrite", "append"]).optional(),
  createParents: z.boolean().optional(),
  permissions: z.number().int().nonnegative().max(0o7777).optional(),
}).superRefine((value, ctx) => {
  if (value.encoding === "base64" && !isValidBase64Data(value.data)) {
    ctx.addIssue({ code: "custom", path: ["data"], message: "Invalid Base64 data" });
  }
});
const fsListSchema = z.object({ path: z.string().min(1) });
const fsRawReadSchema = z.object({ path: z.string().min(1) });
const fsDirectTransferSchema = z.object({
  sourceBase: z.string().url(),
  sourceToken: z.string().optional(),
  expectedBytes: z.number().int().nonnegative().optional(),
  expectedModifiedAt: z.string().datetime().optional(),
  preserveTimestamps: z.boolean().optional(),
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  timeoutMs: timeoutMsField.optional(),
});
const processStartSchema = z.object({
  command: z.string().min(1), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(),
});
const processKillSchema = z.object({
  pid: z.number().int().positive(),
  signal: z.union([z.string(), z.number().int()]).optional(),
});
const ptyStartSchema = z.object({ shell: z.string().optional(), cwd: z.string().optional(), cols: z.number().int().positive().optional(), rows: z.number().int().positive().optional(), env: z.record(z.string(), z.string()).optional() });
const ptyInputSchema = z.object({ id: z.string().min(1), data: z.string() });
const ptyOutputSchema = z.object({ id: z.string().min(1), offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().optional() });
const ptyResizeSchema = z.object({ id: z.string().min(1), cols: z.number().int().positive(), rows: z.number().int().positive() });
const ptyTerminateSchema = z.object({ id: z.string().min(1), signal: z.string().optional() });
const ptyRemoveSchema = z.object({ id: z.string().min(1), force: z.boolean().optional() });

const configuredBodyLimitBytes = process.env.RCMCP_BODY_LIMIT_BYTES === undefined
  ? null
  : Number(process.env.RCMCP_BODY_LIMIT_BYTES);
if (configuredBodyLimitBytes !== null && (!Number.isSafeInteger(configuredBodyLimitBytes) || configuredBodyLimitBytes <= 0)) {
  throw new Error("RCMCP_BODY_LIMIT_BYTES must be a positive safe integer when configured");
}
// Default to the same unbounded contract as the central MCP. Fastify requires
// a numeric parser limit, so MAX_SAFE_INTEGER is the practical no-fixed-cap value.
const bodyLimit = configuredBodyLimitBytes ?? Number.MAX_SAFE_INTEGER;
const app = Fastify({ logger: true, bodyLimit });
const runtimeWithHttpLimits = () => ({ ...runtimeStatus(), maxBodyBytes: configuredBodyLimitBytes, transferStagingVersion: 1 });

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health" || allowUnauthenticated) return;
  if (request.headers.authorization !== `Bearer ${token}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async () => ({ ok: true, device: os.hostname(), runtime: runtimeWithHttpLimits() }));
app.get("/v1/info", async () => ({
  hostname: os.hostname(), platform: process.platform, arch: process.arch, release: os.release(),
  uptimeSeconds: Math.floor(os.uptime()), cpuCount: os.cpus().length,
  totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), node: process.version,
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  runtime: runtimeWithHttpLimits(),
}));

app.post("/v1/exec", async (request, reply) => {
  const parsed = execSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Exec caller disconnected; foreground command cancelled"));
  const disconnected = () => { if (!reply.raw.writableFinished) abort(); };
  request.raw.once("aborted", abort);
  reply.raw.once("close", disconnected);
  try {
    return await runCommand(parsed.data, controller.signal);
  } finally {
    request.raw.off("aborted", abort);
    reply.raw.off("close", disconnected);
  }
});

app.post("/v1/fs/read", async (request, reply) => {
  const parsed = fsReadSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  return fsRead(parsed.data);
});
async function rawFileResponse(request: any, reply: any, headOnly = false) {
  const parsed = fsRawReadSchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  const controller = new AbortController();
  const abort = () => controller.abort();
  const disconnected = () => { if (!reply.raw.writableFinished) abort(); };
  request.raw.once("aborted", abort);
  reply.raw.once("close", disconnected);
  try {
    const info = await openRawFile(parsed.data.path, { metadataOnly: headOnly, signal: controller.signal });
    controller.signal.throwIfAborted();
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", String(info.size));
    reply.header("x-rcmcp-modified-at", info.modifiedAt);
    reply.header("x-rcmcp-sha256", info.sha256);
    if (info.posixMode !== undefined) reply.header("x-rcmcp-posix-mode", String(info.posixMode));
    reply.header("x-rcmcp-source-confirmation", "head");
    if (headOnly) { info.stream.destroy(); return reply.send(); }
    return reply.send(info.stream);
  } finally {
    request.raw.off("aborted", abort);
    reply.raw.off("close", disconnected);
  }
}
// Register HEAD first: Fastify otherwise creates an automatic HEAD from GET.
app.head("/v1/fs/raw", async (request, reply) => rawFileResponse(request, reply, true));
app.get("/v1/fs/raw", async (request, reply) => rawFileResponse(request, reply));
app.post("/v1/fs/transfer-from", async (request, reply) => {
  const parsed = fsDirectTransferSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  const controller = new AbortController();
  const abort = () => controller.abort();
  const requestClosed = () => { if (request.raw.aborted) abort(); };
  const replyClosed = () => { if (!reply.raw.writableFinished) abort(); };
  request.raw.once("aborted", abort);
  request.raw.once("close", requestClosed);
  reply.raw.once("close", replyClosed);
  try {
    return await receiveDirectTransfer(parsed.data, controller.signal);
  } finally {
    request.raw.off("aborted", abort);
    request.raw.off("close", requestClosed);
    reply.raw.off("close", replyClosed);
  }
});
app.post("/v1/fs/write", async (request, reply) => {
  const parsed = fsWriteSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  return fsWrite(parsed.data);
});
app.post("/v1/fs/list", async (request, reply) => {
  const parsed = fsListSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  return fsList(parsed.data);
});
registerFilesystemManageRoute(app);

app.get("/v1/processes", async () => listProcesses());
app.post("/v1/processes/start", async (request, reply) => {
  const parsed = processStartSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  return startProcess(parsed.data);
});
app.post("/v1/processes/kill", async (request, reply) => {
  const parsed = processKillSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  const signal = typeof parsed.data.signal === "string" ? parsed.data.signal as NodeJS.Signals : parsed.data.signal;
  return killProcess(parsed.data.pid, signal);
});

app.get("/v1/pty", async () => ptyList());
app.post("/v1/pty/start", async (request, reply) => { const p=ptyStartSchema.safeParse(request.body); if(!p.success) return reply.code(400).send({error:"invalid_request",details:p.error.issues}); try { return await ptyStart(p.data); } catch (error) { throw error; } });
app.post("/v1/pty/input", async (request, reply) => { const p=ptyInputSchema.safeParse(request.body); if(!p.success) return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return ptyInput(p.data.id,p.data.data); });
app.post("/v1/pty/output", async (request, reply) => { const p=ptyOutputSchema.safeParse(request.body); if(!p.success) return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return ptyOutput(p.data.id,p.data.offset,p.data.length); });
app.post("/v1/pty/resize", async (request, reply) => { const p=ptyResizeSchema.safeParse(request.body); if(!p.success) return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return ptyResize(p.data.id,p.data.cols,p.data.rows); });
app.post("/v1/pty/terminate", async (request, reply) => { const p=ptyTerminateSchema.safeParse(request.body); if(!p.success) return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return ptyTerminate(p.data.id,p.data.signal); });
app.post("/v1/pty/remove", async (request, reply) => { const p=ptyRemoveSchema.safeParse(request.body); if(!p.success) return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return ptyRemove(p.data.id,p.data.force); });

registerExtraRoutes(app);
registerBrowserRoutes(app);
if (process.env.RCMCP_DESKTOP_ENABLED === "1") registerDesktopRoutes(app);
await app.listen({ host, port });
