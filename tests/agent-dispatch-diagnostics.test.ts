import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AgentDispatchObserver } from "../apps/mcp-server/src/agent-dispatch-observer.ts";

it.each([
  ["/v1/metrics?profile=light", "/v1/metrics"],
  ["/v1/info?private=fixture-query", "/v1/info"],
  ["/v1/jobs/history?limit=5", "/v1/jobs"],
  ["/health/details?private=fixture-query", "/health"],
  ["/v1/metrics#fixture-fragment", "/v1/metrics"],
  ["/private-fixture-path?profile=light", "other"],
])("categorizes %s without persisting caller URL detail", (route, category) => {
  const observer = new AgentDispatchObserver();
  const handle = observer.begin("fixture", "user", route, {
    version: 1, controllerInstanceId: randomUUID(), dispatchId: randomUUID(),
  });
  observer.finish(handle, "success");
  const snapshot = observer.snapshot();
  expect(snapshot.samples[0]).toMatchObject({ route: category, identity: "owner", outcome: "success" });
  expect(JSON.stringify(snapshot)).not.toMatch(/fixture-query|fixture-fragment|private-fixture-path|profile=|limit=/);
});
