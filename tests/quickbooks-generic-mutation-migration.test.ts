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

  it("adds a pre-readback Provider outcome checkpoint and recovery-only states", async () => {
    const sql = await readFile(new URL("../migrations/030_quickbooks_mutation_recovery.sql", import.meta.url), "utf8");
    expect(sql).toContain("provider_outcome_receipt");
    expect(sql).toContain("PROVIDER_OUTCOME_RECORDED");
    expect(sql).toContain("provider_entity_id IS NOT NULL AND jsonb_typeof(provider_outcome_receipt) = 'object'");
    expect(sql).toContain("WHERE state IN ('EXECUTING','PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','READBACK_MISMATCH')");
    expect(sql).toContain("quickbooks_mutation_provider_outcome_immutable_guard");
  });

  it("adds one durable execution attempt, lease fence, dispatch marker, and no-Id operator state", async () => {
    const sql = await readFile(new URL(
      "../migrations/033_quickbooks_mutation_execution_fencing.sql",
      import.meta.url,
    ), "utf8");
    for (const required of [
      "execution_attempt_id",
      "execution_claim_sequence",
      "execution_lease_token_hash",
      "execution_lease_until",
      "dispatch_started_at",
      "provider_outcome_recorded_at",
      "WRITE_RESULT_UNKNOWN_NO_ID",
      "operatorResolutionRequired",
      "automaticRearmAllowed",
      "quickbooks_mutation_execution_attempt_shape",
      "quickbooks_mutation_execution_attempt_immutable_guard",
    ]) {
      expect(sql).toContain(required);
    }
    expect(sql).toContain("LEGACY_EXECUTING_STATE_MIGRATED_FAIL_CLOSED");
    expect(sql).toContain("LEGACY_RECOVERY_WITHOUT_EXACT_ID_MIGRATED_FAIL_CLOSED");
    expect(sql).toContain("execution_lease_token_hash IS DISTINCT FROM OLD.execution_lease_token_hash");
    expect(sql).toContain("ON quickbooks_mutation_preparations (state, execution_lease_until)");
  });
});
