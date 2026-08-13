import { AppError } from "../errors.js";
import { safeEqual } from "../security/hash.js";
import type {
  CreateQuickBooksPostingInput,
  QuickBooksPostClaim,
  QuickBooksPostingRequest,
  QuickBooksPostingState,
} from "./models.js";
import type { QuickBooksPostingRepository } from "./repository.js";

function copy(posting: QuickBooksPostingRequest): QuickBooksPostingRequest {
  return structuredClone(posting);
}

export class InMemoryQuickBooksPostingRepository implements QuickBooksPostingRepository {
  readonly #postings = new Map<string, QuickBooksPostingRequest>();
  readonly #requestIndex = new Map<string, string>();

  async createOrGet(input: CreateQuickBooksPostingInput): Promise<{
    posting: QuickBooksPostingRequest;
    created: boolean;
  }> {
    const requestKey = `${input.actorId}:${input.realmId}:${input.payload.clientRequestId}`;
    const existingId = this.#requestIndex.get(requestKey);
    if (existingId) {
      const existing = this.#postings.get(existingId);
      if (!existing) throw new Error("QuickBooks posting index is corrupt");
      return { posting: copy(existing), created: false };
    }
    const active = new Set<QuickBooksPostingState>(["PREPARED", "POSTING", "WRITE_RESULT_UNKNOWN", "POSTED_READBACK_VERIFIED"]);
    const normalizedDocNumber = input.payload.docNumber?.trim().toLocaleLowerCase("en-US");
    const companyDuplicate = [...this.#postings.values()].find((candidate) =>
      candidate.realmId === input.realmId && active.has(candidate.state) && (
        candidate.sourceSha256 === input.payload.sourceSha256 || (
          normalizedDocNumber !== undefined && candidate.payload.vendorId === input.payload.vendorId &&
          candidate.payload.docNumber?.trim().toLocaleLowerCase("en-US") === normalizedDocNumber
        )
      )
    );
    if (companyDuplicate) return { posting: copy(companyDuplicate), created: false };
    const posting: QuickBooksPostingRequest = {
      postingRequestId: input.postingRequestId,
      actorId: input.actorId,
      realmId: input.realmId,
      clientRequestId: input.payload.clientRequestId,
      providerRequestId: input.providerRequestId,
      sourceRef: input.payload.sourceRef,
      sourceSha256: input.payload.sourceSha256,
      payload: structuredClone(input.payload),
      payloadHash: input.payloadHash,
      state: "PREPARED",
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.#postings.set(posting.postingRequestId, posting);
    this.#requestIndex.set(requestKey, posting.postingRequestId);
    return { posting: copy(posting), created: true };
  }

  async findActiveDuplicate(input: {
    actorId: string;
    realmId: string;
    sourceSha256: string;
    vendorId: string;
    docNumber?: string;
  }): Promise<QuickBooksPostingRequest | undefined> {
    const active = new Set<QuickBooksPostingState>(["PREPARED", "POSTING", "WRITE_RESULT_UNKNOWN", "POSTED_READBACK_VERIFIED"]);
    const normalizedDocNumber = input.docNumber?.trim().toLocaleLowerCase("en-US");
    const posting = [...this.#postings.values()].find((candidate) =>
      candidate.realmId === input.realmId && active.has(candidate.state) && (
        candidate.sourceSha256 === input.sourceSha256 || (
          normalizedDocNumber !== undefined && candidate.payload.vendorId === input.vendorId &&
          candidate.payload.docNumber?.trim().toLocaleLowerCase("en-US") === normalizedDocNumber
        )
      )
    );
    return posting ? copy(posting) : undefined;
  }

  async get(postingRequestId: string): Promise<QuickBooksPostingRequest | undefined> {
    const posting = this.#postings.get(postingRequestId);
    return posting ? copy(posting) : undefined;
  }

  async claimForApprovedPost(input: {
    postingRequestId: string;
    actorId: string;
    approvedPayloadHash: string;
    approvedBy: string;
    now: Date;
  }): Promise<QuickBooksPostClaim> {
    const posting = this.#postings.get(input.postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "QuickBooks posting request was not found.", { httpStatus: 404 });
    if (!safeEqual(posting.actorId, input.actorId)) {
      throw new AppError("FORBIDDEN", "QuickBooks posting belongs to another actor.", { httpStatus: 403 });
    }
    if (!safeEqual(posting.payloadHash, input.approvedPayloadHash)) {
      throw new AppError("APPROVAL_INVALID", "Approved QuickBooks payload hash does not match the prepared bill.", {
        httpStatus: 409,
      });
    }
    if (posting.state === "POSTED_READBACK_VERIFIED") return { posting: copy(posting), shouldPost: false };
    if (posting.state === "POSTING") {
      throw new AppError("CONFLICT", "QuickBooks posting is already in progress.", { httpStatus: 409, retryable: true });
    }
    if (!["PREPARED", "WRITE_RESULT_UNKNOWN"].includes(posting.state)) {
      throw new AppError("APPROVAL_INVALID", `QuickBooks posting cannot be approved from ${posting.state}.`, {
        httpStatus: 409,
      });
    }
    posting.state = "POSTING";
    posting.approvedBy = input.approvedBy;
    posting.approvedAt = posting.approvedAt ?? input.now;
    posting.updatedAt = input.now;
    return { posting: copy(posting), shouldPost: true };
  }

  async reject(input: {
    postingRequestId: string;
    actorId: string;
    rejectedBy: string;
    now: Date;
  }): Promise<QuickBooksPostingRequest> {
    const posting = this.#postings.get(input.postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "QuickBooks posting request was not found.", { httpStatus: 404 });
    if (!safeEqual(posting.actorId, input.actorId)) {
      throw new AppError("FORBIDDEN", "QuickBooks posting belongs to another actor.", { httpStatus: 403 });
    }
    if (posting.state === "REJECTED") return copy(posting);
    if (posting.state !== "PREPARED") {
      throw new AppError("CONFLICT", `QuickBooks posting cannot be rejected from ${posting.state}.`, { httpStatus: 409 });
    }
    posting.state = "REJECTED";
    posting.rejectedBy = input.rejectedBy;
    posting.rejectedAt = input.now;
    posting.updatedAt = input.now;
    return copy(posting);
  }

  async completeVerified(input: {
    postingRequestId: string;
    bill: QuickBooksPostingRequest["readback"] extends infer T ? Exclude<T, undefined> : never;
    receipt: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksPostingRequest> {
    const posting = this.#postings.get(input.postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "QuickBooks posting request was not found.", { httpStatus: 404 });
    if (posting.state === "POSTED_READBACK_VERIFIED") return copy(posting);
    if (posting.state !== "POSTING") {
      throw new AppError("CONFLICT", `QuickBooks posting cannot complete from ${posting.state}.`, { httpStatus: 409 });
    }
    posting.state = "POSTED_READBACK_VERIFIED";
    posting.qboBillId = input.bill.billId;
    posting.writeReceipt = structuredClone(input.receipt);
    posting.readback = structuredClone(input.bill);
    posting.updatedAt = input.now;
    return copy(posting);
  }

  async markFailure(
    postingRequestId: string,
    state: Extract<QuickBooksPostingState, "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION">,
    now: Date,
  ): Promise<void> {
    const posting = this.#postings.get(postingRequestId);
    if (!posting) return;
    if (posting.state === "POSTED_READBACK_VERIFIED") return;
    posting.state = state;
    posting.updatedAt = now;
  }
}
