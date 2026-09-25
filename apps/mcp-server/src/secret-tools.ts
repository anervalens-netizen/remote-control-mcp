import { randomUUID } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient, AgentContext } from "./agent-client.ts";
import { SecretStore } from "./secret-store.ts";

const CHUNK_BYTES = 1024 * 1024;
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const structured = (value: Record<string, unknown>, textValue: unknown = value) => ({ content: [{ type: "text" as const, text: JSON.stringify(textValue) }], structuredContent: value });
const secretMetadataSchema = z.object({
  alias: z.string(),
  present: z.boolean(),
  bytes: z.number().int().nonnegative().optional(),
  updatedAt: z.string().optional(),
});

type RemoteStat = { size: number; isFile: boolean; modifiedAt?: string; dev?: number; ino?: number };
type RemoteInfo = { platform?: string };
type MoveResult = { atomic?: boolean; destinationAtomic?: boolean };
type Identity = "root" | "owner";

function identityContext(identity: Identity | undefined): AgentContext {
  return identity === "owner" ? "user" : "system";
}

function siblingTemporary(destination: string, platform: string | undefined): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(p.dirname(destination), `.rcmcp-secret-${randomUUID()}.tmp`);
}

async function installChunks(
  client: AgentClient,
  device: string,
  destination: string,
  context: AgentContext,
  chunks: AsyncIterable<Buffer>,
): Promise<{ device: string; destination: string; bytes: number; identity: Identity; atomic: boolean; destinationAtomic: boolean }> {
  const info = await client.info(device, context) as RemoteInfo;
  const temporary = siblingTemporary(destination, info.platform);
  let offset = 0;
  let wrote = false;
  try {
    for await (const chunk of chunks) {
      await client.fsWrite(device, {
        path: temporary,
        data: chunk.toString("base64"),
        encoding: "base64",
        mode: wrote ? "append" : "rewrite",
        createParents: !wrote,
        ...(!wrote ? { permissions: 0o600 } : {}),
      }, context);
      wrote = true;
      offset += chunk.length;
    }
    if (!wrote) await client.fsWrite(device, { path: temporary, data: "", mode: "rewrite", createParents: true, permissions: 0o600 }, context);
    const move = await client.fsManage(device, { operation: "move", path: temporary, destination, force: true }, context) as MoveResult;
    const destinationAtomic = move.destinationAtomic ?? move.atomic ?? false;
    return { device, destination, bytes: offset, identity: context === "user" ? "owner" : "root", atomic: destinationAtomic, destinationAtomic };
  } catch (error) {
    try { await client.fsManage(device, { operation: "delete", path: temporary, force: true }, context); } catch { /* best effort */ }
    throw error;
  }
  throw new Error("unreachable secret installation state");
}

export async function importRemoteSecret(
  client: AgentClient,
  store: SecretStore,
  input: { alias: string; sourceDevice: string; sourcePath: string; sourceIdentity?: Identity },
) {
  const context = identityContext(input.sourceIdentity);
  const before = await client.fsManage(input.sourceDevice, { operation: "stat", path: input.sourcePath }, context) as RemoteStat;
  if (!before.isFile) throw new Error(`Secret import source is not a file: ${input.sourcePath}`);

  const raw = await client.rawFile(input.sourceDevice, input.sourcePath, context);
  if (raw.size !== before.size) throw new Error(`Secret import source changed before streaming alias ${input.alias}`);
  if (before.modifiedAt && raw.modifiedAt && new Date(before.modifiedAt).toISOString() !== raw.modifiedAt) {
    throw new Error(`Secret import source timestamp changed before streaming alias ${input.alias}`);
  }

  async function* chunks() {
    let bytes = 0;
    for await (const chunk of raw.chunks) {
      bytes += chunk.length;
      yield chunk;
    }
    if (bytes !== raw.size) throw new Error(`Secret import source size changed while streaming alias ${input.alias}`);

    // This check happens before the generator completes, so SecretStore has not
    // committed the new alias yet. Rename/replacement and ordinary in-place
    // mutations therefore abort while the previous alias remains active.
    const after = await client.fsManage(input.sourceDevice, { operation: "stat", path: input.sourcePath }, context) as RemoteStat;
    const changedIdentity = before.dev !== undefined && after.dev !== undefined && before.dev !== after.dev
      || before.ino !== undefined && after.ino !== undefined && before.ino !== after.ino;
    const changedSize = after.size !== before.size;
    const changedMtime = before.modifiedAt !== undefined && after.modifiedAt !== undefined
      && new Date(before.modifiedAt).toISOString() !== new Date(after.modifiedAt).toISOString();
    if (changedIdentity || changedSize || changedMtime) {
      throw new Error(`Secret import source changed while streaming alias ${input.alias}; old alias retained`);
    }
  }

  const metadata = await store.putChunks(input.alias, chunks());
  return { ...metadata, importedFrom: { device: input.sourceDevice, identity: context === "user" ? "owner" : "root" } };
}

export async function installSecret(
  client: AgentClient,
  store: SecretStore,
  input: { alias: string; device: string; destination: string; identity?: Identity },
) {
  const metadata = await store.metadata(input.alias);
  if (!metadata.present) throw new Error(`Secret alias not found: ${input.alias}`);
  const installed = await installChunks(client, input.device, input.destination, identityContext(input.identity), store.chunks(input.alias));
  return { alias: input.alias, ...installed };
}

function templateAliases(template: string): string[] {
  const aliases = new Set<string>();
  for (const match of template.matchAll(/\{\{secret(?:_base64)?:([^}]+)\}\}/g)) aliases.add(match[1]!);
  return [...aliases];
}

export async function renderSecretTemplate(
  client: AgentClient,
  store: SecretStore,
  input: { device: string; destination: string; template: string; identity?: Identity },
) {
  const aliases = templateAliases(input.template);
  const values = new Map<string, Buffer>();
  for (const alias of aliases) values.set(alias, await store.read(alias));
  const rendered = input.template.replace(/\{\{secret(_base64)?:([^}]+)\}\}/g, (_match, base64: string | undefined, alias: string) => {
    const value = values.get(alias);
    if (!value) throw new Error(`Secret alias not found: ${alias}`);
    if (base64) return value.toString("base64");
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  });
  const buffer = Buffer.from(rendered, "utf8");
  async function* chunks() {
    for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) yield buffer.subarray(offset, offset + CHUNK_BYTES);
  }
  const installed = await installChunks(client, input.device, input.destination, identityContext(input.identity), chunks());
  return { aliases, ...installed };
}

export function registerSecretTools(server: McpServer, client: AgentClient, store = new SecretStore()): void {
  const alias = z.string().min(1);
  const identity = z.enum(["root", "owner"]).optional();

  server.registerTool("secret_status", {
    description: "Check whether a locally brokered secret alias exists. Never returns secret content.",
    inputSchema: { alias },
    outputSchema: secretMetadataSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ alias }) => structured(await store.metadata(alias) as Record<string, unknown>));

  server.registerTool("secret_list", {
    description: "List brokered secret aliases and metadata only; never returns secret content.",
    outputSchema: { secrets: z.array(secretMetadataSchema) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const secrets = await store.list();
    return structured({ secrets }, secrets);
  });

  server.registerTool("secret_import_file", {
    description: "Import an existing remote file into the secret broker by alias without returning its bytes to the model.",
    inputSchema: { alias, sourceDevice: z.string().min(1), sourcePath: z.string().min(1), sourceIdentity: identity },
  }, async (input) => text(await importRemoteSecret(client, store, input)));

  server.registerTool("secret_install", {
    description: "Install brokered secret bytes to any remote path using only an alias. Secret content stays inside MCP/agent transport.",
    inputSchema: { alias, device: z.string().min(1), destination: z.string().min(1), identity },
  }, async (input) => text(await installSecret(client, store, input)));

  server.registerTool("secret_template_render", {
    description: "Render {{secret:alias}} or {{secret_base64:alias}} placeholders internally and install the result without exposing secret values.",
    inputSchema: { device: z.string().min(1), destination: z.string().min(1), template: z.string(), identity },
  }, async (input) => text(await renderSecretTemplate(client, store, input)));

  server.registerTool("secret_rotate", {
    description: "Replace one broker alias atomically from another broker alias without exposing either value.",
    inputSchema: { alias, fromAlias: z.string().min(1) },
  }, async ({ alias, fromAlias }) => text(await store.put(alias, await store.read(fromAlias))));

  server.registerTool("secret_delete", {
    description: "Delete a brokered secret alias from the local broker store.",
    inputSchema: { alias },
    outputSchema: { alias: z.string(), deleted: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ alias }) => structured(await store.delete(alias) as Record<string, unknown>));
}
