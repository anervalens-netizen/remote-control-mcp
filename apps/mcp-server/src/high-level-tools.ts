import { withToolErrors } from "./tool-errors.ts";
import { projectRunFields, deployFields } from "../../../packages/protocol/src/project.ts";
import { repoCheckpointFields, repoPatchFields, fsEditFields } from "../../../packages/protocol/src/editing.ts";
import { batchResultSchema, execRequestFields, execResultSchema, fsReadFields, fsReadResultSchema } from "../../../packages/protocol/src/execution.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { mapLimit, settledLimit } from "./concurrency.ts";
import { advancedClient } from "./advanced-client.ts";
import { elevationSchema, executionInputSchema, executionLabel, identitySchema, legacyContextSchema, resolveExecutionContext } from "./execution-identity.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const structured = (value: Record<string, unknown>, textValue: unknown = value) => ({ ...text(textValue), structuredContent: value });
const gitRouteSchema = {
  identity: z.enum(["owner", "root", "interactive"]),
  context: z.enum(["user", "system", "desktop"]),
};
const gitNetworkCommonSchema = {
  ok: z.literal(true),
  remote: z.string().nullable(),
  nonInteractive: z.literal(true),
  timeoutMs: z.number().int().positive(),
  durationMs: z.number().nonnegative(),
  summary: z.string(),
};
async function settled<T>(items: T[], fn: (item: T, index: number) => Promise<unknown>, concurrency?: number, signal?: AbortSignal) {
  return settledLimit(items, concurrency, fn, signal);
}


export function registerHighLevelTools(server: McpServer, client: AgentClient): void {
  server.registerTool("batch_exec", {
    description: "Execute many independent shell commands in parallel. Each item supports the same identity/context/elevation/env routing contract as exec.",
    inputSchema: z.object({
      items: z.array(executionInputSchema({ device: z.string().min(1), ...execRequestFields })).min(1).max(64),
      concurrency: z.number().int().min(1).max(32).optional(),
    }).strict(),
    outputSchema: batchResultSchema(execResultSchema),
  }, async ({ items, concurrency }, extra) => {
    // Resolve every route before dispatch. One invalid/unavailable target must not
    // allow earlier items to produce effects before the batch is rejected.
    const planned = items.map((item, index) => {
      const { device, context, identity, elevation, ...request } = item;
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      return { index, device, target, identity: executionLabel(target), request };
    });
    const legacy = await settled(
      planned,
      (item) => client.exec(item.device, item.request, item.target, { signal: extra.signal }),
      concurrency,
      extra.signal,
    );
    const routed = legacy.map((entry, index) => {
      const plan = planned[index]!;
      return entry.ok
        ? { ...entry, device: plan.device, identity: plan.identity, context: plan.target }
        : { ...entry, device: plan.device, identity: plan.identity, context: plan.target };
    });
    const errors = routed.filter((entry): entry is Extract<(typeof routed)[number], { ok: false }> => !entry.ok);
    return structured({ items: routed, errors, partial: errors.length > 0 }, legacy);
  });

  server.registerTool("batch_read", {
    description: "Read many files in parallel. Each item supports explicit owner/root/interactive routing and returns a typed structured envelope.",
    inputSchema: z.object({
      items: z.array(executionInputSchema({ device: z.string().min(1), ...fsReadFields })).min(1).max(64),
      concurrency: z.number().int().min(1).max(32).optional(),
    }).strict(),
    outputSchema: batchResultSchema(fsReadResultSchema),
  }, async ({ items, concurrency }, extra) => {
    const planned = items.map((item, index) => {
      const { device, context, identity, elevation, ...input } = item;
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      return { index, device, target, identity: executionLabel(target), input };
    });
    const legacy = await settled(
      planned,
      (item) => client.fsRead(item.device, item.input, item.target, { signal: extra.signal }),
      concurrency,
      extra.signal,
    );
    const routed = legacy.map((entry, index) => {
      const plan = planned[index]!;
      return entry.ok
        ? { ...entry, device: plan.device, identity: plan.identity, context: plan.target }
        : { ...entry, device: plan.device, identity: plan.identity, context: plan.target };
    });
    const errors = routed.filter((entry): entry is Extract<(typeof routed)[number], { ok: false }> => !entry.ok);
    return structured({ items: routed, errors, partial: errors.length > 0 }, legacy);
  });

  server.registerTool("fleet_status", {
    description: "Compact health/resource summary for all or selected devices. Android reverse devices report controller readiness instead of unavailable host metrics.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { devices: z.array(z.string().min(1)).max(64).optional(), context: z.enum(["system", "user"]).optional(), concurrency: z.number().int().min(1).max(32).optional() },
  }, async ({ devices, context, concurrency }) => {
    const names = devices?.length ? devices : client.devices.map((item) => item.name);
    const runContext = context ?? "system";
    const results = await mapLimit(names, concurrency, async (device) => {
      try {
        const configuredDevice = client.devices.find((item) => item.name.toLowerCase() === device.toLowerCase());
        if (configuredDevice?.transport === "android-reverse") {
          const status = client.androidStatus(device) as {
            name: string; online: boolean; readiness: string; readinessReason: string;
            state: null | { model?: string; network?: string; batteryPercent?: number | null; screenOn?: boolean; keyguardLocked?: boolean; accessibility?: boolean };
          };
          const androidContext = context === undefined ? "user" : runContext;
          if (androidContext === "system") {
            return { device, online: status.online, platform: "android", context: "system", contextAvailable: false, readiness: status.readiness, readinessReason: status.readinessReason, error: "system context is not configured for android-reverse" };
          }
          return {
            device, online: status.online, hostname: status.state?.model ?? status.name, platform: "android", arch: null,
            uptimeSeconds: null, cpuCount: null, cpuModel: null, memoryUsedPercent: null, rootUsedPercent: null, rootAvailableBytes: null,
            readiness: status.readiness, readinessReason: status.readinessReason, context: "user", contextAvailable: true,
            network: status.state?.network ?? null, batteryPercent: status.state?.batteryPercent ?? null,
            screenOn: status.state?.screenOn ?? null, keyguardLocked: status.state?.keyguardLocked ?? null, accessibility: status.state?.accessibility ?? null,
          };
        }
        const metrics = await advancedClient.metrics(client, device, runContext, "light") as Record<string, unknown>;
        const platform = String(metrics.platform ?? "unknown");
        const root = metrics.rootFilesystem && typeof metrics.rootFilesystem === "object"
          ? metrics.rootFilesystem as Record<string, unknown>
          : (Array.isArray(metrics.filesystems)
            ? (metrics.filesystems as Array<Record<string, unknown>>).find((item) => item.mount === "/" || item.mount === "C:")
            : null) ?? null;
        const total = Number(metrics.totalMemoryBytes ?? 0); const free = Number(metrics.freeMemoryBytes ?? 0);
        return {
          device, online: true, hostname: metrics.hostname ?? null, platform, arch: metrics.arch ?? null,
          uptimeSeconds: metrics.uptimeSeconds ?? null, cpuCount: metrics.cpuCount ?? null, cpuModel: metrics.cpuModel ?? null,
          memoryUsedPercent: total > 0 ? Math.round((1 - free / total) * 1000) / 10 : null,
          rootUsedPercent: root?.usedPercent ?? null, rootAvailableBytes: root?.availableBytes ?? null,
        };
      } catch (error) {
        return { device, online: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    return text({ devices: results });
  });

  server.registerTool("process_find", {
    description: "Find processes with agent-side filtering so the complete process table does not cross the network.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { device: z.string().min(1), context: z.enum(["system", "user"]).optional(), query: z.string().optional(), pid: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async ({ device, context, query, pid, limit }) => {
    const result = await client.processFind(device, { query, pid, limit }, context) as Record<string, unknown>;
    return text({ device, ...result });
  });

  server.registerTool("repo_compare", {
    description: "Compare compact Git state for the same or different repositories across multiple computers in one call.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { items: z.array(z.object({ device: z.string().min(1), path: z.string().min(1) })).min(1).max(32), concurrency: z.number().int().min(1).max(32).optional(), context: legacyContextSchema, identity: identitySchema, elevation: elevationSchema },
  }, async ({ items, concurrency, context, identity, elevation }) => {
    const results = await settled(items, async (item) => {
      const target = resolveExecutionContext(client, item.device, { context, identity, elevation }, "user");
      const snap = await client.repoSnapshot(item.device, { path: item.path, logCount: 1, profile: "summary" }, target) as Record<string, unknown>;
      return { device: item.device, path: item.path, head: snap.head ?? null, branch: snap.branch ?? null, upstream: snap.upstream ?? null, clean: snap.clean ?? null, ahead: snap.ahead ?? null, behind: snap.behind ?? null };
    }, concurrency);
    return text(results);
  });

  server.registerTool("docker_summary", {
    description: "Compact Docker health/count summary with optional agent-side container filtering. Prefer this over docker_snapshot unless full container/image detail is required.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      device: z.string().min(1), context: z.enum(["system", "user"]).optional(),
      query: z.string().optional(), state: z.enum(["all", "running", "stopped"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async ({ device, context, query, state, limit }) => {
    const result = await client.dockerSummary(device, { query, state, limit }, context) as Record<string, unknown>;
    return text({ device, ...result });
  });

  server.registerTool("repo_snapshot", {
    description: "Return a compact Git repository snapshot: HEAD/branch/upstream, clean state, ahead/behind, status, diff stats, remotes and recent commits.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { device: z.string().min(1), path: z.string().min(1), logCount: z.number().int().positive().max(50).optional(), profile: z.enum(["summary", "full"]).optional(), context: legacyContextSchema, identity: identitySchema, elevation: elevationSchema },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    return text(await client.repoSnapshot(device, input, target));
  });

  server.registerTool("repo_checkpoint", {
    description: "Create a Git checkpoint: mode=all (default), staged, or paths (Git pathspecs relative to path). Selected paths preserve unrelated staged work; dryRun previews changes without changing HEAD/index. Failed commits preserve the original index.",
    inputSchema: { device: z.string().min(1), ...repoCheckpointFields, context: legacyContextSchema, identity: identitySchema, elevation: elevationSchema },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    const result = await client.repoCheckpoint(device, input, target) as Record<string, unknown>;
    return { ...text(result), ...(result.indexUpdated === false ? { isError: true } : {}) };
  });

  server.registerTool("repo_apply_patch", {
    description: "Check or apply a Git unified/binary patch to the worktree (default), index only, or both. Supports reverse, strip, directory and whitespace options. Checks all hunks before applying; no rejected-hunk partial mode.",
    inputSchema: { device: z.string().min(1), ...repoPatchFields, context: legacyContextSchema, identity: identitySchema, elevation: elevationSchema },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    const result = await client.repoApplyPatch(device, input, target) as Record<string, unknown>;
    return { ...text(result), ...(result.ok === false ? { isError: true } : {}) };
  });

  server.registerTool("fs_edit", {
    description: "Apply sequential literal UTF-8 text replacements in one write, preserving metadata through fs_write. Each edit must match exactly expectedOccurrences (default 1). Supports SHA-256 freshness and dryRun; returns before/after hashes and read-back verification. Concurrent fs_edit calls on the same path are serialized; external editors are not locked.",
    inputSchema: { device: z.string().min(1), ...fsEditFields, context: legacyContextSchema, identity: identitySchema, elevation: elevationSchema },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    const result = await client.fsEdit(device, input, target) as Record<string, unknown>;
    return { ...text(result), ...(result.verified === false ? { isError: true } : {}) };
  });

  server.registerTool("repo_fetch", {
    description: "Fetch Git remote refs through the owner endpoint with interactive credential prompts disabled and a bounded timeout. Fails fast if owner identity is unavailable; raw exec remains available for explicit root/SYSTEM Git.",
    inputSchema: executionInputSchema({
      device: z.string().min(1), path: z.string().min(1), remote: z.string().min(1).optional(),
      refspecs: z.array(z.string().min(1)).max(32).optional(), prune: z.boolean().optional(), tags: z.boolean().optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    outputSchema: {
      ...gitRouteSchema,
      result: z.object({ ...gitNetworkCommonSchema, operation: z.literal("fetch"), remote: z.string() }).passthrough(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    return structured({ identity: executionLabel(target), context: target, result: await client.repoFetch(device, input, target) });
  });

  server.registerTool("repo_pull", {
    description: "Pull through the owner endpoint with non-interactive credentials. Fast-forward-only by default; set ffOnly=false for normal Git pull behavior. Raw exec remains available for explicit root/SYSTEM Git.",
    inputSchema: executionInputSchema({
      device: z.string().min(1), path: z.string().min(1), remote: z.string().min(1).optional(),
      refspecs: z.array(z.string().min(1)).max(32).optional(), ffOnly: z.boolean().optional(), tags: z.boolean().optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    outputSchema: {
      ...gitRouteSchema,
      result: z.object({
        ...gitNetworkCommonSchema,
        operation: z.literal("pull"),
        beforeHead: z.string().nullable(),
        afterHead: z.string().nullable(),
        headChanged: z.boolean(),
      }).passthrough(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    return structured({ identity: executionLabel(target), context: target, result: await client.repoPull(device, input, target) });
  });

  server.registerTool("repo_push", {
    description: "Push through the owner endpoint with non-interactive credentials and bounded timeout. Supports normal push, upstream setup, tags and dry-run; raw exec retains unrestricted Git including explicit root/SYSTEM workflows.",
    inputSchema: executionInputSchema({
      device: z.string().min(1), path: z.string().min(1), remote: z.string().min(1).optional(),
      refspecs: z.array(z.string().min(1)).max(32).optional(), setUpstream: z.boolean().optional(), tags: z.boolean().optional(),
      dryRun: z.boolean().optional(), timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    outputSchema: {
      ...gitRouteSchema,
      result: z.object({ ...gitNetworkCommonSchema, operation: z.literal("push"), remote: z.string() }).passthrough(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    return structured({ identity: executionLabel(target), context: target, result: await client.repoPush(device, input, target) });
  });

  server.registerTool("project_run", {
    description: "Detect Node/Python/Go/Rust/.NET/Make and run install/check/test/build/typecheck/lint or script. command runs a raw shell task; executable runs any native program with literal args. Generated stack argv is literal; env is forwarded. Default action=check, mode=job; dryRun returns the exact plan without execution. Multi-stack repos can select stack.",
    inputSchema: { device: z.string().min(1), ...projectRunFields, context: legacyContextSchema, identity: identitySchema, elevation: elevationSchema },
  }, async ({ device, context, identity, elevation, ...input }, extra) => withToolErrors(async () => {
    const runContext = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    const result = await client.projectRun(device, input, runContext, { signal: extra.signal }) as Record<string, unknown>;
    return { ...text({ ...result, identity: executionLabel(runContext), context: runContext }), ...(result.ok === false ? { isError: true } : {}) };
  }));

  server.registerTool("deploy_run", {
    description: "Run an unrestricted deployment as a durable job. command keeps the original one-step behavior; optionally use prepare/apply/verify/recover phases with persistent progress in job_status/job_wait. A phase failure skips later phases and runs supplied recover; successful recovery still reports the deployment failure. dryRun previews without execution. Raw commands remain available.",
    inputSchema: { device: z.string().min(1), ...deployFields, context: legacyContextSchema, identity: identitySchema, elevation: elevationSchema },
  }, async ({ device, context, identity, elevation, ...input }) => withToolErrors(async () => {
    const runContext = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    if (input.prepare || input.apply || input.verify || input.recover || input.dryRun) {
      return text({ ...await client.deployRun(device, input, runContext) as Record<string, unknown>, identity: executionLabel(runContext), context: runContext });
    }
    if (!input.command) throw new Error("command or apply is required");
    const before = input.repoPath ? await client.repoSnapshot(device, { path: input.repoPath, logCount: 3 }, runContext) : null;
    const job = await client.jobStart(device, { command: input.command, ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(input.env ? { env: input.env } : {}) }, runContext);
    return text({ before, identity: executionLabel(runContext), context: runContext, job });
  }));

  server.registerTool("service_inspect", {
    description: "Return service status and recent logs/events together in one call.",
    inputSchema: { device: z.string().min(1), name: z.string().min(1), scope: z.enum(["user", "system"]).optional(), lines: z.number().int().positive().max(1000).optional() },
  }, async ({ device, name, scope, lines }) => {
    const [status, logs] = await Promise.all([
      advancedClient.service(client, device, { name, action: "status", ...(scope === undefined ? {} : { scope }) }),
      advancedClient.logs(client, device, { name, ...(scope === undefined ? {} : { scope }), ...(lines === undefined ? {} : { lines }) }),
    ]);
    return text({ status, logs });
  });

  server.registerTool("docker_snapshot", {
    description: "Return one compact Docker snapshot: engine/client version, all containers, images and Compose projects.",
    inputSchema: { device: z.string().min(1), context: z.enum(["system", "user"]).optional() },
  }, async ({ device, context }) => text(await client.dockerSnapshot(device, context)));
}
