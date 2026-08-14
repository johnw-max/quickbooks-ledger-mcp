import { randomUUID } from "node:crypto";
import { AppError, toSafeError } from "../errors.js";
import type {
  QuickBooksBillListInput,
  QuickBooksBillListResult,
  QuickBooksExistingBillMatch,
  QuickBooksExistingDocumentMatch,
  QuickBooksReferenceValidationResult,
  QuickBooksSearchResult,
} from "../providers/quickbooksProvider.js";
import type {
  QuickBooksReportInput,
  QuickBooksTransactionEntity,
  QuickBooksTransactionListInput,
  QuickBooksTransactionListResult,
} from "../providers/quickbooksProvider.js";
import type {
  QuickBooksAccount,
  QuickBooksBillSnapshot,
  QuickBooksCompanyContext,
  QuickBooksCompanyInfo,
  QuickBooksCustomer,
  QuickBooksItem,
  QuickBooksSupplierBillInput,
  QuickBooksTaxCode,
  QuickBooksTaxRate,
  QuickBooksVendor,
} from "../providers/quickbooksTypes.js";
import { hashObject, safeEqual, sha256 } from "../security/hash.js";
import type {
  QuickBooksProviderMutationCommand,
  QuickBooksProviderWritePermit,
} from "../security/quickBooksProviderWritePermit.js";
import { issueQuickBooksSupplierBillProviderWritePermit } from "../security/quickBooksProviderWritePermit.js";
import type { QuickBooksPreparedPayload, QuickBooksPostingRequest } from "./models.js";
import type { QuickBooksPostingRepository } from "./repository.js";
import type {
  QuickBooksGetBillInput,
  QuickBooksHashSourceDocumentInput,
  QuickBooksListBillsToolInput,
  QuickBooksPrepareSupplierBillToolInput,
  QuickBooksSearchVendorsInput,
  QuickBooksSearchCustomersInput,
  QuickBooksListTransactionsInput,
  QuickBooksGetTransactionInput,
  QuickBooksRunReportInput,
  QuickBooksTrialBalanceInput,
} from "./schemas.js";
import type { QuickBooksWritableEntity } from "./writePolicy.js";
import {
  verifyQuickBooksSourceAttestation,
  type QuickBooksSourceAttestationVerifier,
} from "./sourceAttestation.js";

export interface QuickBooksConnectionStatus {
  connected: boolean;
  company?: { realmId: string; name: string };
  scopes: string[];
  connectionRefSafe: string | null;
  boundTargetRefSafe: string | null;
  bindingRevision: string | null;
  connectUrl?: string;
  connectUrlExpiresAt?: string;
  connectAction?: "CONNECT_COMPANY" | "REPLACE_CURRENT_COMPANY";
}

export interface ResolvedQuickBooksProvider {
  realmId: string;
  companyName: string;
  connectionRefSafe: string;
  boundTargetRefSafe: string;
  bindingRevision: string;
  /** Provider OAuth deny reasons checked before autonomous authorization. Intuit does not supply dynamic roles. */
  providerAccessDenyReasons?: readonly string[];
  targetSessionId?: string;
  targetSessionExpiresAt?: Date;
  provider: QuickBooksProviderCapabilities;
}

export interface QuickBooksReadSnapshot<T> {
  readonly result: T;
  readonly binding: Pick<
    ResolvedQuickBooksProvider,
    "companyName" | "connectionRefSafe" | "boundTargetRefSafe" | "bindingRevision"
  >;
}

export interface QuickBooksProviderCapabilities {
  getCompany(): Promise<QuickBooksCompanyInfo>;
  getCompanyContext(): Promise<QuickBooksCompanyContext>;
  listAccounts(): Promise<QuickBooksAccount[]>;
  listTaxCodes(): Promise<QuickBooksTaxCode[]>;
  getTaxRate(taxRateId: string): Promise<QuickBooksTaxRate>;
  searchVendors(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksVendor>>;
  searchCustomers(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksCustomer>>;
  listItems(): Promise<QuickBooksItem[]>;
  listTransactions(input: QuickBooksTransactionListInput): Promise<QuickBooksTransactionListResult>;
  getTransaction(entity: QuickBooksTransactionEntity, transactionId: string): Promise<Record<string, unknown>>;
  runReport(input: QuickBooksReportInput): Promise<Record<string, unknown>>;
  listBills(input?: QuickBooksBillListInput): Promise<QuickBooksBillListResult>;
  getBill(billId: string): Promise<QuickBooksBillSnapshot>;
  findExistingSupplierBills(input: { vendorId: string; docNumber: string }): Promise<QuickBooksExistingBillMatch[]>;
  findExistingAccountingDocuments(input: {
    entity: QuickBooksExistingDocumentMatch["entity"];
    counterpartyId: string;
    docNumber: string;
  }): Promise<QuickBooksExistingDocumentMatch[]>;
  validateSupplierBill(input: QuickBooksSupplierBillInput): Promise<QuickBooksReferenceValidationResult>;
  createApprovedSupplierBill(input: QuickBooksSupplierBillInput, permit: QuickBooksProviderWritePermit): Promise<{
    bill: QuickBooksBillSnapshot;
    receipt: Record<string, unknown>;
  }>;
  getTrialBalance(date?: string): Promise<Record<string, unknown>>;
  getMutationTarget(entity: QuickBooksWritableEntity, targetId: string): Promise<Record<string, unknown>>;
  executeMutation(
    input: QuickBooksProviderMutationCommand,
    permit: QuickBooksProviderWritePermit,
    recordProviderOutcome: (outcome: {
      providerEntityId: string;
      receipt: Record<string, unknown>;
    }) => Promise<void>,
    markProviderDispatch: () => Promise<void>,
  ): Promise<{
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  }>;
  recoverMutation(input: QuickBooksProviderMutationCommand, providerEntityId: string): Promise<{
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  }>;
}

export interface QuickBooksProviderResolver {
  connectionStatus(actorId: string): Promise<QuickBooksConnectionStatus>;
  issueTargetSession?(actorId: string): Promise<QuickBooksResolvedTarget>;
  resolve(actorId: string, targetSessionRef?: string): Promise<ResolvedQuickBooksProvider>;
  resolvePrepared?(
    actorId: string,
    expectedRealmId: string,
    expectedBindingRevision?: string,
  ): Promise<ResolvedQuickBooksProvider>;
}

export interface QuickBooksResolvedTarget {
  companyName: string;
  connectionRefSafe: string;
  boundTargetRefSafe: string;
  bindingRevision: string;
  targetSessionRef: string;
  expiresAt: string;
}

export interface QuickBooksPreparedResult {
  postingRequestId: string;
  state: "PREPARED";
  approvedPayloadHash: string;
  reviewUrl: string;
  companyName: string;
  connectionRefSafe: string;
  boundTargetRefSafe: string;
  bindingRevision: string;
  payload: QuickBooksPreparedPayload;
  referenceValidation: QuickBooksReferenceValidationResult;
  warnings: string[];
  idempotentReplay: boolean;
}

export interface QuickBooksPostedResult {
  postingRequestId: string;
  state: "POSTED_READBACK_VERIFIED";
  bill: QuickBooksBillSnapshot;
  receipt: Record<string, unknown>;
  idempotentReplay: boolean;
}

function preparedPayload(
  input: QuickBooksPrepareSupplierBillToolInput,
  binding: Pick<ResolvedQuickBooksProvider, "connectionRefSafe" | "boundTargetRefSafe" | "bindingRevision">,
  sourceAttestationDigest?: string,
): QuickBooksPreparedPayload {
  return {
    clientRequestId: input.request_id,
    connectionRefSafe: binding.connectionRefSafe,
    boundTargetRefSafe: binding.boundTargetRefSafe,
    bindingRevision: binding.bindingRevision,
    sourceRef: input.source_ref,
    sourceSha256: input.source_sha256,
    sourceDigestProvenance: input.source_digest_provenance,
    ...(sourceAttestationDigest ? { sourceAttestationDigest } : {}),
    vendorId: input.vendor_id,
    txnDate: input.txn_date,
    ...(input.due_date ? { dueDate: input.due_date } : {}),
    ...(input.doc_number ? { docNumber: input.doc_number } : {}),
    ...(input.missing_doc_number_reason ? { missingDocNumberReason: input.missing_doc_number_reason } : {}),
    ...(input.currency_code ? { currencyCode: input.currency_code } : {}),
    ...(input.memo ? { memo: input.memo } : {}),
    ...(input.approval_ref ? { approvalRef: input.approval_ref } : {}),
    supportingEvidence: input.supporting_evidence.map((evidence) => ({
      kind: evidence.kind,
      ref: evidence.ref,
      sha256: evidence.sha256,
    })),
    ...(input.global_tax_calculation ? { globalTaxCalculation: input.global_tax_calculation } : {}),
    invoiceTotal: Number(input.invoice_total).toFixed(2),
    taxTotal: Number(input.tax_total).toFixed(2),
    lines: input.lines.map((line) => ({
      accountId: line.account_id,
      amount: Number(line.amount).toFixed(2),
      ...(line.description ? { description: line.description } : {}),
      ...(line.tax_code_id ? { taxCodeId: line.tax_code_id } : {}),
    })),
  };
}

function providerBillInput(payload: QuickBooksPreparedPayload, requestId: string): QuickBooksSupplierBillInput {
  return {
    requestId,
    sourceRef: payload.sourceRef,
    sourceSha256: payload.sourceSha256,
    vendorId: payload.vendorId,
    txnDate: payload.txnDate,
    ...(payload.dueDate ? { dueDate: payload.dueDate } : {}),
    ...(payload.docNumber ? { docNumber: payload.docNumber } : {}),
    ...(payload.missingDocNumberReason ? { missingDocNumberReason: payload.missingDocNumberReason } : {}),
    ...(payload.currencyCode ? { currencyCode: payload.currencyCode } : {}),
    ...(payload.memo ? { memo: payload.memo } : {}),
    ...(payload.approvalRef ? { approvalRef: payload.approvalRef } : {}),
    ...(payload.supportingEvidence ? { supportingEvidence: payload.supportingEvidence } : {}),
    ...(payload.globalTaxCalculation ? { globalTaxCalculation: payload.globalTaxCalculation } : {}),
    ...(payload.invoiceTotal ? { invoiceTotal: payload.invoiceTotal } : {}),
    ...(payload.taxTotal ? { taxTotal: payload.taxTotal } : {}),
    lines: payload.lines,
  };
}

function preparationWarnings(payload: QuickBooksPreparedPayload, now: Date): string[] {
  const warnings: string[] = [];
  if (payload.sourceDigestProvenance !== "HOST_PROVIDED_ORIGINAL_FILE_SHA256") {
    warnings.push("The source digest does not verify the original file bytes; compare the proposal with the original material before approval.");
  }
  if (!payload.docNumber) warnings.push(`Supplier document number is missing: ${payload.missingDocNumberReason ?? "no reason supplied"}.`);
  if (!payload.approvalRef) warnings.push("No separate manager or business approval reference was supplied; apply the workspace approval policy.");
  if (!payload.memo) warnings.push("No accounting memo was supplied.");
  const today = now.toISOString().slice(0, 10);
  if (payload.txnDate > today) warnings.push(`Invoice date ${payload.txnDate} is in the future relative to ${today}.`);
  return warnings;
}

export class QuickBooksWorkflowService {
  readonly #repository: QuickBooksPostingRepository;
  readonly #resolver: QuickBooksProviderResolver;
  readonly #publicBaseUrl: string;
  readonly #writeEnabled: boolean;
  readonly #writeTargetMode: "exact_allowlist" | "oauth_bound";
  readonly #allowedRealmId: string | undefined;
  readonly #executeScopeAuthorizer: ((actorId: string, requiredScope: string) => Promise<boolean>) | undefined;
  readonly #sourceAttestationVerifier: QuickBooksSourceAttestationVerifier | undefined;

  constructor(options: {
    repository: QuickBooksPostingRepository;
    resolver: QuickBooksProviderResolver;
    publicBaseUrl: string;
    writeEnabled?: boolean;
    writeTargetMode?: "exact_allowlist" | "oauth_bound";
    allowedRealmId?: string;
    executeScopeAuthorizer?: (actorId: string, requiredScope: string) => Promise<boolean>;
    sourceAttestationVerifier?: QuickBooksSourceAttestationVerifier;
  }) {
    this.#repository = options.repository;
    this.#resolver = options.resolver;
    this.#publicBaseUrl = options.publicBaseUrl.replace(/\/$/, "");
    this.#writeEnabled = options.writeEnabled ?? false;
    this.#writeTargetMode = options.writeTargetMode ?? "exact_allowlist";
    this.#allowedRealmId = options.allowedRealmId;
    this.#executeScopeAuthorizer = options.executeScopeAuthorizer;
    this.#sourceAttestationVerifier = options.sourceAttestationVerifier;
  }

  connectionStatus(actorId: string): Promise<QuickBooksConnectionStatus> {
    return this.#resolver.connectionStatus(actorId);
  }

  resolveTarget(actorId: string): Promise<QuickBooksResolvedTarget> {
    if (!this.#resolver.issueTargetSession) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks target sessions are not configured.", {
        httpStatus: 503,
      });
    }
    return this.#resolver.issueTargetSession(actorId);
  }

  async #read<T>(
    actorId: string,
    targetSessionRef: string | undefined,
    action: (provider: QuickBooksProviderCapabilities) => Promise<T>,
  ): Promise<QuickBooksReadSnapshot<T>> {
    const resolved = await this.#resolver.resolve(actorId, targetSessionRef);
    const result = await action(resolved.provider);
    return {
      result,
      binding: {
        companyName: resolved.companyName,
        connectionRefSafe: resolved.connectionRefSafe,
        boundTargetRefSafe: resolved.boundTargetRefSafe,
        bindingRevision: resolved.bindingRevision,
      },
    };
  }

  hashSourceDocument(input: QuickBooksHashSourceDocumentInput): {
    sourceRef: string;
    algorithm: "sha256";
    sha256: string;
    utf8ByteLength: number;
    evidenceType: "AGENT_SUPPLIED_TEXT_FINGERPRINT";
    originalFileVerified: false;
    storedByQuickBooksMcp: false;
  } {
    return {
      sourceRef: input.source_ref,
      algorithm: "sha256",
      sha256: sha256(input.content),
      utf8ByteLength: Buffer.byteLength(input.content, "utf8"),
      evidenceType: "AGENT_SUPPLIED_TEXT_FINGERPRINT",
      originalFileVerified: false,
      storedByQuickBooksMcp: false,
    };
  }

  async getCompany(actorId: string, targetSessionRef?: string): Promise<QuickBooksCompanyContext> {
    return (await this.getCompanyRead(actorId, targetSessionRef)).result;
  }

  getCompanyRead(actorId: string, targetSessionRef?: string): Promise<QuickBooksReadSnapshot<QuickBooksCompanyContext>> {
    return this.#read(actorId, targetSessionRef, (provider) => provider.getCompanyContext());
  }

  async listAccounts(actorId: string, targetSessionRef?: string): Promise<QuickBooksAccount[]> {
    return (await this.listAccountsRead(actorId, targetSessionRef)).result;
  }

  listAccountsRead(actorId: string, targetSessionRef?: string): Promise<QuickBooksReadSnapshot<QuickBooksAccount[]>> {
    return this.#read(actorId, targetSessionRef, (provider) => provider.listAccounts());
  }

  async listTaxCodes(actorId: string, targetSessionRef?: string): Promise<QuickBooksTaxCode[]> {
    return (await this.listTaxCodesRead(actorId, targetSessionRef)).result;
  }

  listTaxCodesRead(actorId: string, targetSessionRef?: string): Promise<QuickBooksReadSnapshot<QuickBooksTaxCode[]>> {
    return this.#read(actorId, targetSessionRef, (provider) => provider.listTaxCodes());
  }

  async searchVendors(actorId: string, input: QuickBooksSearchVendorsInput): Promise<QuickBooksSearchResult<QuickBooksVendor>> {
    return (await this.searchVendorsRead(actorId, input)).result;
  }

  searchVendorsRead(
    actorId: string,
    input: QuickBooksSearchVendorsInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksSearchResult<QuickBooksVendor>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.searchVendors(input.query, input.limit));
  }

  async searchCustomers(actorId: string, input: QuickBooksSearchCustomersInput): Promise<QuickBooksSearchResult<QuickBooksCustomer>> {
    return (await this.searchCustomersRead(actorId, input)).result;
  }

  searchCustomersRead(
    actorId: string,
    input: QuickBooksSearchCustomersInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksSearchResult<QuickBooksCustomer>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.searchCustomers(input.query, input.limit));
  }

  async listItems(actorId: string, targetSessionRef?: string): Promise<QuickBooksItem[]> {
    return (await this.listItemsRead(actorId, targetSessionRef)).result;
  }

  listItemsRead(actorId: string, targetSessionRef?: string): Promise<QuickBooksReadSnapshot<QuickBooksItem[]>> {
    return this.#read(actorId, targetSessionRef, (provider) => provider.listItems());
  }

  async listTransactions(actorId: string, input: QuickBooksListTransactionsInput): Promise<QuickBooksTransactionListResult> {
    return (await this.listTransactionsRead(actorId, input)).result;
  }

  listTransactionsRead(
    actorId: string,
    input: QuickBooksListTransactionsInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksTransactionListResult>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.listTransactions({
      entity: input.entity,
      ...(input.date_from ? { dateFrom: input.date_from } : {}),
      ...(input.date_to ? { dateTo: input.date_to } : {}),
      ...(input.customer_id ? { customerId: input.customer_id } : {}),
      ...(input.vendor_id ? { vendorId: input.vendor_id } : {}),
      ...(input.open_only === undefined ? {} : { openOnly: input.open_only }),
      page: input.page,
      pageSize: input.page_size,
    }));
  }

  async getTransaction(actorId: string, input: QuickBooksGetTransactionInput): Promise<Record<string, unknown>> {
    return (await this.getTransactionRead(actorId, input)).result;
  }

  getTransactionRead(
    actorId: string,
    input: QuickBooksGetTransactionInput,
  ): Promise<QuickBooksReadSnapshot<Record<string, unknown>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.getTransaction(input.entity, input.transaction_id));
  }

  async runReport(actorId: string, input: QuickBooksRunReportInput): Promise<Record<string, unknown>> {
    return (await this.runReportRead(actorId, input)).result;
  }

  runReportRead(
    actorId: string,
    input: QuickBooksRunReportInput,
  ): Promise<QuickBooksReadSnapshot<Record<string, unknown>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.runReport({
      report: input.report,
      ...(input.start_date ? { startDate: input.start_date } : {}),
      ...(input.end_date ? { endDate: input.end_date } : {}),
      ...(input.as_of_date ? { asOfDate: input.as_of_date } : {}),
      ...(input.accounting_method ? { accountingMethod: input.accounting_method } : {}),
      ...(input.customer_id ? { customerId: input.customer_id } : {}),
      ...(input.vendor_id ? { vendorId: input.vendor_id } : {}),
      maxRows: input.max_rows,
      view: input.view,
    }));
  }

  async listBills(actorId: string, input: QuickBooksListBillsToolInput): Promise<QuickBooksBillListResult> {
    return (await this.listBillsRead(actorId, input)).result;
  }

  listBillsRead(
    actorId: string,
    input: QuickBooksListBillsToolInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksBillListResult>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.listBills({
      ...(input.date_from ? { dateFrom: input.date_from } : {}),
      ...(input.date_to ? { dateTo: input.date_to } : {}),
      page: input.page,
      pageSize: input.page_size,
    }));
  }

  async getBill(actorId: string, input: QuickBooksGetBillInput): Promise<QuickBooksBillSnapshot> {
    return (await this.getBillRead(actorId, input)).result;
  }

  getBillRead(
    actorId: string,
    input: QuickBooksGetBillInput,
  ): Promise<QuickBooksReadSnapshot<QuickBooksBillSnapshot>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.getBill(input.bill_id));
  }

  async getTrialBalance(actorId: string, input: QuickBooksTrialBalanceInput): Promise<Record<string, unknown>> {
    return (await this.getTrialBalanceRead(actorId, input)).result;
  }

  getTrialBalanceRead(
    actorId: string,
    input: QuickBooksTrialBalanceInput,
  ): Promise<QuickBooksReadSnapshot<Record<string, unknown>>> {
    return this.#read(actorId, input.target_session_ref, (provider) => provider.getTrialBalance(input.date));
  }

  async prepareSupplierBill(
    actorId: string,
    input: QuickBooksPrepareSupplierBillToolInput,
  ): Promise<QuickBooksPreparedResult> {
    const resolved = await this.#resolver.resolve(actorId, input.target_session_ref);
    const sourceAttestationDigest = await verifyQuickBooksSourceAttestation({
      actorId,
      sourceRef: input.source_ref,
      sourceSha256: input.source_sha256,
      provenance: input.source_digest_provenance,
      ...(input.source_attestation_ref ? { attestationRef: input.source_attestation_ref } : {}),
      boundTargetRefSafe: resolved.boundTargetRefSafe,
      bindingRevision: resolved.bindingRevision,
      ...(this.#sourceAttestationVerifier ? { verifier: this.#sourceAttestationVerifier } : {}),
    });
    const payload = preparedPayload(input, resolved, sourceAttestationDigest);
    const now = new Date();
    const duplicate = await this.#repository.findActiveDuplicate({
      actorId,
      realmId: resolved.realmId,
      sourceSha256: payload.sourceSha256,
      vendorId: payload.vendorId,
      ...(payload.docNumber ? { docNumber: payload.docNumber } : {}),
    });
    if (duplicate && duplicate.clientRequestId !== payload.clientRequestId) {
      throw new AppError("CONFLICT", "This source document or supplier document number already has an active QuickBooks posting request.", {
        httpStatus: 409,
        details: duplicate.actorId === actorId
          ? { duplicatePostingRequestId: duplicate.postingRequestId, duplicateState: duplicate.state }
          : { duplicateSource: "local-company" },
      });
    }
    if (payload.docNumber) {
      const existingBills = await resolved.provider.findExistingSupplierBills({
        vendorId: payload.vendorId,
        docNumber: payload.docNumber,
      });
      if (existingBills.length > 0) {
        throw new AppError("CONFLICT", "A QuickBooks Bill already exists for this vendor and supplier document number.", {
          httpStatus: 409,
          details: {
            duplicateSource: "quickbooks",
            existingBills: existingBills.slice(0, 10),
          },
        });
      }
    }
    const referenceValidation = await resolved.provider.validateSupplierBill(providerBillInput(payload, "prepare-validation"));
    const payloadHash = hashObject({ realmId: resolved.realmId, payload });
    const providerRequestId = `zc.${sha256(`${resolved.realmId}:${payload.clientRequestId}:${payloadHash}`).slice(0, 47)}`;
    const created = await this.#repository.createOrGet({
      postingRequestId: `qbp_${randomUUID()}`,
      actorId,
      realmId: resolved.realmId,
      providerRequestId,
      payload,
      payloadHash,
      now,
    });
    if (!created.created && created.posting.clientRequestId !== payload.clientRequestId) {
      throw new AppError("CONFLICT", "This source document or supplier document number already has an active QuickBooks posting request.", {
        httpStatus: 409,
        details: created.posting.actorId === actorId
          ? { duplicatePostingRequestId: created.posting.postingRequestId, duplicateState: created.posting.state }
          : { duplicateSource: "local-company" },
      });
    }
    if (!created.created && !safeEqual(created.posting.payloadHash, payloadHash)) {
      throw new AppError("CONFLICT", "request_id was already used with a different QuickBooks bill payload.", {
        httpStatus: 409,
      });
    }
    if (created.posting.state !== "PREPARED") {
      throw new AppError("CONFLICT", `The QuickBooks posting is already in ${created.posting.state}.`, {
        httpStatus: 409,
      });
    }
    return {
      postingRequestId: created.posting.postingRequestId,
      state: "PREPARED",
      approvedPayloadHash: created.posting.payloadHash,
      reviewUrl: `${this.#publicBaseUrl}/quickbooks/review/${created.posting.postingRequestId}`,
      companyName: resolved.companyName,
      connectionRefSafe: resolved.connectionRefSafe,
      boundTargetRefSafe: resolved.boundTargetRefSafe,
      bindingRevision: resolved.bindingRevision,
      payload: created.posting.payload,
      referenceValidation,
      warnings: preparationWarnings(created.posting.payload, now),
      idempotentReplay: !created.created,
    };
  }

  async getPreparedPosting(actorId: string, postingRequestId: string): Promise<QuickBooksPostingRequest> {
    const posting = await this.#repository.get(postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "QuickBooks posting request was not found.", { httpStatus: 404 });
    if (posting.actorId !== actorId) {
      throw new AppError("FORBIDDEN", "QuickBooks posting belongs to another actor.", { httpStatus: 403 });
    }
    return posting;
  }

  async approveAndPost(options: {
    actorId: string;
    postingRequestId: string;
    approvedPayloadHash: string;
    approvedBy: string;
  }): Promise<QuickBooksPostedResult> {
    if (this.#executeScopeAuthorizer &&
      !await this.#executeScopeAuthorizer(options.actorId, "quickbooks.bill.execute")) {
      throw new AppError("FORBIDDEN", "The connected MCP installation does not grant quickbooks.bill.execute.", {
        httpStatus: 403,
      });
    }
    const existing = await this.getPreparedPosting(options.actorId, options.postingRequestId);
    if (existing.state === "POSTED_READBACK_VERIFIED") {
      if (!safeEqual(existing.payloadHash, options.approvedPayloadHash)) {
        throw new AppError("APPROVAL_INVALID", "Approved QuickBooks payload hash does not match the prepared bill.", {
          httpStatus: 409,
        });
      }
      return this.#terminalResult(existing, true);
    }
    if (!existing.payload.bindingRevision) {
      throw new AppError("APPROVAL_INVALID", "This legacy QuickBooks proposal has no immutable binding revision; prepare it again.", {
        httpStatus: 409,
      });
    }
    const resolved = this.#resolver.resolvePrepared
      ? await this.#resolver.resolvePrepared(options.actorId, existing.realmId, existing.payload.bindingRevision)
      : await this.#resolver.resolve(options.actorId);
    if (
      !safeEqual(existing.payload.bindingRevision, resolved.bindingRevision) ||
      !safeEqual(existing.payload.boundTargetRefSafe, resolved.boundTargetRefSafe) ||
      !safeEqual(existing.payload.connectionRefSafe, resolved.connectionRefSafe)
    ) {
      throw new AppError("FORBIDDEN", "The prepared QuickBooks target no longer matches the active OAuth binding.", {
        httpStatus: 403,
      });
    }
    this.#assertWriteAllowed(resolved.realmId);
    if (existing.state === "PREPARED" && existing.payload.docNumber) {
      const existingBills = await resolved.provider.findExistingSupplierBills({
        vendorId: existing.payload.vendorId,
        docNumber: existing.payload.docNumber,
      });
      if (existingBills.length > 0) {
        await this.#repository.markFailure(existing.postingRequestId, "BLOCKED_VALIDATION", new Date());
        throw new AppError("CONFLICT", "A QuickBooks Bill was created after preparation for this vendor and supplier document number.", {
          httpStatus: 409,
          details: { duplicateSource: "quickbooks", existingBills: existingBills.slice(0, 10) },
        });
      }
    }
    const claim = await this.#repository.claimForApprovedPost({
      postingRequestId: options.postingRequestId,
      actorId: options.actorId,
      approvedPayloadHash: options.approvedPayloadHash,
      approvedBy: options.approvedBy,
      now: new Date(),
    });
    if (!claim.shouldPost) return this.#terminalResult(claim.posting, true);

    if (resolved.realmId !== claim.posting.realmId) {
      await this.#repository.markFailure(claim.posting.postingRequestId, "BLOCKED_VALIDATION", new Date());
      throw new AppError("FORBIDDEN", "The approved QuickBooks company no longer matches the active connection.", {
        httpStatus: 403,
      });
    }

    try {
      const providerWritePermit = issueQuickBooksSupplierBillProviderWritePermit({
        claimedPosting: claim.posting,
      });
      const written = await resolved.provider.createApprovedSupplierBill(
        providerBillInput(claim.posting.payload, claim.posting.providerRequestId),
        providerWritePermit,
      );
      const completed = await this.#repository.completeVerified({
        postingRequestId: claim.posting.postingRequestId,
        bill: written.bill,
        receipt: written.receipt,
        now: new Date(),
      });
      return this.#terminalResult(completed, false);
    } catch (error) {
      const safe = toSafeError(error);
      const state = safe.code === "WRITE_RESULT_UNKNOWN"
        ? "WRITE_RESULT_UNKNOWN"
        : safe.code === "READBACK_MISMATCH"
          ? "READBACK_MISMATCH"
          : "BLOCKED_VALIDATION";
      await this.#repository.markFailure(claim.posting.postingRequestId, state, new Date());
      throw safe;
    }
  }

  reject(options: {
    actorId: string;
    postingRequestId: string;
    rejectedBy: string;
  }): Promise<QuickBooksPostingRequest> {
    return this.#repository.reject({ ...options, now: new Date() });
  }

  #terminalResult(posting: QuickBooksPostingRequest, idempotentReplay: boolean): QuickBooksPostedResult {
    if (posting.state !== "POSTED_READBACK_VERIFIED" || !posting.readback || !posting.writeReceipt) {
      throw new AppError("CONFLICT", "QuickBooks posting has no verified terminal evidence.", { httpStatus: 409 });
    }
    return {
      postingRequestId: posting.postingRequestId,
      state: "POSTED_READBACK_VERIFIED",
      bill: posting.readback,
      receipt: posting.writeReceipt,
      idempotentReplay,
    };
  }

  #assertWriteAllowed(realmId: string): void {
    if (!this.#writeEnabled) {
      throw new AppError("FORBIDDEN", "QuickBooks writes are disabled for this deployment.", { httpStatus: 403 });
    }
    if (
      this.#writeTargetMode === "exact_allowlist" &&
      (!this.#allowedRealmId || !safeEqual(this.#allowedRealmId, realmId))
    ) {
      throw new AppError("FORBIDDEN", "QuickBooks writes are not enabled for this exact company.", { httpStatus: 403 });
    }
  }
}
