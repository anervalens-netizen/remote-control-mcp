export type DockerSnapshot = {
  available: boolean;
  version: unknown;
  containers: Array<Record<string, unknown>>;
  images: unknown[];
  compose: Array<Record<string, unknown>>;
  errors: string[];
};

export function summarizeDockerSnapshot(
  snapshot: DockerSnapshot,
  input: { query?: string; state?: "all" | "running" | "stopped"; limit?: number } = {},
) {
  const containers = snapshot.containers ?? [];
  const running = containers.filter((item) => String(item.State ?? "").toLowerCase() === "running");
  const unhealthy = running.filter((item) => String(item.Status ?? "").toLowerCase().includes("unhealthy"));
  const q = input.query?.toLowerCase();
  const state = input.state ?? "all";
  const filtered = containers.filter((item) => {
    const itemState = String(item.State ?? "").toLowerCase();
    if (state === "running" && itemState !== "running") return false;
    if (state === "stopped" && itemState === "running") return false;
    if (q && !JSON.stringify(item).toLowerCase().includes(q)) return false;
    return true;
  });
  const limit = Math.max(1, Math.min(input.limit ?? 25, 200));
  return {
    available: snapshot.available,
    containers: {
      total: containers.length,
      running: running.length,
      stopped: containers.length - running.length,
      unhealthy: unhealthy.map((item) => item.Names),
    },
    images: snapshot.images?.length ?? 0,
    compose: (snapshot.compose ?? []).map((item) => ({ name: item.Name, status: item.Status })),
    errors: snapshot.errors ?? [],
    filter: { query: input.query ?? null, state },
    matched: filtered.length,
    returned: Math.min(filtered.length, limit),
    matches: filtered.slice(0, limit).map((item) => ({
      name: item.Names ?? null,
      image: item.Image ?? null,
      state: item.State ?? null,
      status: item.Status ?? null,
      ports: item.Ports ?? null,
    })),
  };
}


export function filterProcesses(items: Array<Record<string, unknown>>, input: { query?: string; pid?: number; limit?: number }) {
  const q = input.query?.toLowerCase();
  const matches = items.filter((item) => {
    if (input.pid !== undefined && Number(item.pid ?? item.ProcessId ?? 0) !== input.pid) return false;
    return !q || JSON.stringify(item).toLowerCase().includes(q);
  });
  const limit = Math.max(1, Math.min(input.limit ?? 25, 200));
  return { matched: matches.length, returned: Math.min(matches.length, limit), processes: matches.slice(0, limit) };
}
