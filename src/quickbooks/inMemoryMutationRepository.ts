import { AppError } from "../errors.js";
import { safeEqual } from "../security/hash.js";
import type {
  CreateQuickBooksMutationPreparationInput,
  QuickBooksMutationClaim,
  QuickBooksMutationPreparation,
  QuickBooksMutationState,
} from "./mutationModels.js";
import type { QuickBooksMutationRepository } from "./mutationRepository.js";

function copy(value: QuickBooksMutationPreparation): QuickBooksMutationPreparation {
  return structuredClone(value);
}

export class InMemoryQuickBooksMutationRepository implements QuickBooksMutationRepository {
  readonly #preparations = new Map<string, QuickBooksMutationPreparation>();
  readonly #requestIndex = new Map<string, string>();
  readonly #reviewCsrf = new Map<string, {
    sessionHash: string; actorId: string; preparationId: string; expiresAt: Date; consumed: boolean;
  }>();

  async readiness() {
    return true;
  }

  async createOrGet(input: CreateQuickBooksMutationPreparationInput) {
    const key = `${input.actorId}:${input.realmId}:${input.entity}:${input.operation}:${input.clientRequestId}`;
    const existingId = this.#requestIndex.get(key);
    if (existingId) {
      const existing = this.#preparations.get(existingId);
      if (!existing) throw new Error("QuickBooks mutation request index is corrupt");
      return { preparation: copy(existing), created: false };
    }
    const preparation: QuickBooksMutationPreparation = {
      preparationId: input.preparationId,
      actorId: input.actorId,
      realmId: input.realmId,
      connectionRefSafe: input.connectionRefSafe,
      boundTargetRefSafe: input.boundTargetRefSafe,
      bindingRevision: input.bindingRevision,
      entity: input.entity,
      operation: input.operation,
      risk: input.risk,
      executionMode: input.executionMode,
      providerEffect: input.providerEffect,
      clientRequestId: input.clientRequestId,
      providerRequestId: input.providerRequestId,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.syncToken ? { syncToken: input.syncToken } : {}),
      ...(input.beforeImage ? { beforeImage: structuredClone(input.beforeImage) } : {}),
      payload: structuredClone(input.payload),
      payloadHash: input.payloadHash,
      businessReason: input.businessReason,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.sourceSha256 ? { sourceSha256: input.sourceSha256 } : {}),
      ...(input.sourceDigestProvenance ? { sourceDigestProvenance: input.sourceDigestProvenance } : {}),
      ...(input.sourceAttestationDigest ? { sourceAttestationDigest: input.sourceAttestationDigest } : {}),
      ...(input.approvalRef ? { approvalRef: input.approvalRef } : {}),
      confirmationPhraseHash: input.confirmationPhraseHash,
      state: "PREPARED",
      createdAt: input.now,
      expiresAt: input.expiresAt,
      updatedAt: input.now,
    };
    this.#preparations.set(preparation.preparationId, preparation);
    this.#requestIndex.set(key, preparation.preparationId);
    return { preparation: copy(preparation), created: true };
  }

  async get(preparationId: string) {
    const preparation = this.#preparations.get(preparationId);
    return preparation ? copy(preparation) : undefined;
  }

  async saveReviewCsrf(input: {
    csrfHash: string; sessionHash: string; actorId: string; preparationId: string; expiresAt: Date;
  }) {
    if (this.#reviewCsrf.has(input.csrfHash)) throw new AppError("CONFLICT", "QuickBooks review CSRF already exists.", { httpStatus: 409 });
    this.#reviewCsrf.set(input.csrfHash, { ...input, consumed: false });
  }

  async claimForExecution(input: {
    preparationId: string;
    actorId: string;
    requestId: string;
    confirmationPhraseHash?: string;
    approvedBy: string;
    now: Date;
  }): Promise<QuickBooksMutationClaim> {
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (!safeEqual(preparation.actorId, input.actorId)) {
      throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
    }
    if (preparation.state === "POSTED_READBACK_VERIFIED") return { preparation: copy(preparation), shouldExecute: false };
    if (preparation.state !== "PREPARED") {
      throw new AppError("CONFLICT", `QuickBooks mutation cannot execute from ${preparation.state}.`, { httpStatus: 409 });
    }
    if (preparation.expiresAt <= input.now) {
      throw new AppError("APPROVAL_INVALID", "QuickBooks mutation preparation has expired.", { httpStatus: 409 });
    }
    if (input.confirmationPhraseHash && !safeEqual(preparation.confirmationPhraseHash, input.confirmationPhraseHash)) {
      throw new AppError("APPROVAL_INVALID", "QuickBooks confirmation does not match the prepared mutation.", { httpStatus: 409 });
    }
    preparation.state = "EXECUTING";
    preparation.approvedBy = input.approvedBy;
    preparation.approvedAt = input.now;
    preparation.updatedAt = input.now;
    return { preparation: copy(preparation), shouldExecute: true };
  }

  async claimForHumanReview(input: {
    preparationId: string; actorId: string; sessionHash: string; csrfHash: string; approvedBy: string; now: Date;
  }): Promise<QuickBooksMutationClaim> {
    const csrf = this.#reviewCsrf.get(input.csrfHash);
    if (!csrf || csrf.consumed || csrf.expiresAt <= input.now ||
      !safeEqual(csrf.sessionHash, input.sessionHash) || !safeEqual(csrf.actorId, input.actorId) ||
      !safeEqual(csrf.preparationId, input.preparationId)) {
      throw new AppError("FORBIDDEN", "QuickBooks review CSRF is invalid, expired, or already used.", { httpStatus: 403 });
    }
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (!safeEqual(preparation.actorId, input.actorId)) throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
    if (preparation.state === "POSTED_READBACK_VERIFIED") {
      csrf.consumed = true;
      return { preparation: copy(preparation), shouldExecute: false };
    }
    if (preparation.state !== "PREPARED" || preparation.expiresAt <= input.now) {
      throw new AppError("CONFLICT", `QuickBooks mutation cannot execute from ${preparation.state}.`, { httpStatus: 409 });
    }
    csrf.consumed = true;
    preparation.state = "EXECUTING";
    preparation.approvedBy = input.approvedBy;
    preparation.approvedAt = input.now;
    preparation.updatedAt = input.now;
    return { preparation: copy(preparation), shouldExecute: true };
  }

  async reject(input: { preparationId: string; actorId: string; rejectedBy: string; now: Date }) {
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (!safeEqual(preparation.actorId, input.actorId)) throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
    if (preparation.state === "REJECTED") return copy(preparation);
    if (preparation.state !== "PREPARED") throw new AppError("CONFLICT", `QuickBooks mutation cannot be rejected from ${preparation.state}.`, { httpStatus: 409 });
    preparation.state = "REJECTED";
    preparation.rejectedBy = input.rejectedBy;
    preparation.rejectedAt = input.now;
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async rejectFromHumanReview(input: {
    preparationId: string; actorId: string; sessionHash: string; csrfHash: string; rejectedBy: string; now: Date;
  }) {
    const csrf = this.#reviewCsrf.get(input.csrfHash);
    if (!csrf || csrf.consumed || csrf.expiresAt <= input.now ||
      !safeEqual(csrf.sessionHash, input.sessionHash) || !safeEqual(csrf.actorId, input.actorId) ||
      !safeEqual(csrf.preparationId, input.preparationId)) {
      throw new AppError("FORBIDDEN", "QuickBooks review CSRF is invalid, expired, or already used.", { httpStatus: 403 });
    }
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (!safeEqual(preparation.actorId, input.actorId) || preparation.state !== "PREPARED") {
      throw new AppError("CONFLICT", "QuickBooks mutation cannot be rejected.", { httpStatus: 409 });
    }
    csrf.consumed = true;
    preparation.state = "REJECTED";
    preparation.rejectedBy = input.rejectedBy;
    preparation.rejectedAt = input.now;
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async completeVerified(input: {
    preparationId: string;
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
    now: Date;
  }) {
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (preparation.state === "POSTED_READBACK_VERIFIED") return copy(preparation);
    if (preparation.state !== "EXECUTING") throw new AppError("CONFLICT", `QuickBooks mutation cannot complete from ${preparation.state}.`, { httpStatus: 409 });
    preparation.state = "POSTED_READBACK_VERIFIED";
    preparation.providerEntityId = input.providerEntityId;
    preparation.writeReceipt = structuredClone(input.receipt);
    preparation.readback = structuredClone(input.readback);
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async markFailure(
    preparationId: string,
    state: Extract<QuickBooksMutationState, "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION">,
    now: Date,
  ) {
    const preparation = this.#preparations.get(preparationId);
    if (!preparation || preparation.state === "POSTED_READBACK_VERIFIED") return;
    preparation.state = state;
    preparation.updatedAt = now;
  }
}
