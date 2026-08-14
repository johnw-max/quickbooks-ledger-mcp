import { describe, expect, it } from "vitest";
import {
  evaluateAutonomousLedgerWrite,
  type EvaluateAutonomousLedgerWriteInput,
  type LedgerAutonomousDenyReason,
  type LedgerStandingDelegation,
} from "../src/ledger-control/ledgerControlKernel.js";

const now = new Date("2026-08-13T04:00:00.000Z");
const delegation: LedgerStandingDelegation = {
  delegationId: "delegation-1", revision: 1, status: "ACTIVE", providerId: "quickbooks",
  workspaceId: "ws-1", agentId: "agent-1", installationId: "inst-1",
  tenantIds: ["9341457701636490"], actionIds: ["invoice.create"],
};
const base: EvaluateAutonomousLedgerWriteInput = {
  actionId: "invoice.create",
  canonicalPayloadHash: "a".repeat(64),
  sourceRevisionHash: "b".repeat(64),
  caseVersion: 1,
  principal: {
    actorId: "ws-1:user:user-1", workspaceId: "ws-1", agentId: "agent-1", installationId: "inst-1",
    bindingId: "bind-1", bindingRevision: 1, connectionId: "conn-1",
  },
  target: {
    providerId: "quickbooks", tenantId: "9341457701636490", targetSessionId: "session-1",
    targetSessionExpiresAt: new Date("2026-08-13T04:15:00.000Z"),
  },
  standingDelegations: [delegation],
  writeKillSwitchEnabled: true,
  staticActionReleased: true,
  transportScopeAllowed: true,
  providerAccessDenyReasons: [],
  providerCapabilityReceiptHash: "c".repeat(64),
  validation: { passed: true, receiptHash: "d".repeat(64) },
  now,
};
const denialCases: Array<[
  string,
  Partial<EvaluateAutonomousLedgerWriteInput>,
  LedgerAutonomousDenyReason,
]> = [
  ["kill switch", { writeKillSwitchEnabled: false }, "WRITE_KILL_SWITCH_DISABLED"],
  ["missing delegation", { standingDelegations: [] }, "STANDING_DELEGATION_MISSING"],
  ["wrong target", { standingDelegations: [{ ...delegation, tenantIds: ["999"] }] }, "STANDING_DELEGATION_TARGET_MISMATCH"],
  ["expired target", { target: { ...base.target as NonNullable<typeof base.target>, targetSessionExpiresAt: now } }, "TARGET_SESSION_EXPIRED"],
  ["invalid validation", { validation: { passed: false, reasonCodes: ["AMOUNT_MISMATCH"] } }, "DETERMINISTIC_VALIDATION_FAILED"],
];

describe("QuickBooks embedded Ledger Control Kernel", () => {
  it("issues a payload/case/target-bound standing delegation receipt", () => {
    const decision = evaluateAutonomousLedgerWrite(base);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("expected allow");
    expect(decision.receipt).toMatchObject({
      actionId: "invoice.create", tenantId: "9341457701636490", caseVersion: 1,
      delegationId: "delegation-1", canonicalPayloadHash: "a".repeat(64),
    });
    expect(decision.receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(denialCases)("fails closed for %s", (_label, change, expected) => {
    const decision = evaluateAutonomousLedgerWrite({ ...base, ...change });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected deny");
    expect(decision.denyReasons).toContain(expected);
  });
});
