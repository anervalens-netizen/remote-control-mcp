import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** One persistent subprocess, correlated JSON lines, sequential execution and no action replay. */
export class DesktopHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private pending: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private starts = 0;
  private completed = 0;
  private lastError: string | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly options: SpawnOptionsWithoutStdio;
  constructor(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
    this.command = command; this.args = args; this.options = options;
  }
  status() {
    return { running: this.child !== null, pid: this.child?.pid ?? null, busy: this.pending !== null, starts: this.starts, completed: this.completed, lastError: this.lastError };
  }
  close() { this.closed = true; this.fail(this.child, new Error('Desktop helper closed')); }
  private fail(child: ChildProcessWithoutNullStreams | null, error: Error) {
    if (this.child !== child) return;
    this.lastError = error.message;
    this.child = null;
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    child?.stdin.destroy();
    if (child && child.exitCode === null) child.kill();
  }
  private start() {
    if (this.closed) throw new Error('Desktop helper closed');
    if (this.child) return this.child;
    const child = spawn(this.command, this.args, { ...this.options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.starts++;
    let output = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', (error) => this.fail(child, new Error('Desktop helper process error: ' + error.message)));
    child.stdin.on('error', (error) => this.fail(child, new Error('Desktop helper write error: ' + error.message)));
    child.on('close', (code, signal) => this.fail(child, new Error(`Desktop helper exited before response (${code ?? signal})${stderr ? ': ' + stderr : ''}; action was not replayed`)));
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      output += chunk;
      if (output.length > 64 * 1024 * 1024) { this.fail(child, new Error('Desktop helper response exceeded 64 MiB; action was not replayed')); return; }
      let index: number;
      while ((index = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, index).trim(); output = output.slice(index + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          const pending = this.pending;
          if (!pending || response.id !== pending.id || typeof response.ok !== 'boolean') throw new Error('Uncorrelated desktop helper response');
          // Decode before releasing pending so malformed output rejects this request.
          const value = response.ok && response.stdout?.trim() ? JSON.parse(response.stdout) : null;
          this.pending = null; clearTimeout(pending.timer);
          if (response.ok) { this.completed++; pending.resolve(value); }
          else { this.lastError = String(response.error ?? 'Desktop request failed'); pending.reject(new Error(this.lastError)); }
        } catch (error) { this.fail(child, error instanceof Error ? error : new Error(String(error))); return; }
      }
    });
    return child;
  }
  request(script: string, input?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const task = () => {
      const child = this.start();
      const id = randomUUID();
      const payload = JSON.stringify({ id, script, input }) + '\n';
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(child, new Error(`Desktop helper request timed out after ${timeoutMs}ms; action was not replayed`)), timeoutMs);
        this.pending = { id, resolve, reject, timer };
        child.stdin.write(payload, 'utf8', (error) => { if (error) this.fail(child, error); });
      });
    };
    const result = this.queue.then(task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const desktopHelperPowerShell = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
while(($line=[Console]::In.ReadLine()) -ne $null){
  if([string]::IsNullOrWhiteSpace($line)){continue}
  $request=$null
  try {
    $request=$line|ConvertFrom-Json
    $block=[ScriptBlock]::Create('param($RcmcpInput)' + [Environment]::NewLine + [string]$request.script)
    $output=& $block $request.input | Out-String -Width 2147483647
    $response=@{id=[string]$request.id;ok=$true;stdout=([string]$output).Trim()}
  } catch {
    $response=@{id=if($request){[string]$request.id}else{$null};ok=$false;error=$_.Exception.Message}
  }
  [Console]::Out.WriteLine(($response|ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
  $request=$null;$block=$null;$output=$null;$response=$null;$line=$null
}
`;
