import type {
  CreateQuickBooksPostingInput,
  QuickBooksPostClaim,
  QuickBooksPostingRequest,
  QuickBooksPostingState,
} from "./models.js";
import type { QuickBooksBillSnapshot } from "../providers/quickbooksTypes.js";

export interface QuickBooksPostingRepository {
  createOrGet(input: CreateQuickBooksPostingInput): Promise<{ posting: QuickBooksPostingRequest; created: boolean }>;
  findActiveDuplicate(input: {
    actorId: string;
    realmId: string;
    sourceSha256: string;
    vendorId: string;
    docNumber?: string;
  }): Promise<QuickBooksPostingRequest | undefined>;
  get(postingRequestId: string): Promise<QuickBooksPostingRequest | undefined>;
  claimForApprovedPost(input: {
    postingRequestId: string;
    actorId: string;
    approvedPayloadHash: string;
    approvedBy: string;
    now: Date;
  }): Promise<QuickBooksPostClaim>;
  reject(input: {
    postingRequestId: string;
    actorId: string;
    rejectedBy: string;
    now: Date;
  }): Promise<QuickBooksPostingRequest>;
  completeVerified(input: {
    postingRequestId: string;
    bill: QuickBooksBillSnapshot;
    receipt: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksPostingRequest>;
  markFailure(
    postingRequestId: string,
    state: Extract<QuickBooksPostingState, "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION">,
    now: Date,
  ): Promise<void>;
}
