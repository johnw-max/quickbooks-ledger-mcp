import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("QuickBooks Accounting Case migration", () => {
  it("defines immutable Case and operation tables with unique execution identities", async () => {
    const sql = await readFile(new URL("../migrations/027_quickbooks_accounting_case_foundation.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE quickbooks_accounting_cases");
    expect(sql).toContain("CREATE TABLE quickbooks_accounting_case_operations");
    expect(sql).toContain("quickbooks_accounting_case_immutable_guard");
    expect(sql).toContain("quickbooks_accounting_case_operation_preparation_uq");
    expect(sql).toContain("quickbooks_accounting_case_operation_mutation_uq");
    expect(sql).not.toMatch(/ON DELETE CASCADE/u);
  });
});
