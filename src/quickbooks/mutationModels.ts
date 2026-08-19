import type {
  QuickBooksExecutionMode,
  QuickBooksProviderEffect,
  QuickBooksWritableEntity,
  QuickBooksWriteOperation,
  QuickBooksWriteRisk,
} from "./writePolicy.js";
import type { QuickBooksAutonomousAuthorizationEvidence } from "./autonomousAuthorizationEvidence.js";
import type { QuickBooksMutationExecutionAttempt } from "./mutationExecutionAttempt.js";
import type { QuickBooksOperatorResolutionReceipt } from "./operatorResolution.js";

export type QuickBooksMutationState =
  | "PREPARED"
  | "EXECUTING"
  | "PROVIDER_OUTCOME_RECORDED"
  | "WRITE_RESULT_UNKNOWN"
  | "WRITE_RESULT_UNKNOWN_NO_ID"
  | "POSTED_READBACK_VERIFIED"
  | "READBACK_MISMATCH"
  | "BLOCKED_VALIDATION"
  | "REJECTED";

export interface QuickBooksMutationPreparation {
  preparationId: string;
  actorId: string;
  realmId: string;
  connectionRefSafe: string;
  boundTargetRefSafe: string;
  bindingRevision: string;
  entity: QuickBooksWritableEntity;
  operation: QuickBooksWriteOperation;
  risk: QuickBooksWriteRisk;
  executionMode: QuickBooksExecutionMode;
  providerEffect: QuickBooksProviderEffect;
  clientRequestId: string;
  providerRequestId: string;
  targetId?: string;
  syncToken?: string;
  beforeImage?: Record<string, unknown>;
  payload: Record<string, unknown>;
  payloadHash: string;
  businessReason: string;
  sourceRef?: string;
  sourceSha256?: string;
  sourceDigestProvenance?:
    | "AGENT_SUPPLIED_TEXT_FINGERPRINT"
    | "HOST_PROVIDED_ORIGINAL_FILE_SHA256"
    | "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256";
  sourceAttestationDigest?: string;
  approvalRef?: string;
  confirmationPhraseHash: string;
  state: QuickBooksMutationState;
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  providerEntityId?: string;
  /** Immutable authorization that causally preceded the first Provider dispatch. */
  autonomousAuthorizationEvidence?: QuickBooksAutonomousAuthorizationEvidence;
  executionAttempt?: QuickBooksMutationExecutionAttempt;
  /**
   * An operator's attestation of what QuickBooks actually holds, recorded only
   * from WRITE_RESULT_UNKNOWN_NO_ID. It accretes beside the execution
   * resolution receipt and never amends it: the row keeps saying the outcome
   * was unknown, and gains what a person found when they looked.
   */
  operatorResolutionReceipt?: QuickBooksOperatorResolutionReceipt;
  providerOutcomeReceipt?: Record<string, unknown>;
  writeReceipt?: Record<string, unknown>;
  readback?: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
}

export interface CreateQuickBooksMutationPreparationInput extends Omit<
  QuickBooksMutationPreparation,
  "state" | "approvedBy" | "approvedAt" | "rejectedBy" | "rejectedAt" |
  "providerEntityId" | "providerOutcomeReceipt" | "writeReceipt" | "readback" | "createdAt" | "updatedAt"
  | "autonomousAuthorizationEvidence"
  | "executionAttempt"
  | "operatorResolutionReceipt"
> {
  now: Date;
}

export interface QuickBooksMutationClaim {
  preparation: QuickBooksMutationPreparation;
  shouldExecute: boolean;
  recoveryOnly: boolean;
}

export interface QuickBooksMutationExecutionResult {
  preparationId: string;
  state: "POSTED_READBACK_VERIFIED";
  entity: QuickBooksWritableEntity;
  operation: QuickBooksWriteOperation;
  providerEntityId: string;
  receipt: Record<string, unknown>;
  readback: Record<string, unknown>;
  idempotentReplay: boolean;
}
