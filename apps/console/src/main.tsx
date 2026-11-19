import { captureError } from "./error-reporting.js";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { UsageCoverage } from "./usage-coverage.js";
import "./style.css";

type Json = Record<string, any>;
const app = new App({ name: "Remote Control Console", version: "1.0.0" });
const extensions = new OpenAIExtensions(app);
let launch: Json | undefined;
let launchVersion = 0;
let awaitingOpener: Json | undefined;
const receivedOpeners = new Set<string>();
let changed = () => {};
let connected = false;
let bridgeError = "";
const isSnapshot = (value?: Json) => typeof value?.observedAt === "string" && Array.isArray(value?.operations?.items);
// Complete tool input is the host's explicit activation signal. A repeated
// result alone is idempotent; it must not reopen details during ambient polls.
function matchesOpener(value: Json, args: Json) {
  if (args.diagnosticScopeId && value.diagnosticScopeId !== args.diagnosticScopeId) return false;
  const wanted = args.reference, selected = value.selected;
  if (wanted?.traceId) return selected?.traceId === wanted.traceId;
  if (wanted?.job) return ["device", "identity", "jobId"].every(key => selected?.job?.[key] === wanted.job[key]);
  return !selected && value.diagnosticScopeId === args.diagnosticScopeId;
}
app.ontoolinput = params => { awaitingOpener = params.arguments ?? {}; };
app.ontoolcancelled = () => { awaitingOpener = undefined; };
app.ontoolresult = result => {
  if (result.isError) return;
  const value = result.structuredContent;
  if (!value || !(isSnapshot(value) || value.selected)) return;
  const explicit = awaitingOpener !== undefined && matchesOpener(value, awaitingOpener);
  // An unrelated ambient result cannot consume a pending scope/reference intent.
  if (awaitingOpener !== undefined && !explicit) return;
  if (explicit) awaitingOpener = undefined;
  const signature = JSON.stringify(value);
  if (!explicit && receivedOpeners.has(signature)) return;
  receivedOpeners.add(signature);
  if (receivedOpeners.size > 32) receivedOpeners.delete(receivedOpeners.values().next().value!);
  launch = value; launchVersion++; changed();
};
function theme() {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.onhostcontextchanged = () => theme();
async function call(name: string, args: Json) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError && (name === "usage_report" || name === "usage_window")) {
    const detail = result.content.find(item => item.type === "text")?.text;
    const route = args.identity === "root" ? "system/root" : args.identity;
    if (detail === `${args.device} ${route} identity is not configured`) throw new Error("unconfigured_usage_identity");
    if (detail === "usage_window_unavailable") throw new Error(detail);
  }
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

const identityLabel: Record<string, string> = { root: "Root / system", owner: "Owner", interactive: "Interactive" };
const readable = (value: string) => value.replaceAll("_", " ");
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not observed";
const doctorStageName: Record<string, string> = {
  controller: "Controller", agent: "Agent", graphical_session: "Graphical session",
  managed_desktop_engine: "Managed desktop engine", capture_capability: "Capture", input_capability: "Input",
};
const nextJobRead: Record<string, string> = {
  job_wait: "Refresh the original job status. Use job_wait for a bounded wait.",
  job_lineage: "Use job_lineage with this original job reference to inspect retained receipts.",
  job_output_since: "Read retained stdout or stderr using the original job reference.",
};
function ObservationFacts({ observation, reference }: { observation: Json; reference: Json }) {
  const progress = observation.progressGuidance;
  const output = progress?.outputBytes;
  const noOutputBytes = output?.stdout == null && output?.stderr == null;
  const exitCode = observation.exitCode ?? observation.code;
  return <>{exitCode != null && <p>Exit code: {pretty(exitCode)}</p>}<dl className="observation-facts">
    {reference.job ? <>
      <dt>Route</dt><dd>{reference.job.device} · {identityLabel[reference.job.identity] ?? reference.job.identity}</dd>
      <dt>Job record</dt><dd><Badge value={observation.state ?? "unknown"}/></dd>
      <dt>Termination</dt><dd>{progress?.terminationEvidence ?? "Unknown"}</dd>
      <dt>Last output</dt><dd>{timestamp(progress?.lastOutputAt)}
        {!noOutputBytes && <small>stdout {output.stdout ?? "unknown"} B · stderr {output.stderr ?? "unknown"} B</small>}
      </dd>
      {progress?.nextCheck && <><dt>Next check</dt><dd>{nextJobRead[progress.nextCheck] ?? "Inspect the original job receipt."}
        {progress.retryAfterMs != null && <small>Suggested retry interval {progress.retryAfterMs} ms</small>}
        {progress.waitExpiredWithoutTermination && <small>The last wait expired while the job was active.</small>}
      </dd></>}
    </> : <>
      <dt>Request handler</dt><dd><Badge value={observation.state ?? "unknown"}/>{observation.callerDisconnected && <small>Caller disconnected</small>}</dd>
      <dt>Execution outcome</dt><dd>{readable(observation.executionOutcome ?? "unknown")}</dd>
      {observation.observationOutcome === "failed" && <><dt>Observation</dt><dd>Read failed</dd></>}
      {observation.recoveryId && <><dt>Result receipt</dt><dd><code>{observation.recoveryId}</code><small>Use result_recover while the original receipt is retained.</small></dd></>}
    </>}
    <dt>Verified effect</dt><dd>{readable(observation.effectVerification ?? progress?.effectVerification ?? "unverified")}</dd>
    <dt>Client acceptance</dt><dd>{readable(observation.clientAcceptance ?? "unknown")}</dd>
  </dl></>;
}

function DeviceDoctor({ device, identity, ready, disconnected }: { device: string; identity: string; ready: boolean; disconnected: boolean }) {
  const [report, setReport] = useState<Json>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function diagnose() {
    setPending(true); setError(false);
    try { setReport(await call("dashboard_doctor", { device })); }
    catch { setError(true); }
    finally { setPending(false); }
  }
  return <div className="device-doctor">
    <div className="section-title"><h3>Device diagnosis</h3>
      <button type="button" disabled={!ready || pending} onClick={diagnose}>{pending ? "Checking…" : report ? "Refresh diagnosis" : "Check endpoints"}</button>
    </div>
    <p className="muted">Selected route is {identityLabel[identity] ?? identity}. Use Owner for owner files and processes, Interactive for desktop sessions, or Root / system for system services. Inspect known jobs using their original identity.</p>
    {error && <p className="notice" role="status">Diagnosis unavailable. Any previous results are cached observations.</p>}
    {report && <>
      <p><Badge value={report.status ?? "unknown"}/> <small>{error || pending || disconnected ? "Last observed" : "Observed"} {timestamp(report.observedAt)}</small></p>
      <div className="table-wrap"><table><thead><tr><th>Check</th><th>State and cause</th><th>Source and time</th></tr></thead><tbody>
        {report.stages?.map((stage: Json) => <tr key={`${stage.name}:${stage.identity ?? ""}`}>
          <th scope="row">{doctorStageName[stage.name] ?? readable(stage.name)}{stage.identity && <small>{identityLabel[stage.identity] ?? stage.identity}</small>}</th>
          <td><Badge value={stage.state}/><small>{readable(stage.cause)}</small></td>
          <td><small>{stage.source} · {timestamp(stage.observedAt)}</small></td>
        </tr>)}
      </tbody></table></div>
      {report.nextCheck && <p>{report.nextCheck}</p>}
      {report.coverage?.caveat && <p className="muted">{report.coverage.caveat}</p>}
    </>}
  </div>;
}

function Console() {
  const [ready, setReady] = useState(connected);
  const lastLaunch = useRef(launchVersion);
  const viewEpoch = useRef(0);
  const snapshotInFlight = useRef(false);
  const hasStartedPoll = useRef(false);
  const hasCompletedPoll = useRef(false);
  // Only completed Fleet polls advance this local monotonic clock. Server
  // timestamps and replayed openers cannot postpone or accelerate probes.
  const lastFleet = useRef<number | undefined>(undefined);
  const [data, setData] = useState<Json | undefined>(isSnapshot(launch) ? launch : undefined);
  const [scope, setScope] = useState<string | undefined>(launch?.diagnosticScopeId ?? launch?.suggestedDiagnosticScopeId);
  const [all, setAll] = useState(!launch?.diagnosticScopeId);
  const [fleet, setFleet] = useState<Json[]>(launch?.fleet?.devices ?? []);
  const [fleetPage, setFleetPage] = useState<Json>(launch?.fleet ?? {});
  const [fleetCursor, setFleetCursor] = useState<string>();
  const [device, setDevice] = useState("");
  const [identity, setIdentity] = useState("root");
  const [selection, setSelection] = useState<Json | undefined>(launch?.selected);
  const [detailResult, setDetailResult] = useState<{ reference: Json; value: Json }>();
  const detail = detailResult?.reference === selection ? detailResult?.value : undefined;
  const outputPage = detail?.output;
  const outputHasNext = outputPage && (!outputPage.eof
    || outputPage.nextOffset < (detail?.observation?.progressGuidance?.outputBytes?.[outputPage.stream] ?? 0));
  const [detailRevision, refreshDetail] = useState(0);
  const detailReads = useRef(new Set<Json>());
  const lastDetailState = useRef<string | undefined>(undefined);
  const [error, setError] = useState(bridgeError);
  const [detailError, setDetailError] = useState("");
  const [outputError, setOutputError] = useState("");
  const [lastSuccess, setLastSuccess] = useState<string | undefined>(isSnapshot(launch) ? launch?.observedAt : undefined);
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [jobCursor, setJobCursor] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  const [manualJob, setManualJob] = useState("");
  const selectedRef = useRef(selection); selectedRef.current = selection;
  useEffect(() => {
    changed = () => {
      setReady(connected); setError(bridgeError);
      if (launch && launchVersion !== lastLaunch.current) {
        lastLaunch.current = launchVersion;
        if (isSnapshot(launch)) {
          viewEpoch.current++;
          setScope(launch.diagnosticScopeId ?? launch.suggestedDiagnosticScopeId);
          setAll(!launch.diagnosticScopeId);
          setCursor(undefined); setFleetCursor(undefined); setJobCursor(undefined);
          // Opener data only bootstraps the panel. Later activations select the
          // view and fetch live data, regardless of cached observation dates.
          if (!hasCompletedPoll.current) {
            setData(launch);
            if (launch.fleet) { setFleet(launch.fleet.devices ?? []); setFleetPage(launch.fleet); }
            setLastSuccess(launch.observedAt);
          } else {
            lastFleet.current = undefined; refresh(n => n + 1);
          }
        }
        setSelection(launch.selected);
      }
    };
    changed();
    return () => { changed = () => {}; };
  }, []);
  useEffect(() => {
    if (!ready || (!all && !scope)) return;
    let stopped = false, failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      if (snapshotInFlight.current) { timer = setTimeout(tick, 250); return; }
      if (document.hidden) { timer = setTimeout(tick, 5000); return; }
      hasStartedPoll.current = true; snapshotInFlight.current = true; setBusy(true);
      try {
        const includeFleet = lastFleet.current === undefined || performance.now() - lastFleet.current >= 30_000;
        const epoch = viewEpoch.current;
        const next = await call("dashboard_snapshot", { ...(all ? {} : { diagnosticScopeId: scope }), includeFleet, fleetCursor, cursor,
          ...(device ? { jobDevice: device, jobIdentity: identity, jobCursor } : {}) });
        if (stopped || epoch !== viewEpoch.current) return;
        hasCompletedPoll.current = true;
        setData(next); if (next.fleet) { setFleet(next.fleet.devices); setFleetPage(next.fleet); lastFleet.current = performance.now(); }
        setLastSuccess(next.observedAt); setError(""); failures = 0;
      } catch { if (!stopped) { setError("Connection unavailable. Displayed observations may be old; device and job state are unknown until refreshed."); failures++; } }
      finally { snapshotInFlight.current = false; if (!stopped) { setBusy(false); timer = setTimeout(tick, Math.min(60000, 5000 * 2 ** failures)); } }
    };
    // Allow the host's opener and its React state updates to settle together.
    // Only a started poll completes scheduling bootstrap; a timer can be cancelled by
    // the opener's scope update before the first request is needed.
    if (!hasStartedPoll.current && revision === 0) {
      timer = setTimeout(() => {
        const initialView = scope === (launch?.diagnosticScopeId ?? launch?.suggestedDiagnosticScopeId)
          && all === !launch?.diagnosticScopeId && !device && !cursor && !fleetCursor && !jobCursor;
        if (isSnapshot(launch) && initialView) timer = setTimeout(tick, 5000);
        else void tick();
      }, 250);
    } else timer = setTimeout(tick, 0);
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [ready, scope, all, device, identity, cursor, fleetCursor, jobCursor, revision]);
  useEffect(() => {
    lastDetailState.current = undefined;
    setDetailResult(undefined); setDetailError(""); setOutputError(""); setCopied(false); setCopyFallback("");
  }, [selection]);
  useEffect(() => {
    if (!selection || !ready) return;
    const selected = selection;
    let stopped = false, failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const followsJob = () => Boolean(selected.job && (lastDetailState.current === "running" || lastDetailState.current === "cancelling"));
    const tick = async () => {
      if (stopped || document.hidden) return;
      if (detailReads.current.has(selected)) { timer = setTimeout(tick, 250); return; }
      detailReads.current.add(selected);
      try {
        const value = await call("operation_inspect", { reference: selected });
        if (stopped) return;
        lastDetailState.current = value.observation?.state;
        setDetailResult(previous => ({
          reference: selected,
          value: previous?.reference === selected && previous.value.output ? { ...value, output: previous.value.output } : value,
        }));
        setDetailError("");
        failures = 0;
      } catch {
        if (stopped) return;
        setDetailError(lastDetailState.current
          ? "Latest observation unavailable. Showing the previous observation."
          : "Detail unavailable. Refresh detail to read the original record.");
        failures++;
      } finally {
        detailReads.current.delete(selected);
        const retryInitialRead = selected.job && !lastDetailState.current && failures > 0 && failures < 3;
        if (!stopped && (followsJob() || retryInitialRead)) timer = setTimeout(tick, Math.min(30_000, 5000 * 2 ** failures));
      }
    };
    const visible = () => {
      if (document.hidden || detailReads.current.has(selected) || (lastDetailState.current && !followsJob())) return;
      clearTimeout(timer);
      void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [selection, ready, detailRevision]);
  async function output(stream: string, offset = 0) {
    if (!selection?.job || busy) return;
    const reference = selection;
    setBusy(true);
    try {
      const result = await call("operation_inspect", { reference, output: { stream, offset, length: 4096 } });
      if (selectedRef.current === reference) {
        setDetailResult(previous => ({
          reference,
          value: previous?.reference === reference ? { ...previous.value, output: result.output } : result,
        }));
        setOutputError("");
      }
    } catch { if (selectedRef.current === reference) setOutputError("Output unavailable. Retry the read to continue at this page."); }
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
  useEffect(() => { if (ready && scope) void associate(); }, [ready, scope]);
  const operations = (all ? !data?.diagnosticScopeId : data?.diagnosticScopeId === scope) ? data?.operations?.items ?? [] : [];
  const coverage = data?.operations?.coverage;
  const jobs = data?.jobs?.device === device && data?.jobs?.identity === identity ? data.jobs : undefined;
  const disconnected = error.startsWith("Connection unavailable");
  return <main>
    <header><div><div className="eyebrow">REMOTE CONTROL</div><h1>Fleet & operations</h1><p>Read-only observations across your devices</p></div><button disabled={busy || !ready} onClick={() => { lastFleet.current = undefined; refresh(n => n + 1); }}>{busy ? "Refreshing…" : "Refresh"}</button></header>
    {!connected && <div className="notice">{bridgeError || "Connecting to the app host…"}</div>}
    {error && <div className="notice" role="alert">{error}</div>}
    <div className="freshness">Last successful refresh: {when(lastSuccess)} · Device probes carry their own observation times.</div>
    <section><h2>Fleet <small>{Array.isArray(fleetPage.devices) ? `${fleet.length} shown · ${fleetPage.totalConfigured ?? fleet.length} configured` : "Not observed yet"}</small></h2><div className="fleet-grid">{fleet.map(row => <button className={`device ${device === row.device ? "selected" : ""}`} key={row.device} onClick={() => { setDevice(row.device); setIdentity(row.identity ?? "root"); setJobCursor(undefined); }}>
      <div className="device-title">{row.device}<Badge value={row.probeSkipped === "manual_selection_required" ? "manual" : disconnected || !row.observedAt || Date.now() - Date.parse(row.observedAt) > 60_000 ? "stale" : row.connectivity ?? "unknown"}/></div><p>{row.identity ?? "Unselected identity"} · {disconnected ? "Last observed: " : ""}{row.readiness ?? "Readiness unknown"}</p>
      <div className="device-meta">
        <small>Configured: {row.configuredIdentities?.join(", ") ?? "Not reported"}</small>
        <small>{row.expectedAvailability === "manual" ? "Manual checks only · " : row.expectedAvailability === "intermittent" ? "Intermittent availability · " : ""}{when(row.observedAt)}</small>
        {row.runtime?.sha && <code title={row.runtime.sha}>{String(row.runtime.sha).slice(0, 12)}</code>}
      </div>
      {row.reason && <p className="muted">{row.reason}</p>}
    </button>)}</div>{fleet.length === 0 && <p>No fleet observations available.</p>}
      <div className="pagination"><button disabled={!fleetCursor || busy} onClick={() => { lastFleet.current = undefined; setFleetCursor(undefined); }}>First devices</button><button disabled={!fleetPage.nextCursor || busy} onClick={() => { lastFleet.current = undefined; setFleetCursor(fleetPage.nextCursor); }}>Next devices</button></div></section>
    <section><div className="section-title"><h2>{all ? "Observed operations" : "Associated operations"}</h2><label><input type="checkbox" checked={all} disabled={!scope} onChange={e => { setAll(e.target.checked); setCursor(undefined); }}/> All observed scopes</label></div>
      <div className="scope"><code>{scope ?? "All observed scopes"}</code><button disabled={!scope} onClick={associate}>Associate future operations</button></div>
      <p className="muted">Association is explicit. An empty view does not mean the conversation has no active work.</p>
      {coverage?.partial && <div className="notice">Partial observation history. {coverage.historyHasGaps ? "Older records were evicted. " : ""}{coverage.faults?.map(readable).join(", ")}</div>}
      {coverage?.oldestRetainedAt && coverage.newestRetainedAt && <p className="muted">Controller retention spans {timestamp(coverage.oldestRetainedAt)} to {timestamp(coverage.newestRetainedAt)}.</p>}
      <div className="table-wrap"><table><thead><tr><th>Operation</th><th>Association</th><th>Handler</th><th>Started</th><th>Observed duration</th><th>Jobs</th></tr></thead><tbody>{operations.map((op: Json) => <tr key={op.traceId}><td><button className="link" onClick={() => setSelection({ traceId: op.traceId })}>{op.tool}</button><code>{op.traceId.slice(0, 8)}</code></td><td>{op.diagnosticScopeId ? <code title={op.diagnosticScopeId}>{op.diagnosticScopeId === scope ? "This scope" : op.diagnosticScopeId.slice(0, 8)}</code> : <span>Unassociated</span>}</td><td><Badge value={op.state}/>{op.executionOutcome && <small>{op.executionOutcome}</small>}</td><td>{when(op.startedAt)}</td><td title="Controller time between first and latest recorded events; not workload runtime">{observedDuration(op)}</td><td>{op.jobCount}</td></tr>)}</tbody></table></div>
      {!operations.length && <p className="empty">No operations in this observed scope.</p>}
      <div className="pagination"><button disabled={!cursor} onClick={() => setCursor(undefined)}>Newest</button><button disabled={!data?.operations?.nextCursor} onClick={() => setCursor(data?.operations?.nextCursor)}>Older observations</button></div>
    </section>
    {device && <section><div className="section-title"><h2>Jobs · {device}</h2><select aria-label="Job execution identity" value={identity} onChange={e => { setIdentity(e.target.value); setJobCursor(undefined); }}><option value="root">Root / system</option><option value="owner">Owner</option><option value="interactive">Interactive</option></select></div>
      <DeviceDoctor key={device} device={device} identity={identity} ready={ready} disconnected={disconnected}/>
      <UsageCoverage key={JSON.stringify([device, identity])} device={device} identity={identity} ready={ready} call={call}/>
      <form className="scope" onSubmit={e => { e.preventDefault(); if (manualJob.trim()) setSelection({ job: { device, identity, jobId: manualJob.trim() } }); }}><input aria-label="Known job ID" placeholder="Known job ID" value={manualJob} maxLength={256} onChange={e => setManualJob(e.target.value)}/><button disabled={!manualJob.trim()}>Inspect job</button></form>
      {jobs?.partial && <div className="notice">Job history is incomplete or unavailable.</div>}
      {(jobs?.items ?? []).map((job: Json) => <button className="job-row" key={job.id} onClick={() => setSelection({ job: { device, identity, jobId: job.id } })}><code>{job.id}</code><Badge value={job.state ?? "unknown"}/>{job.lifecycleDiagnostics?.reviewRecommended && <span>Long running · review activity</span>}<span>{when(job.startedAt)}</span></button>)}
      <div className="pagination"><button disabled={!jobCursor} onClick={() => setJobCursor(undefined)}>Newest jobs</button><button disabled={!jobs?.nextCursor} onClick={() => setJobCursor(jobs?.nextCursor)}>Older jobs</button></div>
    </section>}
    {selection && <aside aria-label="Operation details"><div className="section-title"><h2>Details</h2><button onClick={() => refreshDetail(n => n + 1)}>Refresh detail</button><button onClick={() => setSelection(undefined)}>Close</button></div>
      {detailError && <div className="notice" role="status">{detailError}</div>}
      {outputError && <div className="notice" role="status">{outputError}</div>}
      {!detail && !detailError && <p>Reading observation…</p>}
      {detail && <><p className="muted">{detail.coverage}</p>{detail.observation ? <>
        <ObservationFacts observation={detail.observation} reference={detail.reference ?? selection}/>
        {detail.observation.lifecycleDiagnostics?.reviewRecommended && <div className="notice">{detail.observation.lifecycleDiagnostics.guidance}</div>}<p>Observed: {timestamp(detail.observedAt)}</p>
        {detail.observation.contextKeep && <p>ContextKeep task <code>{detail.observation.contextKeep.taskId}</code></p>}
        {detail.observation.events?.map((event: Json, i: number) => <div className="event" key={i}><time>{when(event.at)}</time><span>{event.stage.replaceAll("_", " ")}</span><small>{event.device} {event.identity}</small></div>)}
        {detail.observation.eventsPartial && <p className="notice">Additional stages were omitted by the observation limit.</p>}
        {detail.observation.nextDetailOffset != null && <button disabled={busy} onClick={async () => {
          const reference = selection; setBusy(true);
          try { const next = await call("operation_inspect", { reference, detailOffset: detail.observation.nextDetailOffset }); if (selectedRef.current === reference) setDetailResult({ reference, value: next }); }
          catch { if (selectedRef.current === reference) setDetailError("Detail page unavailable. The operation has not been retried."); }
          finally { setBusy(false); }
        }}>Next detail page</button>}
        {detail.observation.jobs?.map((job: Json) => <button className="job-row" key={JSON.stringify(job)} onClick={() => setSelection({ job })}>{job.device} · {job.identity}<code>{job.jobId}</code></button>)}
      </> : <p>Observation not retained. Inspect a known durable job reference; do not repeat the operation.</p>}
      {selection.job && <div className="pagination"><button disabled={busy} onClick={() => output("stdout")}>Read stdout</button><button disabled={busy} onClick={() => output("stderr")}>Read stderr</button></div>}
      {outputPage && <><pre>{String(outputPage.data ?? "")}</pre><button disabled={busy || !outputHasNext} onClick={() => output(outputPage.stream, outputPage.nextOffset)}>Next output page</button></>}
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
