import { AppError, toSafeError } from "../errors.js";
import { issueDeterministicValidationReceipt } from "../ledger-control/deterministicValidation.js";
import { hashObject, sha256 } from "../security/hash.js";
import { requireOAuthBoundRequestContext, type RequestContext } from "../security/requestContext.js";
import {
  QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION,
  QUICKBOOKS_ACCOUNTING_CASE_POLICY_VERSION,
  type CompiledQuickBooksAccountingCase,
  type QuickBooksAccountingCaseRecord,
  type QuickBooksAccountingFact,
  type QuickBooksCaseBinding,
  type QuickBooksCaseOperation,
  type QuickBooksCaseOperationRecord,
  type QuickBooksContactCandidateFact,
  type QuickBooksJournalEntryFact,
  type QuickBooksNativeDocumentFact,
  type QuickBooksSourceArtifact,
} from "./accountingCase.js";
import {
  compileQuickBooksAccountingCase,
  validateQuickBooksCompiledOperationAgainstSource,
} from "./accountingCaseCompiler.js";
import type { QuickBooksAccountingCaseRepository } from "./accountingCaseRepository.js";
import type {
  QuickBooksExecuteAccountingCaseInput,
  QuickBooksGetAccountingCaseStatusInput,
  QuickBooksPrepareAccountingCaseInput,
} from "./accountingCaseSchemas.js";
import type { QuickBooksMutationService } from "./mutationService.js";
import type { QuickBooksMutationPreparation } from "./mutationModels.js";
import type { QuickBooksProviderResolver, ResolvedQuickBooksProvider } from "./service.js";
import type { QuickBooksCompanyContext } from "../providers/quickbooksTypes.js";
import type { QuickBooksTaxCode } from "../providers/quickbooksTypes.js";
import {
  verifyQuickBooksAutonomousAuthorizationEvidence,
  verifyQuickBooksMutationReuseEvidence,
} from "./autonomousAuthorizationEvidence.js";

function scaled(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000n + BigInt((fraction + "0000").slice(0, 4));
}

function decimal(value: bigint): number {
  return Number(value) / 10_000;
}

const CENT_SCALE = 100n;

function cents(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * CENT_SCALE + BigInt((fraction + "00").slice(0, 2));
}

function roundRatioHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) {
    throw new AppError("VALIDATION_FAILED", "Tax calculation inputs are outside the released deterministic policy.", {
      httpStatus: 422,
      details: { failureLayer: "DETERMINISTIC_VALIDATION", reasonCodes: ["TAX_CALCULATION_OUT_OF_RANGE"] },
    });
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function hashReceiptBody(value: Record<string, unknown> | undefined): string | undefined {
  return value ? hashObject(value) : undefined;
}

function verifiesEmbeddedReceiptHash(value: Record<string, unknown> | undefined): boolean {
  if (!value || typeof value.receiptHash !== "string") return false;
  const { receiptHash, ...unsigned } = value;
  return hashObject(unsigned) === receiptHash;
}

function binding(
  context: RequestContext,
  resolved: ResolvedQuickBooksProvider,
  targetSessionRef: string,
): QuickBooksCaseBinding {
  const principal = requireOAuthBoundRequestContext(context);
  return {
    actorId: principal.actorId,
    workspaceId: principal.workspaceId,
    subjectType: principal.subjectType,
    subjectId: principal.subjectId,
    agentId: principal.agentId,
    installationId: principal.oauthInstallationId,
    bindingId: principal.bindingId,
    bindingRevision: principal.bindingRevision,
    connectionId: principal.connectionId,
    realmId: resolved.realmId,
    targetSessionHash: sha256(targetSessionRef),
  };
}

function planHash(caseBinding: QuickBooksCaseBinding, compiled: CompiledQuickBooksAccountingCase): string {
  // targetSessionHash is intentionally excluded: target_session_ref is a
  // short-lived proof, while the durable OAuth installation/connection/Realm
  // identity below is what owns the immutable Case. The original target hash
  // remains persisted on the Case as audit evidence.
  const { targetSessionHash: _ephemeralTargetProof, ...durableBinding } = caseBinding;
  return hashObject({ schemaVersion: "quickbooks-accounting-case-plan:v1", binding: durableBinding, compiled });
}

/**
 * A rejected operation may be re-armed only when nothing reached the Provider.
 * That is decided by the operation's own durable evidence, never by what its
 * last error receipt happened to say: the receipt is overwritten by any later
 * failure, so keying on it let one unrelated refusal permanently strand work
 * the ledger could still prove was never dispatched. The linked preparation is
 * checked separately by the caller, and the database enforces both halves.
 */
function isResumablePreDispatchRejection(record: QuickBooksCaseOperationRecord): boolean {
  return record.state === "PROVIDER_REJECTED" && Boolean(record.preparationId) &&
    !record.providerEntityId && !record.authorizationReceipt && !record.writeReceipt && !record.readback;
}

function operationStatus(
  record: QuickBooksCaseOperationRecord,
  caseRecord: Pick<QuickBooksAccountingCaseRecord, "binding" | "compiled">,
) {
  const authorizationReceiptRef = hashReceiptBody(record.authorizationReceipt);
  const providerReceiptRef = hashReceiptBody(record.writeReceipt);
  const readbackRef = hashReceiptBody(record.readback);
  const providerReceiptIdentityVerified = Boolean(record.writeReceipt && record.providerEntityId &&
    record.writeReceipt.providerEntityId === record.providerEntityId && record.writeReceipt.verified === true);
  const exactReadbackIdentityVerified = Boolean(record.readback && record.providerEntityId &&
    record.readback.Id === record.providerEntityId);
  const authorizationEvidenceVerified = Boolean(record.authorizationEvidence &&
    verifyQuickBooksAutonomousAuthorizationEvidence(record.authorizationEvidence, {
      preparationId: record.preparationId ?? "",
      providerRequestId: typeof record.authorizationEvidence.providerRequestId === "string"
        ? record.authorizationEvidence.providerRequestId
        : "",
      stableOperationKey: record.operation.stableOperationKey,
      actionId: record.operation.actionId,
      actorId: caseRecord.binding.actorId,
      realmId: caseRecord.binding.realmId,
      preparationPayloadHash: record.preparationPayloadHash ?? "",
      canonicalPayloadHash: record.operation.canonicalPayloadHash,
    }));
  const reuseEvidenceVerified = !record.reuseEvidenceReceipt || Boolean(record.authorizationEvidence && record.providerEntityId &&
    verifyQuickBooksMutationReuseEvidence(record.reuseEvidenceReceipt, {
      authorizationEvidence: record.authorizationEvidence,
      providerEntityId: record.providerEntityId,
      stableOperationKey: record.operation.stableOperationKey,
      actionId: record.operation.actionId,
      canonicalPayloadHash: record.operation.canonicalPayloadHash,
      caseId: caseRecord.compiled.caseId,
      caseVersion: caseRecord.compiled.version,
      sourceRevisionHash: caseRecord.compiled.sourceRevisionHash,
      deterministicValidationReceiptHash: record.operation.validationReceipt.receiptHash,
    }));
  const errorDetails = record.errorReceipt?.details && typeof record.errorReceipt.details === "object"
    ? record.errorReceipt.details as Record<string, unknown>
    : undefined;
  const operatorResolutionRequired = record.errorReceipt?.code === "WRITE_RESULT_UNKNOWN_NO_ID" ||
    errorDetails?.operatorResolutionRequired === true ||
    errorDetails?.operatorResolutionRequired !== false &&
      errorDetails?.automaticRearmAllowed === false && !record.providerEntityId;
  const nextAction = record.state === "PENDING" ? "EXECUTE_ACCOUNTING_CASE" :
    record.state === "PREPARED" ? "RESUME_IDEMPOTENT_EXECUTION" :
      record.state === "READBACK_VERIFIED" ? "NONE" :
        isResumablePreDispatchRejection(record)
          ? "RESUME_AFTER_MCP_EXECUTE_SCOPE_RESTORED" :
        record.state === "WRITE_UNCERTAIN" || record.state === "READBACK_MISMATCH"
          ? record.providerEntityId
            ? "RECOVER_BY_EXACT_PROVIDER_ID_NO_SECOND_WRITE"
            : operatorResolutionRequired
              ? "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM"
              : "INSPECT_DURABLE_MUTATION_BEFORE_RECOVERY"
          : "CORRECT_SOURCE_OR_PROVIDER_REFERENCES";
  return {
    operation_id: record.operation.operationId,
    event_id: record.operation.eventId,
    action_id: record.operation.actionId,
    entity: record.operation.entity,
    state: record.state,
    ...(record.providerEntityId ? { provider_entity_id: record.providerEntityId } : {}),
    authorization_receipt_recorded: record.authorizationReceipt !== undefined,
    provider_receipt_recorded: record.writeReceipt !== undefined,
    exact_readback_recorded: record.readback !== undefined,
    ...(authorizationReceiptRef ? {
      authorization_receipt_ref: authorizationReceiptRef,
      authorization_receipt: record.authorizationReceipt,
    } : {}),
    ...(record.authorizationEvidence ? {
      original_authorization_identity_ref: record.authorizationEvidence.authorizationIdentityHash,
      original_authorization_origin: {
        case_id: record.authorizationEvidence.originCaseId,
        case_version: record.authorizationEvidence.originCaseVersion,
      },
    } : {}),
    ...(record.reuseEvidenceReceipt ? {
      deterministic_reuse_evidence_ref: record.reuseEvidenceReceipt.receiptHash,
      deterministic_reuse_evidence: record.reuseEvidenceReceipt,
    } : {}),
    ...(providerReceiptRef ? {
      provider_receipt_ref: providerReceiptRef,
      provider_receipt: record.writeReceipt,
    } : {}),
    ...(readbackRef ? {
      exact_readback_ref: readbackRef,
      exact_readback: record.readback,
    } : {}),
    assurance: {
      authorization_receipt_hash_verified: verifiesEmbeddedReceiptHash(record.authorizationReceipt),
      authorization_causal_evidence_verified: authorizationEvidenceVerified,
      deterministic_reuse_evidence_verified: reuseEvidenceVerified,
      provider_receipt_identity_verified: providerReceiptIdentityVerified,
      exact_readback_identity_verified: exactReadbackIdentityVerified,
      all_required_evidence_verified: verifiesEmbeddedReceiptHash(record.authorizationReceipt) &&
        authorizationEvidenceVerified && reuseEvidenceVerified && providerReceiptIdentityVerified && exactReadbackIdentityVerified,
    },
    next_action: nextAction,
  };
}

function durableMutationRecovery(
  preparation: QuickBooksMutationPreparation,
  currentError: AppError,
): { error: AppError; state: "WRITE_UNCERTAIN" | "READBACK_MISMATCH"; providerEntityId?: string } | undefined {
  const currentControlFailure = {
    code: currentError.code,
    failureLayer: currentError.details?.failureLayer ?? null,
    reasonCodes: currentError.details?.reasonCodes ?? currentError.details?.denyReasons ?? null,
  };
  if (preparation.state === "WRITE_RESULT_UNKNOWN_NO_ID") {
    return {
      state: "WRITE_UNCERTAIN",
      error: new AppError(
        "WRITE_RESULT_UNKNOWN_NO_ID",
        "The durable QuickBooks mutation proves Provider dispatch without an exact Id; current authorization state cannot reclassify that possible write as a Provider rejection.",
        {
          httpStatus: 503,
          retryable: false,
          details: {
            failureLayer: "PROVIDER_OUTCOME",
            durableMutationState: preparation.state,
            attemptId: preparation.executionAttempt?.attemptId,
            providerRequestId: preparation.providerRequestId,
            providerMutationPossible: true,
            automaticRearmAllowed: false,
            operatorResolutionRequired: true,
            recoveryAction: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
            ...(preparation.executionAttempt?.resolutionReceipt ? {
              executionResolutionReceiptHash: hashObject(preparation.executionAttempt.resolutionReceipt),
            } : {}),
            currentControlFailure,
          },
          cause: currentError,
        },
      ),
    };
  }
  const exactOutcomeState = preparation.state === "PROVIDER_OUTCOME_RECORDED" ||
    preparation.state === "WRITE_RESULT_UNKNOWN" || preparation.state === "READBACK_MISMATCH" ||
    preparation.state === "POSTED_READBACK_VERIFIED";
  if (exactOutcomeState && preparation.providerEntityId && preparation.providerOutcomeReceipt) {
    const mismatch = preparation.state === "READBACK_MISMATCH";
    return {
      state: mismatch ? "READBACK_MISMATCH" : "WRITE_UNCERTAIN",
      providerEntityId: preparation.providerEntityId,
      error: new AppError(
        mismatch ? "READBACK_MISMATCH" : "WRITE_RESULT_UNKNOWN",
        "The durable QuickBooks mutation contains an exact Provider Id; current authorization state cannot overwrite its exact-Id recovery path.",
        {
          httpStatus: 503,
          retryable: false,
          details: {
            failureLayer: mismatch ? "READBACK" : "PROVIDER_OUTCOME",
            durableMutationState: preparation.state,
            providerEntityId: preparation.providerEntityId,
            providerRequestId: preparation.providerRequestId,
            providerOutcomeReceiptHash: hashObject(preparation.providerOutcomeReceipt),
            providerMutationPossible: true,
            providerMutationRetried: false,
            recoveryAction: "RECOVER_BY_EXACT_PROVIDER_ID_NO_SECOND_WRITE",
            currentControlFailure,
          },
          cause: currentError,
        },
      ),
    };
  }
  if (preparation.state === "EXECUTING" && preparation.executionAttempt?.dispatchStartedAt) {
    return {
      state: "WRITE_UNCERTAIN",
      error: new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The durable QuickBooks execution attempt crossed the Provider-dispatch boundary; current authorization state cannot terminalize the Case while its outcome is unresolved.",
        {
          httpStatus: 503,
          retryable: false,
          details: {
            failureLayer: "PROVIDER_OUTCOME",
            durableMutationState: preparation.state,
            executionAttemptState: preparation.executionAttempt.state,
            attemptId: preparation.executionAttempt.attemptId,
            providerRequestId: preparation.providerRequestId,
            providerMutationPossible: true,
            secondProviderDispatchAllowed: false,
            automaticRearmAllowed: false,
            operatorResolutionRequired: false,
            recoveryAction: "WAIT_FOR_ACTIVE_ATTEMPT_OR_STALE_RECONCILIATION",
            currentControlFailure,
          },
          cause: currentError,
        },
      ),
    };
  }
  return undefined;
}

function summary(record: QuickBooksAccountingCaseRecord) {
  const operations = record.operations.map((operation) => operationStatus(operation, record));
  const operationByEvent = new Map(operations.map((operation) => [operation.event_id, operation]));
  const verified = operations.filter((operation) => operation.state === "READBACK_VERIFIED").length;
  const uncertain = operations.some((operation) => operation.state === "WRITE_UNCERTAIN" || operation.state === "READBACK_MISMATCH");
  const eligibleWriteStatus = uncertain ? "UNKNOWN" as const : operations.length === 0 ? "NONE" as const :
    verified === operations.length ? "ALL_READBACK_VERIFIED" as const : verified > 0 ? "PARTIAL" as const : "NONE" as const;
  const ledgerWriteClaim = uncertain || record.state === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" as const :
    eligibleWriteStatus === "ALL_READBACK_VERIFIED" ? "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" as const :
      eligibleWriteStatus === "PARTIAL" ? "PARTIALLY_VERIFIED" as const : "NOT_WRITTEN" as const;
  const eventStatuses = record.compiled.events.map((event) => {
    const operation = operationByEvent.get(event.eventId);
    const executionDisposition = !operation ? event.disposition : operation.state === "READBACK_VERIFIED"
      ? "POSTED_READBACK_VERIFIED" : operation.state === "PENDING" ? "PENDING_EXECUTION"
        : operation.state === "PREPARED" ? "PREPARED_NOT_WRITTEN"
          : operation.state === "WRITE_UNCERTAIN" || operation.state === "READBACK_MISMATCH"
            ? "RECOVERY_REQUIRED" : "TERMINAL_BLOCKED";
    const nextAction = executionDisposition === "PENDING_EXECUTION" ? "EXECUTE_ACCOUNTING_CASE" :
      executionDisposition === "PREPARED_NOT_WRITTEN" ? "RESUME_IDEMPOTENT_EXECUTION" :
        executionDisposition === "RECOVERY_REQUIRED" ? operation?.next_action ?? "INSPECT_DURABLE_MUTATION_BEFORE_RECOVERY" :
          executionDisposition === "REVIEW_REQUIRED" ? "RESOLVE_REFERENCE_AND_PREPARE_NEW_CASE_VERSION" :
            executionDisposition === "BLOCKED_COVERAGE" ? "SUPPLY_MISSING_FACTS_AND_PREPARE_NEW_CASE_VERSION" :
              executionDisposition === "BLOCKED_VALIDATION" ? "CORRECT_FACTS_AND_PREPARE_NEW_CASE_VERSION" :
                executionDisposition === "BLOCKED_UNSUPPORTED" ? "KEEP_AS_TYPED_RESIDUAL" : "NONE";
    return {
      event_id: event.eventId,
      event_key: event.eventKey,
      source_unit_ids: event.sourceUnitIds,
      compiled_disposition: event.disposition,
      disposition: executionDisposition,
      ...(event.route ? { route: event.route } : {}),
      ...(event.unsupportedEventType ? { unsupported_event_type: event.unsupportedEventType } : {}),
      reason_codes: event.reasonCodes,
      next_action: nextAction,
    };
  });
  const allUnits = record.compiled.sources.flatMap((source) => source.units.map((unit) => unit.unitId));
  const terminalDispositions = new Set([
    "EVIDENCE_ONLY", "BLOCKED_UNSUPPORTED", "POSTED_READBACK_VERIFIED", "TERMINAL_BLOCKED",
  ]);
  const sourceUnits = allUnits.map((unitId) => {
    const related = eventStatuses.filter((event) => event.source_unit_ids.includes(unitId));
    const terminal = related.length > 0 && related.every((event) => terminalDispositions.has(event.disposition));
    return {
      source_unit_id: unitId,
      terminal,
      event_ids: related.map((event) => event.event_id),
      dispositions: [...new Set(related.map((event) => event.disposition))].sort(),
    };
  });
  const pendingEligibleWrites = eventStatuses.some((event) =>
    event.disposition === "PENDING_EXECUTION" || event.disposition === "PREPARED_NOT_WRITTEN");
  const residualEvents = record.compiled.events.some((event) =>
    event.disposition === "BLOCKED_COVERAGE" || event.disposition === "BLOCKED_VALIDATION" ||
    event.disposition === "BLOCKED_UNSUPPORTED" || event.disposition === "REVIEW_REQUIRED");
  const caseProcessingCompleteness = residualEvents
    ? (pendingEligibleWrites ? "RESIDUAL_EVENTS_AND_ELIGIBLE_WRITES_PENDING" as const : "RESIDUAL_EVENTS_REMAIN" as const)
    : pendingEligibleWrites ? "ELIGIBLE_WRITES_PENDING" as const : "ALL_TYPED_EVENTS_TERMINAL" as const;
  return {
    case_id: record.compiled.caseId,
    case_version: record.compiled.version,
    state: record.state,
    source_revision_hash: record.compiled.sourceRevisionHash,
    compiled_plan_hash: record.compiledPlanHash,
    compiler_version: record.compiled.compilerVersion,
    policy_version: record.compiled.policyVersion,
    coverage: {
      supplied_set: record.compiled.coverage.missingFactRequirements.length === 0 ? "COMPLETE" as const : "INCOMPLETE" as const,
      expected_artifacts: record.compiled.coverage.expectedArtifactCount,
      expected_source_units: record.compiled.coverage.expectedSourceUnitCount,
      expected_fact_requirements: record.compiled.coverage.expectedFactRequirementCount,
      satisfied_fact_requirements: record.compiled.coverage.satisfiedFactRequirementCount,
      missing_fact_requirements: record.compiled.coverage.missingFactRequirements,
    },
    events: eventStatuses,
    operations,
    source_unit_terminal_coverage: {
      expected_source_units: sourceUnits.length,
      dispositioned_source_units: sourceUnits.filter((unit) => unit.event_ids.length > 0).length,
      all_source_units_dispositioned: sourceUnits.every((unit) => unit.event_ids.length > 0),
      terminal_source_units: sourceUnits.filter((unit) => unit.terminal).length,
      all_source_units_terminal: sourceUnits.every((unit) => unit.terminal),
      units: sourceUnits,
    },
    residual_event_count: record.compiled.events.filter((event) =>
      event.disposition === "BLOCKED_COVERAGE" || event.disposition === "BLOCKED_VALIDATION" ||
      event.disposition === "BLOCKED_UNSUPPORTED" || event.disposition === "REVIEW_REQUIRED").length,
    completion_claim: {
      supplied_set_coverage: record.compiled.coverage.missingFactRequirements.length === 0 ? "COMPLETE" as const : "INCOMPLETE" as const,
      eligible_write_status: eligibleWriteStatus,
      whole_business_completeness: "NOT_ASSERTED" as const,
      case_processing_completeness: caseProcessingCompleteness,
      ledger_write_claim: ledgerWriteClaim,
    },
  };
}

function exactByName<T>(records: readonly T[], name: string, select: (value: T) => string | undefined, label: string): T {
  const normalized = name.toLocaleLowerCase("en");
  const matches = records.filter((record) => select(record)?.trim().toLocaleLowerCase("en") === normalized);
  if (matches.length !== 1) {
    throw new AppError("VALIDATION_FAILED", `Accounting Case could not resolve one exact active QuickBooks ${label} named ${name}.`, {
      httpStatus: 422,
      details: { failureLayer: "PROVIDER_REFERENCE", reasonCodes: [matches.length === 0 ? "REFERENCE_NOT_FOUND" : "REFERENCE_AMBIGUOUS"] },
    });
  }
  return matches[0] as T;
}

export class QuickBooksAccountingCaseService {
  readonly #clock: () => Date;

  constructor(
    private readonly repository: QuickBooksAccountingCaseRepository,
    private readonly resolver: QuickBooksProviderResolver,
    private readonly mutations: QuickBooksMutationService,
    options?: { clock?: () => Date },
  ) {
    this.#clock = options?.clock ?? (() => new Date());
  }

  async prepare(context: RequestContext, input: QuickBooksPrepareAccountingCaseInput) {
    requireOAuthBoundRequestContext(context);
    const resolved = await this.resolver.resolve(context.actorId, input.target_session_ref);
    const company = await resolved.provider.getCompanyContext();
    const baseCurrency = company.HomeCurrency?.value;
    if (!baseCurrency || !/^[A-Z]{3}$/u.test(baseCurrency)) {
      throw new AppError("VALIDATION_FAILED", "QuickBooks Company home currency is unavailable.", {
        httpStatus: 422, details: { failureLayer: "PROVIDER_CONFIGURATION", reasonCodes: ["HOME_CURRENCY_UNKNOWN"] },
      });
    }
    const draft = compileQuickBooksAccountingCase({
      caseId: input.case_id,
      expectedVersion: input.expected_version,
      sources: input.sources.map((source): QuickBooksSourceArtifact => ({
        artifactId: source.artifactId,
        label: source.label,
        units: source.units.map((unit) => ({
          unitId: unit.unitId,
          expectedFactKinds: [...unit.expectedFactKinds],
        })),
        ...(source.sourceRef ? { sourceRef: source.sourceRef } : {}),
        ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}),
        ...(source.sourceDigestProvenance ? { sourceDigestProvenance: source.sourceDigestProvenance } : {}),
        ...(source.sourceAttestationRef ? { sourceAttestationRef: source.sourceAttestationRef } : {}),
      })),
      facts: input.facts as QuickBooksAccountingFact[],
    });
    const operations: QuickBooksCaseOperation[] = [];
    if (draft.status === "PLANNED_NEEDS_PREFLIGHT" || draft.status === "PLANNED_WITH_EXCEPTIONS") {
      for (const candidate of draft.operationCandidates) {
        const fact = draft.activeFacts.find((entry) => entry.factId === candidate.primaryFactId);
        if (!fact) throw new AppError("CONFIGURATION_ERROR", "Accounting Case compiler lost a primary fact.", { httpStatus: 503 });
        let canonicalPayload: Record<string, unknown>;
        try {
          canonicalPayload = await this.#canonicalPayload(resolved, fact, company);
        } catch (error) {
          const safe = toSafeError(error);
          const failureLayer = safe.details?.failureLayer;
          if (safe.code !== "VALIDATION_FAILED" ||
              (failureLayer !== "PROVIDER_REFERENCE" && failureLayer !== "DETERMINISTIC_VALIDATION" &&
               failureLayer !== "ALREADY_SATISFIED" && failureLayer !== "PROVIDER_CONFIGURATION")) {
            throw error;
          }
          const event = draft.events.find((entry) => entry.eventId === candidate.eventId);
          if (event) {
            // PROVIDER_CONFIGURATION is a fact about the ledger, not about the
            // facts submitted, so re-preparing cannot clear it — someone has to
            // decide something in QuickBooks. It also must not sink the whole
            // Case: when a company cannot hold foreign currency, its contacts
            // are still perfectly creatable, and failing the prepare outright
            // would throw that work away along with the documents.
            event.disposition = failureLayer === "PROVIDER_REFERENCE" ||
              failureLayer === "PROVIDER_CONFIGURATION" ? "REVIEW_REQUIRED"
              : failureLayer === "ALREADY_SATISFIED" ? "EVIDENCE_ONLY"
                : "BLOCKED_VALIDATION";
            const reasonCodes = Array.isArray(safe.details?.reasonCodes)
              ? safe.details.reasonCodes.filter((reason): reason is string => typeof reason === "string")
              : [safe.code];
            event.reasonCodes = [...new Set([...event.reasonCodes, ...reasonCodes])].sort();
          }
          continue;
        }
        const canonicalPayloadHash = hashObject(canonicalPayload);
        const validationChecks: Array<{ code: string; evidence: Record<string, unknown> }> = [
          { code: "SOURCE_COVERAGE_COMPLETE", evidence: { ...draft.coverage } },
          { code: "SOURCE_FACT_LINKED", evidence: {
            sourceFactHash: candidate.sourceFactHash,
            sourceEvidenceHash: candidate.sourceEvidenceHash,
            sourceUnitIds: candidate.sourceUnitIds,
          } },
          { code: "SERVER_TOTALS_RECOMPUTED", evidence: { eventId: candidate.eventId, payloadHash: canonicalPayloadHash } },
          { code: "PROVIDER_REFERENCES_EXACT", evidence: { realmId: resolved.realmId, entity: candidate.entity } },
        ];
        if (candidate.amountBridge) {
          validationChecks.push({ code: "SOURCE_AMOUNT_BRIDGE_MATCHED", evidence: { ...candidate.amountBridge } });
        }
        const validationReceipt = issueDeterministicValidationReceipt({
          actionId: candidate.actionId,
          canonicalPayloadHash,
          sourceRevisionHash: draft.sourceRevisionHash,
          caseId: draft.caseId,
          caseVersion: draft.version,
          policyVersion: draft.policyVersion,
          compilerVersion: draft.compilerVersion,
          checks: validationChecks,
          now: this.#clock(),
        });
        const operation = { ...candidate, canonicalPayload, canonicalPayloadHash, validationReceipt };
        const sourceMismatches = validateQuickBooksCompiledOperationAgainstSource(operation, fact);
        if (sourceMismatches.length > 0) {
          const event = draft.events.find((entry) => entry.eventId === candidate.eventId);
          if (event) {
            event.disposition = "BLOCKED_VALIDATION";
            event.reasonCodes = [...new Set([...event.reasonCodes, ...sourceMismatches])].sort();
          }
          continue;
        }
        operations.push(operation);
      }
    }
    const compiledStatus = draft.events.some((event) => event.disposition === "BLOCKED_COVERAGE")
      ? "BLOCKED_COVERAGE" as const
      : draft.events.some((event) => event.disposition === "BLOCKED_VALIDATION")
        ? "BLOCKED_VALIDATION" as const
        : draft.events.some((event) =>
          event.disposition === "REVIEW_REQUIRED" || event.disposition === "BLOCKED_UNSUPPORTED")
          ? "PLANNED_WITH_EXCEPTIONS" as const
          : "PLANNED_NEEDS_PREFLIGHT" as const;
    const compiled: CompiledQuickBooksAccountingCase = {
      ...draft,
      status: compiledStatus,
      realmId: resolved.realmId,
      companyName: resolved.companyName,
      baseCurrency,
      operations,
    };
    const caseBinding = binding(context, resolved, input.target_session_ref);
    const compiledPlanHash = planHash(caseBinding, compiled);
    const persisted = await this.repository.createOrAdvance({
      binding: caseBinding,
      compiled,
      compiledPlanHash,
      now: this.#clock(),
    });
    return { ...summary(persisted.record), persistence_mode: persisted.mode };
  }

  async status(context: RequestContext, input: QuickBooksGetAccountingCaseStatusInput) {
    const resolved = await this.resolver.resolve(context.actorId, input.target_session_ref);
    const caseBinding = binding(context, resolved, input.target_session_ref);
    const record = await this.repository.getBound({
      binding: caseBinding,
      caseId: input.case_id,
      ...(input.case_version ? { version: input.case_version } : {}),
    });
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    this.#verify(record);
    return summary(record);
  }

  async execute(context: RequestContext, input: QuickBooksExecuteAccountingCaseInput) {
    if (!context.scopes.includes("quickbooks.mutation.execute")) {
      throw new AppError("FORBIDDEN", "The QuickBooks mutation execute scope is required.", {
        httpStatus: 403, details: { failureLayer: "MCP_SCOPE", reasonCodes: ["TRANSPORT_SCOPE_MISSING"] },
      });
    }
    const resolved = await this.resolver.resolve(context.actorId, input.target_session_ref);
    const caseBinding = binding(context, resolved, input.target_session_ref);
    let record = await this.repository.getBound({ binding: caseBinding, caseId: input.case_id, version: input.case_version });
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    this.#verify(record);
    if (record.state === "BLOCKED_COVERAGE" || record.state === "BLOCKED_VALIDATION") {
      throw new AppError("VALIDATION_FAILED", "Accounting Case coverage or deterministic validation has not passed.", {
        httpStatus: 422, details: { failureLayer: "DETERMINISTIC_VALIDATION", reasonCodes: [record.state] },
      });
    }
    record = (await this.repository.claimExecution({
      binding: caseBinding,
      caseId: input.case_id,
      version: input.case_version,
      requestId: input.request_id,
      expectedPlanHash: record.compiledPlanHash,
      now: this.#clock(),
    })).record;
    if (record.state === "TERMINAL") return summary(record);
    for (const current of record.operations) {
      if (current.state === "READBACK_VERIFIED") continue;
      const operation = current.operation;
      const sourceFact = record.compiled.activeFacts.find((fact) => fact.factId === operation.primaryFactId);
      if (!sourceFact || operation.sourceRevisionHash !== record.compiled.sourceRevisionHash) {
        throw new AppError("CONFIGURATION_ERROR", "Accounting Case operation source linkage is unavailable.", {
          httpStatus: 503,
          details: { failureLayer: "PERSISTENCE", reasonCodes: ["SOURCE_LINKAGE_MISSING"] },
        });
      }
      const sourceMismatches = validateQuickBooksCompiledOperationAgainstSource(operation, sourceFact);
      if (sourceMismatches.length > 0) {
        throw new AppError("VALIDATION_FAILED", "Accounting Case operation no longer matches its immutable source fact.", {
          httpStatus: 422,
          details: { failureLayer: "DETERMINISTIC_VALIDATION", reasonCodes: sourceMismatches },
        });
      }
      const operationRequestId = `qbocase.${operation.stableOperationKey.slice(0, 40)}`;
      let preparationId = current.preparationId;
      try {
        if (current.state === "PROVIDER_REJECTED") {
          if (!isResumablePreDispatchRejection(current) || !preparationId) {
            throw new AppError("CONFLICT", "A definitive QuickBooks operation rejection cannot be retried in place.", {
              httpStatus: 409,
              details: { failureLayer: "PROVIDER_OUTCOME", reasonCodes: ["TERMINAL_REJECTION_NOT_RETRYABLE"] },
            });
          }
          const preDispatchPreparation = await this.mutations.getPreparation(context.actorId, preparationId);
          if (preDispatchPreparation.state !== "PREPARED" || preDispatchPreparation.providerEntityId ||
            preDispatchPreparation.providerOutcomeReceipt || preDispatchPreparation.executionAttempt) {
            throw new AppError("CONFIGURATION_ERROR", "MCP scope rejection cannot be re-armed because durable no-dispatch evidence is incomplete.", {
              httpStatus: 503,
              details: { failureLayer: "PROVIDER_OUTCOME", reasonCodes: ["NO_DISPATCH_EVIDENCE_INVALID"] },
            });
          }
          record = await this.repository.updateOperation({
            binding: caseBinding, caseId: input.case_id, version: input.case_version,
            operationId: operation.operationId, requestId: input.request_id,
            expectedStates: ["PROVIDER_REJECTED"], state: "PREPARED", now: this.#clock(),
          });
        }
        if ((current.state === "WRITE_UNCERTAIN" || current.state === "READBACK_MISMATCH") && !preparationId) {
          throw new AppError("CONFIGURATION_ERROR", "Accounting Case recovery has no linked durable mutation preparation.", {
            httpStatus: 503, details: { failureLayer: "PERSISTENCE", reasonCodes: ["RECOVERY_PREPARATION_MISSING"] },
          });
        }
        if (!preparationId) {
          const prepared = await this.mutations.prepareCaseOperation(context.actorId, {
            target_session_ref: input.target_session_ref,
            request_id: operationRequestId,
            entity: operation.entity,
            operation: operation.operation,
            payload: operation.canonicalPayload,
            business_reason: `Accounting Case stable source operation ${operation.stableOperationKey}`,
            ...this.#sourceIdentity(record, operation),
          });
          preparationId = prepared.preparation_id;
          record = await this.repository.updateOperation({
            binding: caseBinding, caseId: input.case_id, version: input.case_version,
            operationId: operation.operationId, requestId: input.request_id, expectedStates: ["PENDING"],
            state: "PREPARED", preparationId,
            preparationPayloadHash: prepared.canonical_payload_hash,
            operationSourceEvidenceHash: operation.sourceEvidenceHash,
            now: this.#clock(),
          });
        }
        const executed = await this.mutations.executeAutonomously(context, {
          preparationId,
          requestId: operationRequestId,
          targetSessionRef: input.target_session_ref,
          actionId: operation.actionId,
          caseId: input.case_id,
          caseVersion: input.case_version,
          sourceRevisionHash: record.compiled.sourceRevisionHash,
          stableOperationKey: operation.stableOperationKey,
          validationReceipt: operation.validationReceipt,
        });
        record = await this.repository.updateOperation({
          binding: caseBinding, caseId: input.case_id, version: input.case_version,
          operationId: operation.operationId, requestId: input.request_id,
          expectedStates: ["PREPARED", "WRITE_UNCERTAIN", "READBACK_MISMATCH"],
          state: "READBACK_VERIFIED", preparationId, mutationRequestId: operationRequestId,
          providerEntityId: executed.providerEntityId, authorizationReceipt: executed.authorizationReceipt,
          authorizationEvidence: executed.authorizationEvidence,
          ...(executed.reuseEvidenceReceipt ? { reuseEvidenceReceipt: executed.reuseEvidenceReceipt } : {}),
          writeReceipt: executed.receipt, readback: executed.readback, now: this.#clock(),
        });
      } catch (error) {
        let safe = toSafeError(error);
        let errorToThrow: unknown = error;
        let durablePreparation: QuickBooksMutationPreparation | undefined;
        if (preparationId) {
          try {
            durablePreparation = await this.mutations.getPreparation(context.actorId, preparationId);
          } catch (durableLookupError) {
            throw new AppError(
              "CONFIGURATION_ERROR",
              "Accounting Case could not inspect its linked durable mutation after an execution error; the Case remains resumable and must not be terminalized without that write-state evidence.",
              {
                httpStatus: 503,
                retryable: true,
                details: {
                  failureLayer: "PERSISTENCE",
                  reasonCodes: ["DURABLE_MUTATION_STATE_UNAVAILABLE"],
                  preparationId,
                  currentErrorCode: safe.code,
                },
                cause: new AggregateError([error, durableLookupError], "Execution and durable mutation lookup both failed."),
              },
            );
          }
        }
        const currentPreDispatchTransient = safe.details?.failureLayer === "PRE_DISPATCH_TRANSIENT" &&
          safe.details.providerMutationPossible === false;
        // The durable row, not the error's shape, is what proves the Provider was
        // never reached: a real Provider rejection always passes the dispatch
        // marker first, so it leaves an execution attempt behind. Classifying on
        // details.failureLayer alone missed every refusal that carries no details
        // — a target session expiring mid-execute, a reconnect, a binding
        // revision moving — and recorded PROVIDER_REJECTED for work Intuit never
        // saw, terminalizing the Case and putting a falsehood in the audit trail.
        const durablyNeverDispatched = durablePreparation?.state === "PREPARED" &&
          !durablePreparation.providerEntityId &&
          !durablePreparation.providerOutcomeReceipt && !durablePreparation.executionAttempt;
        if (!currentPreDispatchTransient && durablePreparation?.state === "EXECUTING" &&
          durablePreparation.executionAttempt && !durablePreparation.executionAttempt.dispatchStartedAt) {
          throw new AppError(
            "CONFLICT",
            "Accounting Case cannot be terminalized while its durable mutation has an unresolved pre-dispatch execution attempt.",
            {
              httpStatus: 409,
              retryable: true,
              details: {
                failureLayer: "EXECUTION_FENCING",
                reasonCodes: safe.details?.failureLayer === "EXECUTION_FENCING" &&
                  Array.isArray(safe.details.reasonCodes)
                  ? safe.details.reasonCodes
                  : ["EXECUTION_LEASE_ACTIVE_OR_RECLAIMABLE"],
                attemptId: durablePreparation.executionAttempt.attemptId,
                executionAttemptState: durablePreparation.executionAttempt.state,
                providerMutationPossible: false,
                caseTerminalizationAllowed: false,
                currentControlFailure: {
                  code: safe.code,
                  failureLayer: safe.details?.failureLayer ?? null,
                  reasonCodes: safe.details?.reasonCodes ?? safe.details?.denyReasons ?? null,
                },
              },
              cause: error,
            },
          );
        }
        const terminalAuthorizationEvidence = durablePreparation?.state === "POSTED_READBACK_VERIFIED" &&
          durablePreparation.providerEntityId && durablePreparation.providerOutcomeReceipt &&
          durablePreparation.writeReceipt && durablePreparation.readback &&
          durablePreparation.autonomousAuthorizationEvidence && preparationId
          ? verifyQuickBooksAutonomousAuthorizationEvidence(durablePreparation.autonomousAuthorizationEvidence, {
              preparationId,
              providerRequestId: durablePreparation.providerRequestId,
              stableOperationKey: operation.stableOperationKey,
              actionId: operation.actionId,
              actorId: record.binding.actorId,
              realmId: record.binding.realmId,
              preparationPayloadHash: durablePreparation.payloadHash,
              canonicalPayloadHash: operation.canonicalPayloadHash,
            })
          : undefined;
        const currentCaseOperation = record.operations.find((entry) => entry.operation.operationId === operation.operationId);
        const canProjectOriginTerminalOutcome = Boolean(terminalAuthorizationEvidence && durablePreparation &&
          terminalAuthorizationEvidence.originCaseId === input.case_id &&
          terminalAuthorizationEvidence.originCaseVersion === input.case_version &&
          terminalAuthorizationEvidence.sourceRevisionHash === record.compiled.sourceRevisionHash &&
          terminalAuthorizationEvidence.deterministicValidationReceipt.receiptHash === operation.validationReceipt.receiptHash &&
          currentCaseOperation?.preparationId === durablePreparation.preparationId &&
          currentCaseOperation.preparationPayloadHash === durablePreparation.payloadHash &&
          durablePreparation.payloadHash === operation.canonicalPayloadHash &&
          durablePreparation.writeReceipt?.providerEntityId === durablePreparation.providerEntityId &&
          durablePreparation.writeReceipt?.verified === true &&
          durablePreparation.readback?.Id === durablePreparation.providerEntityId);
        if (canProjectOriginTerminalOutcome && preparationId && durablePreparation && terminalAuthorizationEvidence &&
          durablePreparation.providerEntityId && durablePreparation.writeReceipt && durablePreparation.readback) {
          record = await this.repository.updateOperation({
            binding: caseBinding, caseId: input.case_id, version: input.case_version,
            operationId: operation.operationId, requestId: input.request_id,
            expectedStates: ["PREPARED", "WRITE_UNCERTAIN", "READBACK_MISMATCH"],
            state: "READBACK_VERIFIED", preparationId, mutationRequestId: operationRequestId,
            providerEntityId: durablePreparation.providerEntityId,
            authorizationReceipt: terminalAuthorizationEvidence.authorizationReceipt,
            authorizationEvidence: terminalAuthorizationEvidence,
            writeReceipt: durablePreparation.writeReceipt,
            readback: durablePreparation.readback,
            errorReceipt: {
              code: "CASE_CHECKPOINT_RECOVERED_FROM_DURABLE_MUTATION",
              message: "The Provider write and exact readback were already durable; the Accounting Case checkpoint was projected from its original authorization evidence.",
              retryable: false,
              details: { currentControlFailure: { code: safe.code, details: safe.details ?? null } },
            },
            now: this.#clock(),
          });
          continue;
        }
        const durableRecovery = durablePreparation ? durableMutationRecovery(durablePreparation, safe) : undefined;
        if (durableRecovery) {
          safe = durableRecovery.error;
          errorToThrow = durableRecovery.error;
        }
        const executionFenced = safe.code === "CONFLICT" && (
          safe.details?.failureLayer === "EXECUTION_FENCING" ||
          Array.isArray(safe.details?.reasonCodes) && (
            safe.details.reasonCodes.includes("SHARED_MUTATION_IN_FLIGHT") ||
            safe.details.reasonCodes.includes("EXECUTION_LEASE_ACTIVE") ||
            safe.details.reasonCodes.includes("EXECUTION_LEASE_INVALID")
          )
        );
        const preDispatchTransient = currentPreDispatchTransient;
        if (executionFenced || preDispatchTransient || durablyNeverDispatched) {
          // Another Case owns the same stable durable mutation right now. Keep
          // this Case resumable under its existing execution request. A
          // transient pre-dispatch failure is equally safe to retry because
          // the mutation lease was durably released before this error escaped.
          // The same holds for anything the durable row shows never dispatched:
          // the Case stays resumable and the operation keeps its true state
          // rather than being recorded as rejected by a Provider that never saw it.
          throw safe;
        }
        const providerMutationPossible = safe.code === "WRITE_RESULT_UNKNOWN" ||
          safe.code === "WRITE_RESULT_UNKNOWN_NO_ID" || safe.code === "READBACK_MISMATCH" ||
          safe.details?.providerMutationPossible === true;
        const exactProviderEntityId = typeof safe.details?.providerEntityId === "string"
          ? safe.details.providerEntityId
          : undefined;
        record = await this.repository.updateOperation({
          binding: caseBinding, caseId: input.case_id, version: input.case_version,
          operationId: operation.operationId, requestId: input.request_id,
          expectedStates: ["PENDING", "PREPARED", "WRITE_UNCERTAIN", "READBACK_MISMATCH"],
          state: durableRecovery?.state ?? (
            safe.code === "WRITE_RESULT_UNKNOWN" || safe.code === "WRITE_RESULT_UNKNOWN_NO_ID"
              ? "WRITE_UNCERTAIN" :
            safe.code === "READBACK_MISMATCH" ? "READBACK_MISMATCH" :
              providerMutationPossible ? "WRITE_UNCERTAIN" :
                safe.code === "VALIDATION_FAILED" ? "BLOCKED_VALIDATION" : "PROVIDER_REJECTED"),
          ...(durableRecovery?.providerEntityId
            ? { providerEntityId: durableRecovery.providerEntityId }
            : exactProviderEntityId ? { providerEntityId: exactProviderEntityId } : {}),
          errorReceipt: { code: safe.code, message: safe.message, retryable: safe.retryable, details: safe.details ?? null },
          now: this.#clock(),
        });
        const recovery = record.operations.some((entry) => entry.state === "WRITE_UNCERTAIN" || entry.state === "READBACK_MISMATCH");
        record = await this.repository.finalize({
          binding: caseBinding, caseId: input.case_id, version: input.case_version, requestId: input.request_id,
          state: recovery ? "RECOVERY_REQUIRED" : "TERMINAL",
          terminalSummary: { completion: recovery ? "RECOVERY_REQUIRED" : "BLOCKED", errorCode: safe.code },
          now: this.#clock(),
        });
        throw errorToThrow;
      }
    }
    record = await this.repository.finalize({
      binding: caseBinding, caseId: input.case_id, version: input.case_version, requestId: input.request_id,
      state: "TERMINAL",
      terminalSummary: {
        completion: record.compiled.events.some((event) =>
          event.disposition === "BLOCKED_UNSUPPORTED" || event.disposition === "REVIEW_REQUIRED")
          ? (record.operations.length > 0
              ? "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED_WITH_RESIDUALS"
              : "NO_ELIGIBLE_WRITES_WITH_RESIDUALS")
          : (record.operations.length > 0 ? "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" : "NO_ELIGIBLE_WRITES"),
      },
      now: this.#clock(),
    });
    return summary(record);
  }

  #verify(record: QuickBooksAccountingCaseRecord): void {
    if (record.compiledPlanHash !== planHash(record.binding, record.compiled)) {
      throw new AppError("CONFIGURATION_ERROR", "Accounting Case plan integrity verification failed.", {
        httpStatus: 503, details: { failureLayer: "PERSISTENCE" },
      });
    }
    for (const operation of record.operations) {
      if (operation.operation.canonicalPayloadHash !== hashObject(operation.operation.canonicalPayload)) {
        throw new AppError("CONFIGURATION_ERROR", "Accounting Case operation payload integrity failed.", {
          httpStatus: 503, details: { failureLayer: "PERSISTENCE" },
        });
      }
      const sourceFact = record.compiled.activeFacts.find((fact) => fact.factId === operation.operation.primaryFactId);
      const sourceMismatches = sourceFact
        ? validateQuickBooksCompiledOperationAgainstSource(operation.operation, sourceFact)
        : ["SOURCE_FACT_MISSING"];
      if (operation.operation.sourceRevisionHash !== record.compiled.sourceRevisionHash || sourceMismatches.length > 0) {
        throw new AppError("CONFIGURATION_ERROR", "Accounting Case operation source evidence integrity failed.", {
          httpStatus: 503,
          details: { failureLayer: "PERSISTENCE", reasonCodes: sourceMismatches },
        });
      }
      const authorizationEvidence = operation.authorizationEvidence && operation.preparationId && operation.preparationPayloadHash
        ? verifyQuickBooksAutonomousAuthorizationEvidence(operation.authorizationEvidence, {
            preparationId: operation.preparationId,
            providerRequestId: operation.authorizationEvidence.providerRequestId,
            stableOperationKey: operation.operation.stableOperationKey,
            actionId: operation.operation.actionId,
            actorId: record.binding.actorId,
            realmId: record.binding.realmId,
            preparationPayloadHash: operation.preparationPayloadHash,
            canonicalPayloadHash: operation.operation.canonicalPayloadHash,
          })
        : undefined;
      if (operation.state === "READBACK_VERIFIED") {
        if (!authorizationEvidence || !operation.authorizationReceipt ||
            hashObject(operation.authorizationReceipt) !== hashObject(authorizationEvidence.authorizationReceipt) ||
            !operation.providerEntityId || !operation.writeReceipt || !operation.readback ||
            operation.writeReceipt.providerEntityId !== operation.providerEntityId ||
            operation.readback.Id !== operation.providerEntityId) {
          throw new AppError("CONFIGURATION_ERROR", "Accounting Case terminal write evidence integrity failed.", {
            httpStatus: 503,
            details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["TERMINAL_CAUSAL_EVIDENCE_INVALID"] },
          });
        }
        const reuseRequired = authorizationEvidence.originCaseId !== record.compiled.caseId ||
          authorizationEvidence.originCaseVersion !== record.compiled.version ||
          authorizationEvidence.sourceRevisionHash !== record.compiled.sourceRevisionHash;
        const reuse = operation.reuseEvidenceReceipt
          ? verifyQuickBooksMutationReuseEvidence(operation.reuseEvidenceReceipt, {
              authorizationEvidence,
              providerEntityId: operation.providerEntityId,
              stableOperationKey: operation.operation.stableOperationKey,
              actionId: operation.operation.actionId,
              canonicalPayloadHash: operation.operation.canonicalPayloadHash,
              caseId: record.compiled.caseId,
              caseVersion: record.compiled.version,
              sourceRevisionHash: record.compiled.sourceRevisionHash,
              deterministicValidationReceiptHash: operation.operation.validationReceipt.receiptHash,
            })
          : undefined;
        if (reuseRequired && !reuse) {
          throw new AppError("CONFIGURATION_ERROR", "Cross-Case mutation replay has no valid deterministic reuse evidence.", {
            httpStatus: 503,
            details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["CROSS_CASE_REUSE_EVIDENCE_INVALID"] },
          });
        }
      }
    }
  }

  #sourceIdentity(
    record: QuickBooksAccountingCaseRecord,
    operation: QuickBooksCaseOperation,
  ): {
    source_ref: string;
    source_sha256: string;
    source_digest_provenance:
      | "AGENT_SUPPLIED_TEXT_FINGERPRINT"
      | "HOST_PROVIDED_ORIGINAL_FILE_SHA256"
      | "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256";
    source_attestation_ref?: string;
  } {
    const matching = record.compiled.sources.filter((source) => source.units.some((unit) =>
      operation.sourceUnitIds.includes(unit.unitId)));
    if (matching.length === 1) {
      const [source] = matching;
      if (source?.sourceRef && source.sourceSha256 && source.sourceDigestProvenance) {
        return {
          source_ref: source.sourceRef,
          source_sha256: source.sourceSha256,
          source_digest_provenance: source.sourceDigestProvenance,
          ...(source.sourceAttestationRef ? { source_attestation_ref: source.sourceAttestationRef } : {}),
        };
      }
    }
    // This is explicitly a Case fact fingerprint, not an assertion about the
    // original uploaded bytes. MODEL_EXTRACTED facts remain eligible under the
    // frozen standing-delegation policy, while preparation still binds the
    // mutation to one immutable source-evidence revision.
    return {
      source_ref: `accounting-case-operation:${operation.stableOperationKey}`,
      source_sha256: operation.stableOperationKey,
      source_digest_provenance: "AGENT_SUPPLIED_TEXT_FINGERPRINT",
    };
  }

  async #canonicalPayload(
    resolved: ResolvedQuickBooksProvider,
    fact: QuickBooksAccountingFact,
    company: QuickBooksCompanyContext,
  ): Promise<Record<string, unknown>> {
    if (fact.kind === "CONTACT_CANDIDATE") return this.#contactPayload(resolved, fact, company);
    if (fact.kind === "JOURNAL_ENTRY") return this.#journalEntryPayload(resolved, fact, company);
    if (fact.kind !== "NATIVE_DOCUMENT") {
      throw new AppError("VALIDATION_FAILED", "Evidence-only facts cannot create QuickBooks operations.", { httpStatus: 422 });
    }
    return this.#documentPayload(resolved, fact, company);
  }

  async #contactPayload(
    resolved: ResolvedQuickBooksProvider,
    fact: QuickBooksContactCandidateFact,
    company: QuickBooksCompanyContext,
  ): Promise<Record<string, unknown>> {
    const records = fact.role === "CUSTOMER"
      ? (await resolved.provider.searchCustomers(fact.displayName, 100)).records
      : (await resolved.provider.searchVendors(fact.displayName, 100)).records;
    const exactActive = records.filter((entry) => entry.Active !== false &&
      entry.DisplayName?.trim().toLocaleLowerCase("en") === fact.displayName.toLocaleLowerCase("en"));
    if (exactActive.length === 1) {
      // A Customer/Vendor's CurrencyRef is frozen at creation in QuickBooks
      // and can never be edited afterwards. fact.currency here is never
      // Agent-stated -- it is derived purely from the NATIVE_DOCUMENT facts
      // in this Case that reference this contact (see
      // reconcileContactCurrencies in accountingCaseCompiler.ts). When that
      // derived currency disagrees with the currency the contact that
      // already exists in QuickBooks was actually created in, no document in
      // the derived currency can ever be posted to it: re-preparing this
      // same Case can never fix that, only a different contact record can.
      // That is reported distinctly from the plain CONTACT_ALREADY_EXISTS
      // case below, which is otherwise fine to treat as already satisfied.
      const existingCurrency = exactActive[0]?.CurrencyRef?.value;
      if (fact.currency && existingCurrency && existingCurrency !== fact.currency) {
        throw new AppError(
          "VALIDATION_FAILED",
          `The QuickBooks contact "${fact.displayName}" already exists and was created in ${existingCurrency}, but this Case needs it in ${fact.currency}. A contact's currency is frozen at creation in QuickBooks and cannot be edited, so this is not fixable by changing the existing contact -- a different contact record, created in ${fact.currency}, is required.`,
          {
            httpStatus: 422,
            details: {
              failureLayer: "PROVIDER_REFERENCE",
              reasonCodes: ["EXISTING_CONTACT_CURRENCY_MISMATCH"],
              existingCurrency,
              documentCurrency: fact.currency,
              recoveryAction: "USE_A_DIFFERENTLY_NAMED_CONTACT_RECORD_IN_THE_REQUIRED_CURRENCY",
            },
          },
        );
      }
      throw new AppError("VALIDATION_FAILED", "The exact QuickBooks contact already exists.", {
        httpStatus: 422,
        details: { failureLayer: "ALREADY_SATISFIED", reasonCodes: ["CONTACT_ALREADY_EXISTS"] },
      });
    }
    if (exactActive.length > 1) {
      throw new AppError("VALIDATION_FAILED", "More than one active QuickBooks contact has the exact display name.", {
        httpStatus: 422,
        details: { failureLayer: "PROVIDER_REFERENCE", reasonCodes: ["REFERENCE_AMBIGUOUS"] },
      });
    }
    // A Customer/Vendor's CurrencyRef is set once at creation and is
    // immutable afterwards, and QuickBooks rejects the field outright on a
    // company that has never turned multicurrency on. fact.currency is never
    // Agent-stated here -- the compiler derives it purely from the
    // NATIVE_DOCUMENT facts in this Case that reference this contact, and
    // leaves it undefined when no such document exists yet (a legitimate
    // contact-only Case, left to default to the company's home currency).
    // When the derived currency equals the company's home currency,
    // QuickBooks would default to the same value regardless, but this still
    // names it explicitly -- one fewer implicit assumption, matching how
    // #documentPayload always names CurrencyRef below rather than relying on
    // the provider default.
    const currencyRef = company.MultiCurrencyEnabled === true && fact.currency
      ? { CurrencyRef: { value: fact.currency } }
      : {};
    return {
      DisplayName: fact.displayName,
      ...(fact.companyName ? { CompanyName: fact.companyName } : {}),
      ...(fact.email ? { PrimaryEmailAddr: { Address: fact.email } } : {}),
      ...currencyRef,
    };
  }

  /**
   * The one foreign-currency policy, shared by every posting fact kind.
   *
   * A foreign-currency document used to be refused outright, on the grounds
   * that no exchange-rate policy had been released. Nothing could supply one:
   * the intake had no field for a rate, so the refusal named a remedy that did
   * not exist and every SGD document against a USD ledger was unbookable.
   *
   * Deciding the rate was never this service's job. It is the same shape as a
   * tax code: the Agent names an explicit value, and the ledger is what the
   * claim is checked against. So there are two checkable facts instead of one
   * policy — whether the company can hold foreign currency at all, which
   * QuickBooks answers, and whether a rate was actually supplied. The rate
   * itself is recorded in the receipt and confirmed by exact read-back.
   */
  #assertCurrencyPolicy(
    posting: { currency: string; exchangeRate?: string },
    company: QuickBooksCompanyContext,
    noun: "document" | "journal entry",
  ): void {
    const foreignCurrency = posting.currency !== company.HomeCurrency.value;
    if (foreignCurrency && company.MultiCurrencyEnabled !== true) {
      throw new AppError("VALIDATION_FAILED", `This QuickBooks company keeps its books in ${company.HomeCurrency.value} and does not have multicurrency turned on, so a ${posting.currency} ${noun} cannot be created in it.`, {
        httpStatus: 422,
        details: {
          failureLayer: "PROVIDER_CONFIGURATION",
          reasonCodes: ["COMPANY_MULTICURRENCY_DISABLED"],
          homeCurrency: company.HomeCurrency.value,
          documentCurrency: posting.currency,
          recoveryAction: "USE_HOME_CURRENCY_OR_A_MULTICURRENCY_COMPANY",
        },
      });
    }
    if (foreignCurrency && !posting.exchangeRate) {
      throw new AppError("VALIDATION_FAILED", `A ${posting.currency} ${noun} in a ${company.HomeCurrency.value} ledger needs an explicit exchange_rate: how many ${company.HomeCurrency.value} one ${posting.currency} converts to on that date.`, {
        httpStatus: 422,
        details: {
          failureLayer: "DETERMINISTIC_VALIDATION",
          reasonCodes: ["EXCHANGE_RATE_REQUIRED_FOR_FOREIGN_CURRENCY"],
          homeCurrency: company.HomeCurrency.value,
          documentCurrency: posting.currency,
          invalidFields: ["exchange_rate"],
          recoveryAction: "CORRECT_CASE_FACTS",
        },
      });
    }
    if (!foreignCurrency && posting.exchangeRate) {
      throw new AppError("VALIDATION_FAILED", `This ${noun} is already in the ledger's home currency ${company.HomeCurrency.value}, so it must not carry an exchange_rate.`, {
        httpStatus: 422,
        details: {
          failureLayer: "DETERMINISTIC_VALIDATION",
          reasonCodes: ["EXCHANGE_RATE_NOT_APPLICABLE_TO_HOME_CURRENCY"],
          invalidFields: ["exchange_rate"],
          recoveryAction: "CORRECT_CASE_FACTS",
        },
      });
    }
  }

  /**
   * One exact, active chart-of-accounts record by name, or a refusal that names
   * the field. Identical discipline to a tax code: the system never guesses an
   * account and fails closed when the name is absent or ambiguous.
   */
  #account(
    accounts: Awaited<ReturnType<ResolvedQuickBooksProvider["provider"]["listAccounts"]>>,
    name: string,
  ) {
    const account = exactByName(accounts.filter((entry) => entry.Active !== false), name,
      (entry) => entry.FullyQualifiedName ?? entry.Name, "Account");
    if (!account.Id) throw new AppError("VALIDATION_FAILED", "QuickBooks Account has no provider Id.", { httpStatus: 422 });
    return account;
  }

  async #journalEntryPayload(
    resolved: ResolvedQuickBooksProvider,
    fact: QuickBooksJournalEntryFact,
    company: QuickBooksCompanyContext,
  ): Promise<Record<string, unknown>> {
    this.#assertCurrencyPolicy(fact, company, "journal entry");
    const accounts = await resolved.provider.listAccounts();
    const lines = fact.lines.map((line) => {
      const account = this.#account(accounts, line.accountName);
      // QuickBooks requires a per-line Entity on an Accounts Receivable or
      // Accounts Payable journal line, because the amount has to land on some
      // customer's or vendor's sub-ledger. This release carries no such field,
      // so the honest answer is to refuse before dispatch and say so, rather
      // than post a line QuickBooks will reject or, worse, mis-attribute.
      const accountType = account.AccountType;
      if (accountType === "Accounts Receivable" || accountType === "Accounts Payable") {
        throw new AppError(
          "VALIDATION_FAILED",
          `QuickBooks requires a customer or vendor on a journal line against "${line.accountName}" (${accountType}), and this release does not carry one. Post the receivable or payable side as an Invoice, Bill, CreditMemo or VendorCredit instead, and keep the journal entry to the remaining accounts.`,
          {
            httpStatus: 422,
            details: {
              failureLayer: "DETERMINISTIC_VALIDATION",
              reasonCodes: ["JOURNAL_LINE_ACCOUNT_REQUIRES_COUNTERPARTY"],
              accountName: line.accountName,
              accountType,
              invalidFields: ["lines"],
              recoveryAction: "CORRECT_CASE_FACTS",
            },
          },
        );
      }
      return {
        Amount: decimal(scaled(line.amount)),
        Description: line.description,
        DetailType: "JournalEntryLineDetail",
        JournalEntryLineDetail: {
          PostingType: line.postingType === "DEBIT" ? "Debit" : "Credit",
          AccountRef: { value: account.Id as string },
        },
      };
    });
    return {
      Line: lines,
      TxnDate: fact.entryDate,
      ...(fact.documentNumber ? { DocNumber: fact.documentNumber } : {}),
      CurrencyRef: { value: fact.currency },
      ...(fact.exchangeRate ? { ExchangeRate: Number(fact.exchangeRate) } : {}),
      PrivateNote: fact.businessReason,
    };
  }

  async #documentPayload(
    resolved: ResolvedQuickBooksProvider,
    fact: QuickBooksNativeDocumentFact,
    company: QuickBooksCompanyContext,
  ): Promise<Record<string, unknown>> {
    this.#assertCurrencyPolicy(fact, company, "document");
    const salesSide = fact.documentType === "INVOICE" || fact.documentType === "CREDIT_MEMO";
    const counterparties = salesSide
      ? (await resolved.provider.searchCustomers(fact.counterpartyName, 100)).records.filter((entry) => entry.Active !== false)
      : (await resolved.provider.searchVendors(fact.counterpartyName, 100)).records.filter((entry) => entry.Active !== false);
    const counterparty = exactByName(counterparties, fact.counterpartyName,
      (entry) => "DisplayName" in entry ? entry.DisplayName : undefined, salesSide ? "Customer" : "Vendor");
    const counterpartyId = counterparty.Id;
    if (!counterpartyId) throw new AppError("VALIDATION_FAILED", "QuickBooks counterparty has no provider Id.", { httpStatus: 422 });
    // The same immutability from the other direction. Staging a contact checks
    // this before creating one; a document that resolves to a contact already
    // in the Company was not checked at all, so a mismatch only surfaced as a
    // Provider refusal after dispatch. Catching it here keeps the failure
    // pre-dispatch, where it is cleanly correctable, and lets the message name
    // the only remedy that exists -- the contact cannot be edited.
    const counterpartyCurrency = counterparty.CurrencyRef?.value;
    if (company.MultiCurrencyEnabled === true && counterpartyCurrency &&
      counterpartyCurrency !== fact.currency) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The QuickBooks ${salesSide ? "customer" : "vendor"} "${fact.counterpartyName}" keeps its account in ${counterpartyCurrency}, but this document is in ${fact.currency}. QuickBooks requires a transaction to match the currency of the contact it is against, and a contact's currency is frozen at creation, so this is not fixable by editing the contact -- a different contact record, created in ${fact.currency}, is required.`,
        {
          httpStatus: 422,
          details: {
            failureLayer: "PROVIDER_REFERENCE",
            reasonCodes: ["COUNTERPARTY_CURRENCY_MISMATCH"],
            existingCurrency: counterpartyCurrency,
            documentCurrency: fact.currency,
            recoveryAction: "USE_A_DIFFERENTLY_NAMED_CONTACT_RECORD_IN_THE_REQUIRED_CURRENCY",
          },
        },
      );
    }
    if (fact.documentNumber) {
      const existing = await resolved.provider.findExistingAccountingDocuments({
        entity: {
          INVOICE: "Invoice" as const,
          BILL: "Bill" as const,
          CREDIT_MEMO: "CreditMemo" as const,
          VENDOR_CREDIT: "VendorCredit" as const,
          PURCHASE: "Purchase" as const,
        }[fact.documentType],
        counterpartyId,
        docNumber: fact.documentNumber,
      });
      if (existing.length === 1) {
        throw new AppError("VALIDATION_FAILED", "The exact QuickBooks document number and counterparty already exist.", {
          httpStatus: 422,
          details: {
            failureLayer: "ALREADY_SATISFIED",
            reasonCodes: ["DOCUMENT_ALREADY_EXISTS"],
            providerEntityId: existing[0]?.providerEntityId,
          },
        });
      }
      if (existing.length > 1) {
        throw new AppError("VALIDATION_FAILED", "Multiple QuickBooks documents match the exact document number and counterparty.", {
          httpStatus: 422,
          details: { failureLayer: "PROVIDER_REFERENCE", reasonCodes: ["DOCUMENT_NUMBER_AMBIGUOUS"] },
        });
      }
    }
    const [items, accounts, taxes] = await Promise.all([
      resolved.provider.listItems(), resolved.provider.listAccounts(), resolved.provider.listTaxCodes(),
    ]);
    await this.#verifyTax(resolved, fact, taxes, salesSide);
    const lines = fact.lines.map((line) => {
      const amount = decimal(scaled(line.quantity) * scaled(line.unitAmount) / 10_000n);
      if (line.codingType === "ITEM") {
        const item = exactByName(items.filter((entry) => entry.Active !== false), line.codingName,
          (entry) => entry.Name ?? entry.FullyQualifiedName, "Item");
        if (!item.Id) throw new AppError("VALIDATION_FAILED", "QuickBooks Item has no provider Id.", { httpStatus: 422 });
        return {
          Amount: amount,
          Description: line.description,
          DetailType: salesSide ? "SalesItemLineDetail" : "ItemBasedExpenseLineDetail",
          [salesSide ? "SalesItemLineDetail" : "ItemBasedExpenseLineDetail"]: {
            ItemRef: { value: item.Id }, Qty: Number(line.quantity), UnitPrice: Number(line.unitAmount),
            ...(line.taxCodeName ? { TaxCodeRef: { value: this.#taxId(taxes, line.taxCodeName) } } : {}),
          },
        };
      }
      const account = this.#account(accounts, line.codingName);
      return {
        Amount: amount,
        Description: line.description,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: account.Id as string },
          ...(line.taxCodeName ? { TaxCodeRef: { value: this.#taxId(taxes, line.taxCodeName) } } : {}),
        },
      };
    });
    // A Purchase is an outflow that already happened, so QuickBooks also needs
    // the account it left from and how. Both are resolved, never inferred: the
    // account by exact name against the chart of accounts, the payment type
    // from the closed enum the Agent stated. The account is only checked for
    // being a money account at all -- pairing Cash/Check with a bank account
    // and CreditCard with a card account is QuickBooks' own rule to enforce, and
    // a wrong guess here would block correct work with no override, while a
    // Provider refusal after dispatch is now recoverable.
    if (fact.documentType === "PURCHASE" && (!fact.paymentAccountName || !fact.paymentType)) {
      throw new AppError("VALIDATION_FAILED", "A QuickBooks purchase requires both the account the money came from and the payment type.", {
        httpStatus: 422,
        details: {
          failureLayer: "DETERMINISTIC_VALIDATION",
          reasonCodes: [fact.paymentAccountName ? "PURCHASE_REQUIRES_PAYMENT_TYPE" : "PURCHASE_REQUIRES_PAYMENT_ACCOUNT"],
          invalidFields: ["payment_account_name", "payment_type"],
          recoveryAction: "CORRECT_CASE_FACTS",
        },
      });
    }
    const paymentSource = fact.documentType === "PURCHASE" && fact.paymentAccountName
      ? this.#account(accounts, fact.paymentAccountName)
      : undefined;
    if (paymentSource && paymentSource.AccountType &&
      paymentSource.AccountType !== "Bank" && paymentSource.AccountType !== "Credit Card") {
      throw new AppError(
        "VALIDATION_FAILED",
        `The QuickBooks account "${fact.paymentAccountName}" is a ${paymentSource.AccountType} account, so money cannot have left from it. Name the bank or credit card account this purchase was paid from.`,
        {
          httpStatus: 422,
          details: {
            failureLayer: "DETERMINISTIC_VALIDATION",
            reasonCodes: ["PAYMENT_ACCOUNT_IS_NOT_A_MONEY_ACCOUNT"],
            accountName: fact.paymentAccountName,
            accountType: paymentSource.AccountType,
            invalidFields: ["payment_account_name"],
            recoveryAction: "CORRECT_CASE_FACTS",
          },
        },
      );
    }
    return {
      ...(paymentSource && fact.paymentType
        // Purchase names its payee through EntityRef, not VendorRef, and the
        // ref carries the payee's type. This release resolves that payee as a
        // Vendor only, which is what the compiler already stages and what the
        // contact-currency derivation assumes.
        ? {
          EntityRef: { value: counterpartyId, type: "Vendor" },
          AccountRef: { value: paymentSource.Id as string },
          PaymentType: { CASH: "Cash", CHECK: "Check", CREDIT_CARD: "CreditCard" }[fact.paymentType],
        }
        : { [salesSide ? "CustomerRef" : "VendorRef"]: { value: counterpartyId } }),
      Line: lines,
      TxnDate: fact.documentDate,
      ...((fact.documentType === "INVOICE" || fact.documentType === "BILL") && fact.dueDate
        ? { DueDate: fact.dueDate }
        : {}),
      ...(fact.documentNumber ? { DocNumber: fact.documentNumber } : {}),
      CurrencyRef: { value: fact.currency },
      ...(fact.exchangeRate ? { ExchangeRate: Number(fact.exchangeRate) } : {}),
      GlobalTaxCalculation: fact.taxMode === "NO_TAX" ? "NotApplicable" :
        fact.taxMode === "TAX_INCLUSIVE" ? "TaxInclusive" : "TaxExcluded",
      ...(fact.taxMode === "NO_TAX" ? {} : { TxnTaxDetail: { TotalTax: Number(fact.declaredTax) } }),
      PrivateNote: fact.businessReason,
    };
  }

  #taxId(taxes: Awaited<ReturnType<ResolvedQuickBooksProvider["provider"]["listTaxCodes"]>>, name: string): string {
    const tax = exactByName(taxes.filter((entry) => entry.Active !== false), name, (entry) => entry.Name, "TaxCode");
    if (!tax.Id) throw new AppError("VALIDATION_FAILED", "QuickBooks TaxCode has no provider Id.", { httpStatus: 422 });
    return tax.Id;
  }

  async #verifyTax(
    resolved: ResolvedQuickBooksProvider,
    fact: QuickBooksNativeDocumentFact,
    taxes: QuickBooksTaxCode[],
    salesSide: boolean,
  ): Promise<void> {
    if (fact.taxMode === "NO_TAX") return;
    let recomputedTax = 0n;
    const taxRateCache = new Map<string, Awaited<ReturnType<ResolvedQuickBooksProvider["provider"]["getTaxRate"]>>>();
    for (const line of fact.lines) {
      const taxCode = exactByName(taxes.filter((entry) => entry.Active !== false), line.taxCodeName as string,
        (entry) => entry.Name, "TaxCode");
      if (!taxCode.Id || taxCode.Taxable !== true || taxCode.TaxGroup === true) {
        throw new AppError("VALIDATION_FAILED", "QuickBooks tax code is unresolved, non-taxable, or compound.", {
          httpStatus: 422,
          details: {
            failureLayer: "DETERMINISTIC_VALIDATION",
            reasonCodes: [taxCode.TaxGroup === true ? "COMPOUND_TAX_CODE_NOT_RELEASED" : "TAX_CODE_NOT_TAXABLE"],
          },
        });
      }
      const rateDetails = salesSide
        ? taxCode.SalesTaxRateList?.TaxRateDetail
        : taxCode.PurchaseTaxRateList?.TaxRateDetail;
      const rateRefs = (rateDetails ?? []).flatMap((detail) => detail.TaxRateRef?.value ? [detail.TaxRateRef.value] : []);
      if (rateRefs.length !== 1) {
        throw new AppError("VALIDATION_FAILED", "QuickBooks tax code did not resolve to one simple TaxRate.", {
          httpStatus: 422,
          details: {
            failureLayer: "DETERMINISTIC_VALIDATION",
            reasonCodes: [rateRefs.length === 0 ? "TAX_RATE_UNRESOLVED" : "COMPOUND_TAX_CODE_NOT_RELEASED"],
          },
        });
      }
      const rateRef = rateRefs[0] as string;
      const taxRate = taxRateCache.get(rateRef) ?? await resolved.provider.getTaxRate(rateRef);
      taxRateCache.set(rateRef, taxRate);
      const rateValue = taxRate.RateValue;
      const roundedRateUnits = typeof rateValue === "number" && Number.isFinite(rateValue)
        ? Math.round(rateValue * 10_000)
        : undefined;
      if (taxRate.Active === false || typeof taxRate.RateValue !== "number" || !Number.isFinite(taxRate.RateValue) ||
          taxRate.RateValue < 0 || taxRate.RateValue > 100 ||
          roundedRateUnits === undefined || Math.abs(taxRate.RateValue - roundedRateUnits / 10_000) > 1e-9) {
        throw new AppError("VALIDATION_FAILED", "QuickBooks TaxRate is outside the released deterministic policy.", {
          httpStatus: 422,
          details: { failureLayer: "DETERMINISTIC_VALIDATION", reasonCodes: ["TAX_RATE_UNRESOLVED"] },
        });
      }
      const quantity = scaled(line.quantity);
      const unitAmount = scaled(line.unitAmount);
      const lineAmountCents = roundRatioHalfUp(quantity * unitAmount * CENT_SCALE, 10_000n * 10_000n);
      const rateUnits = BigInt(roundedRateUnits);
      const expectedLineTax = fact.taxMode === "TAX_EXCLUDED"
        ? roundRatioHalfUp(lineAmountCents * rateUnits, 100n * 10_000n)
        : roundRatioHalfUp(lineAmountCents * rateUnits, (100n * 10_000n) + rateUnits);
      const sourceLineTax = cents(line.sourceTax);
      if (sourceLineTax !== expectedLineTax) {
        throw new AppError("VALIDATION_FAILED", "Source tax does not match the exact QuickBooks TaxRate and rounding policy.", {
          httpStatus: 422,
          details: {
            failureLayer: "DETERMINISTIC_VALIDATION",
            reasonCodes: ["SOURCE_TAX_RECOMPUTATION_MISMATCH"],
            lineId: line.lineId,
            expectedTax: Number(expectedLineTax) / 100,
            suppliedTax: Number(sourceLineTax) / 100,
          },
        });
      }
      recomputedTax += expectedLineTax;
    }
    if (recomputedTax !== cents(fact.declaredTax)) {
      throw new AppError("VALIDATION_FAILED", "Declared tax does not equal the server-recomputed line tax total.", {
        httpStatus: 422,
        details: { failureLayer: "DETERMINISTIC_VALIDATION", reasonCodes: ["DECLARED_TAX_RECOMPUTATION_MISMATCH"] },
      });
    }
  }
}

export const QUICKBOOKS_CASE_ATTESTATION = Object.freeze({
  compilerVersion: QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION,
  policyVersion: QUICKBOOKS_ACCOUNTING_CASE_POLICY_VERSION,
});
