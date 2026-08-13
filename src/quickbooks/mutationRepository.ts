import type {
  CreateQuickBooksMutationPreparationInput,
  QuickBooksMutationClaim,
  QuickBooksMutationPreparation,
  QuickBooksMutationState,
} from "./mutationModels.js";

export interface QuickBooksMutationRepository {
  readiness(): Promise<boolean>;
  createOrGet(input: CreateQuickBooksMutationPreparationInput): Promise<{
    preparation: QuickBooksMutationPreparation;
    created: boolean;
  }>;
  get(preparationId: string): Promise<QuickBooksMutationPreparation | undefined>;
  saveReviewCsrf(input: {
    csrfHash: string;
    sessionHash: string;
    actorId: string;
    preparationId: string;
    expiresAt: Date;
  }): Promise<void>;
  claimForExecution(input: {
    preparationId: string;
    actorId: string;
    requestId: string;
    confirmationPhraseHash?: string;
    approvedBy: string;
    now: Date;
  }): Promise<QuickBooksMutationClaim>;
  claimForHumanReview(input: {
    preparationId: string;
    actorId: string;
    sessionHash: string;
    csrfHash: string;
    approvedBy: string;
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
  completeVerified(input: {
    preparationId: string;
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksMutationPreparation>;
  markFailure(
    preparationId: string,
    state: Extract<QuickBooksMutationState, "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION">,
    now: Date,
  ): Promise<void>;
}
