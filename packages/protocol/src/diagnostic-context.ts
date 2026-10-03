import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
export type Stage = "handler" | "agentRequest" | "executionWait" | "persistence" | "reconciliation" | "resultPreparation" | "finalValidation";
export type Trace = { jobHashes: string[]; agentErrors: Partial<Record<"timeout" | "cancelled" | "network" | "http" | "protocol" | "context", number>>; correlation: Partial<Record<"request" | "session" | "operation" | "job" | "ckProject" | "ckTask" | "ckRun", string>>; stages: Partial<Record<Stage, { ms: number; count: number }>>; totalBytes: number; queueMs: null; clientAcceptance: "unknown"; callerDisconnected: boolean };
export const diagnosticContext = new AsyncLocalStorage<Trace>();
export const correlationHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function recordStage(stage: Stage, ms: number) {
  const trace = diagnosticContext.getStore(); if (!trace) return;
  const value = trace.stages[stage] ??= { ms: 0, count: 0 };
  value.ms += Math.max(0, ms); value.count++;
}
export function measureSync<T>(stage: Stage, action: () => T): T { const start = performance.now(); try { return action(); } finally { recordStage(stage, performance.now() - start); } }
export async function measureAsync<T>(stage: Stage, action: () => Promise<T>): Promise<T> { const start = performance.now(); try { return await action(); } finally { recordStage(stage, performance.now() - start); } }
export function createTrace(name: string, args: unknown, requestId: unknown, sessionId?: unknown): Trace {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const correlation: Trace["correlation"] = {};
  if (sessionId !== undefined) correlation.session = correlationHash(sessionId);
  if (requestId !== undefined) correlation.request = correlationHash(requestId);
  if (typeof input.operationKey === "string") correlation.operation = correlationHash(input.operationKey);
  else if (typeof input.operationId === "string") correlation.operation = input.operationId;
  if (name.startsWith("job_") && typeof input.id === "string") correlation.job = correlationHash(input.id);
  const ck = input.contextKeep as Record<string, unknown> | undefined;
  for (const [key, field] of [["ckProject", "projectId"], ["ckTask", "taskId"], ["ckRun", "runId"]] as const) if (typeof ck?.[field] === "string") correlation[key] = correlationHash(ck[field]);
  return { jobHashes: [], agentErrors: {}, correlation, stages: {}, totalBytes: 0, queueMs: null, clientAcceptance: "unknown", callerDisconnected: false };
}
