import { randomBytes, randomUUID } from "node:crypto";
import { AppError, toSafeError } from "../errors.js";
import { hashObject, safeEqual, sha256 } from "../security/hash.js";
import {
  evaluateAutonomousLedgerReuse,
  evaluateAutonomousLedgerWrite,
  type EvaluateAutonomousLedgerWriteInput,
  type LedgerStandingDelegation,
} from "../ledger-control/ledgerControlKernel.js";
import {
  verifyDeterministicValidationReceipt,
  type DeterministicValidationReceipt,
} from "../ledger-control/deterministicValidation.js";
import { requireOAuthBoundRequestContext, type RequestContext } from "../security/requestContext.js";
import { issueQuickBooksProviderWritePermit } from "../security/quickBooksProviderWritePermit.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "./service.js";
import type {
  QuickBooksExecutePreparedMutationInput,
  QuickBooksGetWriteCapabilitiesInput,
  QuickBooksPrepareMutationInput,
} from "./schemas.js";
import type {
  QuickBooksMutationExecutionResult,
  QuickBooksMutationPreparation,
} from "./mutationModels.js";
import type { QuickBooksMutationRepository } from "./mutationRepository.js";
import type {
  QuickBooksAuditCompletion,
  QuickBooksAuditIntent,
  QuickBooksControlRepository,
} from "./controlRepository.js";
import {
  QUICKBOOKS_WRITE_CAPABILITIES,
  quickBooksWriteCapability,
  quickBooksWriteCapabilitySummary,
} from "./writePolicy.js";
import {
  verifyQuickBooksSourceAttestation,
  type QuickBooksSourceAttestationVerifier,
} from "./sourceAttestation.js";
import {
  issueQuickBooksAutonomousAuthorizationEvidence,
  issueQuickBooksMutationReuseEvidence,
  resolveQuickBooksAutonomousAuthorizationDelegationIdentity,
  verifyQuickBooksAutonomousAuthorizationEvidence,
  type QuickBooksAutonomousAuthorizationEvidence,
  type QuickBooksMutationReuseEvidence,
} from "./autonomousAuthorizationEvidence.js";
import {
  QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS,
  resolvedNoWriteReceipt,
  unknownNoIdResolutionReceipt,
} from "./mutationExecutionAttempt.js";

export interface QuickBooksMutationRuntimePolicy {
  writeEnabled: boolean;
  allowedRealmId?: string;
  allowedCapabilities?: string[];
  publicBaseUrl: string;
  writeTargetMode: "exact_allowlist" | "oauth_bound";
  restrictedReviewerActors?: string[];
  /** When present, the public Agent surface is Accounting Case-only. */
  accountingCaseReleasedCapabilities?: readonly string[];
  executeScopeAuthorizer?: (actorId: string, requiredScope: string) => Promise<boolean>;
  standingDelegationProvider?: (
    context: RequestContext,
    realmId: string,
  ) => Promise<readonly LedgerStandingDelegation[]>;
}

type MutationAuditRepository = Pick<QuickBooksControlRepository, "beginAudit" | "completeAudit">;

function isDefinitivePreDispatchFailure(code: AppError["code"]): boolean {
  return code === "VALIDATION_FAILED" || code === "APPROVAL_INVALID" ||
    code === "FORBIDDEN" || code === "NOT_FOUND";
}

function confirmationPhrase(
  input: QuickBooksPrepareMutationInput,
  boundTargetRefSafe: string,
  payloadHash: string,
): string {
  const target = input.target_id ? ` ${input.target_id}` : "";
  return `CONFIRM QUICKBOOKS ${input.operation} ${input.entity}${target} IN ${boundTargetRefSafe} PAYLOAD ${payloadHash}`;
}

function preparationWarnings(
  input: QuickBooksPrepareMutationInput,
  providerEffect: string,
  quickBooksDraftAvailable: boolean,
): string[] {
  const warnings = [
    quickBooksDraftAvailable
      ? "This QuickBooks object is non-posting, but it can still affect an operational workflow."
      : "QuickBooks has no universal draft state for this object; provider execution changes the connected Company immediately.",
  ];
  if (providerEffect === "POSTING_TRANSACTION") warnings.push("Creating or updating this object posts an accounting transaction.");
  if (providerEffect === "CASH_MOVEMENT") warnings.push("This action records cash settlement, refund, deposit, or transfer.");
  if (providerEffect === "LEDGER_ADJUSTMENT") warnings.push("This action posts directly to the general ledger.");
  if (providerEffect === "PERMANENT_DELETE") warnings.push("QuickBooks transaction deletion is permanent and cannot be undone.");
  if (providerEffect === "DEACTIVATION") warnings.push("The target master-data record will be made inactive.");
  if (input.source_digest_provenance && input.source_digest_provenance !== "HOST_PROVIDED_ORIGINAL_FILE_SHA256") {
    warnings.push("The supplied source digest does not independently verify the original uploaded file bytes.");
  }
  return warnings;
}

/** A prepared mutation is only good for this long, so that authority is
  * re-evaluated rather than assumed. Reseal reopens the window; it does not
  * widen it. */
const QUICKBOOKS_PREPARATION_TTL_MS = 30 * 60_000;

export class QuickBooksMutationService {
  constructor(
    private readonly repository: QuickBooksMutationRepository,
    private readonly resolver: QuickBooksProviderResolver,
    private readonly policy: QuickBooksMutationRuntimePolicy,
    private readonly audit?: MutationAuditRepository,
    private readonly sourceAttestationVerifier?: QuickBooksSourceAttestationVerifier,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  capabilities(input: QuickBooksGetWriteCapabilitiesInput = {}) {
    const summary = quickBooksWriteCapabilitySummary();
    const enabledCapabilityKeys = this.#enabledCapabilityKeys();
    const caseReleased = this.policy.accountingCaseReleasedCapabilities
      ? new Set(this.policy.accountingCaseReleasedCapabilities)
      : undefined;
    return {
      ...summary,
      runtime: {
        writeEnabled: this.policy.writeEnabled,
        targetMode: this.policy.writeTargetMode,
        exactCompanyAllowlisted: Boolean(this.policy.allowedRealmId),
        enabledCapabilities: enabledCapabilityKeys,
        agentFacingMode: caseReleased ? "ACCOUNTING_CASE" : "LEGACY_OBJECT_MUTATION",
        accountingCaseReleasedCapabilities: caseReleased ? [...caseReleased].sort() : [],
      },
      capabilities: QUICKBOOKS_WRITE_CAPABILITIES.filter((capability) =>
        (!input.entity || capability.entity === input.entity) &&
        (!input.operation || capability.operation === input.operation))
        .map((capability) => {
          const key = `${capability.operation}:${capability.entity}`;
          const runtimeExecutionEnabled = this.policy.writeEnabled &&
            enabledCapabilityKeys.includes(key) &&
            (!caseReleased || caseReleased.has(key)) &&
            (this.policy.writeTargetMode === "oauth_bound" || Boolean(this.policy.allowedRealmId));
          return {
            ...capability,
            // The plainest-named field must answer for the route that is
            // actually mounted. Under ACCOUNTING_CASE the released document
            // creates are executed by the Agent, so the legacy object-mutation
            // answer ("false", human review) would contradict this same
            // response's accountingCaseReleased and runtimeExecutionEnabled.
            // The legacy answer is preserved verbatim under its own name.
            agentMayExecute: caseReleased ? runtimeExecutionEnabled : capability.agentMayExecute,
            legacyObjectMutationAgentMayExecute: capability.agentMayExecute,
            runtimePolicyEnabled: enabledCapabilityKeys.includes(key),
            accountingCaseReleased: caseReleased?.has(key) ?? false,
            runtimeExecutionEnabled,
          };
        }),
    };
  }

  async prepare(actorId: string, input: QuickBooksPrepareMutationInput) {
    return this.#withAudit(actorId, "quickbooks_prepare_mutation", input, () => this.#prepare(actorId, input));
  }

  /** Internal Case compiler path. Agent-facing generic payload preparation stays a compatibility surface. */
  prepareCaseOperation(actorId: string, input: QuickBooksPrepareMutationInput) {
    return this.#withAudit(actorId, "quickbooks_prepare_accounting_case_operation", {
      request_id: input.request_id,
      entity: input.entity,
      operation: input.operation,
      payload_hash: hashObject(input.payload),
    }, () => this.#prepare(actorId, input, { allowVerifiedTerminalReplay: true }));
  }

  async #prepare(
    actorId: string,
    input: QuickBooksPrepareMutationInput,
    options: { allowVerifiedTerminalReplay?: boolean } = {},
  ) {
    const capability = quickBooksWriteCapability(input.operation, input.entity);
    if (!capability) {
      throw new AppError("VALIDATION_FAILED", `Intuit's current official MCP does not expose ${input.operation} for ${input.entity}.`, {
        httpStatus: 422,
      });
    }
    const resolved = await this.resolver.resolve(actorId, input.target_session_ref);
    const sourceAttestationDigest = await verifyQuickBooksSourceAttestation({
      actorId,
      ...(input.source_ref ? { sourceRef: input.source_ref } : {}),
      ...(input.source_sha256 ? { sourceSha256: input.source_sha256 } : {}),
      ...(input.source_digest_provenance ? { provenance: input.source_digest_provenance } : {}),
      ...(input.source_attestation_ref ? { attestationRef: input.source_attestation_ref } : {}),
      boundTargetRefSafe: resolved.boundTargetRefSafe,
      bindingRevision: resolved.bindingRevision,
      ...(this.sourceAttestationVerifier ? { verifier: this.sourceAttestationVerifier } : {}),
    });
    let beforeImage: Record<string, unknown> | undefined;
    if (input.operation !== "CREATE") {
      beforeImage = await resolved.provider.getMutationTarget(input.entity, input.target_id as string);
      if (beforeImage.SyncToken !== input.sync_token) {
        throw new AppError("CONFLICT", `QuickBooks ${input.entity} changed before preparation; read the exact target again.`, {
          httpStatus: 409,
        });
      }
    }
    const payloadHash = hashObject({
      realmId: resolved.realmId,
      bindingRevision: resolved.bindingRevision,
      entity: input.entity,
      operation: input.operation,
      targetId: input.target_id,
      syncToken: input.sync_token,
      payload: input.payload,
      businessReason: input.business_reason,
      sourceRef: input.source_ref,
      sourceSha256: input.source_sha256,
      sourceDigestProvenance: input.source_digest_provenance,
      sourceAttestationDigest,
      approvalRef: input.approval_ref,
      beforeImage,
    });
    const phrase = confirmationPhrase(input, resolved.boundTargetRefSafe, payloadHash);
    const providerRequestId = `zc.${sha256(`${resolved.realmId}:${input.request_id}:${payloadHash}`).slice(0, 47)}`;
    const now = new Date();
    const created = await this.repository.createOrGet({
      preparationId: `qbm_${randomBytes(16).toString("hex")}`,
      actorId,
      realmId: resolved.realmId,
      connectionRefSafe: resolved.connectionRefSafe,
      boundTargetRefSafe: resolved.boundTargetRefSafe,
      bindingRevision: resolved.bindingRevision,
      entity: input.entity,
      operation: input.operation,
      risk: capability.risk,
      executionMode: capability.executionMode,
      providerEffect: capability.providerEffect,
      clientRequestId: input.request_id,
      providerRequestId,
      ...(input.target_id ? { targetId: input.target_id } : {}),
      ...(input.sync_token ? { syncToken: input.sync_token } : {}),
      ...(beforeImage ? { beforeImage } : {}),
      payload: input.payload,
      payloadHash,
      businessReason: input.business_reason,
      ...(input.source_ref ? { sourceRef: input.source_ref } : {}),
      ...(input.source_sha256 ? { sourceSha256: input.source_sha256 } : {}),
      ...(input.source_digest_provenance ? { sourceDigestProvenance: input.source_digest_provenance } : {}),
      ...(sourceAttestationDigest ? { sourceAttestationDigest } : {}),
      ...(input.approval_ref ? { approvalRef: input.approval_ref } : {}),
      confirmationPhraseHash: sha256(phrase),
      expiresAt: new Date(now.getTime() + QUICKBOOKS_PREPARATION_TTL_MS),
      now,
    });
    if (!created.created && !safeEqual(created.preparation.payloadHash, payloadHash)) {
      throw new AppError("CONFLICT", "request_id was already used with a different QuickBooks mutation payload.", {
        httpStatus: 409,
      });
    }
    const verifiedTerminalReplay = !created.created && options.allowVerifiedTerminalReplay === true &&
      created.preparation.state === "POSTED_READBACK_VERIFIED";
    if (created.preparation.state !== "PREPARED" && !verifiedTerminalReplay) {
      throw new AppError("CONFLICT", `The QuickBooks mutation is already in ${created.preparation.state}.`, {
        httpStatus: 409,
      });
    }
    return {
      preparation_id: created.preparation.preparationId,
      state: verifiedTerminalReplay ? "POSTED_READBACK_VERIFIED" as const : "PREPARED" as const,
      entity: capability.entity,
      operation: capability.operation,
      official_tool: capability.officialTool,
      risk: capability.risk,
      execution_mode: capability.executionMode,
      provider_effect: capability.providerEffect,
      quickbooks_draft_available: capability.quickBooksDraftAvailable,
      provider_write_executed: verifiedTerminalReplay,
      runtime_policy_enabled: this.#enabledCapabilityKeys().includes(`${capability.operation}:${capability.entity}`),
      runtime_execution_enabled: this.policy.writeEnabled &&
        this.#enabledCapabilityKeys().includes(`${capability.operation}:${capability.entity}`) &&
        (this.policy.writeTargetMode === "oauth_bound" || Boolean(this.policy.allowedRealmId)),
      proposal: {
        target_id: input.target_id,
        sync_token: input.sync_token,
        payload: input.payload,
        business_reason: input.business_reason,
        before_image: beforeImage,
      },
      canonical_payload_hash: created.preparation.payloadHash,
      confirmation_phrase: capability.executionMode === "EXPLICIT_CONFIRMATION" ? phrase : undefined,
      // review_required says only that Agent confirmation is not sufficient. It
      // names no review page: the operator review route is gone, and an
      // Accounting Case reaches these capabilities through standing delegation.
      review_required: capability.executionMode !== "EXPLICIT_CONFIRMATION",
      expires_at: created.preparation.expiresAt.toISOString(),
      warnings: preparationWarnings(input, capability.providerEffect, capability.quickBooksDraftAvailable),
      idempotent_replay: !created.created,
    };
  }

  async executeWithConfirmation(actorId: string, input: QuickBooksExecutePreparedMutationInput) {
    return this.#withAudit(actorId, "quickbooks_execute_confirmed_mutation", input, async () => {
      const existing = await this.#owned(input.preparation_id, actorId);
      if (existing.executionMode !== "EXPLICIT_CONFIRMATION") {
        throw new AppError("APPROVAL_INVALID", "This QuickBooks mutation requires the out-of-band human review page.", {
          httpStatus: 409,
        });
      }
      if (!safeEqual(existing.clientRequestId, input.request_id)) {
        throw new AppError("APPROVAL_INVALID", "Execution request_id must exactly match the prepared mutation request_id.", {
          httpStatus: 409,
        });
      }
      return this.#execute({
        actorId,
        preparation: existing,
        requestId: input.request_id,
        confirmationPhraseHash: sha256(input.confirmation_phrase),
        approvedBy: actorId,
        humanReview: false,
        authorityMode: "CONFIRMATION",
      });
    });
  }

  async executeAfterHumanReview(options: {
    actorId: string;
    preparationId: string;
    approvedBy: string;
    sessionHash: string;
    csrfHash: string;
  }) {
    return this.#withAudit(options.actorId, "quickbooks_mutation_review_approve", {
      preparationId: options.preparationId,
      approvedBy: options.approvedBy,
    }, async () => {
      const existing = await this.#owned(options.preparationId, options.actorId);
      if (existing.executionMode === "EXPLICIT_CONFIRMATION") {
        throw new AppError("APPROVAL_INVALID", "This low-risk mutation should use the exact-confirmation MCP tool.", {
          httpStatus: 409,
        });
      }
      return this.#execute({
        actorId: options.actorId,
        preparation: existing,
        requestId: existing.clientRequestId,
        approvedBy: options.approvedBy,
        humanReview: true,
        authorityMode: "HUMAN_REVIEW",
        sessionHash: options.sessionHash,
        csrfHash: options.csrfHash,
      });
    });
  }

  async executeAutonomously(context: RequestContext, input: {
    preparationId: string;
    requestId: string;
    targetSessionRef: string;
    actionId: string;
    caseId: string;
    caseVersion: number;
    sourceRevisionHash: string;
    stableOperationKey: string;
    validationReceipt: DeterministicValidationReceipt;
  }): Promise<QuickBooksMutationExecutionResult & {
    authorizationReceipt: Record<string, unknown>;
    authorizationEvidence: QuickBooksAutonomousAuthorizationEvidence;
    reuseEvidenceReceipt?: QuickBooksMutationReuseEvidence;
  }> {
    return this.#withAudit(context.actorId, "quickbooks_execute_accounting_case_operation", {
      preparationId: input.preparationId,
      requestId: input.requestId,
      actionId: input.actionId,
      caseId: input.caseId,
      caseVersion: input.caseVersion,
    }, async () => {
      const principal = requireOAuthBoundRequestContext(context);
      let existing = await this.#owned(input.preparationId, context.actorId);
      if (existing.expiresAt <= this.clock()) {
        // An Accounting Case can legitimately resume days later, and the
        // operation's request id is a content hash, so every retry — including a
        // new Case version — resolves back to this same row. Left as-is the Case
        // is unexecutable forever. Reopening it is safe only because the reseal
        // clears the recorded authorization, which forces the fresh standing
        // delegation evaluation below; the expiry existed to demand exactly that
        // re-check, not to end the work. A row that ever reached the Provider
        // fails the reseal predicate and keeps its expiry error.
        const resealed = await this.repository.resealNeverDispatchedPreparation({
          preparationId: input.preparationId,
          actorId: context.actorId,
          expiresAt: new Date(this.clock().getTime() + QUICKBOOKS_PREPARATION_TTL_MS),
          now: this.clock(),
        });
        if (resealed) existing = resealed;
      }
      if (!safeEqual(existing.clientRequestId, input.requestId)) {
        throw new AppError("CONFLICT", "Accounting Case operation request_id does not match its immutable preparation.", {
          httpStatus: 409, details: { failureLayer: "IDEMPOTENCY" },
        });
      }
      const canonicalPayloadHash = hashObject(existing.payload);
      const validation = verifyDeterministicValidationReceipt(input.validationReceipt, {
        actionId: input.actionId,
        canonicalPayloadHash,
        sourceRevisionHash: input.sourceRevisionHash,
        caseId: input.caseId,
        caseVersion: input.caseVersion,
      });
      const resolved = await this.resolver.resolve(context.actorId, input.targetSessionRef);
      await this.#assertExecutionAllowed(existing, resolved.realmId, resolved.bindingRevision, context.actorId, "AUTONOMOUS");
      const standingDelegations = this.policy.standingDelegationProvider
        ? await this.policy.standingDelegationProvider(context, resolved.realmId)
        : [];
      // Authorization is about authority at execution time. The validation
      // receipt proves deterministic accounting checks, but its historical
      // issuedAt must never rewind target-session or delegation expiry.
      const authorizationEvaluatedAt = new Date(this.clock().getTime());
      const providerCapabilityReceiptHash = hashObject({
        provider: "quickbooks",
        realmId: resolved.realmId,
        bindingRevision: resolved.bindingRevision,
        capability: `${existing.operation}:${existing.entity}`,
        executeScope: context.scopes.includes("quickbooks.mutation.execute"),
        providerAccessDenyReasons: [...(resolved.providerAccessDenyReasons ?? [])],
        checkedAt: authorizationEvaluatedAt.toISOString(),
      });
      const authorityInput = {
        actionId: input.actionId,
        canonicalPayloadHash,
        sourceRevisionHash: input.sourceRevisionHash,
        caseVersion: input.caseVersion,
        principal: {
          actorId: principal.actorId,
          workspaceId: principal.workspaceId,
          agentId: principal.agentId,
          installationId: principal.oauthInstallationId,
          bindingId: principal.bindingId,
          bindingRevision: principal.bindingRevision,
          connectionId: principal.connectionId,
        },
        ...(resolved.targetSessionId && resolved.targetSessionExpiresAt ? {
          target: {
            providerId: "quickbooks",
            tenantId: resolved.realmId,
            targetSessionId: resolved.targetSessionId,
            targetSessionExpiresAt: resolved.targetSessionExpiresAt,
          },
        } : {}),
        standingDelegations,
        writeKillSwitchEnabled: this.policy.writeEnabled,
        staticActionReleased: this.#enabledCapabilityKeys().includes(`${existing.operation}:${existing.entity}`) &&
          Boolean(this.policy.accountingCaseReleasedCapabilities?.includes(`${existing.operation}:${existing.entity}`)),
        transportScopeAllowed: context.scopes.includes("quickbooks.mutation.execute"),
        providerAccessDenyReasons: [...(resolved.providerAccessDenyReasons ?? [])],
        providerCapabilityReceiptHash,
        validation: validation
          ? { passed: true, receiptHash: validation.receiptHash }
          : { passed: false, reasonCodes: ["VALIDATION_RECEIPT_INVALID"] },
        now: authorizationEvaluatedAt,
      } satisfies EvaluateAutonomousLedgerWriteInput;
      const expectedAuthorizationEvidence = {
        preparationId: existing.preparationId,
        providerRequestId: existing.providerRequestId,
        stableOperationKey: input.stableOperationKey,
        actionId: input.actionId,
        actorId: existing.actorId,
        realmId: existing.realmId,
        preparationPayloadHash: existing.payloadHash,
        canonicalPayloadHash,
      };
      let authorizationEvidence = verifyQuickBooksAutonomousAuthorizationEvidence(
        existing.autonomousAuthorizationEvidence,
        expectedAuthorizationEvidence,
      );
      let currentDelegation: LedgerStandingDelegation;
      if (existing.autonomousAuthorizationEvidence && !authorizationEvidence) {
        throw new AppError("CONFIGURATION_ERROR", "QuickBooks durable autonomous authorization evidence failed integrity verification.", {
          httpStatus: 503,
          details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_INVALID"] },
        });
      }
      if (authorizationEvidence) {
        const reuseDecision = evaluateAutonomousLedgerReuse(authorityInput);
        if (!reuseDecision.allowed) {
          throw new AppError("FORBIDDEN", "QuickBooks shared mutation reuse authority was denied.", {
            httpStatus: 403,
            details: {
              failureLayer: "STANDING_DELEGATION",
              denyReasons: reuseDecision.denyReasons,
              providerAccessDenyReasons: reuseDecision.providerAccessDenyReasons,
              validationReasonCodes: reuseDecision.validationReasonCodes,
            },
          });
        }
        currentDelegation = reuseDecision.delegation;
      } else {
        const decision = evaluateAutonomousLedgerWrite(authorityInput);
        if (!decision.allowed) {
          throw new AppError("FORBIDDEN", "QuickBooks autonomous ledger authority was denied.", {
            httpStatus: 403,
            details: {
              failureLayer: "STANDING_DELEGATION",
              denyReasons: decision.denyReasons,
              providerAccessDenyReasons: decision.providerAccessDenyReasons,
              validationReasonCodes: decision.validationReasonCodes,
            },
          });
        }
        currentDelegation = decision.delegation;
        const candidate = issueQuickBooksAutonomousAuthorizationEvidence({
          preparationId: existing.preparationId,
          providerRequestId: existing.providerRequestId,
          stableOperationKey: input.stableOperationKey,
          actionId: input.actionId,
          preparationPayloadHash: existing.payloadHash,
          canonicalPayloadHash,
          caseId: input.caseId,
          caseVersion: input.caseVersion,
          sourceRevisionHash: input.sourceRevisionHash,
          deterministicValidationReceipt: input.validationReceipt,
          authorizationReceipt: decision.receipt,
          recordedAt: authorizationEvaluatedAt,
        });
        const recorded = await this.repository.recordAutonomousAuthorizationEvidence({
          preparationId: existing.preparationId,
          actorId: context.actorId,
          evidence: candidate,
          now: authorizationEvaluatedAt,
        });
        authorizationEvidence = verifyQuickBooksAutonomousAuthorizationEvidence(
          recorded.preparation.autonomousAuthorizationEvidence,
          expectedAuthorizationEvidence,
        );
        if (!authorizationEvidence) {
          throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence was not durably linked to the mutation.", {
            httpStatus: 503,
            details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_PERSISTENCE_MISMATCH"] },
          });
        }
      }
      if (!authorizationEvidence) {
        throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence is unavailable.", {
          httpStatus: 503,
          details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_MISSING"] },
        });
      }
      const causalitySnapshot = await this.#owned(input.preparationId, context.actorId);
      const durableAuthorizationEvidence = verifyQuickBooksAutonomousAuthorizationEvidence(
        causalitySnapshot.autonomousAuthorizationEvidence,
        expectedAuthorizationEvidence,
      );
      if (!durableAuthorizationEvidence ||
          !safeEqual(durableAuthorizationEvidence.authorizationIdentityHash, authorizationEvidence.authorizationIdentityHash)) {
        throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence changed or disappeared before execution claim.", {
          httpStatus: 503,
          details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_PERSISTENCE_MISMATCH"] },
        });
      }
      authorizationEvidence = durableAuthorizationEvidence;
      const originalDelegation = resolveQuickBooksAutonomousAuthorizationDelegationIdentity(authorizationEvidence, {
        preparationId: causalitySnapshot.preparationId,
        providerRequestId: causalitySnapshot.providerRequestId,
        actorId: causalitySnapshot.actorId,
        realmId: causalitySnapshot.realmId,
        preparationPayloadHash: causalitySnapshot.payloadHash,
      });
      if (!originalDelegation) {
        throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization delegation identity is invalid.", {
          httpStatus: 503,
          details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_INVALID"] },
        });
      }
      const providerDispatchCanStillBegin = causalitySnapshot.state === "PREPARED" ||
        (causalitySnapshot.state === "EXECUTING" && !causalitySnapshot.executionAttempt?.dispatchStartedAt);
      if (providerDispatchCanStillBegin &&
          (!safeEqual(currentDelegation.delegationId, originalDelegation.delegationId) ||
            currentDelegation.revision !== originalDelegation.delegationRevision)) {
        throw new AppError("FORBIDDEN", "QuickBooks original standing delegation changed before the first Provider dispatch.", {
          httpStatus: 403,
          details: {
            failureLayer: "AUTHORIZATION_CAUSALITY",
            reasonCodes: ["ORIGINAL_AUTHORIZATION_DELEGATION_CHANGED_BEFORE_FIRST_DISPATCH"],
            originalDelegationId: originalDelegation.delegationId,
            originalDelegationRevision: originalDelegation.delegationRevision,
            currentDelegationId: currentDelegation.delegationId,
            currentDelegationRevision: currentDelegation.revision,
          },
        });
      }
      const result = await this.#execute({
        actorId: context.actorId,
        preparation: existing,
        requestId: input.requestId,
        approvedBy: originalDelegation.approvedBy,
        humanReview: false,
        authorityMode: "AUTONOMOUS",
        resolved,
      });
      const reuseEvidenceReceipt = result.idempotentReplay ||
        authorizationEvidence.originCaseId !== input.caseId ||
        authorizationEvidence.originCaseVersion !== input.caseVersion ||
        authorizationEvidence.sourceRevisionHash !== input.sourceRevisionHash
        ? issueQuickBooksMutationReuseEvidence({
            authorizationEvidence,
            providerEntityId: result.providerEntityId,
            stableOperationKey: input.stableOperationKey,
            actionId: input.actionId,
            canonicalPayloadHash,
            caseId: input.caseId,
            caseVersion: input.caseVersion,
            sourceRevisionHash: input.sourceRevisionHash,
            deterministicValidationReceipt: input.validationReceipt,
            currentDelegationId: currentDelegation.delegationId,
            currentDelegationRevision: currentDelegation.revision,
            currentProviderCapabilityReceiptHash: providerCapabilityReceiptHash,
            issuedAt: new Date(),
          })
        : undefined;
      return {
        ...result,
        authorizationReceipt: authorizationEvidence.authorizationReceipt,
        authorizationEvidence,
        ...(reuseEvidenceReceipt ? { reuseEvidenceReceipt } : {}),
      };
    });
  }

  reject(options: { actorId: string; preparationId: string; rejectedBy: string }) {
    return this.#withAudit(options.actorId, "quickbooks_mutation_reject", options, () =>
      this.repository.reject({ ...options, now: new Date() }));
  }

  rejectAfterHumanReview(options: {
    actorId: string; preparationId: string; rejectedBy: string; sessionHash: string; csrfHash: string;
  }) {
    return this.#withAudit(options.actorId, "quickbooks_mutation_review_reject", {
      preparationId: options.preparationId,
      rejectedBy: options.rejectedBy,
    }, () => this.repository.rejectFromHumanReview({ ...options, now: new Date() }));
  }

  getPreparation(actorId: string, preparationId: string) {
    return this.#owned(preparationId, actorId);
  }

  async #execute(options: {
    actorId: string;
    preparation: QuickBooksMutationPreparation;
    requestId: string;
    confirmationPhraseHash?: string;
    approvedBy: string;
    humanReview: boolean;
    authorityMode: "CONFIRMATION" | "HUMAN_REVIEW" | "AUTONOMOUS";
    resolved?: Awaited<ReturnType<QuickBooksProviderResolver["resolve"]>>;
    sessionHash?: string;
    csrfHash?: string;
  }): Promise<QuickBooksMutationExecutionResult> {
    const resolved = options.resolved ?? (this.resolver.resolvePrepared
      ? await this.resolver.resolvePrepared(
          options.actorId,
          options.preparation.realmId,
          options.preparation.bindingRevision,
        )
      : await this.resolver.resolve(options.actorId));
    await this.#assertExecutionAllowed(
      options.preparation,
      resolved.realmId,
      resolved.bindingRevision,
      options.approvedBy,
      options.authorityMode,
    );
    const leaseTokenHash = sha256(randomBytes(32).toString("base64url"));
    const leaseOwner = `worker:${process.pid}:${randomUUID()}`;
    const claim = options.humanReview
      ? await this.repository.claimForHumanReview({
          preparationId: options.preparation.preparationId,
          actorId: options.actorId,
          sessionHash: options.sessionHash as string,
          csrfHash: options.csrfHash as string,
          approvedBy: options.approvedBy,
          leaseOwner,
          leaseTokenHash,
          leaseDurationMs: QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS,
          now: new Date(),
        })
      : await this.repository.claimForExecution({
          preparationId: options.preparation.preparationId,
          actorId: options.actorId,
          requestId: options.requestId,
          ...(options.confirmationPhraseHash ? { confirmationPhraseHash: options.confirmationPhraseHash } : {}),
          approvedBy: options.approvedBy,
          leaseOwner,
          leaseTokenHash,
          leaseDurationMs: QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS,
          now: new Date(),
        });
    const command = {
      entity: claim.preparation.entity,
      operation: claim.preparation.operation,
      payload: claim.preparation.payload,
      ...(claim.preparation.targetId ? { targetId: claim.preparation.targetId } : {}),
      ...(claim.preparation.syncToken ? { syncToken: claim.preparation.syncToken } : {}),
      requestId: claim.preparation.providerRequestId,
    };
    if (claim.recoveryOnly) {
      return this.#recoverExactProviderOutcome(claim.preparation, resolved, command);
    }
    if (!claim.shouldExecute) return this.#terminalResult(claim.preparation, true);
    if (!claim.preparation.executionAttempt) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks execution claim has no durable attempt lease.", {
        httpStatus: 503,
        details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_ATTEMPT_LEASE_MISSING"] },
      });
    }
    const attemptId = claim.preparation.executionAttempt.attemptId;
    const claimedLeaseTokenHash = leaseTokenHash;
    let written: Awaited<ReturnType<typeof resolved.provider.executeMutation>> | undefined;
    let returnedProviderOutcome: {
      providerEntityId: string;
      providerOutcomeReceipt: Record<string, unknown>;
    } | undefined;
    let dispatchStarted = false;
    try {
      const providerWritePermit = issueQuickBooksProviderWritePermit({
        claimedPreparation: claim.preparation,
      });
      written = await resolved.provider.executeMutation(command, providerWritePermit, async (outcome) => {
        const providerOutcomeReceipt = {
          ...outcome.receipt,
          evidenceType: "PROVIDER_OUTCOME_CHECKPOINT",
          realmId: claim.preparation.realmId,
          bindingRevision: claim.preparation.bindingRevision,
          entity: claim.preparation.entity,
          operation: claim.preparation.operation,
          providerRequestId: claim.preparation.providerRequestId,
          canonicalPayloadHash: claim.preparation.payloadHash,
        };
        // Keep the exact Provider Id in this process until it is durably
        // checkpointed. Retrying this database CAS is safe; retrying the
        // Provider write is never safe.
        returnedProviderOutcome = {
          providerEntityId: outcome.providerEntityId,
          providerOutcomeReceipt,
        };
        try {
          await this.repository.recordProviderOutcome({
            preparationId: claim.preparation.preparationId,
            attemptId,
            leaseTokenHash: claimedLeaseTokenHash,
            providerEntityId: outcome.providerEntityId,
            providerOutcomeReceipt,
            now: new Date(),
          });
        } catch (error) {
          throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks returned an exact entity Id, but its durable Provider-outcome checkpoint could not be committed; no write retry is allowed.", {
            httpStatus: 503, retryable: false,
            details: {
              preparationId: claim.preparation.preparationId,
              providerEntityId: outcome.providerEntityId,
              providerRequestId: claim.preparation.providerRequestId,
              providerMutationPossible: true,
              providerMutationRetried: false,
            },
            cause: error,
          });
        }
      }, async () => {
        await this.repository.markDispatchStarted({
          preparationId: claim.preparation.preparationId,
          attemptId,
          leaseTokenHash: claimedLeaseTokenHash,
          now: new Date(),
        });
        dispatchStarted = true;
      });
      const completed = await this.repository.completeVerified({
        preparationId: claim.preparation.preparationId,
        providerEntityId: written.providerEntityId,
        receipt: written.receipt,
        readback: written.readback,
        now: new Date(),
      });
      return this.#terminalResult(completed, false);
    } catch (error) {
      const safe = toSafeError(error);
      const localCompletionLost = written !== undefined;
      let persisted = await this.repository.get(claim.preparation.preparationId);
      if (dispatchStarted && !persisted?.providerEntityId && returnedProviderOutcome) {
        try {
          // A failed checkpoint acknowledgement must never induce another
          // Provider POST. Make one idempotent persistence retry while the
          // exact Id is still available, then recover by exact GET only.
          persisted = await this.repository.recordProviderOutcome({
            preparationId: claim.preparation.preparationId,
            attemptId,
            leaseTokenHash: claimedLeaseTokenHash,
            providerEntityId: returnedProviderOutcome.providerEntityId,
            providerOutcomeReceipt: returnedProviderOutcome.providerOutcomeReceipt,
            now: new Date(),
          });
        } catch {
          persisted = await this.repository.get(claim.preparation.preparationId);
        }
      }
      const providerOutcomeRecorded = persisted?.providerEntityId !== undefined;
      if (dispatchStarted && !providerOutcomeRecorded) {
        const providerEntityIdHint = returnedProviderOutcome?.providerEntityId ??
          (typeof safe.details?.providerEntityId === "string" ? safe.details.providerEntityId : undefined);
        const receipt = unknownNoIdResolutionReceipt({
          attemptId,
          providerRequestId: claim.preparation.providerRequestId,
          reasonCode: "DISPATCH_OUTCOME_NOT_CHECKPOINTED",
          resolvedAt: new Date(),
          ...(providerEntityIdHint ? { providerEntityIdHint } : {}),
        });
        await this.repository.resolveUnknownNoId({
          preparationId: claim.preparation.preparationId,
          attemptId,
          leaseTokenHash: claimedLeaseTokenHash,
          resolutionReceipt: receipt,
          now: new Date(),
        });
        throw new AppError(
          "WRITE_RESULT_UNKNOWN_NO_ID",
          "QuickBooks Provider dispatch started, but no exact Provider Id was durably checkpointed; operator resolution is required and automatic re-arm is forbidden.",
          {
            httpStatus: 503,
            retryable: false,
            details: {
              failureLayer: "PROVIDER_OUTCOME",
              preparationId: claim.preparation.preparationId,
              attemptId,
              providerRequestId: claim.preparation.providerRequestId,
              providerMutationPossible: true,
              providerMutationRetried: false,
              automaticRearmAllowed: false,
              operatorResolutionRequired: true,
              recoveryAction: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
              ...(providerEntityIdHint ? { providerEntityIdHint } : {}),
            },
            cause: error,
          },
        );
      }
      if (!dispatchStarted && !providerOutcomeRecorded && !isDefinitivePreDispatchFailure(safe.code)) {
        if (safe.code === "CONFLICT" && safe.details?.failureLayer === "EXECUTION_FENCING") {
          throw safe;
        }
        try {
          await this.repository.releasePreDispatchLease({
            preparationId: claim.preparation.preparationId,
            attemptId,
            leaseTokenHash: claimedLeaseTokenHash,
            now: new Date(),
          });
        } catch (leaseError) {
          throw toSafeError(leaseError);
        }
        throw new AppError(safe.code, safe.message, {
          httpStatus: safe.httpStatus,
          retryable: safe.retryable || safe.httpStatus >= 500,
          details: {
            ...safe.details,
            failureLayer: "PRE_DISPATCH_TRANSIENT",
            attemptId,
            providerRequestId: claim.preparation.providerRequestId,
            providerMutationPossible: false,
            providerMutationRetried: false,
            retrySamePreparation: true,
            recoveryAction: "RETRY_SAME_PREPARATION_AFTER_LEASE_RELEASE",
          },
          cause: error,
        });
      }
      const failureState = safe.code === "READBACK_MISMATCH"
        ? "READBACK_MISMATCH" as const
        : localCompletionLost || providerOutcomeRecorded || safe.code === "WRITE_RESULT_UNKNOWN"
          ? "WRITE_RESULT_UNKNOWN" as const
          : "BLOCKED_VALIDATION" as const;
      const failureAt = new Date();
      await this.repository.markFailure({
        preparationId: claim.preparation.preparationId,
        attemptId,
        leaseTokenHash: claimedLeaseTokenHash,
        providerRequestId: claim.preparation.providerRequestId,
        state: failureState,
        now: failureAt,
        ...(failureState === "BLOCKED_VALIDATION" ? {
          resolutionReceipt: resolvedNoWriteReceipt({
            attemptId,
            providerRequestId: claim.preparation.providerRequestId,
            reasonCode: `DEFINITIVE_PRE_DISPATCH_${safe.code}`,
            resolvedAt: failureAt,
          }),
        } : {}),
      });
      const exactProviderEntityId = persisted?.providerEntityId ?? written?.providerEntityId;
      if (safe.code === "READBACK_MISMATCH" && exactProviderEntityId) {
        throw new AppError("READBACK_MISMATCH", safe.message, {
          httpStatus: safe.httpStatus,
          retryable: false,
          details: {
            ...safe.details,
            providerEntityId: exactProviderEntityId,
            providerMutationPossible: true,
            providerMutationRetried: false,
            recoveryAction: "RECOVER_BY_EXACT_PROVIDER_ID_NO_SECOND_WRITE",
          },
          cause: error,
        });
      }
      if (localCompletionLost) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks write and readback succeeded, but durable terminal evidence could not be committed.", {
          httpStatus: 503,
          retryable: false,
          details: {
            providerEntityId: exactProviderEntityId,
            preparationId: claim.preparation.preparationId,
            providerMutationPossible: true,
            providerMutationRetried: false,
            recoveryAction: "RECOVER_BY_EXACT_PROVIDER_ID_NO_SECOND_WRITE",
          },
          cause: error,
        });
      }
      if (providerOutcomeRecorded && exactProviderEntityId) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks exact Provider outcome is durable, but verified readback did not complete; recover by exact Id without a second write.", {
          httpStatus: 503,
          retryable: false,
          details: {
            providerEntityId: exactProviderEntityId,
            preparationId: claim.preparation.preparationId,
            providerMutationPossible: true,
            providerMutationRetried: false,
            recoveryAction: "RECOVER_BY_EXACT_PROVIDER_ID_NO_SECOND_WRITE",
          },
          cause: error,
        });
      }
      throw safe;
    }
  }

  async #recoverExactProviderOutcome(
    preparation: QuickBooksMutationPreparation,
    resolved: Awaited<ReturnType<QuickBooksProviderResolver["resolve"]>>,
    command: Parameters<QuickBooksProviderCapabilities["recoverMutation"]>[0],
  ): Promise<QuickBooksMutationExecutionResult> {
    if (!preparation.providerEntityId || !preparation.providerOutcomeReceipt) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks mutation cannot be recovered automatically without a durable exact Provider Id.", {
        httpStatus: 503, retryable: false, details: { preparationId: preparation.preparationId, providerMutationRetried: false },
      });
    }
    try {
      const recovered = await resolved.provider.recoverMutation(command, preparation.providerEntityId);
      if (!safeEqual(recovered.providerEntityId, preparation.providerEntityId)) {
        throw new AppError("READBACK_MISMATCH", "QuickBooks recovery returned a different Provider entity Id.", {
          httpStatus: 502, details: { expectedProviderEntityId: preparation.providerEntityId, providerMutationRetried: false },
        });
      }
      const receipt = {
        ...preparation.providerOutcomeReceipt,
        verified: true,
        verification: "DURABLE_PROVIDER_OUTCOME_EXACT_ID_READBACK",
        recoveryOnly: true,
        providerMutationRetried: false,
        recoveryReceipt: recovered.receipt,
      };
      const completed = await this.repository.completeVerified({
        preparationId: preparation.preparationId,
        providerEntityId: preparation.providerEntityId,
        receipt,
        readback: recovered.readback,
        now: new Date(),
      });
      return this.#terminalResult(completed, true);
    } catch (error) {
      const safe = toSafeError(error);
      const attempt = preparation.executionAttempt;
      if (!attempt) {
        throw new AppError("CONFIGURATION_ERROR", "QuickBooks exact-Id recovery has no durable execution attempt.", {
          httpStatus: 503, details: { failureLayer: "EXECUTION_FENCING" }, cause: error,
        });
      }
      await this.repository.markFailure({
        preparationId: preparation.preparationId,
        attemptId: attempt.attemptId,
        leaseTokenHash: attempt.leaseTokenHash,
        providerRequestId: preparation.providerRequestId,
        state: safe.code === "READBACK_MISMATCH" ? "READBACK_MISMATCH" : "WRITE_RESULT_UNKNOWN",
        now: new Date(),
      });
      throw safe;
    }
  }

  async #assertExecutionAllowed(
    preparation: QuickBooksMutationPreparation,
    realmId: string,
    bindingRevision: string,
    approvedBy: string,
    authorityMode: "CONFIRMATION" | "HUMAN_REVIEW" | "AUTONOMOUS",
  ) {
    if (!this.policy.writeEnabled) {
      throw new AppError("FORBIDDEN", "QuickBooks writes are disabled for this deployment.", {
        httpStatus: 403, details: { failureLayer: "WRITE_POLICY", denyReasons: ["WRITE_KILL_SWITCH_DISABLED"] },
      });
    }
    if (
      this.policy.writeTargetMode === "exact_allowlist" &&
      (!this.policy.allowedRealmId || !safeEqual(this.policy.allowedRealmId, realmId))
    ) {
      throw new AppError("FORBIDDEN", "QuickBooks writes are not enabled for this exact Company.", {
        httpStatus: 403, details: { failureLayer: "TENANT_POLICY", denyReasons: ["STANDING_DELEGATION_TARGET_MISMATCH"] },
      });
    }
    if (!safeEqual(preparation.realmId, realmId) || !safeEqual(preparation.bindingRevision, bindingRevision)) {
      throw new AppError("FORBIDDEN", "The prepared QuickBooks target no longer matches the active OAuth binding.", {
        httpStatus: 403, details: { failureLayer: "TENANT_BINDING", denyReasons: ["TARGET_BINDING_INVALID"] },
      });
    }
    const capabilityKey = `${preparation.operation}:${preparation.entity}`;
    if (!this.#enabledCapabilityKeys().includes(capabilityKey)) {
      throw new AppError("FORBIDDEN", `${capabilityKey} is disabled by the QuickBooks runtime write policy.`, {
        httpStatus: 403, details: { failureLayer: "WRITE_POLICY", denyReasons: ["STATIC_ACTION_NOT_RELEASED"] },
      });
    }
    if (authorityMode === "AUTONOMOUS" &&
      !this.policy.accountingCaseReleasedCapabilities?.includes(capabilityKey)) {
      throw new AppError("FORBIDDEN", `${capabilityKey} is not released through the QuickBooks Accounting Case compiler.`, {
        httpStatus: 403,
        details: { failureLayer: "WRITE_POLICY", denyReasons: ["ACCOUNTING_CASE_ACTION_NOT_RELEASED"] },
      });
    }
    if (authorityMode !== "AUTONOMOUS" && preparation.executionMode === "RESTRICTED_HUMAN_REVIEW" &&
      !(this.policy.restrictedReviewerActors ?? []).some((actor) => safeEqual(actor, approvedBy))) {
      throw new AppError("FORBIDDEN", "This restricted QuickBooks action requires a separately allowlisted controller reviewer.", {
        httpStatus: 403, details: { failureLayer: "PROVIDER_ROLE", denyReasons: ["RESTRICTED_ROLE_REQUIRED"] },
      });
    }
    if (this.policy.executeScopeAuthorizer) {
      // Generic mutations and Accounting Cases are exposed behind the single
      // mutation.execute transport scope. Nothing here re-checks a per-entity
      // scope: doing so would make Case Bills impossible even though the caller
      // passed the Case tool's transport authorization.
      const requiredScope = "quickbooks.mutation.execute";
      if (!await this.policy.executeScopeAuthorizer(preparation.actorId, requiredScope)) {
        throw new AppError("FORBIDDEN", `The connected MCP installation does not grant ${requiredScope}.`, {
          httpStatus: 403, details: { failureLayer: "MCP_SCOPE", denyReasons: ["TRANSPORT_SCOPE_MISSING"] },
        });
      }
    } else if (authorityMode === "HUMAN_REVIEW" && preparation.executionMode === "RESTRICTED_HUMAN_REVIEW") {
      // A restricted action must never silently rely on an absent production scope authorizer.
      throw new AppError("FORBIDDEN", "Restricted QuickBooks execution scope authorization is not configured.", {
        httpStatus: 403, details: { failureLayer: "CONFIGURATION", denyReasons: ["SCOPE_AUTHORIZER_MISSING"] },
      });
    }
  }

  #enabledCapabilityKeys(): string[] {
    if (this.policy.allowedCapabilities?.length) return [...new Set(this.policy.allowedCapabilities)].sort();
    return QUICKBOOKS_WRITE_CAPABILITIES
      .filter((capability) => capability.enabledByDefault)
      .map((capability) => `${capability.operation}:${capability.entity}`)
      .sort();
  }

  async #owned(preparationId: string, actorId: string) {
    const preparation = await this.repository.get(preparationId);
    if (!preparation) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
    if (!safeEqual(preparation.actorId, actorId)) throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
    return preparation;
  }

  async #withAudit<T>(
    actorId: string,
    toolName: string,
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!this.audit) return action();
    const callId = `call_${randomUUID()}`;
    const intent: QuickBooksAuditIntent = {
      callId,
      actorId,
      toolName,
      requestHash: hashObject(input),
      resultStatus: "IN_PROGRESS",
      startedAt: new Date(),
    };
    try {
      await this.audit.beginAudit(intent);
    } catch (error) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks audit intent could not be persisted; the action was not run.", {
        httpStatus: 503,
        cause: error,
      });
    }
    let result: T;
    try {
      result = await action();
    } catch (error) {
      const safe = toSafeError(error);
      try {
        await this.audit.completeAudit(callId, {
          resultStatus: safe.httpStatus < 500 ? "REJECTED" : "FAILED",
          errorClass: safe.code,
          finishedAt: new Date(),
        });
      } catch (auditError) {
        throw new AppError(safe.code, safe.message, {
          httpStatus: safe.httpStatus,
          retryable: safe.retryable,
          details: { ...(safe.details ?? {}), auditCallId: callId, auditCompletionStatus: "UNKNOWN" },
          cause: new AggregateError([safe, auditError], "QuickBooks action and audit completion both failed."),
        });
      }
      throw safe;
    }
    const recordId = result && typeof result === "object"
      ? ((result as Record<string, unknown>).preparationId ?? (result as Record<string, unknown>).preparation_id)
      : undefined;
    const completion: QuickBooksAuditCompletion = {
      resultStatus: "SUCCEEDED",
      ...(typeof recordId === "string" ? { recordId } : {}),
      finishedAt: new Date(),
    };
    try {
      await this.audit.completeAudit(callId, completion);
    } catch (error) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks action completed, but audit completion is unknown; the result was withheld.", {
        httpStatus: 503,
        details: { auditCallId: callId, auditCompletionStatus: "UNKNOWN" },
        cause: error,
      });
    }
    return result;
  }

  #terminalResult(preparation: QuickBooksMutationPreparation, idempotentReplay: boolean): QuickBooksMutationExecutionResult {
    if (
      preparation.state !== "POSTED_READBACK_VERIFIED" ||
      !preparation.providerEntityId ||
      !preparation.writeReceipt ||
      !preparation.readback
    ) {
      throw new AppError("CONFLICT", "QuickBooks mutation has no verified terminal evidence.", { httpStatus: 409 });
    }
    return {
      preparationId: preparation.preparationId,
      state: "POSTED_READBACK_VERIFIED",
      entity: preparation.entity,
      operation: preparation.operation,
      providerEntityId: preparation.providerEntityId,
      receipt: preparation.writeReceipt,
      readback: preparation.readback,
      idempotentReplay,
    };
  }
}
