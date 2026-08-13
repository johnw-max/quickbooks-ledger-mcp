import type { QuickBooksBillSnapshot, QuickBooksSupplierBillInput } from "../providers/quickbooksTypes.js";

export type QuickBooksPostingState =
  | "PREPARED"
  | "POSTING"
  | "WRITE_RESULT_UNKNOWN"
  | "POSTED_READBACK_VERIFIED"
  | "READBACK_MISMATCH"
  | "BLOCKED_VALIDATION"
  | "REJECTED";

export interface QuickBooksPreparedPayload extends Omit<QuickBooksSupplierBillInput, "requestId"> {
  clientRequestId: string;
  connectionRefSafe: string;
  boundTargetRefSafe: string;
  bindingRevision: string;
  sourceDigestProvenance?:
    | "AGENT_SUPPLIED_TEXT_FINGERPRINT"
    | "HOST_PROVIDED_ORIGINAL_FILE_SHA256"
    | "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256";
  sourceAttestationDigest?: string;
}

export interface QuickBooksPostingRequest {
  postingRequestId: string;
  actorId: string;
  realmId: string;
  clientRequestId: string;
  providerRequestId: string;
  sourceRef: string;
  sourceSha256: string;
  payload: QuickBooksPreparedPayload;
  payloadHash: string;
  state: QuickBooksPostingState;
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  qboBillId?: string;
  writeReceipt?: Record<string, unknown>;
  readback?: QuickBooksBillSnapshot;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateQuickBooksPostingInput {
  postingRequestId: string;
  actorId: string;
  realmId: string;
  providerRequestId: string;
  payload: QuickBooksPreparedPayload;
  payloadHash: string;
  now: Date;
}

export interface QuickBooksPostClaim {
  posting: QuickBooksPostingRequest;
  shouldPost: boolean;
}
