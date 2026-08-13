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
  type QuickBooksNativeDocumentFact,
} from "./accountingCase.js";
import { compileQuickBooksAccountingCase } from "./accountingCaseCompiler.js";
import type { QuickBooksAccountingCaseRepository } from "./accountingCaseRepository.js";
import type {
  QuickBooksExecuteAccountingCaseInput,
  QuickBooksGetAccountingCaseStatusInput,
  QuickBooksPrepareAccountingCaseInput,
} from "./accountingCaseSchemas.js";
import type { QuickBooksMutationService } from "./mutationService.js";
import type { QuickBooksProviderResolver, ResolvedQuickBooksProvider } from "./service.js";
import type { QuickBooksCompanyContext } from "../providers/quickbooksTypes.js";

function scaled(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000n + BigInt((fraction + "0000").slice(0, 4));
}

function decimal(value: bigint): number {
  return Number(value) / 10_000;
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
  return hashObject({ schemaVersion: "quickbooks-accounting-case-plan:v1", binding: caseBinding, compiled });
}

function operationStatus(record: QuickBooksCaseOperationRecord) {
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
  };
}

function summary(record: QuickBooksAccountingCaseRecord) {
  const operations = record.operations.map(operationStatus);
  const verified = operations.filter((operation) => operation.state === "READBACK_VERIFIED").length;
  const uncertain = operations.some((operation) => operation.state === "WRITE_UNCERTAIN" || operation.state === "READBACK_MISMATCH");
  const eligibleWriteStatus = uncertain ? "UNKNOWN" as const : operations.length === 0 ? "NONE" as const :
    verified === operations.length ? "ALL_READBACK_VERIFIED" as const : verified > 0 ? "PARTIAL" as const : "NONE" as const;
  const ledgerWriteClaim = uncertain || record.state === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" as const :
    eligibleWriteStatus === "ALL_READBACK_VERIFIED" ? "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" as const :
      eligibleWriteStatus === "PARTIAL" ? "PARTIALLY_VERIFIED" as const : "NOT_WRITTEN" as const;
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
    events: record.compiled.events.map((event) => ({
      event_id: event.eventId,
      event_key: event.eventKey,
      disposition: event.disposition,
      ...(event.route ? { route: event.route } : {}),
      reason_codes: event.reasonCodes,
    })),
    operations,
    residual_event_count: record.compiled.events.filter((event) =>
      event.disposition === "BLOCKED_COVERAGE" || event.disposition === "BLOCKED_VALIDATION" ||
      event.disposition === "REVIEW_REQUIRED").length,
    completion_claim: {
      supplied_set_coverage: record.compiled.coverage.missingFactRequirements.length === 0 ? "COMPLETE" as const : "INCOMPLETE" as const,
      eligible_write_status: eligibleWriteStatus,
      whole_business_completeness: "NOT_ASSERTED" as const,
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
      sources: input.sources,
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
               failureLayer !== "ALREADY_SATISFIED")) {
            throw error;
          }
          const event = draft.events.find((entry) => entry.eventId === candidate.eventId);
          if (event) {
            event.disposition = failureLayer === "PROVIDER_REFERENCE" ? "REVIEW_REQUIRED"
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
        const validationReceipt = issueDeterministicValidationReceipt({
          actionId: candidate.actionId,
          canonicalPayloadHash,
          sourceRevisionHash: draft.sourceRevisionHash,
          caseId: draft.caseId,
          caseVersion: draft.version,
          policyVersion: draft.policyVersion,
          compilerVersion: draft.compilerVersion,
          checks: [
            { code: "SOURCE_COVERAGE_COMPLETE", evidence: draft.coverage },
            { code: "SERVER_TOTALS_RECOMPUTED", evidence: { eventId: candidate.eventId, payloadHash: canonicalPayloadHash } },
            { code: "PROVIDER_REFERENCES_EXACT", evidence: { realmId: resolved.realmId, entity: candidate.entity } },
          ],
          now: this.#clock(),
        });
        operations.push({ ...candidate, canonicalPayload, canonicalPayloadHash, validationReceipt });
      }
    }
    const compiledStatus = draft.events.some((event) => event.disposition === "BLOCKED_COVERAGE")
      ? "BLOCKED_COVERAGE" as const
      : draft.events.some((event) => event.disposition === "BLOCKED_VALIDATION")
        ? "BLOCKED_VALIDATION" as const
        : draft.events.some((event) => event.disposition === "REVIEW_REQUIRED")
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
      if (current.state === "WRITE_UNCERTAIN" || current.state === "READBACK_MISMATCH") {
        record = await this.repository.finalize({
          binding: caseBinding, caseId: input.case_id, version: input.case_version, requestId: input.request_id,
          state: "RECOVERY_REQUIRED", terminalSummary: { completion: "RECOVERY_REQUIRED" }, now: this.#clock(),
        });
        return summary(record);
      }
      const operation = current.operation;
      const operationRequestId = `qbocase.${sha256(`${input.case_id}:${input.case_version}:${operation.operationId}`).slice(0, 40)}`;
      try {
        let preparationId = current.preparationId;
        if (!preparationId) {
          const prepared = await this.mutations.prepareCaseOperation(context.actorId, {
            target_session_ref: input.target_session_ref,
            request_id: operationRequestId,
            entity: operation.entity,
            operation: operation.operation,
            payload: operation.canonicalPayload,
            business_reason: `Accounting Case ${input.case_id} event ${operation.eventId}`,
          });
          preparationId = prepared.preparation_id;
          record = await this.repository.updateOperation({
            binding: caseBinding, caseId: input.case_id, version: input.case_version,
            operationId: operation.operationId, requestId: input.request_id, expectedStates: ["PENDING"],
            state: "PREPARED", preparationId, now: this.#clock(),
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
          validationReceipt: operation.validationReceipt,
        });
        record = await this.repository.updateOperation({
          binding: caseBinding, caseId: input.case_id, version: input.case_version,
          operationId: operation.operationId, requestId: input.request_id, expectedStates: ["PREPARED"],
          state: "READBACK_VERIFIED", preparationId, mutationRequestId: operationRequestId,
          providerEntityId: executed.providerEntityId, authorizationReceipt: executed.authorizationReceipt,
          writeReceipt: executed.receipt, readback: executed.readback, now: this.#clock(),
        });
      } catch (error) {
        const safe = toSafeError(error);
        record = await this.repository.updateOperation({
          binding: caseBinding, caseId: input.case_id, version: input.case_version,
          operationId: operation.operationId, requestId: input.request_id, expectedStates: ["PENDING", "PREPARED"],
          state: safe.code === "WRITE_RESULT_UNKNOWN" ? "WRITE_UNCERTAIN" :
            safe.code === "READBACK_MISMATCH" ? "READBACK_MISMATCH" :
              safe.httpStatus >= 500 ? "WRITE_UNCERTAIN" : safe.code === "VALIDATION_FAILED" ? "BLOCKED_VALIDATION" : "PROVIDER_REJECTED",
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
        throw error;
      }
    }
    record = await this.repository.finalize({
      binding: caseBinding, caseId: input.case_id, version: input.case_version, requestId: input.request_id,
      state: "TERMINAL",
      terminalSummary: {
        completion: record.operations.length > 0
          ? "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED"
          : "NO_ELIGIBLE_WRITES",
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
    }
  }

  async #canonicalPayload(
    resolved: ResolvedQuickBooksProvider,
    fact: QuickBooksAccountingFact,
    company: QuickBooksCompanyContext,
  ): Promise<Record<string, unknown>> {
    if (fact.kind === "CONTACT_CANDIDATE") return this.#contactPayload(resolved, fact);
    if (fact.kind !== "NATIVE_DOCUMENT") {
      throw new AppError("VALIDATION_FAILED", "Evidence-only facts cannot create QuickBooks operations.", { httpStatus: 422 });
    }
    return this.#documentPayload(resolved, fact, company);
  }

  async #contactPayload(
    resolved: ResolvedQuickBooksProvider,
    fact: QuickBooksContactCandidateFact,
  ): Promise<Record<string, unknown>> {
    const records = fact.role === "CUSTOMER"
      ? (await resolved.provider.searchCustomers(fact.displayName, 100)).records
      : (await resolved.provider.searchVendors(fact.displayName, 100)).records;
    const exactActive = records.filter((entry) => entry.Active !== false &&
      entry.DisplayName?.trim().toLocaleLowerCase("en") === fact.displayName.toLocaleLowerCase("en"));
    if (exactActive.length === 1) {
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
    return {
      DisplayName: fact.displayName,
      ...(fact.companyName ? { CompanyName: fact.companyName } : {}),
      ...(fact.email ? { PrimaryEmailAddr: { Address: fact.email } } : {}),
    };
  }

  async #documentPayload(
    resolved: ResolvedQuickBooksProvider,
    fact: QuickBooksNativeDocumentFact,
    company: QuickBooksCompanyContext,
  ): Promise<Record<string, unknown>> {
    if (fact.currency !== company.HomeCurrency.value && company.MultiCurrencyEnabled !== true) {
      throw new AppError("VALIDATION_FAILED", "QuickBooks multi-currency is disabled for this Company.", {
        httpStatus: 422,
        details: { failureLayer: "DETERMINISTIC_VALIDATION", reasonCodes: ["MULTI_CURRENCY_DISABLED"] },
      });
    }
    const salesSide = fact.documentType === "INVOICE" || fact.documentType === "CREDIT_MEMO";
    const counterparties = salesSide
      ? (await resolved.provider.searchCustomers(fact.counterpartyName, 100)).records.filter((entry) => entry.Active !== false)
      : (await resolved.provider.searchVendors(fact.counterpartyName, 100)).records.filter((entry) => entry.Active !== false);
    const counterparty = exactByName(counterparties, fact.counterpartyName,
      (entry) => "DisplayName" in entry ? entry.DisplayName : undefined, salesSide ? "Customer" : "Vendor");
    const counterpartyId = counterparty.Id;
    if (!counterpartyId) throw new AppError("VALIDATION_FAILED", "QuickBooks counterparty has no provider Id.", { httpStatus: 422 });
    const [items, accounts, taxes] = await Promise.all([
      resolved.provider.listItems(), resolved.provider.listAccounts(), resolved.provider.listTaxCodes(),
    ]);
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
      const account = exactByName(accounts.filter((entry) => entry.Active !== false), line.codingName,
        (entry) => entry.FullyQualifiedName ?? entry.Name, "Account");
      if (!account.Id) throw new AppError("VALIDATION_FAILED", "QuickBooks Account has no provider Id.", { httpStatus: 422 });
      return {
        Amount: amount,
        Description: line.description,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: account.Id },
          ...(line.taxCodeName ? { TaxCodeRef: { value: this.#taxId(taxes, line.taxCodeName) } } : {}),
        },
      };
    });
    return {
      [salesSide ? "CustomerRef" : "VendorRef"]: { value: counterpartyId },
      Line: lines,
      TxnDate: fact.documentDate,
      ...(fact.dueDate ? { DueDate: fact.dueDate } : {}),
      ...(fact.documentNumber ? { DocNumber: fact.documentNumber } : {}),
      CurrencyRef: { value: fact.currency },
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
}

export const QUICKBOOKS_CASE_ATTESTATION = Object.freeze({
  compilerVersion: QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION,
  policyVersion: QUICKBOOKS_ACCOUNTING_CASE_POLICY_VERSION,
});
