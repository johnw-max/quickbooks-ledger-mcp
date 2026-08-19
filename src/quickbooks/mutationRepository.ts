import type {
  CreateQuickBooksMutationPreparationInput,
  QuickBooksMutationClaim,
  QuickBooksMutationPreparation,
  QuickBooksMutationState,
} from "./mutationModels.js";
import type { QuickBooksAutonomousAuthorizationEvidence } from "./autonomousAuthorizationEvidence.js";
import type { QuickBooksMutationExecutionReconciliation } from "./mutationExecutionAttempt.js";

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
  }): Promise<void>;
}
