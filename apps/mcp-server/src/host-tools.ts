import { sendWake } from "../../../packages/shared/src/wake.ts";
import { powerSchema,wakeSchema } from "../../../packages/protocol/src/power.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { advancedClient } from "./advanced-client.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const contextSchema = z.enum(["system", "user"]).optional();
export function registerHostTools(server: McpServer, client: AgentClient): void {
  server.registerTool("host_inventory", {
    description: "Collect a light CPU/memory/root-storage inventory or the full metrics/network/storage/GPU/package snapshot.",
    inputSchema: { device: z.string().min(1), context: contextSchema, profile: z.enum(["light", "full"]).optional() },
  }, async ({ device, context, profile }) => {
    const runContext = context ?? "system";
    const selectedProfile = profile ?? "full";
    if (selectedProfile === "light") {
      try {
        const metrics = await advancedClient.metrics(client, device, runContext, "light");
        return text({ device, context: runContext, profile: "light", partial: false, errors: {}, metrics });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return text({ device, context: runContext, profile: "light", partial: true, errors: { metrics: message }, metrics: null });
      }
    }
    const components = await Promise.allSettled([
      advancedClient.metrics(client, device, runContext, "full"), client.networkSnapshot(device, runContext), client.storageSnapshot(device, runContext), client.gpuSnapshot(device, runContext), client.packageManagers(device, runContext),
    ]);
    const names = ["metrics", "network", "storage", "gpu", "packages"] as const;
    const errors: Record<string, string> = {};
    const result: Record<string, unknown> = { device, context: runContext, profile: "full", partial: components.some((item) => item.status === "rejected"), errors };
    components.forEach((item, index) => {
      const name = names[index]!;
      if (item.status === "fulfilled") result[name] = item.value;
      else { result[name] = null; errors[name] = item.reason instanceof Error ? item.reason.message : String(item.reason); }
    });
    return text(result);
  });
  server.registerTool("network_snapshot", { description: "Return adapters, addresses, routes, listeners, DNS and Tailscale status.", inputSchema: { device: z.string().min(1), context: contextSchema } }, async ({ device, context }) => text(await client.networkSnapshot(device, context)));
  server.registerTool("storage_snapshot", { description: "Return physical disks/block devices and mounted/logical storage.", inputSchema: { device: z.string().min(1), context: contextSchema } }, async ({ device, context }) => text(await client.storageSnapshot(device, context)));
  server.registerTool("gpu_snapshot", { description: "Return best-effort GPU identity, driver and utilization/temperature telemetry.", inputSchema: { device: z.string().min(1), context: contextSchema } }, async ({ device, context }) => text(await client.gpuSnapshot(device, context)));
  server.registerTool("package_managers", { description: "List supported OS package managers available on a computer.", inputSchema: { device: z.string().min(1), context: contextSchema } }, async ({ device, context }) => text(await client.packageManagers(device, context)));
  server.registerTool("package_manage", {
    description: "List/search/install/upgrade/remove OS packages through apt, winget or Chocolatey when available.",
    inputSchema: { device: z.string().min(1), context: contextSchema, manager: z.string().optional(), action: z.enum(["list", "search", "install", "upgrade", "remove"]), packages: z.array(z.string().min(1)).optional(), all: z.boolean().optional(), timeoutMs: z.number().int().positive().max(2 * 60 * 60 * 1000).optional() },
  }, async ({ device, context, ...input }) => text(await client.packageManage(device, input, context)));
  server.registerTool("host_power", {
    description: "Queue a durable reboot/shutdown/sleep/hibernate/lock request. dryRun previews the exact command. Returns job ID; use job_wait/status/cancel. scheduled confirms job submission only, never a physical power transition. Defaults to system; Windows lock defaults to the interactive owner.",
    inputSchema: { device:z.string().min(1),context:contextSchema,...powerSchema.shape },
  }, async ({device,context,...input},extra)=>{
    let target=context??"system";
    if(!context&&input.action==="lock"&&client.hasUserContext(device)){
      const info=await client.requestRoute<{platform:string}>(device,"/v1/info",undefined,"user",{signal:extra.signal});
      if(info.platform==="win32")target="user";
    }
    return text({context:target,...await client.hostPower(device,powerSchema.parse(input),target) as object});
  });
  server.registerTool("wake_on_lan", {
    description: "Send a Wake-on-LAN packet from the central MCP host, or choose device/context as a LAN relay. localAddress chooses the sender interface; dryRun only previews. sent confirms UDP submission, not delivery or wake. Verify the target separately with device_info.",
    inputSchema: {device:z.string().optional(),context:contextSchema,...wakeSchema.shape},
  },async({device,context="system",...input},extra)=>{
    const parsed=wakeSchema.parse(input);
    const result=device?await client.requestRoute(device,"/v1/wake",parsed,context,{signal:extra.signal,timeoutMs:parsed.timeoutMs===0?0:(parsed.timeoutMs??10000)+5000}):await sendWake(parsed,extra.signal);
    return text(result);
  });
}
