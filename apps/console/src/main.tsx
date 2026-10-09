import { captureError } from "./error-reporting.js";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import "./style.css";

type Json = Record<string, any>;
const app = new App({ name: "Remote Control Console", version: "1.0.0" });
const extensions = new OpenAIExtensions(app);
let launch: Json | undefined;
let changed = () => {};
let connected = false;
let bridgeError = "";
app.ontoolresult = result => { if (result.structuredContent) { launch = result.structuredContent; changed(); } };
function theme() {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.onhostcontextchanged = () => theme();
async function call(name: string, args: Json) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError || !result.structuredContent) throw new Error(String(result.structuredContent?.error ?? "Observation unavailable"));
  return result.structuredContent as Json;
}
const when = (value?: string) => value ? new Date(value).toLocaleTimeString() : "Not observed";
const observedDuration = (operation: Json) => {
  const milliseconds = Date.parse(operation.updatedAt) - Date.parse(operation.startedAt);
  return Number.isFinite(milliseconds) ? `${(Math.max(0, milliseconds) / 1000).toFixed(1)} s` : "Unknown";
};
const pretty = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
function Badge({ value }: { value: string }) {
  const tone = ["ready", "reachable", "completed", "returned"].includes(value) ? "good" : ["running", "cancelling"].includes(value) ? "active" : "unknown";
  return <span className={`badge ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

function Console() {
  const [ready, setReady] = useState(connected);
  const lastLaunch = useRef(launch);
  const snapshotInFlight = useRef(false);
  const initialSnapshotScheduled = useRef(false);
  const lastFleet = useRef(launch?.fleet ? Date.now() : 0);
  const [data, setData] = useState<Json | undefined>(launch);
  const [scope, setScope] = useState<string | undefined>(launch?.diagnosticScopeId);
  const [all, setAll] = useState(false);
  const [fleet, setFleet] = useState<Json[]>(launch?.fleet?.devices ?? []);
  const [fleetPage, setFleetPage] = useState<Json>(launch?.fleet ?? {});
  const [fleetCursor, setFleetCursor] = useState<string>();
  const [device, setDevice] = useState("");
  const [identity, setIdentity] = useState("root");
  const [selection, setSelection] = useState<Json | undefined>(launch?.selected);
  const [detail, setDetail] = useState<Json>();
  const [error, setError] = useState(bridgeError);
  const [detailError, setDetailError] = useState("");
  const [lastSuccess, setLastSuccess] = useState<string | undefined>(launch?.observedAt);
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [jobCursor, setJobCursor] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  const [manualJob, setManualJob] = useState("");
  const selectedRef = useRef(selection); selectedRef.current = selection;
  useEffect(() => {
    changed = () => { setReady(connected); setError(bridgeError); if (launch && launch !== lastLaunch.current) { lastLaunch.current = launch; setData(launch); setScope(launch.diagnosticScopeId); setFleet(launch.fleet?.devices ?? []); setFleetPage(launch.fleet ?? {}); setFleetCursor(undefined); lastFleet.current = Date.now(); setSelection(launch.selected); setLastSuccess(launch.observedAt); } };
    changed();
    return () => { changed = () => {}; };
  }, []);
  useEffect(() => {
    if (!ready || !scope) return;
    let stopped = false, failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      if (snapshotInFlight.current) { timer = setTimeout(tick, 250); return; }
      if (document.hidden) { timer = setTimeout(tick, 5000); return; }
      snapshotInFlight.current = true; setBusy(true);
      try {
        const includeFleet = Date.now() - lastFleet.current >= 30_000;
        const next = await call("dashboard_snapshot", { ...(all ? {} : { diagnosticScopeId: scope }), includeFleet, fleetCursor, cursor,
          ...(device ? { jobDevice: device, jobIdentity: identity, jobCursor } : {}) });
        if (stopped) return;
        setData(next); if (next.fleet) { setFleet(next.fleet.devices); setFleetPage(next.fleet); lastFleet.current = Date.now(); }
        setLastSuccess(next.observedAt); setError(""); failures = 0;
      } catch { if (!stopped) { setError("Connection unavailable. Displayed observations may be old; device and job state are unknown until refreshed."); failures++; } }
      finally { snapshotInFlight.current = false; if (!stopped) { setBusy(false); timer = setTimeout(tick, Math.min(60000, 5000 * 2 ** failures)); } }
    };
    // Render the opener's snapshot first; no duplicate initial backend request.
    timer = setTimeout(tick, !initialSnapshotScheduled.current && launch ? 5000 : 0);
    initialSnapshotScheduled.current = true;
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [ready, scope, all, device, identity, cursor, fleetCursor, jobCursor, revision]);
  useEffect(() => {
    let stale = false;
    setDetail(undefined); setDetailError(""); setCopied(false); setCopyFallback("");
    if (selection && connected) void call("operation_inspect", { reference: selection }).then(value => { if (!stale) setDetail(value); }).catch(() => { if (!stale) setDetailError("Detail unavailable. The operation has not been retried."); });
    return () => { stale = true; };
  }, [selection]);
  async function output(stream: string, offset = 0) {
    if (!selection?.job || busy) return;
    const reference = selection;
    setBusy(true);
    try { const result = await call("operation_inspect", { reference, output: { stream, offset, length: 4096 } }); if (selectedRef.current === reference) { setDetail(result); setDetailError(""); } }
    catch { if (selectedRef.current === reference) setDetailError("Output unavailable. The job has not been restarted."); }
    finally { setBusy(false); }
  }
  async function associate() {
    if (!scope) return;
    try {
      const params = { content: [{ type: "text" as const, text: `Remote Control diagnosticScopeId: ${scope}. Include this optional scope in future RC operation starts to associate them with this panel. This is client-declared association, not the chat identity.` }] };
      if (extensions.modelContext) await extensions.modelContext.update(params); else await app.updateModelContext(params);
      setError("");
    } catch { setError("This host could not attach the diagnostic scope. Copy the scope to associate future operations explicitly."); }
  }
  const operations = (all ? !data?.diagnosticScopeId : data?.diagnosticScopeId === scope) ? data?.operations?.items ?? [] : [];
  const jobs = data?.jobs?.device === device && data?.jobs?.identity === identity ? data.jobs : undefined;
  const disconnected = error.startsWith("Connection unavailable");
  return <main>
    <header><div><div className="eyebrow">REMOTE CONTROL</div><h1>Fleet & operations</h1><p>Read-only observations across your devices</p></div><button disabled={busy || !ready} onClick={() => { lastFleet.current = 0; refresh(n => n + 1); }}>{busy ? "Refreshing…" : "Refresh"}</button></header>
    {!connected && <div className="notice">{bridgeError || "Connecting to the app host…"}</div>}
    {error && <div className="notice" role="alert">{error}</div>}
    <div className="freshness">Last successful refresh: {when(lastSuccess)} · Device probes carry their own observation times.</div>
    <section><h2>Fleet <small>{fleet.length} shown · {fleetPage.totalConfigured ?? fleet.length} configured</small></h2><div className="fleet-grid">{fleet.map(row => <button className={`device ${device === row.device ? "selected" : ""}`} key={row.device} onClick={() => { setDevice(row.device); setIdentity(row.identity ?? "root"); setJobCursor(undefined); }}>
      <div className="device-title">{row.device}<Badge value={disconnected || !row.observedAt || Date.now() - Date.parse(row.observedAt) > 60_000 ? "stale" : row.connectivity ?? "unknown"}/></div><p>{row.identity ?? "Unselected identity"} · {disconnected ? "Last observed: " : ""}{row.readiness ?? "Readiness unknown"}</p>
      <div className="device-meta">
        <small>Configured: {row.configuredIdentities?.join(", ") ?? "Not reported"}</small>
        <small>{row.expectedAvailability === "intermittent" ? "Intermittent availability · " : ""}{when(row.observedAt)}</small>
        {row.runtime?.sha && <code title={row.runtime.sha}>{String(row.runtime.sha).slice(0, 12)}</code>}
      </div>
      {row.reason && <p className="muted">{row.reason}</p>}
    </button>)}</div>{fleet.length === 0 && <p>No fleet observations available.</p>}
      <div className="pagination"><button disabled={!fleetCursor || busy} onClick={() => { lastFleet.current = 0; setFleetCursor(undefined); }}>First devices</button><button disabled={!fleetPage.nextCursor || busy} onClick={() => { lastFleet.current = 0; setFleetCursor(fleetPage.nextCursor); }}>Next devices</button></div></section>
    <section><div className="section-title"><h2>{all ? "Observed operations" : "Associated operations"}</h2><label><input type="checkbox" checked={all} onChange={e => { setAll(e.target.checked); setCursor(undefined); }}/> All observed scopes</label></div>
      <div className="scope"><code>{scope ?? "Waiting for an opener snapshot"}</code><button disabled={!scope} onClick={associate}>Associate future operations</button></div>
      <p className="muted">Association is explicit. An empty view does not mean the conversation has no active work.</p>
      {data?.operations?.coverage?.partial && <div className="notice">Partial observation history: {data.operations.coverage.faults.join(", ")}</div>}
      <div className="table-wrap"><table><thead><tr><th>Operation</th><th>Association</th><th>Handler</th><th>Started</th><th>Observed duration</th><th>Jobs</th></tr></thead><tbody>{operations.map((op: Json) => <tr key={op.traceId}><td><button className="link" onClick={() => setSelection({ traceId: op.traceId })}>{op.tool}</button><code>{op.traceId.slice(0, 8)}</code></td><td>{op.diagnosticScopeId ? <code title={op.diagnosticScopeId}>{op.diagnosticScopeId === scope ? "This scope" : op.diagnosticScopeId.slice(0, 8)}</code> : <span>Unassociated</span>}</td><td><Badge value={op.state}/>{op.executionOutcome && <small>{op.executionOutcome}</small>}</td><td>{when(op.startedAt)}</td><td title="Controller time between first and latest recorded events; not workload runtime">{observedDuration(op)}</td><td>{op.jobCount}</td></tr>)}</tbody></table></div>
      {!operations.length && <p className="empty">No operations in this observed scope.</p>}
      <div className="pagination"><button disabled={!cursor} onClick={() => setCursor(undefined)}>Newest</button><button disabled={!data?.operations?.nextCursor} onClick={() => setCursor(data?.operations?.nextCursor)}>Older observations</button></div>
    </section>
    {device && <section><div className="section-title"><h2>Jobs · {device}</h2><select aria-label="Job execution identity" value={identity} onChange={e => { setIdentity(e.target.value); setJobCursor(undefined); }}><option value="root">Root / system</option><option value="owner">Owner</option><option value="interactive">Interactive</option></select></div>
      <form className="scope" onSubmit={e => { e.preventDefault(); if (manualJob.trim()) setSelection({ job: { device, identity, jobId: manualJob.trim() } }); }}><input aria-label="Known job ID" placeholder="Known job ID" value={manualJob} maxLength={256} onChange={e => setManualJob(e.target.value)}/><button disabled={!manualJob.trim()}>Inspect job</button></form>
      {jobs?.partial && <div className="notice">Job history is incomplete or unavailable.</div>}
      {(jobs?.items ?? []).map((job: Json) => <button className="job-row" key={job.id} onClick={() => setSelection({ job: { device, identity, jobId: job.id } })}><code>{job.id}</code><Badge value={job.state ?? "unknown"}/><span>{when(job.startedAt)}</span></button>)}
      <div className="pagination"><button disabled={!jobCursor} onClick={() => setJobCursor(undefined)}>Newest jobs</button><button disabled={!jobs?.nextCursor} onClick={() => setJobCursor(jobs?.nextCursor)}>Older jobs</button></div>
    </section>}
    {selection && <aside aria-label="Operation details"><div className="section-title"><h2>Details</h2><button onClick={() => setSelection({ ...selection })}>Refresh detail</button><button onClick={() => setSelection(undefined)}>Close</button></div>
      {detailError && <div className="notice">{detailError}</div>}
      {!detail && !detailError && <p>Reading observation…</p>}
      {detail && <><p className="muted">{detail.coverage}</p>{detail.observation ? <>
        <Badge value={detail.observation.state ?? "unknown"}/><p>Observed: {when(detail.observedAt)}</p>
        {detail.observation.contextKeep && <p>ContextKeep task <code>{detail.observation.contextKeep.taskId}</code></p>}
        {detail.observation.exitCode !== undefined && <p>Exit code: {pretty(detail.observation.exitCode)}</p>}{detail.observation.code !== undefined && <p>Exit code: {pretty(detail.observation.code)}</p>}
        {detail.observation.events?.map((event: Json, i: number) => <div className="event" key={i}><time>{when(event.at)}</time><span>{event.stage.replaceAll("_", " ")}</span><small>{event.device} {event.identity}</small></div>)}
        {detail.observation.eventsPartial && <p className="notice">Additional stages were omitted by the observation limit.</p>}
        {detail.observation.nextDetailOffset != null && <button disabled={busy} onClick={async () => {
          const reference = selection; setBusy(true);
          try { const next = await call("operation_inspect", { reference, detailOffset: detail.observation.nextDetailOffset }); if (selectedRef.current === reference) setDetail(next); }
          catch { if (selectedRef.current === reference) setDetailError("Detail page unavailable. The operation has not been retried."); }
          finally { setBusy(false); }
        }}>Next detail page</button>}
        {detail.observation.jobs?.map((job: Json) => <button className="job-row" key={JSON.stringify(job)} onClick={() => setSelection({ job })}>{job.device} · {job.identity}<code>{job.jobId}</code></button>)}
      </> : <p>Observation not retained. Inspect a known durable job reference; do not repeat the operation.</p>}
      {selection.job && <div className="pagination"><button disabled={busy} onClick={() => output("stdout")}>Read stdout</button><button disabled={busy} onClick={() => output("stderr")}>Read stderr</button></div>}
      {detail.output && <><pre>{String(detail.output.data ?? "")}</pre><button disabled={busy || detail.output.eof} onClick={() => output(detail.output.stream, detail.output.nextOffset)}>Next output page</button></>}
      <button onClick={async () => {
        const reference = selection;
        const summary = JSON.stringify({ reference: detail.reference, observedAt: detail.observedAt, observation: detail.observation, coverage: detail.coverage }, null, 2);
        try { await navigator.clipboard.writeText(summary); if (selectedRef.current === reference) { setCopied(true); setCopyFallback(""); } }
        catch { if (selectedRef.current === reference) { setCopied(false); setCopyFallback(summary); } }
      }}>{copied ? "Copied" : "Copy diagnostic summary"}</button>
      {copyFallback && <div className="copy-fallback"><p>Automatic copying is unavailable. Select the summary below and copy it manually.</p><textarea aria-label="Diagnostic summary" readOnly value={copyFallback} onFocus={event => event.currentTarget.select()}/></div>}
      </>}
    </aside>}
    <footer>Handler response, job exit, verified effect and client acceptance are separate facts.</footer>
  </main>;
}
createRoot(document.getElementById("root")!, { onUncaughtError: (error) => { captureError(error); }, onCaughtError: (error) => { captureError(error); } }).render(<Console/>);
void app.connect().then(async () => {
  connected = true; theme(); changed();
  const host = app.getHostContext();
  if (host?.displayMode !== "fullscreen" && host?.availableDisplayModes?.includes("fullscreen")) {
    try { await app.requestDisplayMode({ mode: "fullscreen" }); } catch { /* Placement is a host hint; preserve the connected panel. */ }
  }
}).catch(() => { bridgeError = "The app host connection is unavailable. Open this console from Remote Control MCP."; changed(); });
