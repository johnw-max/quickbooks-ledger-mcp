import type {
  CreateQuickBooksMutationPreparationInput,
  QuickBooksMutationClaim,
  QuickBooksMutationPreparation,
  QuickBooksMutationState,
} from "./mutationModels.js";
import type { QuickBooksAutonomousAuthorizationEvidence } from "./autonomousAuthorizationEvidence.js";
import type { QuickBooksMutationExecutionReconciliation } from "./mutationExecutionAttempt.js";
import type { QuickBooksOperatorResolutionReceipt } from "./operatorResolution.js";

export interface QuickBooksMutationRepository {
  readiness(): Promise<boolean>;
  createOrGet(input: CreateQuickBooksMutationPreparationInput): Promise<{
    preparation: QuickBooksMutationPreparation;
    created: boolean;
  }>;
  get(preparationId: string): Promise<QuickBooksMutationPreparation | undefined>;
  recordAutonomousAuthorizationEvidence(input: {
    preparationId: string;
    actorId: string;
    evidence: QuickBooksAutonomousAuthorizationEvidence;
    now: Date;
  }): Promise<{ preparation: QuickBooksMutationPreparation; created: boolean }>;
  saveReviewCsrf(input: {
    csrfHash: string;
    sessionHash: string;
    actorId: string;
    preparationId: string;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Re-opens a preparation that expired without ever reaching the Provider, by
   * clearing its recorded authorization evidence so the caller must authorize
   * again. Returns undefined unless the row itself proves nothing was
   * dispatched — that is the case the expiry is genuinely protecting, and it
   * must keep failing.
   */
  resealNeverDispatchedPreparation(input: {
    preparationId: string;
    actorId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<QuickBooksMutationPreparation | undefined>;
  claimForExecution(input: {
    preparationId: string;
    actorId: string;
    requestId: string;
    confirmationPhraseHash?: string;
    approvedBy: string;
    leaseOwner: string;
    leaseTokenHash: string;
    leaseDurationMs: number;
    now: Date;
  }): Promise<QuickBooksMutationClaim>;
  claimForHumanReview(input: {
    preparationId: string;
    actorId: string;
    sessionHash: string;
    csrfHash: string;
    approvedBy: string;
    leaseOwner: string;
    leaseTokenHash: string;
    leaseDurationMs: number;
    now: Date;
  }): Promise<QuickBooksMutationClaim>;
  reject(input: {
    preparationId: string;
    actorId: string;
    rejectedBy: string;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  rejectFromHumanReview(input: {
    preparationId: string;
    actorId: string;
    sessionHash: string;
    csrfHash: string;
    rejectedBy: string;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  recordProviderOutcome(input: {
    preparationId: string;
    attemptId: string;
    leaseTokenHash: string;
    providerEntityId: string;
    providerOutcomeReceipt: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  markDispatchStarted(input: {
    preparationId: string;
    attemptId: string;
    leaseTokenHash: string;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  resolveUnknownNoId(input: {
    preparationId: string;
    attemptId: string;
    leaseTokenHash: string;
    resolutionReceipt: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  /**
   * Records an operator's attestation of what QuickBooks holds for a write
   * whose outcome was never known. It is a pure accretion: no state, no
   * Provider identity and no other receipt moves with it. Only a row that is
   * still WRITE_RESULT_UNKNOWN_NO_ID with no attestation may take one, and the
   * database enforces that independently (migration 038), so a drift between
   * this predicate and the guard surfaces as a 23514 rather than a silent write.
   */
  recordOperatorResolution(input: {
    preparationId: string;
    actorId: string;
    receipt: QuickBooksOperatorResolutionReceipt;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  releasePreDispatchLease(input: {
    preparationId: string;
    attemptId: string;
    leaseTokenHash: string;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  reconcileStaleExecutionAttempts(now: Date): Promise<QuickBooksMutationExecutionReconciliation>;
  completeVerified(input: {
    preparationId: string;
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  markFailure(input: {
    preparationId: string;
    attemptId: string;
    leaseTokenHash: string;
    providerRequestId: string;
    state: Extract<QuickBooksMutationState, "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION">;
    now: Date;
    resolutionReceipt?: Record<string, unknown>;
    /**
     * BLOCKED_VALIDATION asserts that QuickBooks' ledger holds nothing, so by
     * default it is refused once the dispatch marker is set: after dispatch the
     * caller normally cannot know. Set this only for a CONFIRMED_NOT_WRITTEN
     * outcome decided by the Provider adapter from a completed response cycle
     * (see classifyQuickBooksProviderWriteFailure). Anything less stays UNKNOWN.
     */
    providerConfirmedNotWritten?: boolean;
  }): Promise<void>;
}
