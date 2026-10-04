import type { AgentClient, AgentEndpointContext, AgentRequestOptions } from "./agent-client.ts";
import { OperationReceiptError } from "./operation-receipt-error.ts";
export const agentCapabilities = { coordination: "high-level-coordination-v1", utf8: "utf8-byte-pages-v1", durableBatch: "job-key-recovery-v1" } as const;
export async function requireAgentCapability(client: AgentClient, device: string, context: AgentEndpointContext, capability: string, options?: AgentRequestOptions) {
  let info: { runtime?: { capabilities?: unknown } } | undefined;
  try { info = await client.info(device, context, options) as typeof info; }
  catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
  if (!Array.isArray(info?.runtime?.capabilities) || !info.runtime.capabilities.includes(capability)) {
    throw new OperationReceiptError("agent_upgrade_required", { code: "agent_upgrade_required", requiredCapability: capability, device, context, effectsStarted: false,
      recovery: "Upgrade the selected agent before retrying this operation. Compatible base64 and control reads remain available." });
  }
}
