import type { IPty } from "node-pty";

// node-pty 1.1.0 normally enumerates console processes during kill(). After our
// verified root shutdown, that console no longer exists: its helper cannot attach,
// emits an exception, and leaves a five-second fallback timer. The tree was
// root is known stopped, so only native pseudoconsole/pipe cleanup remains.
// This helper does not assert whole-tree membership or termination.
// Keep node-pty's own cleanup and output-drain path; never filter stderr.
export function closeVerifiedWindowsPty(terminal: IPty): void {
  const agent = (terminal as unknown as { _agent?: {
    _useConpty?: boolean; _useConptyDll?: boolean;
    _getConsoleProcessList?: () => Promise<number[]>;
  } })._agent;
  if (agent?._useConpty && !agent._useConptyDll && typeof agent._getConsoleProcessList === "function") {
    agent._getConsoleProcessList = async () => [];
  }
  terminal.kill();
}
