export const QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS = 120_000;

export type QuickBooksMutationExecutionAttemptState =
  | "CLAIMED"
  | "DISPATCH_STARTED"
  | "PROVIDER_OUTCOME_RECORDED"
  | "WRITE_RESULT_UNKNOWN_NO_ID"
  | "RESOLVED_NO_WRITE"
  | "READBACK_VERIFIED";

/**
 * Durable fencing evidence for the only Provider-dispatch attempt permitted for
 * one immutable mutation preparation. A stale pre-dispatch worker may transfer
 * the lease (and increment claimSequence), but dispatchStartedAt is a one-way
 * boundary: after it is present, automatic re-arming and a second POST are
 * forbidden.
 */
export interface QuickBooksMutationExecutionAttempt {
  attemptId: string;
  claimSequence: number;
  state: QuickBooksMutationExecutionAttemptState;
  leaseOwner: string;
  /** Hash only; the bearer token remains process-local to the claiming worker. */
  leaseTokenHash: string;
  leaseUntil: Date;
  dispatchStartedAt?: Date;
  providerOutcomeRecordedAt?: Date;
  resolutionReceipt?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuickBooksMutationExecutionReconciliation {
  stalePreDispatchReclaimable: number;
  transitionedToUnknownNoId: number;
  oldestStaleAt?: Date;
}

export function unknownNoIdResolutionReceipt(input: {
  attemptId: string;
  providerRequestId: string;
  reasonCode: "STALE_AFTER_DISPATCH" | "DISPATCH_OUTCOME_NOT_CHECKPOINTED";
  resolvedAt: Date;
  providerEntityIdHint?: string;
}): Record<string, unknown> {
  return Object.freeze({
    evidenceType: "QUICKBOOKS_EXECUTION_RESOLUTION",
    evidenceVersion: "1.0",
    resolution: "WRITE_RESULT_UNKNOWN_NO_ID",
    attemptId: input.attemptId,
    providerRequestId: input.providerRequestId,
    reasonCode: input.reasonCode,
    providerMutationPossible: true,
    automaticRearmAllowed: false,
    operatorResolutionRequired: true,
    recoveryAction: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
    ...(input.providerEntityIdHint ? { providerEntityIdHint: input.providerEntityIdHint } : {}),
    resolvedAt: input.resolvedAt.toISOString(),
  });
}

export function resolvedNoWriteReceipt(input: {
  attemptId: string;
  providerRequestId: string;
  reasonCode: string;
  resolvedAt: Date;
}): Record<string, unknown> {
  return Object.freeze({
    evidenceType: "QUICKBOOKS_EXECUTION_RESOLUTION",
    evidenceVersion: "1.0",
    resolution: "RESOLVED_NO_WRITE",
    attemptId: input.attemptId,
    providerRequestId: input.providerRequestId,
    reasonCode: input.reasonCode,
    providerMutationPossible: false,
    automaticRearmAllowed: false,
    resolvedAt: input.resolvedAt.toISOString(),
  });
}
