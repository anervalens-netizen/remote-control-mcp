import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { AgentClient } from "../../apps/mcp-server/src/agent-client.ts";
import { DurableBatchStore, type BatchPlan } from "../../apps/mcp-server/src/durable-batch.ts";
import { JobStartDeduplicator } from "../../apps/agent/src/job-start-dedup.ts";
const [root, window] = process.argv.slice(2) as [string, string];
const pause = async () => { process.send?.("crash-window"); await new Promise(() => { setInterval(() => {}, 1000); }); };
const keys = path.join(root, "keys"); mkdirSync(keys, { recursive: true });
const dedup = new JobStartDeduplicator(keys);
let starts = 0;
const client = {
  devices: [{ name: "fixture", url: "http://127.0.0.1:1" }],
  info: async () => { if (window === "before-start") await pause(); return { runtime: { capabilities: ["job-key-recovery-v1"] } }; },
  jobStart: async (_device: string, input: { command: string; idempotencyKey: string }) => {
    if (window === "after-two" && starts === 2) await pause();
    starts++;
    return dedup.run(input, async id => {
      appendFileSync(path.join(root, "effects"), input.command + "\n");
      const job = { id, state: window === "after-terminal" ? "completed" : "running", exitCode: window === "after-terminal" ? 0 : null };
      writeFileSync(path.join(root, id + ".job"), JSON.stringify(job));
      if (window === "after-effect" || window === "after-terminal") await pause();
      return job;
    }, async id => JSON.parse(readFileSync(path.join(root, id + ".job"), "utf8")));
  },
};
const plans: BatchPlan[] = Array.from({ length: 4 }, (_, i) => ({ device: "fixture", target: "system", request: { command: `synthetic-${i}` } }));
await new DurableBatchStore(client as unknown as AgentClient, root).start("crash-key", plans, 1);
