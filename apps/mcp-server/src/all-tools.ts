import { registerBrowserTools } from "./browser-tools.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentClient } from "./agent-client.ts";
import { registerAdvancedTools } from "./advanced-tools.ts";
import { registerSearchSessionTools } from "./search-tools.ts";
import { registerTools as registerCoreTools } from "./tools.ts";
import { registerTransferTools } from "./transfer-tools.ts";
import { registerJobTools } from "./job-tools.ts";
import { registerHighLevelTools } from "./high-level-tools.ts";
import { registerDesktopTools } from "./desktop-tools.ts";
import { registerHostTools } from "./host-tools.ts";
import { registerSecretTools } from "./secret-tools.ts";
import { registerCapabilityTools } from "./capability-tools.ts";
import { registerRepoTools } from "./repo-tools.ts";
import { installDefaultToolOutputContracts } from "./tool-contract-defaults.ts";
import { registerAndroidTools } from "./android-tools.ts";

export function registerTools(server: McpServer, client: AgentClient): void {
  installDefaultToolOutputContracts(server);
  registerCoreTools(server, client);
  registerBrowserTools(server, client);
  registerAdvancedTools(server, client);
  registerSearchSessionTools(server, client);
  registerTransferTools(server, client);
  registerJobTools(server, client);
  registerHighLevelTools(server, client);
  registerDesktopTools(server, client);
  registerHostTools(server, client);
  registerSecretTools(server, client);
  registerCapabilityTools(server, client);
  registerRepoTools(server, client);
  registerAndroidTools(server, client);
}
