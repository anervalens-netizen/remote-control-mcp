// The only negotiation observation adapter. Observe the SDK's actual initialize
// response through its public Transport.send API, never a request header/docs URL.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const entry = createRequire(import.meta.url).resolve("@modelcontextprotocol/sdk/server/mcp.js");
export const sdkVersion: string = JSON.parse(readFileSync(path.resolve(path.dirname(entry), "../../../package.json"), "utf8")).version;
export const catalogRevision = "coordination-v1-utf8-v1-durable-batch-v1";
type Mode = "stateful" | "stateless" | "legacy-stateless" | "stdio";
type Observation = { mode: Mode; protocolVersion: string | null; responseMode: "json" | "sse" | "stdio"; observedAt: string; source: "sdk_initialize_response" | "not_negotiated" };
export class SdkCompatibilityDiagnostics {
  private observations: Observation[] = [];
  observe(transport: Transport, mode: Mode, responseMode: Observation["responseMode"], initializeId?: string | number) {
    const record: Observation = { mode, protocolVersion: null, responseMode, observedAt: new Date().toISOString(), source: "not_negotiated" };
    this.observations.push(record); if (this.observations.length > 32) this.observations.shift();
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if ("result" in message && (initializeId === undefined || message.id === initializeId)
        && typeof message.result.protocolVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(message.result.protocolVersion)) {
        record.protocolVersion = message.result.protocolVersion;
        record.source = "sdk_initialize_response"; record.observedAt = new Date().toISOString();
      }
      return send(message, options);
    };
  }
  snapshot() { return { sdkVersion, catalogRevision, retention: 32, observations: this.observations.map(item => ({ ...item })) }; }
}
