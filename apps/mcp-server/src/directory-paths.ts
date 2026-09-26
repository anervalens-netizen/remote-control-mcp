import path from "node:path";
import type { AgentClient, AgentContext, AgentRequestOptions } from "./agent-client.ts";
import { OperationReceiptError } from "./operation-receipt-error.ts";

type HostInfo = { platform?: string; hostname?: string };
export function overlappingPaths(source: string, destination: string, platform?: string): boolean {
  const api = platform === "win32" ? path.win32 : path.posix;
  const contains = (a: string, b: string) => {
    const relative = api.relative(a, b);
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + api.sep) && !api.isAbsolute(relative));
  };
  return contains(source, destination) || contains(destination, source);
}

export async function validateDirectorySeparation(client: AgentClient, input: {
  sourceDevice: string; sourcePath: string; destinationDevice: string; destinationPath: string;
}, sourceInfo: HostInfo, destinationInfo: HostInfo, sourceContext: AgentContext, destinationContext: AgentContext, options: AgentRequestOptions) {
  let sameHost = input.sourceDevice.toLowerCase() === input.destinationDevice.toLowerCase();
  // Shared configured endpoints establish aliases. A hostname alone does not:
  // separate machines can share an OS hostname or a reverse-proxy hostname.
  if (!sameHost && typeof client.getDevice === "function") {
    const endpoints = (name: string) => {
      const device = client.getDevice(name);
      return [device.url, device.userUrl, device.desktopUrl].filter((url): url is string => Boolean(url))
        .map(url => new URL(url).href.replace(/\/$/, ""));
    };
    const destinationEndpoints = new Set(endpoints(input.destinationDevice));
    sameHost = endpoints(input.sourceDevice).some(url => destinationEndpoints.has(url));
  }
  if (!sameHost) return;
  const [source, destination] = await Promise.all([
    client.fsManage(input.sourceDevice, { operation: "resolve-path", path: input.sourcePath }, sourceContext, options),
    client.fsManage(input.destinationDevice, { operation: "resolve-path", path: input.destinationPath }, destinationContext, options),
  ]) as Array<{ resolvedPath?: unknown }>;
  const api = sourceInfo.platform === "win32" ? path.win32 : path.posix;
  if (typeof source?.resolvedPath !== "string" || !api.isAbsolute(source.resolvedPath)
    || typeof destination?.resolvedPath !== "string" || !api.isAbsolute(destination.resolvedPath)) {
    throw new Error("Same-host directory synchronization requires agent path resolution; update the participating agents before retrying");
  }
  if (overlappingPaths(source.resolvedPath, destination.resolvedPath, sourceInfo.platform)) {
    throw new OperationReceiptError("Source and destination directory trees overlap; no destination mutation was requested", {
      code: "directory_sync_overlap", phase: "preflight", destinationMutationAttempted: false,
      resolvedSource: source.resolvedPath, resolvedDestination: destination.resolvedPath,
    });
  }
}
