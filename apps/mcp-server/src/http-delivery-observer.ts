import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentClient } from "./agent-client.ts";

export const controllerHttpContext = new AsyncLocalStorage<{ requestId: string }>();
type Delivery = { requestId: string; startedAt: string; finishedAt?: string; route: string; method: string; bearerVerified: boolean; statusCode?: number; outcome?: "response_finished" | "connection_closed" | "request_aborted"; durationMs?: number };
type Handle = { value: Delivery; started: number; done: boolean };
/** Local response publication only. finish does not acknowledge remote consumption. */
export class HttpDeliveryObserver {
  readonly instanceId = randomUUID();
  readonly collectionStartedAt = new Date().toISOString();
  private started = 0;
  private finished = 0;
  private responseFinished = 0;
  private connectionsClosed = 0;
  private requestsAborted = 0;
  private httpErrors = 0;
  private readonly samples: Delivery[] = [];
  begin(req: IncomingMessage, token?: string): Handle {
    const route = ["/mcp", "/health", "/health/details"].includes(req.url ?? "") ? req.url! : "other";
    const method = ["GET", "POST", "DELETE", "HEAD", "OPTIONS", "PUT", "PATCH"].includes(req.method ?? "") ? req.method! : "other";
    this.started++;
    return { value: { requestId: randomUUID(), startedAt: new Date().toISOString(), route, method,
      bearerVerified: Boolean(token) && req.headers.authorization === "Bearer " + token },
      started: performance.now(), done: false };
  }
  finish(handle: Handle, res: ServerResponse, outcome: NonNullable<Delivery["outcome"]>) {
    if (handle.done) return false;
    handle.done = true; this.finished++;
    if (outcome === "response_finished") this.responseFinished++;
    else if (outcome === "connection_closed") this.connectionsClosed++;
    else this.requestsAborted++;
    if (res.statusCode >= 400) this.httpErrors++;
    Object.assign(handle.value, { finishedAt: new Date().toISOString(), statusCode: res.statusCode, outcome,
      durationMs: Math.max(0, performance.now() - handle.started) });
    this.samples.push({ ...handle.value });
    if (this.samples.length > 128) this.samples.shift();
    return true;
  }
  snapshot() {
    return { version: 1, instanceId: this.instanceId, collectionStartedAt: this.collectionStartedAt, observedAt: new Date().toISOString(),
      persistence: "process_memory", started: this.started, finished: this.finished, inFlight: this.started - this.finished,
      responseFinished: this.responseFinished, connectionsClosed: this.connectionsClosed, requestsAborted: this.requestsAborted,
      httpErrors: this.httpErrors, samples: structuredClone(this.samples), sampleLimit: 128,
      scope: "Controller HTTP lifecycle. Premature close with status 200 is not a completed response. Long-lived SSE includes connection lifetime.",
      clientAcceptance: "unknown", effectVerification: "unverified",
    };
  }
}
const instances = new WeakMap<object, HttpDeliveryObserver>();
export function httpDeliveryFor(client: AgentClient) {
  let value = instances.get(client);
  if (!value) { value = new HttpDeliveryObserver(); instances.set(client, value); }
  return value;
}
