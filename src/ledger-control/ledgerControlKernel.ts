import { hashObject } from "../security/hash.js";

export const LEDGER_CONTROL_KERNEL_VERSION = "0.2.0";

export const LEDGER_AUTONOMOUS_DENY_REASONS = [
  "WRITE_KILL_SWITCH_DISABLED",
  "STATIC_ACTION_NOT_RELEASED",
  "TRANSPORT_SCOPE_MISSING",
  "TARGET_SESSION_REQUIRED",
  "TARGET_SESSION_EXPIRED",
  "TARGET_BINDING_INVALID",
  "PROVIDER_CAPABILITY_RECEIPT_MISSING",
  "PROVIDER_ACCESS_DENIED",
  "STANDING_DELEGATION_MISSING",
  "STANDING_DELEGATION_AMBIGUOUS",
  "STANDING_DELEGATION_REVOKED",
  "STANDING_DELEGATION_EXPIRED",
  "STANDING_DELEGATION_TARGET_MISMATCH",
  "STANDING_DELEGATION_ACTION_MISMATCH",
  "DETERMINISTIC_VALIDATION_FAILED",
] as const;

export type LedgerAutonomousDenyReason = typeof LEDGER_AUTONOMOUS_DENY_REASONS[number];

export interface LedgerOperationPrincipal {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installationId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connectionId: string;
}

export interface LedgerOperationTarget {
  readonly providerId: string;
  readonly tenantId: string;
  readonly targetSessionId: string;
  readonly targetSessionExpiresAt: Date;
}

/** Business authority configured at installation/connection time. */
export interface LedgerStandingDelegation {
  readonly delegationId: string;
  readonly revision: number;
  readonly status: "ACTIVE" | "REVOKED";
  readonly providerId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installationId?: string;
  readonly tenantIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly expiresAt?: Date;
}

export interface LedgerDeterministicValidation {
  readonly passed: boolean;
  readonly receiptHash?: string;
  readonly reasonCodes?: readonly string[];
}

export interface EvaluateAutonomousLedgerWriteInput {
  readonly actionId: string;
  readonly canonicalPayloadHash: string;
  readonly sourceRevisionHash: string;
  readonly caseVersion: number;
  readonly principal: LedgerOperationPrincipal;
  readonly target?: LedgerOperationTarget;
  readonly standingDelegations: readonly LedgerStandingDelegation[];
  readonly writeKillSwitchEnabled: boolean;
  readonly staticActionReleased: boolean;
  readonly transportScopeAllowed: boolean;
  readonly providerAccessDenyReasons: readonly string[];
  readonly providerCapabilityReceiptHash?: string;
  readonly validation: LedgerDeterministicValidation;
  readonly now: Date;
}

export interface LedgerAutonomousAuthorizationReceipt {
  readonly receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION";
  readonly kernelVersion: string;
  readonly actionId: string;
  readonly providerId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installationId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connectionId: string;
  readonly targetSessionId: string;
  readonly delegationId: string;
  readonly delegationRevision: number;
  readonly canonicalPayloadHash: string;
  readonly sourceRevisionHash: string;
  readonly caseVersion: number;
  readonly deterministicValidationReceiptHash: string;
  readonly providerCapabilityReceiptHash: string;
  readonly issuedAt: string;
  readonly receiptHash: string;
}

export type LedgerAutonomousAuthorizationDecision = Readonly<
  | {
      allowed: false;
      denyReasons: readonly LedgerAutonomousDenyReason[];
      providerAccessDenyReasons: readonly string[];
      validationReasonCodes: readonly string[];
    }
  | {
      allowed: true;
      denyReasons: readonly LedgerAutonomousDenyReason[];
      providerAccessDenyReasons: readonly string[];
      validationReasonCodes: readonly string[];
      delegation: LedgerStandingDelegation;
      receipt: LedgerAutonomousAuthorizationReceipt;
    }
>;

/**
 * A reuse decision proves that the current Case may reference an already
 * authorized durable mutation. It intentionally has no authorization receipt:
 * only the decision that preceded the original Provider dispatch may own one.
 */
export type LedgerAutonomousReuseDecision = Readonly<
  | {
      allowed: false;
      denyReasons: readonly LedgerAutonomousDenyReason[];
      providerAccessDenyReasons: readonly string[];
      validationReasonCodes: readonly string[];
    }
  | {
      allowed: true;
      denyReasons: readonly LedgerAutonomousDenyReason[];
      providerAccessDenyReasons: readonly string[];
      validationReasonCodes: readonly string[];
      delegation: LedgerStandingDelegation;
    }
>;

function exactNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function validPrincipal(principal: LedgerOperationPrincipal): boolean {
  return exactNonEmpty(principal.actorId) && exactNonEmpty(principal.workspaceId) &&
    exactNonEmpty(principal.agentId) && exactNonEmpty(principal.installationId) &&
    exactNonEmpty(principal.bindingId) && Number.isSafeInteger(principal.bindingRevision) &&
    principal.bindingRevision > 0 && exactNonEmpty(principal.connectionId);
}

function validTarget(target: LedgerOperationTarget): boolean {
  return exactNonEmpty(target.providerId) && exactNonEmpty(target.tenantId) &&
    exactNonEmpty(target.targetSessionId) && target.targetSessionExpiresAt instanceof Date &&
    Number.isFinite(target.targetSessionExpiresAt.getTime());
}

function matchingSubject(delegation: LedgerStandingDelegation, input: EvaluateAutonomousLedgerWriteInput): boolean {
  return delegation.providerId === input.target?.providerId &&
    delegation.workspaceId === input.principal.workspaceId &&
    delegation.agentId === input.principal.agentId &&
    (delegation.installationId === undefined || delegation.installationId === input.principal.installationId);
}

function buildReceipt(
  input: EvaluateAutonomousLedgerWriteInput & { target: LedgerOperationTarget },
  delegation: LedgerStandingDelegation,
): LedgerAutonomousAuthorizationReceipt {
  const unsigned = {
    receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION" as const,
    kernelVersion: LEDGER_CONTROL_KERNEL_VERSION,
    actionId: input.actionId,
    providerId: input.target.providerId,
    tenantId: input.target.tenantId,
    actorId: input.principal.actorId,
    workspaceId: input.principal.workspaceId,
    agentId: input.principal.agentId,
    installationId: input.principal.installationId,
    bindingId: input.principal.bindingId,
    bindingRevision: input.principal.bindingRevision,
    connectionId: input.principal.connectionId,
    targetSessionId: input.target.targetSessionId,
    delegationId: delegation.delegationId,
    delegationRevision: delegation.revision,
    canonicalPayloadHash: input.canonicalPayloadHash,
    sourceRevisionHash: input.sourceRevisionHash,
    caseVersion: input.caseVersion,
    deterministicValidationReceiptHash: input.validation.receiptHash as string,
    providerCapabilityReceiptHash: input.providerCapabilityReceiptHash as string,
    issuedAt: input.now.toISOString(),
  };
  return Object.freeze({ ...unsigned, receiptHash: hashObject(unsigned) });
}

function evaluateAutonomousLedgerAuthority(
  input: EvaluateAutonomousLedgerWriteInput,
): LedgerAutonomousReuseDecision {
  const denyReasons: LedgerAutonomousDenyReason[] = [];
  if (!input.writeKillSwitchEnabled) denyReasons.push("WRITE_KILL_SWITCH_DISABLED");
  if (!input.staticActionReleased) denyReasons.push("STATIC_ACTION_NOT_RELEASED");
  if (!input.transportScopeAllowed) denyReasons.push("TRANSPORT_SCOPE_MISSING");
  if (!input.target) {
    denyReasons.push("TARGET_SESSION_REQUIRED");
  } else {
    if (!validPrincipal(input.principal) || !validTarget(input.target)) denyReasons.push("TARGET_BINDING_INVALID");
    if (input.target.targetSessionExpiresAt.getTime() <= input.now.getTime()) denyReasons.push("TARGET_SESSION_EXPIRED");
  }
  if (input.providerAccessDenyReasons.length > 0) denyReasons.push("PROVIDER_ACCESS_DENIED");
  if (!exactNonEmpty(input.providerCapabilityReceiptHash)) denyReasons.push("PROVIDER_CAPABILITY_RECEIPT_MISSING");
  if (!input.validation.passed || !exactNonEmpty(input.validation.receiptHash)) {
    denyReasons.push("DETERMINISTIC_VALIDATION_FAILED");
  }

  const subjectDelegations = input.standingDelegations.filter((delegation) => matchingSubject(delegation, input));
  if (subjectDelegations.length === 0) denyReasons.push("STANDING_DELEGATION_MISSING");
  if (subjectDelegations.length > 1) denyReasons.push("STANDING_DELEGATION_AMBIGUOUS");
  const delegation = subjectDelegations.length === 1 ? subjectDelegations[0] : undefined;
  if (delegation) {
    if (delegation.status !== "ACTIVE") denyReasons.push("STANDING_DELEGATION_REVOKED");
    if (delegation.expiresAt && delegation.expiresAt.getTime() <= input.now.getTime()) {
      denyReasons.push("STANDING_DELEGATION_EXPIRED");
    }
    if (!input.target || !delegation.tenantIds.includes(input.target.tenantId)) {
      denyReasons.push("STANDING_DELEGATION_TARGET_MISMATCH");
    }
    if (!delegation.actionIds.includes(input.actionId)) denyReasons.push("STANDING_DELEGATION_ACTION_MISMATCH");
  }

  if (denyReasons.length > 0 || !delegation || !input.target || !input.validation.receiptHash ||
      !input.providerCapabilityReceiptHash) {
    return Object.freeze({
      allowed: false,
      denyReasons: Object.freeze([...new Set(denyReasons)]),
      providerAccessDenyReasons: Object.freeze([...input.providerAccessDenyReasons]),
      validationReasonCodes: Object.freeze([...(input.validation.reasonCodes ?? [])]),
    });
  }
  return Object.freeze({
    allowed: true,
    denyReasons: Object.freeze([]),
    providerAccessDenyReasons: Object.freeze([]),
    validationReasonCodes: Object.freeze([]),
    delegation,
  });
}

/** Evaluate current authority for a read-only reference to an existing write. */
export function evaluateAutonomousLedgerReuse(
  input: EvaluateAutonomousLedgerWriteInput,
): LedgerAutonomousReuseDecision {
  return evaluateAutonomousLedgerAuthority(input);
}

/** Provider-neutral, fail-closed authority intersection for one ledger write. */
export function evaluateAutonomousLedgerWrite(
  input: EvaluateAutonomousLedgerWriteInput,
): LedgerAutonomousAuthorizationDecision {
  const authority = evaluateAutonomousLedgerAuthority(input);
  if (!authority.allowed) return authority;
  if (!input.target) {
    return Object.freeze({
      allowed: false,
      denyReasons: Object.freeze(["TARGET_SESSION_REQUIRED"] as LedgerAutonomousDenyReason[]),
      providerAccessDenyReasons: Object.freeze([...input.providerAccessDenyReasons]),
      validationReasonCodes: Object.freeze([...(input.validation.reasonCodes ?? [])]),
    });
  }
  return Object.freeze({
    allowed: true,
    denyReasons: Object.freeze([]),
    providerAccessDenyReasons: Object.freeze([]),
    validationReasonCodes: Object.freeze([]),
    delegation: authority.delegation,
    receipt: buildReceipt(
      input as EvaluateAutonomousLedgerWriteInput & { target: LedgerOperationTarget },
      authority.delegation,
    ),
  });
}
