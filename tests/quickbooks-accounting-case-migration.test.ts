import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("QuickBooks Accounting Case migration", () => {
  it("defines immutable Case and operation tables, with historical ownership indexes replaced by shared references", async () => {
    const sql = await readFile(new URL("../migrations/027_quickbooks_accounting_case_foundation.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE quickbooks_accounting_cases");
    expect(sql).toContain("CREATE TABLE quickbooks_accounting_case_operations");
    expect(sql).toContain("quickbooks_accounting_case_immutable_guard");
    expect(sql).toContain("quickbooks_accounting_case_operation_preparation_uq");
    expect(sql).toContain("quickbooks_accounting_case_operation_mutation_uq");
    expect(sql).not.toMatch(/ON DELETE CASCADE/u);
  });

  it("allows cross-Case mutation references while preserving original authorization causality", async () => {
    const sql = await readFile(new URL(
      "../migrations/032_quickbooks_cross_case_authorization_causality.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).toContain("DROP INDEX IF EXISTS quickbooks_accounting_case_operation_preparation_uq");
    expect(sql).toContain("DROP INDEX IF EXISTS quickbooks_accounting_case_operation_mutation_uq");
    expect(sql).toContain("CREATE INDEX quickbooks_accounting_case_operation_preparation_idx");
    expect(sql).toContain("autonomous_authorization_evidence");
    expect(sql).toContain("QuickBooks autonomous Provider dispatch requires durable prior authorization evidence");
    expect(sql).toContain("QuickBooks cross-Case terminal replay requires deterministic reuse evidence");
    expect(sql).toContain("existing QuickBooks autonomous writes require external audit archive");
  });

  it("binds autonomous authorization evidence to its original standing-delegation claim", async () => {
    const sql = await readFile(new URL(
      "../migrations/034_quickbooks_autonomous_authorization_claim_binding.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).toContain("quickbooks_mutation_autonomous_authorization_claim_binding");
    expect(sql).toContain("approved_by = ('standing:' || (autonomous_authorization_evidence");
    expect(sql).toContain("can only be claimed by its original standing delegation");
    expect(sql).toContain("autonomous authorization claim history is inconsistent");
  });

  it("links every prepared Case operation to immutable preparation and source evidence hashes", async () => {
    const sql = await readFile(new URL(
      "../migrations/029_quickbooks_accounting_case_evidence_linkage.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).toContain("preparation_payload_hash");
    expect(sql).toContain("operation_source_evidence_hash");
    expect(sql).toContain("QuickBooks prepared Case operation requires linked payload and source evidence");
    expect(sql).toContain("migration 029 blocked: QuickBooks Accounting Case preparation evidence cannot be linked");
    expect(sql).toContain("quickbooks_accounting_case_preparation_fk");
    expect(sql).toContain("preparation.payload_hash = NEW.preparation_payload_hash");
    expect(sql).toContain("legacy QuickBooks Accounting Case requires external audit archive and controlled disposition");
  });

  it("binds a linked preparation to the same immutable Case actor and Realm", async () => {
    const sql = await readFile(new URL(
      "../migrations/031_quickbooks_accounting_case_preparation_identity.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).toContain("preparation.actor_id = case_row.actor_id");
    expect(sql).toContain("preparation.realm_id = NEW.realm_id");
    expect(sql).toContain("preparation.payload_hash = NEW.preparation_payload_hash");
  });

  it("re-arms only an MCP scope rejection with durable proof that Provider dispatch never started", async () => {
    const sql = await readFile(new URL(
      "../migrations/035_quickbooks_mcp_scope_predispatch_rearm.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).toContain("OLD.state='PROVIDER_REJECTED' AND NEW.state='PREPARED'");
    expect(sql).toContain("OLD.error_receipt->>'code'='FORBIDDEN'");
    expect(sql).toContain("OLD.error_receipt->'details'->>'failureLayer'='MCP_SCOPE'");
    expect(sql).toContain("'TRANSPORT_SCOPE_MISSING'");
    expect(sql).toContain("preparation.state='PREPARED'");
    expect(sql).toContain("preparation.execution_attempt_id IS NULL");
    expect(sql).toContain("preparation.dispatch_started_at IS NULL");
  });
  it("permits clearing authorization evidence only for a preparation that never reached the Provider", async () => {
    const sql = await readFile(new URL(
      "../migrations/036_quickbooks_expired_preparation_reseal.sql",
      import.meta.url,
    ), "utf8");
    // Every column that could record Provider contact must be NULL on both
    // sides, and evidence may only be cleared — never rewritten.
    expect(sql).toContain("NEW.autonomous_authorization_evidence IS NULL");
    for (const column of [
      "approved_by", "approved_at", "execution_attempt_id", "dispatch_started_at",
      "provider_entity_id", "provider_outcome_receipt", "write_receipt", "readback",
      "execution_resolution_receipt",
    ]) {
      expect(sql).toContain(`OLD.${column} IS NULL AND NEW.${column} IS NULL`);
    }
    expect(sql).toContain("OLD.state = 'PREPARED' AND NEW.state = 'PREPARED'");
    // The other three guards from 034 must survive untouched.
    expect(sql).toContain("QuickBooks autonomous authorization claim timestamp is immutable");
    expect(sql).toContain("requires durable prior authorization evidence");
    expect(sql).toContain("can only be claimed by its original standing delegation");
  });

  it("re-arms on durable no-dispatch evidence rather than on a mutable error receipt", async () => {
    const sql = await readFile(new URL(
      "../migrations/037_quickbooks_rearm_on_durable_evidence.sql",
      import.meta.url,
    ), "utf8");
    // The mutable proxy is gone.
    expect(sql).not.toContain("OLD.error_receipt->>'code'='FORBIDDEN'");
    expect(sql).not.toContain("'TRANSPORT_SCOPE_MISSING'");
    // The proof is not.
    expect(sql).toContain("OLD.state='PROVIDER_REJECTED' AND NEW.state='PREPARED'");
    for (const clause of [
      "OLD.provider_entity_id IS NULL", "OLD.authorization_receipt IS NULL",
      "OLD.write_receipt IS NULL", "OLD.readback IS NULL", "OLD.preparation_id IS NOT NULL",
      "preparation.state='PREPARED'", "preparation.provider_entity_id IS NULL",
      "preparation.provider_outcome_receipt IS NULL", "preparation.execution_attempt_id IS NULL",
      "preparation.dispatch_started_at IS NULL",
    ]) {
      expect(sql).toContain(clause);
    }
    // Every other immutability guard survives.
    for (const guard of [
      "QuickBooks Accounting Case operation is immutable",
      "QuickBooks preparation identity is immutable",
      "QuickBooks provider identity is immutable",
      "QuickBooks authorization receipt is immutable",
      "QuickBooks write receipt is immutable",
      "QuickBooks readback is immutable",
    ]) {
      expect(sql).toContain(guard);
    }
  });

});
