import type {
  QuickBooksExecutionMode,
  QuickBooksProviderEffect,
  QuickBooksWritableEntity,
  QuickBooksWriteOperation,
  QuickBooksWriteRisk,
} from "./writePolicy.js";

export type QuickBooksMutationState =
  | "PREPARED"
  | "EXECUTING"
  | "WRITE_RESULT_UNKNOWN"
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
  writeReceipt?: Record<string, unknown>;
  readback?: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
}

export interface CreateQuickBooksMutationPreparationInput extends Omit<
  QuickBooksMutationPreparation,
  "state" | "approvedBy" | "approvedAt" | "rejectedBy" | "rejectedAt" |
  "providerEntityId" | "writeReceipt" | "readback" | "createdAt" | "updatedAt"
> {
  now: Date;
}

export interface QuickBooksMutationClaim {
  preparation: QuickBooksMutationPreparation;
  shouldExecute: boolean;
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
