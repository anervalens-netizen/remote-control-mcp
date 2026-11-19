import { useState } from "react";

type Json = Record<string, any>;
type ReadTool = (name: string, args: Json) => Promise<Json>;
type ReadState = { pending: boolean; error: boolean; value?: Json };
const idle: ReadState = { pending: false, error: false };
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value.toLocaleString() : "Unknown";
const utc = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "Unknown";
const uuid = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";

function UsageHistory({ value }: { value: Json }) {
  const agent = value.agent;
  const history = agent?.history;
  if (value.agentStatus?.reason === "identity_mismatch" || (agent && agent.identity !== value.identity)) {
    return <p className="notice" role="status">Agent coverage unavailable. The producer identity could not be verified for this route.</p>;
  }
  if (!history) return <p role="status">Agent coverage unavailable ({value.agentStatus?.state ?? "unknown"}).</p>;
  const rows: Json[] = history.days ?? [];
  return <>
    <dl className="observation-facts">
      <dt>Collection started (UTC)</dt><dd>{utc(history.collectionStartedAt)}</dd>
      <dt>Configured retention</dt><dd>{count(history.retentionDays)} UTC days</dd>
      <dt>Retained daily cohorts</dt><dd>{count(history.page?.total)} · showing {rows.length} newest</dd>
      <dt>Current process</dt><dd>{count(agent.totals?.received)} admitted requests · {count(agent.sampleCoverage?.retained)} retained samples</dd>
    </dl>
    {history.partial && <p className="notice" role="status">Retained history is partial. Gaps or persistence faults may affect daily coverage.</p>}
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
    </dl>
  </>;
}

export function UsageCoverage({ device, identity, ready, call }: { device: string; identity: string; ready: boolean; call: ReadTool }) {
  const [history, setHistory] = useState<ReadState>(idle);
  const [window, setWindow] = useState<ReadState>(idle);
  const [windowId, setWindowId] = useState("");
  async function readHistory() {
    setHistory({ pending: true, error: false });
    try {
      const value = await call("usage_report", { device, identity, sampleLimit: 0, seriesLimit: 0, historyLimit: 7 });
      if (value.device !== device || value.identity !== identity) throw new Error("Usage history identity mismatch");
      setHistory({ pending: false, error: false, value });
    } catch { setHistory({ pending: false, error: true }); }
  }
  async function readWindow() {
    setWindow({ pending: true, error: false });
    try {
      const reply = await call("usage_window", { device, identity, action: "read", windowId, detailLimit: 0 });
      const report = reply.report;
      if (report?.device !== device || report?.identity !== identity || report?.windowId !== windowId.toLowerCase()) {
        throw new Error("Usage window identity mismatch");
      }
      setWindow({ pending: false, error: false, value: report });
    } catch { setWindow({ pending: false, error: true }); }
  }
  return <details className="usage-coverage">
    <summary>Usage coverage</summary>
    <p className="muted">Counts describe requests on the selected identity. A fixed window and retained daily history cover different periods.</p>
    <button type="button" disabled={!ready || history.pending} onClick={readHistory}>{history.pending ? "Reading history…" : "Read daily history"}</button>
    {history.error && <p className="notice" role="status">Daily history could not be read.</p>}
    {history.value && <UsageHistory value={history.value}/>}
    <form className="scope" onSubmit={event => { event.preventDefault(); void readWindow(); }}>
      <input aria-label="Existing usage window ID" placeholder="Existing usage window ID" required pattern={uuid} maxLength={36}
        value={windowId} disabled={window.pending} onChange={event => { setWindowId(event.target.value.toLowerCase()); setWindow(idle); }}/>
      <button disabled={!ready || !windowId || window.pending}>{window.pending ? "Reading window…" : "Read usage window"}</button>
    </form>
    {window.error && <p className="notice" role="status">Window unavailable for this device and identity. Its retained observation may have expired.</p>}
    {window.value && <WindowCoverage report={window.value}/>}
  </details>;
}
