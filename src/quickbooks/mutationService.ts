import { randomBytes, randomUUID } from "node:crypto";
import { AppError, toSafeError } from "../errors.js";
import { hashObject, safeEqual, sha256 } from "../security/hash.js";
import {
  evaluateAutonomousLedgerWrite,
  type LedgerStandingDelegation,
} from "../ledger-control/ledgerControlKernel.js";
import {
  verifyDeterministicValidationReceipt,
  type DeterministicValidationReceipt,
} from "../ledger-control/deterministicValidation.js";
import { requireOAuthBoundRequestContext, type RequestContext } from "../security/requestContext.js";
import type { QuickBooksProviderResolver } from "./service.js";
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

export class QuickBooksMutationService {
  constructor(
    private readonly repository: QuickBooksMutationRepository,
    private readonly resolver: QuickBooksProviderResolver,
    private readonly policy: QuickBooksMutationRuntimePolicy,
    private readonly audit?: MutationAuditRepository,
    private readonly sourceAttestationVerifier?: QuickBooksSourceAttestationVerifier,
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
        .map((capability) => ({
          ...capability,
          runtimePolicyEnabled: enabledCapabilityKeys.includes(`${capability.operation}:${capability.entity}`),
          accountingCaseReleased: caseReleased?.has(`${capability.operation}:${capability.entity}`) ?? false,
          runtimeExecutionEnabled: this.policy.writeEnabled &&
            enabledCapabilityKeys.includes(`${capability.operation}:${capability.entity}`) &&
            (!caseReleased || caseReleased.has(`${capability.operation}:${capability.entity}`)) &&
            (this.policy.writeTargetMode === "oauth_bound" || Boolean(this.policy.allowedRealmId)),
        })),
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
    }, () => this.#prepare(actorId, input));
  }

  async #prepare(actorId: string, input: QuickBooksPrepareMutationInput) {
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
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    });
    if (!created.created && !safeEqual(created.preparation.payloadHash, payloadHash)) {
      throw new AppError("CONFLICT", "request_id was already used with a different QuickBooks mutation payload.", {
        httpStatus: 409,
      });
    }
    if (created.preparation.state !== "PREPARED") {
      throw new AppError("CONFLICT", `The QuickBooks mutation is already in ${created.preparation.state}.`, {
        httpStatus: 409,
      });
    }
    return {
      preparation_id: created.preparation.preparationId,
      state: "PREPARED" as const,
      entity: capability.entity,
      operation: capability.operation,
      official_tool: capability.officialTool,
      risk: capability.risk,
      execution_mode: capability.executionMode,
      provider_effect: capability.providerEffect,
      quickbooks_draft_available: capability.quickBooksDraftAvailable,
      provider_write_executed: false,
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
      review_required: capability.executionMode !== "EXPLICIT_CONFIRMATION",
      review_url: capability.executionMode !== "EXPLICIT_CONFIRMATION"
        ? `${this.policy.publicBaseUrl.replace(/\/$/, "")}/quickbooks/mutation-review/${created.preparation.preparationId}`
        : undefined,
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
    validationReceipt: DeterministicValidationReceipt;
  }): Promise<QuickBooksMutationExecutionResult & { authorizationReceipt: Record<string, unknown> }> {
    return this.#withAudit(context.actorId, "quickbooks_execute_accounting_case_operation", {
      preparationId: input.preparationId,
      requestId: input.requestId,
      actionId: input.actionId,
      caseId: input.caseId,
      caseVersion: input.caseVersion,
    }, async () => {
      const principal = requireOAuthBoundRequestContext(context);
      const existing = await this.#owned(input.preparationId, context.actorId);
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
      const providerCapabilityReceiptHash = hashObject({
        provider: "quickbooks",
        realmId: resolved.realmId,
        bindingRevision: resolved.bindingRevision,
        capability: `${existing.operation}:${existing.entity}`,
        executeScope: context.scopes.includes("quickbooks.mutation.execute"),
        checkedAt: input.validationReceipt.issuedAt,
      });
      const standingDelegations = this.policy.standingDelegationProvider
        ? await this.policy.standingDelegationProvider(context, resolved.realmId)
        : [];
      const decision = evaluateAutonomousLedgerWrite({
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
        staticActionReleased: this.#enabledCapabilityKeys().includes(`${existing.operation}:${existing.entity}`),
        transportScopeAllowed: context.scopes.includes("quickbooks.mutation.execute"),
        providerAccessDenyReasons: [],
        providerCapabilityReceiptHash,
        validation: validation
          ? { passed: true, receiptHash: validation.receiptHash }
          : { passed: false, reasonCodes: ["VALIDATION_RECEIPT_INVALID"] },
        now: new Date(input.validationReceipt.issuedAt),
      });
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
      const result = await this.#execute({
        actorId: context.actorId,
        preparation: existing,
        requestId: input.requestId,
        approvedBy: `standing:${decision.delegation.delegationId}`,
        humanReview: false,
        authorityMode: "AUTONOMOUS",
        resolved,
      });
      return { ...result, authorizationReceipt: decision.receipt as unknown as Record<string, unknown> };
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
    const claim = options.humanReview
      ? await this.repository.claimForHumanReview({
          preparationId: options.preparation.preparationId,
          actorId: options.actorId,
          sessionHash: options.sessionHash as string,
          csrfHash: options.csrfHash as string,
          approvedBy: options.approvedBy,
          now: new Date(),
        })
      : await this.repository.claimForExecution({
          preparationId: options.preparation.preparationId,
          actorId: options.actorId,
          requestId: options.requestId,
          ...(options.confirmationPhraseHash ? { confirmationPhraseHash: options.confirmationPhraseHash } : {}),
          approvedBy: options.approvedBy,
          now: new Date(),
        });
    if (!claim.shouldExecute) return this.#terminalResult(claim.preparation, true);
    let written: Awaited<ReturnType<typeof resolved.provider.executeMutation>> | undefined;
    try {
      written = await resolved.provider.executeMutation({
        entity: claim.preparation.entity,
        operation: claim.preparation.operation,
        payload: claim.preparation.payload,
        ...(claim.preparation.targetId ? { targetId: claim.preparation.targetId } : {}),
        ...(claim.preparation.syncToken ? { syncToken: claim.preparation.syncToken } : {}),
        requestId: claim.preparation.providerRequestId,
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
      await this.repository.markFailure(
        claim.preparation.preparationId,
        localCompletionLost || safe.code === "WRITE_RESULT_UNKNOWN"
          ? "WRITE_RESULT_UNKNOWN"
          : safe.code === "READBACK_MISMATCH"
            ? "READBACK_MISMATCH"
            : "BLOCKED_VALIDATION",
        new Date(),
      );
      if (localCompletionLost) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks write and readback succeeded, but durable terminal evidence could not be committed.", {
          httpStatus: 503,
          retryable: false,
          details: { providerEntityId: written?.providerEntityId, preparationId: claim.preparation.preparationId },
          cause: error,
        });
      }
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
    if (authorityMode !== "AUTONOMOUS" && preparation.executionMode === "RESTRICTED_HUMAN_REVIEW" &&
      !(this.policy.restrictedReviewerActors ?? []).some((actor) => safeEqual(actor, approvedBy))) {
      throw new AppError("FORBIDDEN", "This restricted QuickBooks action requires a separately allowlisted controller reviewer.", {
        httpStatus: 403, details: { failureLayer: "PROVIDER_ROLE", denyReasons: ["RESTRICTED_ROLE_REQUIRED"] },
      });
    }
    if (this.policy.executeScopeAuthorizer) {
      const requiredScope = preparation.entity === "Bill" && preparation.operation === "CREATE"
        ? "quickbooks.bill.execute"
        : "quickbooks.mutation.execute";
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
