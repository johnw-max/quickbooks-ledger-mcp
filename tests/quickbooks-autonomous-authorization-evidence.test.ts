import { describe, expect, it } from "vitest";
import { issueDeterministicValidationReceipt } from "../src/ledger-control/deterministicValidation.js";
import { evaluateAutonomousLedgerWrite } from "../src/ledger-control/ledgerControlKernel.js";
import {
  issueQuickBooksAutonomousAuthorizationEvidence,
  issueQuickBooksMutationReuseEvidence,
  verifyQuickBooksAutonomousAuthorizationEvidence,
  verifyQuickBooksMutationReuseEvidence,
} from "../src/quickbooks/autonomousAuthorizationEvidence.js";

const now = new Date("2026-08-13T08:00:00.000Z");
const preparationId = `qbm_${"a".repeat(32)}`;
const providerRequestId = "zc.provider-request";
const stableOperationKey = "b".repeat(64);
const preparationPayloadHash = "c".repeat(64);
const canonicalPayloadHash = "d".repeat(64);
const sourceRevisionHash = "e".repeat(64);
const providerCapabilityReceiptHash = "f".repeat(64);

function evidenceFixture() {
  const validation = issueDeterministicValidationReceipt({
    actionId: "invoice.create",
    canonicalPayloadHash,
    sourceRevisionHash,
    caseId: "case-a",
    caseVersion: 1,
    policyVersion: "policy-v1",
    compilerVersion: "compiler-v1",
    checks: [{ code: "TEST", evidence: { passed: true } }],
    now,
  });
  const decision = evaluateAutonomousLedgerWrite({
    actionId: "invoice.create",
    canonicalPayloadHash,
    sourceRevisionHash,
    caseVersion: 1,
    principal: {
      actorId: "actor-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      installationId: "installation-1",
      bindingId: "binding-1",
      bindingRevision: 1,
      connectionId: "connection-1",
    },
    target: {
      providerId: "quickbooks",
      tenantId: "9341457701636490",
      targetSessionId: "target-session-1",
      targetSessionExpiresAt: new Date("2026-08-13T08:15:00.000Z"),
    },
    standingDelegations: [{
      delegationId: "delegation-1",
      revision: 1,
      status: "ACTIVE",
      providerId: "quickbooks",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      installationId: "installation-1",
      tenantIds: ["9341457701636490"],
      actionIds: ["invoice.create"],
    }],
    writeKillSwitchEnabled: true,
    staticActionReleased: true,
    transportScopeAllowed: true,
    providerAccessDenyReasons: [],
    providerCapabilityReceiptHash,
    validation: { passed: true, receiptHash: validation.receiptHash },
    now,
  });
  if (!decision.allowed) throw new Error("expected authorization");
  const evidence = issueQuickBooksAutonomousAuthorizationEvidence({
    preparationId,
    providerRequestId,
    stableOperationKey,
    actionId: "invoice.create",
    preparationPayloadHash,
    canonicalPayloadHash,
    caseId: "case-a",
    caseVersion: 1,
    sourceRevisionHash,
    deterministicValidationReceipt: validation,
    authorizationReceipt: decision.receipt,
    recordedAt: now,
  });
  const reuseValidation = issueDeterministicValidationReceipt({
    actionId: "invoice.create",
    canonicalPayloadHash,
    sourceRevisionHash,
    caseId: "case-b",
    caseVersion: 1,
    policyVersion: "policy-v1",
    compilerVersion: "compiler-v1",
    checks: [{ code: "TEST", evidence: { passed: true } }],
    now,
  });
  return { validation, reuseValidation, evidence };
}

describe("QuickBooks autonomous authorization causal evidence", () => {
  it("verifies one original authorization and a Case-specific deterministic reuse receipt", () => {
    const { reuseValidation, evidence } = evidenceFixture();
    const expected = {
      preparationId,
      providerRequestId,
      stableOperationKey,
      actionId: "invoice.create",
      actorId: "actor-1",
      realmId: "9341457701636490",
      preparationPayloadHash,
      canonicalPayloadHash,
    };
    expect(verifyQuickBooksAutonomousAuthorizationEvidence(evidence, expected))
      .toMatchObject({
        originCaseId: "case-a",
        authorizationIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });

    const reuse = issueQuickBooksMutationReuseEvidence({
      authorizationEvidence: evidence,
      providerEntityId: "9001",
      stableOperationKey,
      actionId: "invoice.create",
      canonicalPayloadHash,
      caseId: "case-b",
      caseVersion: 1,
      sourceRevisionHash,
      deterministicValidationReceipt: reuseValidation,
      currentDelegationId: "delegation-1",
      currentDelegationRevision: 1,
      currentProviderCapabilityReceiptHash: providerCapabilityReceiptHash,
      issuedAt: now,
    });
    expect(verifyQuickBooksMutationReuseEvidence(reuse, {
      authorizationEvidence: evidence,
      providerEntityId: "9001",
      stableOperationKey,
      actionId: "invoice.create",
      canonicalPayloadHash,
      caseId: "case-b",
      caseVersion: 1,
      sourceRevisionHash,
      deterministicValidationReceiptHash: reuseValidation.receiptHash,
    })).toEqual(reuse);
  });

  it("rejects tampering with either the original authorization or the current Case reuse identity", () => {
    const { reuseValidation, evidence } = evidenceFixture();
    const tampered = structuredClone(evidence);
    tampered.authorizationReceipt.tenantId = "9999999999999999";
    expect(verifyQuickBooksAutonomousAuthorizationEvidence(tampered, {
      preparationId,
      providerRequestId,
      stableOperationKey,
      actionId: "invoice.create",
      actorId: "actor-1",
      realmId: "9341457701636490",
      preparationPayloadHash,
      canonicalPayloadHash,
    })).toBeUndefined();

    const reuse = issueQuickBooksMutationReuseEvidence({
      authorizationEvidence: evidence,
      providerEntityId: "9001",
      stableOperationKey,
      actionId: "invoice.create",
      canonicalPayloadHash,
      caseId: "case-b",
      caseVersion: 1,
      sourceRevisionHash,
      deterministicValidationReceipt: reuseValidation,
      currentDelegationId: "delegation-1",
      currentDelegationRevision: 1,
      currentProviderCapabilityReceiptHash: providerCapabilityReceiptHash,
      issuedAt: now,
    });
    expect(verifyQuickBooksMutationReuseEvidence({ ...reuse, caseId: "case-c" }, {
      authorizationEvidence: evidence,
      providerEntityId: "9001",
      stableOperationKey,
      actionId: "invoice.create",
      canonicalPayloadHash,
      caseId: "case-b",
      caseVersion: 1,
      sourceRevisionHash,
      deterministicValidationReceiptHash: reuseValidation.receiptHash,
    })).toBeUndefined();
  });
});
