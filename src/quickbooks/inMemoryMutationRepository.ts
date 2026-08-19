import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { hashObject, safeEqual } from "../security/hash.js";
import type {
  CreateQuickBooksMutationPreparationInput,
  QuickBooksMutationClaim,
  QuickBooksMutationPreparation,
} from "./mutationModels.js";
import type { QuickBooksMutationRepository } from "./mutationRepository.js";
import { resolvedNoWriteReceipt, unknownNoIdResolutionReceipt } from "./mutationExecutionAttempt.js";
import { resolveQuickBooksAutonomousAuthorizationDelegationIdentity } from "./autonomousAuthorizationEvidence.js";

function copy(value: QuickBooksMutationPreparation): QuickBooksMutationPreparation {
  return structuredClone(value);
}

function assertAutonomousAuthorizationClaimBinding(
  preparation: QuickBooksMutationPreparation,
  approvedBy: string,
): void {
  const evidence = preparation.autonomousAuthorizationEvidence;
  if (!evidence) {
    if (approvedBy.startsWith("standing:")) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence was not durably recorded before execution.", {
        httpStatus: 503,
        details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_MISSING"] },
      });
    }
    return;
  }
  const identity = resolveQuickBooksAutonomousAuthorizationDelegationIdentity(evidence, {
    preparationId: preparation.preparationId,
    providerRequestId: preparation.providerRequestId,
    actorId: preparation.actorId,
    realmId: preparation.realmId,
    preparationPayloadHash: preparation.payloadHash,
  });
  if (!identity) {
    throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence failed integrity verification at execution claim.", {
      httpStatus: 503,
      details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_INVALID"] },
    });
  }
  if (!safeEqual(approvedBy, identity.approvedBy)) {
    throw new AppError("APPROVAL_INVALID", "QuickBooks mutation must be claimed by the standing delegation recorded in its original authorization.", {
      httpStatus: 409,
      details: {
        failureLayer: "AUTHORIZATION_CAUSALITY",
        reasonCodes: ["AUTHORIZATION_CLAIM_ACTOR_MISMATCH"],
        expectedApprovedBy: identity.approvedBy,
      },
    });
  }
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

  async recordAutonomousAuthorizationEvidence(
    input: Parameters<QuickBooksMutationRepository["recordAutonomousAuthorizationEvidence"]>[0],
  ) {
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (!safeEqual(preparation.actorId, input.actorId)) {
      throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
    }
    if (preparation.autonomousAuthorizationEvidence) {
      return { preparation: copy(preparation), created: false };
    }
    if (preparation.state !== "PREPARED") {
      throw new AppError("CONFLICT", "QuickBooks autonomous authorization must be recorded before Provider dispatch.", {
        httpStatus: 409,
        details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_RECORD_TOO_LATE"] },
      });
    }
    if (!resolveQuickBooksAutonomousAuthorizationDelegationIdentity(input.evidence, {
      preparationId: preparation.preparationId,
      providerRequestId: preparation.providerRequestId,
      actorId: preparation.actorId,
      realmId: preparation.realmId,
      preparationPayloadHash: preparation.payloadHash,
    })) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence failed integrity verification before persistence.", {
        httpStatus: 503,
        details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_INVALID"] },
      });
    }
    preparation.autonomousAuthorizationEvidence = structuredClone(input.evidence);
    preparation.updatedAt = input.now;
    return { preparation: copy(preparation), created: true };
  }

  async saveReviewCsrf(input: {
    csrfHash: string; sessionHash: string; actorId: string; preparationId: string; expiresAt: Date;
  }) {
    if (this.#reviewCsrf.has(input.csrfHash)) throw new AppError("CONFLICT", "QuickBooks review CSRF already exists.", { httpStatus: 409 });
    this.#reviewCsrf.set(input.csrfHash, { ...input, consumed: false });
  }

  async resealNeverDispatchedPreparation(
    input: Parameters<QuickBooksMutationRepository["resealNeverDispatchedPreparation"]>[0],
  ) {
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation || !safeEqual(preparation.actorId, input.actorId)) return undefined;
    // Mirrors the Postgres predicate exactly: any evidence of Provider contact
    // makes the row unresealable, which is the case the expiry protects.
    if (preparation.state !== "PREPARED" || preparation.expiresAt > input.now) return undefined;
    if (preparation.approvedBy || preparation.approvedAt || preparation.executionAttempt ||
      preparation.providerEntityId || preparation.providerOutcomeReceipt ||
      preparation.writeReceipt || preparation.readback) return undefined;
    delete preparation.autonomousAuthorizationEvidence;
    preparation.expiresAt = input.expiresAt;
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async claimForExecution(
    input: Parameters<QuickBooksMutationRepository["claimForExecution"]>[0],
  ): Promise<QuickBooksMutationClaim> {
    const { leaseOwner, leaseTokenHash, leaseDurationMs } = input;
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (!safeEqual(preparation.actorId, input.actorId)) {
      throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
    }
    if (preparation.state === "POSTED_READBACK_VERIFIED") {
      return { preparation: copy(preparation), shouldExecute: false, recoveryOnly: false };
    }
    if (preparation.state === "PROVIDER_OUTCOME_RECORDED" || preparation.state === "WRITE_RESULT_UNKNOWN" ||
      preparation.state === "READBACK_MISMATCH") {
      if (!preparation.providerEntityId || !preparation.providerOutcomeReceipt) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks mutation has no exact Provider Id for automatic recovery; no second write is allowed.", {
          httpStatus: 503, retryable: false,
        });
      }
      return { preparation: copy(preparation), shouldExecute: false, recoveryOnly: true };
    }
    if (preparation.state === "WRITE_RESULT_UNKNOWN_NO_ID") {
      throw unknownNoId(preparation);
    }
    if (preparation.state === "EXECUTING" && preparation.executionAttempt) {
      if (preparation.executionAttempt.dispatchStartedAt) {
        if (preparation.executionAttempt.leaseUntil <= input.now) {
          const receipt = unknownNoIdResolutionReceipt({
            attemptId: preparation.executionAttempt.attemptId,
            providerRequestId: preparation.providerRequestId,
            reasonCode: "STALE_AFTER_DISPATCH",
            resolvedAt: input.now,
          });
          preparation.state = "WRITE_RESULT_UNKNOWN_NO_ID";
          preparation.executionAttempt.state = "WRITE_RESULT_UNKNOWN_NO_ID";
          preparation.executionAttempt.resolutionReceipt = structuredClone(receipt);
          preparation.executionAttempt.updatedAt = input.now;
          preparation.updatedAt = input.now;
          throw unknownNoId(preparation);
        }
        throw inFlight(preparation);
      }
      if (preparation.executionAttempt.leaseUntil > input.now) throw inFlight(preparation);
      preparation.executionAttempt.claimSequence += 1;
      preparation.executionAttempt.leaseOwner = leaseOwner;
      preparation.executionAttempt.leaseTokenHash = leaseTokenHash;
      preparation.executionAttempt.leaseUntil = new Date(input.now.getTime() + leaseDurationMs);
      preparation.executionAttempt.updatedAt = input.now;
      preparation.updatedAt = input.now;
      return { preparation: copy(preparation), shouldExecute: true, recoveryOnly: false };
    }
    if (preparation.state !== "PREPARED") {
      throw new AppError("CONFLICT", `QuickBooks mutation cannot execute from ${preparation.state}.`, {
        httpStatus: 409,
        retryable: preparation.state === "EXECUTING",
        ...(preparation.state === "EXECUTING" ? {
          details: { failureLayer: "IDEMPOTENCY", reasonCodes: ["SHARED_MUTATION_IN_FLIGHT"] },
        } : {}),
      });
    }
    if (preparation.expiresAt <= input.now) {
      throw new AppError("APPROVAL_INVALID", "QuickBooks mutation preparation has expired.", { httpStatus: 409 });
    }
    if (input.confirmationPhraseHash && !safeEqual(preparation.confirmationPhraseHash, input.confirmationPhraseHash)) {
      throw new AppError("APPROVAL_INVALID", "QuickBooks confirmation does not match the prepared mutation.", { httpStatus: 409 });
    }
    assertAutonomousAuthorizationClaimBinding(preparation, input.approvedBy);
    preparation.state = "EXECUTING";
    preparation.approvedBy = input.approvedBy;
    preparation.approvedAt = input.now;
    preparation.updatedAt = input.now;
    preparation.executionAttempt = {
      attemptId: `qbea_${randomUUID().replaceAll("-", "")}`,
      claimSequence: 1,
      state: "CLAIMED",
      leaseOwner,
      leaseTokenHash,
      leaseUntil: new Date(input.now.getTime() + leaseDurationMs),
      createdAt: input.now,
      updatedAt: input.now,
    };
    return { preparation: copy(preparation), shouldExecute: true, recoveryOnly: false };
  }

  async claimForHumanReview(
    input: Parameters<QuickBooksMutationRepository["claimForHumanReview"]>[0],
  ): Promise<QuickBooksMutationClaim> {
    const { leaseOwner, leaseTokenHash, leaseDurationMs } = input;
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
      return { preparation: copy(preparation), shouldExecute: false, recoveryOnly: false };
    }
    if (preparation.state !== "PREPARED" || preparation.expiresAt <= input.now) {
      throw new AppError("CONFLICT", `QuickBooks mutation cannot execute from ${preparation.state}.`, { httpStatus: 409 });
    }
    assertAutonomousAuthorizationClaimBinding(preparation, input.approvedBy);
    csrf.consumed = true;
    preparation.state = "EXECUTING";
    preparation.approvedBy = input.approvedBy;
    preparation.approvedAt = input.now;
    preparation.updatedAt = input.now;
    preparation.executionAttempt = {
      attemptId: `qbea_${randomUUID().replaceAll("-", "")}`,
      claimSequence: 1,
      state: "CLAIMED",
      leaseOwner,
      leaseTokenHash,
      leaseUntil: new Date(input.now.getTime() + leaseDurationMs),
      createdAt: input.now,
      updatedAt: input.now,
    };
    return { preparation: copy(preparation), shouldExecute: true, recoveryOnly: false };
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
    if (preparation.state !== "PROVIDER_OUTCOME_RECORDED" && preparation.state !== "WRITE_RESULT_UNKNOWN" &&
      preparation.state !== "READBACK_MISMATCH") {
      throw new AppError("CONFLICT", `QuickBooks mutation cannot complete from ${preparation.state}.`, { httpStatus: 409 });
    }
    preparation.state = "POSTED_READBACK_VERIFIED";
    preparation.providerEntityId = input.providerEntityId;
    preparation.writeReceipt = structuredClone(input.receipt);
    preparation.readback = structuredClone(input.readback);
    if (preparation.executionAttempt) {
      preparation.executionAttempt.state = "READBACK_VERIFIED";
      preparation.executionAttempt.updatedAt = input.now;
    }
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async recordProviderOutcome(input: Parameters<QuickBooksMutationRepository["recordProviderOutcome"]>[0]) {
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (preparation.state === "POSTED_READBACK_VERIFIED") return copy(preparation);
    if (preparation.providerEntityId) {
      if (!safeEqual(preparation.providerEntityId, input.providerEntityId) || !preparation.providerOutcomeReceipt ||
        !safeEqual(hashObject(preparation.providerOutcomeReceipt), hashObject(input.providerOutcomeReceipt))) {
        throw new AppError("CONFLICT", "QuickBooks provider outcome identity is immutable.", { httpStatus: 409 });
      }
      return copy(preparation);
    }
    const attempt = preparation.executionAttempt;
    const outcomeCheckpointAllowed = Boolean(attempt) && (
      (preparation.state === "EXECUTING" && attempt?.state === "DISPATCH_STARTED") ||
      (preparation.state === "WRITE_RESULT_UNKNOWN_NO_ID" &&
        attempt?.state === "WRITE_RESULT_UNKNOWN_NO_ID" &&
        attempt.dispatchStartedAt !== undefined &&
        attempt.resolutionReceipt !== undefined)
    );
    if (!outcomeCheckpointAllowed || !attempt ||
      !safeEqual(attempt.attemptId, input.attemptId) ||
      !safeEqual(attempt.leaseTokenHash, input.leaseTokenHash)) {
      throw new AppError("CONFLICT", `QuickBooks provider outcome cannot be recorded from ${preparation.state}.`, { httpStatus: 409 });
    }
    preparation.state = "PROVIDER_OUTCOME_RECORDED";
    preparation.providerEntityId = input.providerEntityId;
    preparation.providerOutcomeReceipt = structuredClone(input.providerOutcomeReceipt);
    attempt.state = "PROVIDER_OUTCOME_RECORDED";
    attempt.providerOutcomeRecordedAt = input.now;
    attempt.updatedAt = input.now;
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async markDispatchStarted(input: Parameters<QuickBooksMutationRepository["markDispatchStarted"]>[0]) {
    const preparation = this.#preparations.get(input.preparationId);
    const attempt = preparation?.executionAttempt;
    if (!preparation || preparation.state !== "EXECUTING" || !attempt ||
      !safeEqual(attempt.attemptId, input.attemptId) ||
      !safeEqual(attempt.leaseTokenHash, input.leaseTokenHash) ||
      attempt.leaseUntil <= input.now || attempt.state !== "CLAIMED") {
      throw new AppError("CONFLICT", "QuickBooks execution lease cannot start Provider dispatch.", {
        httpStatus: 409, details: { failureLayer: "EXECUTION_FENCING" },
      });
    }
    attempt.state = "DISPATCH_STARTED";
    attempt.dispatchStartedAt = input.now;
    attempt.updatedAt = input.now;
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async resolveUnknownNoId(input: Parameters<QuickBooksMutationRepository["resolveUnknownNoId"]>[0]) {
    const preparation = this.#preparations.get(input.preparationId);
    const attempt = preparation?.executionAttempt;
    if (!preparation || preparation.state !== "EXECUTING" || !attempt ||
      !safeEqual(attempt.attemptId, input.attemptId) ||
      !safeEqual(attempt.leaseTokenHash, input.leaseTokenHash) ||
      attempt.state !== "DISPATCH_STARTED") {
      throw new AppError("CONFLICT", "QuickBooks execution attempt cannot be resolved as unknown without an exact Id.", {
        httpStatus: 409, details: { failureLayer: "EXECUTION_FENCING" },
      });
    }
    preparation.state = "WRITE_RESULT_UNKNOWN_NO_ID";
    attempt.state = "WRITE_RESULT_UNKNOWN_NO_ID";
    attempt.resolutionReceipt = structuredClone(input.resolutionReceipt);
    attempt.updatedAt = input.now;
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async recordOperatorResolution(
    input: Parameters<QuickBooksMutationRepository["recordOperatorResolution"]>[0],
  ) {
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation || !safeEqual(preparation.actorId, input.actorId)) throw notAttestable(undefined);
    // Mirrors the Postgres predicate and migration 038's trigger exactly.
    if (preparation.operatorResolutionReceipt ||
      preparation.state !== "WRITE_RESULT_UNKNOWN_NO_ID" ||
      preparation.executionAttempt?.state !== "WRITE_RESULT_UNKNOWN_NO_ID" ||
      preparation.providerEntityId || preparation.providerOutcomeReceipt ||
      preparation.writeReceipt || preparation.readback) {
      throw notAttestable(preparation);
    }
    preparation.operatorResolutionReceipt = structuredClone(input.receipt);
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async releasePreDispatchLease(input: Parameters<QuickBooksMutationRepository["releasePreDispatchLease"]>[0]) {
    const preparation = this.#preparations.get(input.preparationId);
    const attempt = preparation?.executionAttempt;
    if (!preparation || preparation.state !== "EXECUTING" || !attempt ||
      !safeEqual(attempt.attemptId, input.attemptId) ||
      !safeEqual(attempt.leaseTokenHash, input.leaseTokenHash) ||
      attempt.state !== "CLAIMED" || attempt.dispatchStartedAt) {
      throw new AppError("CONFLICT", "QuickBooks pre-dispatch lease cannot be released.", {
        httpStatus: 409, details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_INVALID"] },
      });
    }
    attempt.leaseUntil = input.now;
    attempt.updatedAt = input.now;
    preparation.updatedAt = input.now;
    return copy(preparation);
  }

  async reconcileStaleExecutionAttempts(now: Date) {
    let stalePreDispatchReclaimable = 0;
    let transitionedToUnknownNoId = 0;
    let oldestStaleAt: Date | undefined;
    for (const preparation of this.#preparations.values()) {
      const attempt = preparation.executionAttempt;
      if (preparation.state !== "EXECUTING" || !attempt || attempt.leaseUntil > now) continue;
      if (!oldestStaleAt || attempt.leaseUntil < oldestStaleAt) oldestStaleAt = attempt.leaseUntil;
      if (!attempt.dispatchStartedAt) {
        stalePreDispatchReclaimable += 1;
        continue;
      }
      const receipt = unknownNoIdResolutionReceipt({
        attemptId: attempt.attemptId,
        providerRequestId: preparation.providerRequestId,
        reasonCode: "STALE_AFTER_DISPATCH",
        resolvedAt: now,
      });
      preparation.state = "WRITE_RESULT_UNKNOWN_NO_ID";
      attempt.state = "WRITE_RESULT_UNKNOWN_NO_ID";
      attempt.resolutionReceipt = structuredClone(receipt);
      attempt.updatedAt = now;
      preparation.updatedAt = now;
      transitionedToUnknownNoId += 1;
    }
    return { stalePreDispatchReclaimable, transitionedToUnknownNoId, ...(oldestStaleAt ? { oldestStaleAt } : {}) };
  }

  async markFailure(input: Parameters<QuickBooksMutationRepository["markFailure"]>[0]) {
    const preparation = this.#preparations.get(input.preparationId);
    if (!preparation || preparation.state === "POSTED_READBACK_VERIFIED") return;
    const attempt = preparation.executionAttempt;
    // Mirrors the Postgres predicate. BLOCKED_VALIDATION asserts a non-write,
    // so after dispatch it is admitted only on a proven Provider refusal, and
    // never over a row that already holds an exact Provider Id.
    if (!attempt || !safeEqual(attempt.attemptId, input.attemptId) ||
      !safeEqual(attempt.leaseTokenHash, input.leaseTokenHash) ||
      (input.state === "BLOCKED_VALIDATION" && attempt.dispatchStartedAt &&
        !input.providerConfirmedNotWritten) ||
      (input.providerConfirmedNotWritten === true && preparation.providerEntityId)) {
      throw new AppError("CONFLICT", "QuickBooks execution failure cannot cross the durable attempt fence.", {
        httpStatus: 409,
        details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_INVALID"] },
      });
    }
    preparation.state = input.state;
    if (attempt) {
      attempt.state = input.state === "BLOCKED_VALIDATION"
        ? "RESOLVED_NO_WRITE"
        : preparation.providerEntityId ? "PROVIDER_OUTCOME_RECORDED" : attempt.state;
      if (input.state === "BLOCKED_VALIDATION") {
        attempt.resolutionReceipt = input.resolutionReceipt ?? resolvedNoWriteReceipt({
          attemptId: input.attemptId,
          providerRequestId: input.providerRequestId,
          reasonCode: "DEFINITIVE_PRE_DISPATCH_FAILURE",
          resolvedAt: input.now,
        });
      }
      attempt.updatedAt = input.now;
    }
    preparation.updatedAt = input.now;
  }
}

function inFlight(preparation: QuickBooksMutationPreparation): AppError {
  return new AppError("CONFLICT", "QuickBooks mutation is owned by an active execution lease.", {
    httpStatus: 409,
    retryable: true,
    details: {
      failureLayer: "EXECUTION_FENCING",
      reasonCodes: ["EXECUTION_LEASE_ACTIVE"],
      providerMutationPossible: Boolean(preparation.executionAttempt?.dispatchStartedAt),
    },
  });
}

function notAttestable(existing: QuickBooksMutationPreparation | undefined): AppError {
  if (!existing) {
    return new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
  }
  if (existing.operatorResolutionReceipt) {
    return new AppError("CONFLICT", "This QuickBooks write has already been resolved by an operator attestation, and that attestation is immutable.", {
      httpStatus: 409,
      details: {
        failureLayer: "PROVIDER_OUTCOME",
        reasonCodes: ["OPERATOR_RESOLUTION_ALREADY_RECORDED"],
        finding: existing.operatorResolutionReceipt.finding,
        attestedAt: existing.operatorResolutionReceipt.attestedAt,
      },
    });
  }
  return new AppError("CONFLICT", `Only a QuickBooks write whose outcome is unknown can be resolved by attestation; this one is in ${existing.state}.`, {
    httpStatus: 409,
    details: {
      failureLayer: "PROVIDER_OUTCOME",
      reasonCodes: ["OPERATOR_RESOLUTION_STATE_INVALID"],
      state: existing.state,
    },
  });
}

function unknownNoId(preparation: QuickBooksMutationPreparation): AppError {
  return new AppError(
    "WRITE_RESULT_UNKNOWN_NO_ID",
    "QuickBooks Provider dispatch may have occurred without a durable exact Provider Id; operator resolution is required and automatic re-arm is forbidden.",
    {
      httpStatus: 503,
      retryable: false,
      details: {
        failureLayer: "PROVIDER_OUTCOME",
        attemptId: preparation.executionAttempt?.attemptId,
        providerRequestId: preparation.providerRequestId,
        providerMutationPossible: true,
        automaticRearmAllowed: false,
        operatorResolutionRequired: true,
        recoveryAction: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
      },
    },
  );
}
