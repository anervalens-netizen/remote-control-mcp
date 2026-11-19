import { useState } from "react";

type Json = Record<string, any>;
type ReadTool = (name: string, args: Json) => Promise<Json>;
type ReadState = { pending: boolean; error?: string; value?: Json };
const idle: ReadState = { pending: false };
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value.toLocaleString() : "Unknown";
const utc = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "Unknown";
const uuid = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";
const agentReadReason: Record<string, string> = {
  identity_mismatch: "Producer identity did not match the selected route",
  route_unavailable: "Agent does not expose this diagnostic route",
  unsupported_contract: "Agent did not return supported coverage",
  deadline_exceeded: "Agent read exceeded its deadline",
  http_error: "Agent returned an HTTP error",
  network_error: "Agent could not be reached",
  protocol_error: "Agent returned an invalid response",
  unavailable: "Agent coverage unavailable",
};
const gapReason: Record<string, string> = {
  unclean_restart: "Unclean restart", clean_restart_interval: "Restart interval",
  writer_continuity_unknown: "Writer continuity unknown",
};
function statusMessage(status: Json) {
  return status.state === "available" ? "Coverage available" : agentReadReason[status.reason] ?? "Agent coverage unavailable";
}
function readError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message === "unconfigured_usage_identity") return "This device has no endpoint for the selected identity.";
  if (error instanceof Error && error.message === "usage_window_unavailable") return "This window ID is unavailable on the selected route.";
  return fallback;
}

function UsageHistory({ value }: { value: Json }) {
  const agent = value.agent;
  const history = agent?.history;
  if (value.agentStatus?.reason === "identity_mismatch" || (agent && agent.identity !== value.identity)) {
    return <p className="notice" role="status">Agent coverage unavailable. The producer identity could not be verified for this route.</p>;
  }
  if (!history) return <p role="status">{statusMessage(value.agentStatus ?? {})}.</p>;
  const rows: Json[] = history.days ?? [];
  const gaps: Json[] = history.gaps ?? [];
  const offset = history.page?.offset;
  const retainedCount = count(history.page?.total);
  const pageLabel = Number.isSafeInteger(offset) && offset >= 0 && rows.length > 0
    ? rows.length === 1 ? `cohort ${offset + 1}` : `cohorts ${offset + 1}–${offset + rows.length}`
    : `${rows.length} shown`;
  return <>
    <dl className="observation-facts">
      <dt>Collection started (UTC)</dt><dd>{utc(history.collectionStartedAt)}</dd>
      <dt>Configured retention</dt><dd>{count(history.retentionDays)} UTC days</dd>
      <dt>Retained daily cohorts</dt><dd>{retainedCount} · {pageLabel}</dd>
      <dt>Current process</dt><dd>{count(agent.totals?.received)} admitted requests · {count(agent.sampleCoverage?.retained)} retained samples</dd>
      <dt>Sample limits</dt><dd>{count(agent.sampleCoverage?.omitted)} omitted · {count(agent.sampleCoverage?.limit)} retained maximum</dd>
    </dl>
    {history.partial && <p className="notice" role="status">Retained history is partial. Gaps or persistence faults may affect daily coverage.</p>}
    {(gaps.length > 0 || history.omittedGaps > 0) && <>
      <p>Coverage gaps · {gaps.length} retained · {count(history.omittedGaps)} omitted</p>
      <ul>{gaps.map((gap, index) => <li key={index}>{gapReason[gap.reason] ?? "Unclassified gap"} · {utc(gap.from)} to {utc(gap.to)}</li>)}</ul>
    </>}
    {history.legacyCoverageUnknown && <p className="muted">Coverage before collection began is unknown.</p>}
    {rows.length > 0 && <div className="table-wrap"><table>
      <thead><tr><th>Arrival day (UTC)</th><th>Arrivals</th><th>Observed completions</th></tr></thead>
      <tbody>{rows.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{count(day.received)}</td><td>{count(day.completed)}</td></tr>)}</tbody>
    </table></div>}
  </>;
}

function WindowCoverage({ report }: { report: Json }) {
  return <>
    <p>{report.complete ? "Complete window" : "Window coverage is incomplete"}</p>
    <dl className="observation-facts">
      <dt>Start (UTC)</dt><dd>{utc(report.start?.observedAt)}</dd>
      <dt>{report.end ? "End (UTC)" : "Latest observation (UTC)"}</dt><dd>{utc((report.end ?? report.latest)?.observedAt)}</dd>
      <dt>Agent arrivals</dt><dd>{count(report.agentDenominator)}{report.denominatorExact === true ? " · exact denominator" : ""}</dd>
      <dt>Attributed</dt><dd>{count(report.reconciliation?.attributed)}</dd>
      <dt>Explicitly unmatched</dt><dd>{count(report.reconciliation?.unmatchedObserved)}</dd>
      <dt>Collection residual</dt><dd>{count(report.collectionResidual)}</dd>
      <dt>Missing event details</dt><dd>{count(report.missingEventDetail)}</dd>
      {report.lastAgentStatus && <><dt>Last agent read</dt><dd>{statusMessage(report.lastAgentStatus)}</dd></>}
    </dl>
  </>;
}

export function UsageCoverage({ device, identity, ready, call }: { device: string; identity: string; ready: boolean; call: ReadTool }) {
  const [history, setHistory] = useState<ReadState>(idle);
  const [window, setWindow] = useState<ReadState>(idle);
  const [windowId, setWindowId] = useState("");
  async function readHistory(offset = 0) {
    setHistory({ pending: true });
    try {
      const value = await call("usage_report", {
        device, identity, sampleLimit: 0, seriesLimit: 0, historyLimit: 7, ...(offset ? { historyOffset: offset } : {}),
      });
      if (value.device !== device || value.identity !== identity) throw new Error("Usage history identity mismatch");
      setHistory({ pending: false, value });
    } catch (error) { setHistory({ pending: false, error: readError(error, "Daily history could not be read.") }); }
  }
  async function readWindow() {
    setWindow({ pending: true });
    try {
      const reply = await call("usage_window", { device, identity, action: "read", windowId, detailLimit: 0 });
      const report = reply.report;
      if (report?.device !== device || report?.identity !== identity || report?.windowId !== windowId.toLowerCase()) {
        throw new Error("Usage window identity mismatch");
      }
      setWindow({ pending: false, value: report });
    } catch (error) { setWindow({ pending: false, error: readError(error, "Window observation could not be read.") }); }
  }
  const page = history.value?.agent?.identity === identity ? history.value.agent?.history?.page : undefined;
  const nextOffset = page?.nextOffset;
  return <details className="usage-coverage">
    <summary>Usage coverage</summary>
    <p className="muted">Counts describe requests on the selected identity. A fixed window and retained daily history cover different periods.</p>
    <button type="button" disabled={!ready || history.pending} onClick={() => void readHistory()}>{history.pending ? "Reading history…" : "Read daily history"}</button>
    {history.error && <p className="notice" role="status">{history.error}</p>}
    {history.value && <UsageHistory value={history.value}/>}
    {Number.isSafeInteger(nextOffset) && nextOffset > page.offset && nextOffset < 90 &&
      <button type="button" disabled={!ready || history.pending} onClick={() => void readHistory(nextOffset)}>Read older days</button>}
    <form className="scope" onSubmit={event => { event.preventDefault(); void readWindow(); }}>
      <input aria-label="Existing usage window ID" placeholder="Existing usage window ID" required pattern={uuid} maxLength={36}
        value={windowId} disabled={window.pending} onChange={event => { setWindowId(event.target.value.toLowerCase()); setWindow(idle); }}/>
      <button disabled={!ready || !windowId || window.pending}>{window.pending ? "Reading window…" : "Read usage window"}</button>
    </form>
    {window.error && <p className="notice" role="status">{window.error}</p>}
    {window.value && <WindowCoverage report={window.value}/>}
  </details>;
}
