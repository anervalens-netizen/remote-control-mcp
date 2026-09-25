import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Android lifecycle and CI contracts", () => {
  it("runs Android CI when shared Android protocol/controller surfaces change", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/android.yml"), "utf8");
    for (const required of [
      "apps/mcp-server/src/android-*.ts",
      "apps/mcp-server/src/index.ts",
      "packages/protocol/src/android.ts",
      "tests/android-*.test.ts",
    ]) {
      expect(workflow.split("'" + required + "'").length - 1).toBe(2);
    }
  });

  it("stops Android control before forcing long-lived MCP HTTP sessions closed", () => {
    const source = readFileSync(path.join(root, "apps/mcp-server/src/index.ts"), "utf8");
    const androidClose = source.indexOf("await androidController?.close()");
    const httpClose = source.indexOf("http.close(() => resolve())");
    const forceClose = source.indexOf("http.closeAllConnections()");
    expect(androidClose).toBeGreaterThan(-1);
    expect(httpClose).toBeGreaterThan(androidClose);
    expect(forceClose).toBeGreaterThan(httpClose);
    expect(source).toContain("closing ??=");
    expect(source).toContain("try {");
    expect(source).toContain("} finally {");
  });
});
