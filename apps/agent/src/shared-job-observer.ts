/** One status sample/in-flight read per job per agent identity/state directory.
 * No output is cached: each subscriber reads its own bounded disk pages. */
export class SharedJobObserver<T> {
  private readonly entries = new Map<string, { subscribers: number; at: number; value?: T; pending?: Promise<T> }>();
  readonly counters = { polls: 0, joins: 0 };
  private readonly read: (id: string) => Promise<T>;
  private readonly intervalMs: number;
  private readonly maxSubscribers: number;
  constructor(read: (id: string) => Promise<T>, intervalMs = 200, maxSubscribers = 1024) { this.read = read; this.intervalMs = intervalMs; this.maxSubscribers = maxSubscribers; }
  acquire(id: string) {
    if ([...this.entries.values()].reduce((n, e) => n + e.subscribers, 0) >= this.maxSubscribers) throw new Error("Job observer capacity reached");
    let entry = this.entries.get(id);
    if (!entry) { entry = { subscribers: 0, at: -Infinity }; this.entries.set(id, entry); }
    entry.subscribers++; this.counters.joins++;
    const current = entry; let released = false;
    return {
      sample: async (): Promise<T> => {
        if (released) throw new Error("Job observer released");
        if (current.pending) return current.pending;
        if (current.value !== undefined && performance.now() - current.at < this.intervalMs) return current.value;
        this.counters.polls++;
        const pending = Promise.resolve().then(() => this.read(id));
        current.pending = pending;
        try { const value = await pending; current.value = value; current.at = performance.now(); return value; }
        finally { if (current.pending === pending) current.pending = undefined; }
      },
      release: () => {
        if (released) return;
        released = true;
        if (--current.subscribers === 0 && this.entries.get(id) === current) this.entries.delete(id);
      },
    };
  }
  snapshot() { return { ...this.counters, jobs: this.entries.size, subscribers: [...this.entries.values()].reduce((n, e) => n + e.subscribers, 0), maxSubscribers: this.maxSubscribers }; }
}
