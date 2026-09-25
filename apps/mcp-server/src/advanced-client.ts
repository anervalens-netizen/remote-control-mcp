import type { AgentClient, AgentContext } from "./agent-client.ts";

export const advancedClient = {
  search: (client: AgentClient, device: string, input: unknown, context: AgentContext = "system") => client.requestRoute(device, "/v1/search", input, context),
  searchStart: (client: AgentClient, device: string, input: unknown, context: AgentContext = "system") => client.requestRoute(device, "/v1/search/start", input, context),
  searchResults: (client: AgentClient, device: string, input: unknown, context: AgentContext = "system") => client.requestRoute(device, "/v1/search/results", input, context),
  searchStop: (client: AgentClient, device: string, input: unknown, context: AgentContext = "system") => client.requestRoute(device, "/v1/search/stop", input, context),
  searchRemove: (client: AgentClient, device: string, input: unknown, context: AgentContext = "system") => client.requestRoute(device, "/v1/search/remove", input, context),
  searchSessions: (client: AgentClient, device: string, context: AgentContext = "system") => client.requestRoute(device, "/v1/search/sessions", undefined, context),
  service: (client: AgentClient, device: string, input: unknown) => {
    const scope = (input as { scope?: AgentContext }).scope ?? "system";
    return client.service(device, input, scope);
  },
  logs: (client: AgentClient, device: string, input: unknown) => {
    const scope = (input as { scope?: AgentContext }).scope ?? "system";
    return client.serviceLogs(device, input, scope);
  },
  metrics: (client: AgentClient, device: string, context: AgentContext = "system", profile: "light" | "full" = "full") => client.requestRoute(device, `/v1/metrics?profile=${profile}`, undefined, context),
};
