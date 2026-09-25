// Cold-import the pinned production dependency graph before restarting agents.
// Run as the same owner/SYSTEM context and from the production checkout.
const modules = ["fastify", "cross-spawn", "node-pty", "playwright-core", "zod", "@modelcontextprotocol/sdk/server/mcp.js"];
const checks = [];
for (const name of modules) {
  try { await import(name); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) }); }
}
const ok = checks.every(check => check.ok);
console.log(JSON.stringify({ ok, node: process.version, platform: process.platform, checks }, null, 2));
if (!ok) process.exitCode = 1;
