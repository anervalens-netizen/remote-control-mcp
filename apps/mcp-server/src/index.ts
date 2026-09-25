import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { AgentClient } from './agent-client.ts';
import { assertMcpHttpAuth, createMcpHttpServer } from './http-server.ts';
import { AndroidController, loadAndroidControllerConfig } from './android-controller.ts';

const host = process.env.RCMCP_MCP_HOST ?? '127.0.0.1';
const port = Number(process.env.RCMCP_MCP_PORT ?? '45230');
const allowUnauthenticated = process.env.RCMCP_ALLOW_UNAUTHENTICATED === '1';
assertMcpHttpAuth(process.env.RCMCP_MCP_TOKEN, allowUnauthenticated);
const sha = process.env.RCMCP_RUNTIME_SHA ?? (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', timeout: 2000, windowsHide: true }).trim(); }
  catch { return null; }
})();
const configuredSessionIdleMs = process.env.RCMCP_SESSION_IDLE_MS === undefined
  ? undefined
  : Number(process.env.RCMCP_SESSION_IDLE_MS);
if (configuredSessionIdleMs !== undefined && (!Number.isFinite(configuredSessionIdleMs) || configuredSessionIdleMs < 100)) {
  throw new Error('RCMCP_SESSION_IDLE_MS must be a finite number >= 100');
}
const configuredMaxBodyBytes = process.env.RCMCP_MCP_MAX_BODY_BYTES === undefined
  ? null
  : Number(process.env.RCMCP_MCP_MAX_BODY_BYTES);
if (configuredMaxBodyBytes !== null && (!Number.isFinite(configuredMaxBodyBytes) || configuredMaxBodyBytes <= 0)) {
  throw new Error('RCMCP_MCP_MAX_BODY_BYTES must be a finite positive number when configured');
}
const androidConfig = loadAndroidControllerConfig();
const androidController = androidConfig ? new AndroidController(androidConfig) : undefined;
if (androidController) await androidController.start();
const http = createMcpHttpServer(new AgentClient(undefined, undefined, undefined, androidController), {
  token: process.env.RCMCP_MCP_TOKEN,
  sha,
  ...(configuredSessionIdleMs === undefined ? {} : { sessionIdleMs: configuredSessionIdleMs }),
  maxBodyBytes: configuredMaxBodyBytes,
});
let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= (async () => {
    // Stop phone-facing dispatch/polling before waiting for long-lived MCP
    // HTTP/SSE sessions. Even if Android shutdown persistence fails, always
    // close MCP sockets so the signal handler cannot strand the process.
    try {
      await androidController?.close();
    } finally {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    }
  })();
  return closing;
};
const requestClose = () => {
  void close().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', requestClose);
process.once('SIGTERM', requestClose);
http.listen(port, host, () => console.log(`remote-control-mcp listening on http://${host}:${port}/mcp`));
