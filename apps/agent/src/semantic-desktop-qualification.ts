import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SemanticManifest } from "../../../packages/protocol/src/semantic-desktop.ts";
import { semanticSession } from "./semantic-desktop-env.ts";
import { SemanticDesktop } from "./semantic-desktop.ts";

const gtkFixture = `import gi,os,json
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,GLib
GLib.set_prgname(os.environ['RCMCP_FIXTURE_NAME'])
w=Gtk.Window(title=os.environ['RCMCP_FIXTURE_NAME']);w.set_default_size(360,150);w.set_accept_focus(False)
b=Gtk.Box(orientation=Gtk.Orientation.VERTICAL);w.add(b)
entry=Gtk.Entry();entry.get_accessible().set_name('RCMCP verification input');entry.set_text('before');b.pack_start(entry,True,True,0)
button=Gtk.Button(label='RCMCP verification button');b.pack_start(button,True,True,0)
def clicked(_):
 p=os.path.join(os.environ['RCMCP_FIXTURE_DIR'],'clicked.txt')
 with open(p,'a') as f:f.write('click\\n')
button.connect('clicked',clicked);w.connect('destroy',Gtk.main_quit);w.show_all()
with open(os.path.join(os.environ['RCMCP_FIXTURE_DIR'],'ready.json'),'w') as f:json.dump({'ready':True},f)
GLib.timeout_add_seconds(90,lambda: (Gtk.main_quit(),False)[1]);Gtk.main()
`;
const windowsFixture = String.raw`Add-Type -AssemblyName System.Windows.Forms
$form=[Windows.Forms.Form]::new();$form.Text=$env:RCMCP_FIXTURE_NAME;$form.Width=360;$form.Height=180
$input=[Windows.Forms.TextBox]::new();$input.AccessibleName='RCMCP verification input';$input.Text='before';$input.Width=300;$input.Top=10
$button=[Windows.Forms.Button]::new();$button.Text='RCMCP verification button';$button.AccessibleName=$button.Text;$button.Width=300;$button.Top=50
$button.Add_Click({[IO.File]::AppendAllText((Join-Path $env:RCMCP_FIXTURE_DIR 'clicked.txt'),"click\n")})
$form.Controls.AddRange(@($input,$button));$form.Show()
[IO.File]::WriteAllText((Join-Path $env:RCMCP_FIXTURE_DIR 'ready.json'),'{}')
$timer=[Windows.Forms.Timer]::new();$timer.Interval=90000;$timer.Add_Tick({$form.Close()});$timer.Start()
[Windows.Forms.Application]::Run($form)
`;
function named(value: any, name: string): any {
  if (!value || typeof value !== "object") return undefined;
  if (value.name === name && value.ref_id) return value;
  for (const child of Object.values(value)) { const found = named(child, name); if (found) return found; }
}
export async function qualifySemanticDesktop(manifest: SemanticManifest) {
  const session = await semanticSession();
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-semantic-qualification-"));
  const name = `rcmcp-verification-${randomUUID().slice(0, 8)}`;
  const windows = process.platform === "win32";
  const script = path.join(root, windows ? "fixture.ps1" : "fixture.py");
  await writeFile(script, windows ? windowsFixture : gtkFixture);
  const child = spawn(windows ? "powershell.exe" : "python3", windows ? ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", script] : [script], { env: { ...session.env, RCMCP_FIXTURE_NAME: name, RCMCP_FIXTURE_DIR: root }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.on("error", () => {});
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { try { await readFile(path.join(root, "ready.json")); ready = true; break; } catch {} if (child.exitCode !== null) break; await delay(100); }
    if (!ready) throw new Error(`qualification_fixture_unavailable: ${stderr}`);
    const backend = new SemanticDesktop({ root: path.join(root, "state"), manifest: () => manifest });
    let window: any;
    for (let i = 0; i < 20; i++) {
      const windowsResult = await backend.observe({ kind: "windows" });
      const list = windowsResult.data?.windows ?? windowsResult.data;
      window = (Array.isArray(list) ? list : []).find((item: any) => item.title === name || item.name === name);
      if (window?.id) break;
      await delay(150);
    }
    if (!window?.id) throw new Error("qualification_window_not_found");
    const scope = { windowId: window.id, ...(window.app_name ? { app: window.app_name } : {}) };
    const observation = await backend.observe({ ...scope, skeleton: false, maxDepth: 12, timeoutMs: 10000 });
    const entry = named(observation.data, "RCMCP verification input"), button = named(observation.data, "RCMCP verification button");
    if (!observation.ok || !entry || !button) throw new Error(`qualification_controls_missing: ${JSON.stringify(observation).slice(0, 1500)}`);
    const value = `verified-${randomUUID().slice(0, 8)}`;
    const write = await backend.act({ commandId: randomUUID(), observationId: observation.observationId, ref: entry.ref_id, action: "set-value", value, observeAfter: false });
    if (!write.ok) throw new Error(`qualification_set_value_failed: ${JSON.stringify(write)}`);
    const read = await backend.observe({ kind: "get", observationId: observation.observationId, ref: entry.ref_id, property: "value" });
    if (!read.ok || !JSON.stringify(read.data).includes(value)) throw new Error("qualification_value_readback_failed");
    const fresh = await backend.observe({ ...scope, skeleton: false, maxDepth: 12, timeoutMs: 10000 });
    const nextButton = named(fresh.data, "RCMCP verification button");
    if (!nextButton) throw new Error("qualification_button_missing");
    const clickInput = { commandId: randomUUID(), observationId: fresh.observationId, ref: nextButton.ref_id, action: "click", observeAfter: false };
    const clicked = await backend.act(clickInput);
    if (!clicked.ok) throw new Error(`qualification_click_failed: ${JSON.stringify(clicked)}`);
    let marker = "";
    for (let i = 0; i < 30; i++) { try { marker = await readFile(path.join(root, "clicked.txt"), "utf8"); if (marker) break; } catch {} await delay(100); }
    const recovered = await new SemanticDesktop({ root: path.join(root, "state"), manifest: () => manifest }).act(clickInput);
    await delay(150);
    const after = await readFile(path.join(root, "clicked.txt"), "utf8");
    if (!marker || after !== marker || !recovered.recovered) throw new Error("qualification_no_replay_failed");
    return { ok: true, engineVersion: manifest.engineVersion, jsonVersion: manifest.jsonVersion, valueReadback: true, clickEffect: true, recoveredWithoutReplay: true, verifiedAt: new Date().toISOString() };
  } finally {
    child.kill(); await Promise.race([closed, delay(3000)]);
    if (child.exitCode !== null || child.signalCode !== null) await rm(root, { recursive: true, force: true });
  }
}
