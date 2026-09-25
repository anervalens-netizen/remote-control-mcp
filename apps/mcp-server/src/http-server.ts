import { agentInstructions } from "./instructions.ts";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AgentClient } from "./agent-client.ts";
import { registerTools } from "./all-tools.ts";

type Session = { server: McpServer; transport: StreamableHTTPServerTransport; lastUsed: number; active: number };
type McpServerInternals = {
  _registeredTools: Record<string, unknown>;
  setToolRequestHandlers(): void;
};

export function assertMcpHttpAuth(token: string | undefined, allowUnauthenticated = false): void {
  if (!token && !allowUnauthenticated) throw new Error("RCMCP_MCP_TOKEN is required unless RCMCP_ALLOW_UNAUTHENTICATED=1");
}

class HttpInputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpInputError";
    this.status = status;
    this.code = code;
  }
}

async function readBody(req: IncomingMessage, maxBodyBytes: number | null): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (maxBodyBytes !== null && bytes > maxBodyBytes) throw new HttpInputError(413, "payload_too_large", `Request body exceeds ${maxBodyBytes} bytes`);
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpInputError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function originAllowed(req: IncomingMessage, allowedOrigins: Set<string>): boolean {
  const header = req.headers.origin;
  if (header === undefined) return true;
  if (Array.isArray(header)) return false;
  const origin = normalizeOrigin(header);
  if (!origin) return false;
  return allowedOrigins.has(origin);
}

export function createMcpHttpServer(client: AgentClient, options: {
  token?: string;
  sha?: string | null;
  sessionIdleMs?: number;
  allowedOrigins?: string[];
  maxBodyBytes?: number | null;
} = {}) {
  const startedAt = new Date().toISOString();
  const instanceId = randomUUID();
  const sessions = new Map<string, Session>();
  const sessionIdleMs = options.sessionIdleMs ?? 15 * 60 * 1000;
  const maxBodyBytes = options.maxBodyBytes ?? null;
  if (maxBodyBytes !== null && (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0)) {
    throw new Error("maxBodyBytes must be null or a finite positive number");
  }
  const configuredOrigins = options.allowedOrigins
    ?? (process.env.RCMCP_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const allowedOrigins = new Set(configuredOrigins.map(normalizeOrigin).filter((value): value is string => value !== null));
  let requestsTotal = 0;
  let requestsInFlight = 0;
  let requestsFailed = 0;
  let requestDurationMsTotal = 0;

  let sharedToolRegistry: Record<string, unknown> | undefined;
  let toolRegistryBuilds = 0;
  function build() {
    const server = new McpServer({ name: "remote-control-mcp", version: "0.1.0" }, { instructions: agentInstructions });
    const internals = server as unknown as McpServerInternals;
    if (sharedToolRegistry === undefined) {
      registerTools(server, client);
      if (!internals._registeredTools || typeof internals.setToolRequestHandlers !== "function") {
        throw new Error("MCP SDK tool registry internals are incompatible with session reuse");
      }
      sharedToolRegistry = internals._registeredTools;
      toolRegistryBuilds += 1;
    } else {
      // The SDK's transport is per-session, but tool definitions and handlers
      // are immutable in this server. Reuse that registry and install the
      // SDK request handlers against this session's underlying Server.
      internals._registeredTools = sharedToolRegistry;
      internals.setToolRequestHandlers();
    }
    return server;
  }

  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) {
      if (!session.active && Date.now() - session.lastUsed > sessionIdleMs) {
        sessions.delete(id);
        void session.server.close();
      }
    }
  }, Math.min(60_000, Math.max(100, sessionIdleMs)));
  cleanup.unref();

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestStarted = performance.now();
    const requestIdHeader = req.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" && requestIdHeader.length <= 200 ? requestIdHeader : randomUUID();
    res.setHeader("x-rcmcp-request-id", requestId);
    requestsTotal++;
    requestsInFlight++;
    let requestFinished = false;
    const finishRequest = (failed = false) => {
      if (requestFinished) return;
      requestFinished = true;
      requestsInFlight = Math.max(0, requestsInFlight - 1);
      if (failed) requestsFailed++;
      requestDurationMsTotal += performance.now() - requestStarted;
    };
    res.once("finish", () => finishRequest(res.statusCode >= 400));
    res.once("close", () => finishRequest(res.statusCode >= 400));

    try {
      if (req.url === "/health") {
        const registered = sessions.size;
        const inFlight = [...sessions.values()].reduce((sum, session) => sum + session.active, 0);
        const idle = [...sessions.values()].filter((session) => session.active === 0).length;
        const memory = process.memoryUsage();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ok: true,
          ready: true,
          service: "remote-control-mcp",
          runtime: {
            instanceId, startedAt, pid: process.pid, sha: options.sha ?? null, node: process.version,
            requestTimeoutMs: client.requestTimeoutMs, maxBodyBytes,
          },
          sessions: {
            registered, inFlight, idle, idleTtlMs: sessionIdleMs,
            cancellation: true, legacyStateless: true, toolRegistryBuilds,
          },
          requests: {
            total: requestsTotal,
            inFlight: requestsInFlight,
            failed: requestsFailed,
            averageDurationMs: requestsTotal > 1 ? Math.round(requestDurationMsTotal / Math.max(1, requestsTotal - requestsInFlight)) : 0,
          },
          memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external },
          devices: client.devices.map((device) => ({ name: device.name, contexts: client.configuredContexts(device.name) })),
        }));
        return;
      }

      if (req.url !== "/mcp") { res.writeHead(404).end("not found"); return; }
      if (!originAllowed(req, allowedOrigins)) {
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({
          error: "invalid_origin", message: "Origin is not allowed for this MCP endpoint", requestId,
        }));
        return;
      }
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized", requestId }));
        return;
      }
      if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) { res.writeHead(405).end("method_not_allowed"); return; }

      const body = req.method === "POST" ? await readBody(req, maxBodyBytes) : undefined;
      const id = req.headers["mcp-session-id"];
      if (id !== undefined && typeof id !== "string") throw new HttpInputError(400, "invalid_session_id", "mcp-session-id must be a single string");
      let session = id ? sessions.get(id) : undefined;
      if (id && !session) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session expired; initialize a new session" },
        }));
        return;
      }
      if (!session && req.method === "POST" && isInitializeRequest(body)) {
        const server = build();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: sid => { sessions.set(sid, entry); },
        });
        const entry: Session = { server, transport, lastUsed: Date.now(), active: 0 };
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        await server.connect(transport);
        session = entry;
      }
      if (session) {
        const entry = session;
        entry.lastUsed = Date.now();
        entry.active++;
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            entry.active = Math.max(0, entry.active - 1);
            entry.lastUsed = Date.now();
          }
        };
        res.once("close", release);
        res.once("finish", release);
        await entry.transport.handleRequest(req, res, body);
        return;
      }

      // Preserve already-connected legacy clients that did not negotiate a
      // session. New initialize requests always get a correlated MCP session.
      if (req.method !== "POST") { res.writeHead(405).end("session_required"); return; }
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      res.once("close", () => { void server.close(); });
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpInputError) {
        if (!res.headersSent) res.writeHead(error.status, { "content-type": "application/json" });
        if (!res.writableEnded) res.end(JSON.stringify({ error: error.code, message: error.message, requestId }));
        return;
      }
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error", requestId }));
    }
  });

  http.once("close", () => {
    clearInterval(cleanup);
    for (const session of sessions.values()) void session.server.close();
    sessions.clear();
  });
  return http;
}
