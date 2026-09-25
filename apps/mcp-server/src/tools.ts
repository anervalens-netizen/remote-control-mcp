import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { execRequestFields, execResultSchema, executionRouteFields } from "../../../packages/protocol/src/execution.ts";
import { elevationSchema, executionInputSchema, executionLabel, identitySchema, legacyContextSchema, resolveExecutionContext } from "./execution-identity.ts";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function structured(value: Record<string, unknown>, textValue: unknown = value) {
  return { content: [{ type: "text" as const, text: JSON.stringify(textValue) }], structuredContent: value };
}
const targetFields = { context: legacyContextSchema, identity: identitySchema, elevation: elevationSchema };

export function registerTools(server: McpServer, client: AgentClient): void {
  server.registerTool("devices_list", {
    description: "List configured remote computers and their configured execution endpoints. Use capability_report for live endpoint capabilities.",
    outputSchema: {
      devices: z.array(z.object({
        name: z.string(),
        url: z.string(),
        contexts: z.object({ system: z.boolean(), user: z.boolean(), desktop: z.boolean() }),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const devices = client.devices.map(({ name, url }) => ({ name, url, contexts: client.configuredContexts(name) }));
    return structured({ devices }, devices);
  });

  server.registerTool("device_info", {
    description: "Return OS, runtime identity, capabilities, readiness and resource information for a selected execution identity.",
    inputSchema: { device: z.string().min(1), ...targetFields },
  }, async ({ device, context, identity, elevation }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.info(device, target));
  });

  server.registerTool("exec", {
    description: "Execute a shell command on the selected identity. Linux uses Bash; Windows uses PowerShell. identity is canonical; context is a compatible legacy alias.",
    inputSchema: executionInputSchema({ device: z.string().min(1), ...execRequestFields }),
    outputSchema: z.object({ ...execResultSchema.shape, ...executionRouteFields }),
  }, async ({ device, context, identity, elevation, ...request }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    const result = await client.exec(device, request, target, { signal: extra.signal }) as Record<string, unknown>;
    return structured({ ...result, identity: executionLabel(target), context: target }, result);
  });

  server.registerTool("fs_read", {
    description: "Read file bytes as UTF-8/base64 using byte paging, bounded tail reads or bounded 1-based line ranges.",
    inputSchema: {
      device: z.string().min(1), path: z.string().min(1), ...targetFields,
      offset: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
      encoding: z.enum(["utf8", "base64"]).optional(), tailBytes: z.number().int().nonnegative().max(64 * 1024 * 1024).optional(),
      startLine: z.number().int().positive().optional(), lineCount: z.number().int().positive().max(100_000).optional(),
      maxBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
    },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.fsRead(device, input, target));
  });

  server.registerTool("fs_write", {
    description: "Write or append UTF-8/base64 data to a filesystem path using the selected identity.",
    inputSchema: {
      device: z.string().min(1), path: z.string().min(1), data: z.string(), ...targetFields,
      encoding: z.enum(["utf8", "base64"]).optional(), mode: z.enum(["rewrite", "append"]).optional(), createParents: z.boolean().optional(), permissions: z.number().int().nonnegative().max(0o7777).optional(),
    },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.fsWrite(device, input, target));
  });

  server.registerTool("fs_list", {
    description: "List a directory with type, size, modification time and mode metadata.",
    inputSchema: { device: z.string().min(1), path: z.string().min(1), ...targetFields },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.fsList(device, input, target));
  });

  server.registerTool("fs_manage", {
    description: "Stat, create, move, copy, delete or set timestamps on filesystem paths with explicit owner/root/interactive identity routing. Copy reports copied/skipped entry counts and outcome; force=false never overwrites existing entries.",
    inputSchema: {
      device: z.string().min(1), ...targetFields, operation: z.enum(["stat", "mkdir", "move", "copy", "delete", "times"]),
      path: z.string().min(1), destination: z.string().optional(), recursive: z.boolean().optional(), force: z.boolean().optional(),
      modifiedAt: z.string().datetime().optional(), accessedAt: z.string().datetime().optional(),
    },
  }, async ({ device, context, identity, elevation, ...input }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.fsManage(device, input, target, { signal: extra.signal }));
  });

  server.registerTool("process_start", {
    description: "Start a detached background process with the selected execution identity and return its PID.",
    inputSchema: { device: z.string().min(1), command: z.string().min(1), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(), ...targetFields },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.startProcess(device, input, target));
  });

  server.registerTool("process_list", {
    description: "List running processes visible to the selected execution identity.",
    inputSchema: { device: z.string().min(1), ...targetFields },
  }, async ({ device, context, identity, elevation }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.processes(device, target));
  });

  server.registerTool("process_kill", {
    description: "Send a signal to a process using the selected execution identity.",
    inputSchema: { device: z.string().min(1), pid: z.number().int().positive(), signal: z.union([z.string(), z.number().int()]).optional(), ...targetFields },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.killProcess(device, input, target));
  });

  server.registerTool("pty_list", {
    description: "List persistent terminal sessions for the selected execution identity.",
    inputSchema: { device: z.string().min(1), ...targetFields },
  }, async ({ device, context, identity, elevation }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.ptyList(device, target));
  });

  server.registerTool("pty_start", {
    description: "Start a persistent interactive terminal session using root, owner or interactive identity.",
    inputSchema: {
      device: z.string().min(1), shell: z.string().optional(), cwd: z.string().optional(), cols: z.number().int().positive().optional(), rows: z.number().int().positive().optional(),
      env: z.record(z.string(), z.string()).optional(), ...targetFields,
    },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.ptyStart(device, input, target));
  });

  server.registerTool("pty_input", {
    description: "Write input to a persistent terminal session.",
    inputSchema: { device: z.string().min(1), id: z.string().min(1), data: z.string(), ...targetFields },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.ptyInput(device, input, target));
  });

  server.registerTool("pty_output", {
    description: "Read terminal output incrementally.",
    inputSchema: { device: z.string().min(1), id: z.string().min(1), offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().optional(), ...targetFields },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.ptyOutput(device, input, target));
  });

  server.registerTool("pty_resize", {
    description: "Resize a persistent terminal session.",
    inputSchema: { device: z.string().min(1), id: z.string().min(1), cols: z.number().int().positive(), rows: z.number().int().positive(), ...targetFields },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.ptyResize(device, input, target));
  });

  server.registerTool("pty_terminate", {
    description: "Terminate a persistent terminal session.",
    inputSchema: { device: z.string().min(1), id: z.string().min(1), signal: z.string().optional(), ...targetFields },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.ptyTerminate(device, input, target));
  });

  server.registerTool("pty_remove", {
    description: "Remove persisted PTY metadata/output; force can terminate an active session first.",
    inputSchema: { device: z.string().min(1), id: z.string().min(1), force: z.boolean().optional(), ...targetFields },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return text(await client.ptyRemove(device, input, target));
  });
}
