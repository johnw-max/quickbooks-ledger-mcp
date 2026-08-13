import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("QuickBooks generic mutation migration", () => {
  it("persists immutable target, risk, request, receipt and readback evidence", async () => {
    const sql = await readFile(new URL("../migrations/025_quickbooks_generic_mutations.sql", import.meta.url), "utf8");
    for (const required of [
      "quickbooks_mutation_preparations",
      "connection_ref_safe",
      "bound_target_ref_safe",
      "binding_revision",
      "execution_mode",
      "provider_effect",
      "provider_request_id",
      "payload_hash",
      "confirmation_phrase_hash",
      "provider_entity_id",
      "write_receipt",
      "readback",
      "WRITE_RESULT_UNKNOWN",
      "POSTED_READBACK_VERIFIED",
    ]) {
      expect(sql).toContain(required);
    }
    expect(sql).toContain("UNIQUE (actor_id, realm_id, entity, operation, client_request_id)");
    expect(sql).toContain("operation IN ('UPDATE','DELETE') AND target_id IS NOT NULL AND sync_token IS NOT NULL");
    expect(sql).toContain("state = 'POSTED_READBACK_VERIFIED' AND provider_entity_id IS NOT NULL");
    expect(sql).toContain("state = 'REJECTED' AND approved_by IS NULL");
  });

  it("adds durable proof for verified WorkStore source attestations", async () => {
    const sql = await readFile(new URL("../migrations/026_quickbooks_source_attestation.sql", import.meta.url), "utf8");
    expect(sql).toContain("source_attestation_digest");
    expect(sql).toContain("^[a-f0-9]{64}$");
    expect(sql).toContain("repeat('0', 64)");
  });
});
