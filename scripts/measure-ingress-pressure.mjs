import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngressObserver } from "../apps/agent/src/ingress-observer.ts";
import { ExecReceiptStore } from "../apps/agent/src/exec-receipts.ts";
import { reconcileIngressSamples } from "../apps/mcp-server/src/agent-dispatch-observer.ts";

const days = 90;
const requestsPerDay = 1_000;
const requests = days * requestsPerDay;
const routes = Array.from({ length: 300 }, (_, i) => "/synthetic/" + i);
const root = mkdtempSync(join(tmpdir(), "rcmcp-ingress-pressure-"));
const aggregateDir = join(root, "aggregate");
const receiptDir = join(root, "receipts");
const timings = { collection: [], flush: [], reconciliation: [] };
let day = Date.UTC(2026, 0, 1);
let observer;

function p95(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3));
}

try {
  const receipts = new ExecReceiptStore(receiptDir);
  const ref = receipts.prepare();
  let executions = 0;
  await assert.rejects(receipts.execute(ref.id, async () => {
    executions++;
    throw new Error("synthetic uncertainty");
  }));
  const receiptPath = join(receiptDir, ref.id, "meta.json");
  const originalReceipt = readFileSync(receiptPath);
  const options = {
    identity: "owner", stateDirectory: aggregateDir, now: () => day, knownRoutes: routes,
  };
  observer = new IngressObserver(options);
  for (let i = 0; i < days; i++) {
    day = Date.UTC(2026, 0, i + 1);
    let start = performance.now();
    for (let j = 0; j < requestsPerDay; j++) {
      const handle = observer.begin({
        route: routes[j % routes.length], method: "POST",
        entryPoint: "unattributed", authentication: "bearer_verified",
      });
      observer.finish(handle, { statusCode: 200 });
    }
    timings.collection.push(performance.now() - start);

    start = performance.now();
    observer.flush();
    timings.flush.push(performance.now() - start);
    const snapshot = observer.snapshot();
    start = performance.now();
    const report = reconcileIngressSamples(snapshot.totals.received, snapshot.samples, []);
    timings.reconciliation.push(performance.now() - start);
    assert.equal(report.agentTotal, snapshot.totals.received);
  }

  const snapshot = observer.snapshot();
  assert.equal(snapshot.totals.received, requests);
  assert.equal(snapshot.totals.completed, requests);
  assert.equal(snapshot.history.days.length, days);
  assert.equal(snapshot.series.length, observer.maxSeries);
  assert.equal(snapshot.samples.length, observer.sampleLimit);
  assert.ok(snapshot.seriesOverflowRequests > 0);
  observer.close();
  const aggregateBytes = statSync(join(aggregateDir, "aggregate.json")).size;
  assert.ok(aggregateBytes <= observer.maxStateBytes);

  observer = new IngressObserver(options);
  assert.equal(observer.snapshot().history.days.reduce((sum, record) => sum + record.received, 0), requests);
  const reopenedReceipts = new ExecReceiptStore(receiptDir);
  assert.equal(reopenedReceipts.read(ref.id).state, "unknown");
  await assert.rejects(reopenedReceipts.execute(ref.id, async () => { executions++; }), /already used/);
  assert.equal(executions, 1);
  assert.deepEqual(readFileSync(receiptPath), originalReceipt);

  console.log(JSON.stringify({
    requests, days, series: snapshot.series.length, samples: snapshot.samples.length,
    overflowRequests: snapshot.seriesOverflowRequests, aggregateBytes,
    limits: { series: observer.maxSeries, samples: observer.sampleLimit, aggregateBytes: observer.maxStateBytes },
    collectionPerDayP95Ms: p95(timings.collection),
    flushP95Ms: p95(timings.flush), reconciliationP95Ms: p95(timings.reconciliation),
    originalReceiptPreserved: true,
  }));
} finally {
  observer?.close();
  rmSync(root, { recursive: true, force: true });
}
