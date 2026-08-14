import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("QuickBooks production startup readiness", () => {
  it("runs migrations and strict repository readiness before opening a listener", async () => {
    const source = await readFile(new URL("../src/quickbooks/server.ts", import.meta.url), "utf8");
    const migration = source.indexOf("await runQuickBooksMigrations");
    const startupReadiness = source.indexOf("startupReadiness = await runtimeReadiness()");
    const startupReconciliation = source.indexOf("await reconcileExecutionAttempts()");
    const listener = source.indexOf("app.listen(config.port, config.host)");
    expect(migration).toBeGreaterThan(0);
    expect(startupReadiness).toBeGreaterThan(migration);
    expect(startupReconciliation).toBeGreaterThan(startupReadiness);
    expect(listener).toBeGreaterThan(startupReconciliation);
    expect(listener).toBeGreaterThan(startupReadiness);
    expect(source).toContain("if (!startupReadiness.ready)");
    expect(source).toContain("legacyCompilerRows");
    expect(source).toContain("setInterval(() =>");
    expect(source).toContain("clearInterval(executionReconciler)");
  });

  it("pins migration files with SHA-256 checksums and rejects an applied-file mismatch", async () => {
    const source = await readFile(new URL("../src/quickbooks/migrate.ts", import.meta.url), "utf8");
    expect(source).toContain("checksum_sha256");
    expect(source).toContain("sha256(sql)");
    expect(source).toContain("migration checksum mismatch");
    expect(source).not.toContain("UPDATE schema_migrations SET checksum_sha256");
  });
});
