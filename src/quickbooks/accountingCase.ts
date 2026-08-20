import type { DeterministicValidationReceipt } from "../ledger-control/deterministicValidation.js";
import type { QuickBooksWritableEntity, QuickBooksWriteOperation } from "./writePolicy.js";
import type {
  QuickBooksAutonomousAuthorizationEvidence,
  QuickBooksMutationReuseEvidence,
} from "./autonomousAuthorizationEvidence.js";

export const QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION = "0.3.0";
export const QUICKBOOKS_ACCOUNTING_CASE_POLICY_VERSION = "quickbooks-sg-core-v1";

/**
 * Public Accounting Case release boundary. The official Intuit write catalog is
 * deliberately broader; only these compiler-owned actions can be executed from
 * the Agent-facing Case tools in this release.
 *
 * The boundary is drawn on writePolicy's `providerEffect`: MASTER_DATA,
 * POSTING_TRANSACTION and LEDGER_ADJUSTMENT record the books and are released
 * here; CASH_MOVEMENT (Payment, BillPayment, Deposit, Transfer, RefundReceipt)
 * initiates or settles money and stays out of this release deliberately.
 */
export const QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES = [
  "CREATE:Customer",
  "CREATE:Vendor",
  "CREATE:Invoice",
  "CREATE:Bill",
  "CREATE:CreditMemo",
  "CREATE:VendorCredit",
  "CREATE:JournalEntry",
  "CREATE:Purchase",
] as const;

export const QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS = [
  "customer.create_basic",
  "vendor.create_basic",
  "invoice.create",
  "bill.create",
  "credit_memo.create",
  "vendor_credit.create",
  "journal_entry.create",
  "purchase.create",
] as const;

export const QUICKBOOKS_ACCOUNTING_FACT_KINDS = [
  "CONTACT_CANDIDATE",
  "NATIVE_DOCUMENT",
  "JOURNAL_ENTRY",
  "UNSUPPORTED_EVENT",
  "EVIDENCE",
  "CONTROL_FINDING",
] as const;

/**
 * Real accounting events this release still cannot route natively.
 *
 * PAYMENT, BILL_PAYMENT and PREPAYMENT are `CASH_MOVEMENT` in writePolicy and
 * are out of scope by decision, not by omission. FX_SETTLEMENT is the gain or
 * loss realised *by* such a settlement, so it cannot outlive them. Month-end
 * revaluation is not this: it is an ordinary JOURNAL_ENTRY fact.
 *
 * OPENING_BALANCE stays because only half of it is now reachable. A plain
 * opening trial balance is a journal entry, but opening AR/AP aging needs one
 * ledger line per customer or vendor, and a JournalEntry line against an
 * Accounts Receivable/Payable account requires a per-line Entity that this
 * release does not carry (see #journalEntryPayload). The typed residual is the
 * honest label for that half.
 *
 * FOREIGN_CURRENCY_BILL was retired on evidence, not on the code path existing:
 * on 2026-08-20 Bill 154 / MBC-2026-0820, S$1,635.00 at 0.783503, posted to the
 * real Sandbox Company US c694 with sent payload and exact read-back identical
 * field for field, provider write count +1, and QuickBooks itself auto-creating
 * an `Accounts Payable (A/P) - SGD` account carrying the balance. Until that run
 * it stayed listed, because "the code path is ready" is not a release record
 * here. See docs/QUICKBOOKS-MCP-RELEASE-VERDICT-2026-08-19.md.
 *
 * BANK_FEE and EXPENSE_CLAIM were removed by this release: a bank charge is a
 * Purchase against the bank account, and an expense claim is either a Purchase
 * (company card) or a journal entry crediting the employee payable. Neither
 * routes through cash movement.
 */
export const QUICKBOOKS_UNSUPPORTED_EVENT_TYPES = [
  "PAYMENT",
  "BILL_PAYMENT",
  "PREPAYMENT",
  "OPENING_BALANCE",
  "FX_SETTLEMENT",
] as const;

export type QuickBooksAccountingFactKind = typeof QUICKBOOKS_ACCOUNTING_FACT_KINDS[number];
export type QuickBooksAccountingFactOrigin = "MODEL_EXTRACTED" | "AGENT_ASSERTED";
export type QuickBooksUnsupportedEventType = typeof QUICKBOOKS_UNSUPPORTED_EVENT_TYPES[number];
export type QuickBooksSourceDigestProvenance =
  | "AGENT_SUPPLIED_TEXT_FINGERPRINT"
  | "HOST_PROVIDED_ORIGINAL_FILE_SHA256"
  | "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256";

export interface QuickBooksSourceUnit {
  unitId: string;
  expectedFactKinds: QuickBooksAccountingFactKind[];
}

export interface QuickBooksSourceArtifact {
  artifactId: string;
  label: string;
  units: QuickBooksSourceUnit[];
  /** Optional source identity. Its absence does not block MODEL_EXTRACTED facts. */
  sourceRef?: string;
  sourceSha256?: string;
  sourceDigestProvenance?: QuickBooksSourceDigestProvenance;
  /** Only meaningful with HOST_PROVIDED provenance and a server-side verifier. */
  sourceAttestationRef?: string;
}

interface QuickBooksFactBase {
  factId: string;
  lineageKey: string;
  eventKey: string;
  sourceUnitIds: string[];
  origin: QuickBooksAccountingFactOrigin;
  revision: number;
  supersedesFactId?: string;
}

export interface QuickBooksContactCandidateFact extends QuickBooksFactBase {
  kind: "CONTACT_CANDIDATE";
  role: "CUSTOMER" | "VENDOR";
  displayName: string;
  email?: string;
  companyName?: string;
  /**
   * Never part of the public intake schema and never Agent-supplied. The
   * compiler alone derives this from the NATIVE_DOCUMENT facts in the same
   * Case that reference this contact (see reconcileContactCurrencies in
   * accountingCaseCompiler.ts) and fills it in here so downstream payload
   * construction has one place to read it. Left undefined when no document
   * in the Case references this contact. A Customer/Vendor's CurrencyRef is
   * immutable after creation in QuickBooks.
   */
  currency?: string;
}

export type QuickBooksNativeDocumentType =
  | "INVOICE"
  | "BILL"
  | "CREDIT_MEMO"
  | "VENDOR_CREDIT"
  | "PURCHASE";

/** QuickBooks Purchase.PaymentType. Cash and Check draw a bank account; CreditCard draws a card account. */
export type QuickBooksPurchasePaymentType = "CASH" | "CHECK" | "CREDIT_CARD";

export interface QuickBooksNativeDocumentLine {
  lineId: string;
  description: string;
  quantity: string;
  unitAmount: string;
  sourceTax: string;
  codingType: "ITEM" | "ACCOUNT";
  codingName: string;
  taxCodeName?: string;
}

export interface QuickBooksNativeDocumentFact extends QuickBooksFactBase {
  kind: "NATIVE_DOCUMENT";
  documentType: QuickBooksNativeDocumentType;
  counterpartyName: string;
  documentDate: string;
  dueDate?: string;
  documentNumber?: string;
  currency: string;
  /** Home-currency units per one unit of `currency`; present only for a foreign-currency document. */
  exchangeRate?: string;
  taxMode: "NO_TAX" | "TAX_EXCLUDED" | "TAX_INCLUSIVE";
  lines: QuickBooksNativeDocumentLine[];
  declaredNet: string;
  declaredTax: string;
  declaredGross: string;
  businessReason: string;
  /**
   * PURCHASE only, and required there. A Purchase records an outflow that has
   * already happened, so unlike every other document type it names the account
   * the money left from -- a bank or credit card account, resolved by exact
   * name against the chart of accounts -- and how it left. QuickBooks requires
   * both on the object; every other released documentType must omit them.
   */
  paymentAccountName?: string;
  paymentType?: QuickBooksPurchasePaymentType;
}

export type QuickBooksJournalPostingType = "DEBIT" | "CREDIT";

export interface QuickBooksJournalEntryLine {
  lineId: string;
  description: string;
  postingType: QuickBooksJournalPostingType;
  /** Exact chart-of-accounts name; resolved the same way a document's ACCOUNT coding is. */
  accountName: string;
  amount: string;
}

/**
 * A general-ledger adjustment: accrual, reclassification, depreciation,
 * correction. It has no counterparty and no document total -- it has balanced
 * debit and credit lines against named accounts, which is why it cannot be a
 * NATIVE_DOCUMENT. Which accounts to touch is the Agent's or skill's judgment;
 * that debits equal credits is arithmetic and is checked here, deterministically.
 */
export interface QuickBooksJournalEntryFact extends QuickBooksFactBase {
  kind: "JOURNAL_ENTRY";
  entryDate: string;
  documentNumber?: string;
  currency: string;
  /** Home-currency units per one unit of `currency`; present only for a foreign-currency entry. */
  exchangeRate?: string;
  lines: QuickBooksJournalEntryLine[];
  /**
   * The entry's own stated value. Total debits and total credits must each
   * equal it, so a transcription error that happens to keep the entry balanced
   * is still caught -- the same independent anchor declaredNet/Tax/Gross give a
   * document.
   */
  declaredTotal: string;
  businessReason: string;
}

/**
 * A real accounting event supplied by the user that is outside this release's
 * native QuickBooks write routes. It remains typed and terminally accounted
 * for; it must never be disguised as generic evidence or a journal fallback.
 */
export interface QuickBooksUnsupportedEventFact extends QuickBooksFactBase {
  kind: "UNSUPPORTED_EVENT";
  eventType: QuickBooksUnsupportedEventType;
  date: string;
  currency: string;
  amount: string;
  counterpartyName?: string;
  note: string;
}

export interface QuickBooksEvidenceFact extends QuickBooksFactBase {
  kind: "EVIDENCE";
  evidenceRole: "SOURCE_DOCUMENT" | "APPROVAL" | "CORRESPONDENCE" | "CONTROL_SUPPORT";
  relatedEventKey?: string;
  note: string;
}

export interface QuickBooksControlFindingFact extends QuickBooksFactBase {
  kind: "CONTROL_FINDING";
  severity: "INFO" | "WARNING" | "BLOCK_WRITE";
  relatedEventKey?: string;
  code: string;
  note: string;
}

export type QuickBooksAccountingFact =
  | QuickBooksContactCandidateFact
  | QuickBooksNativeDocumentFact
  | QuickBooksJournalEntryFact
  | QuickBooksUnsupportedEventFact
  | QuickBooksEvidenceFact
  | QuickBooksControlFindingFact;

export type QuickBooksCaseEventDisposition =
  | "AUTO_EXECUTE"
  | "EVIDENCE_ONLY"
  | "BLOCKED_COVERAGE"
  | "BLOCKED_VALIDATION"
  | "BLOCKED_UNSUPPORTED"
  | "REVIEW_REQUIRED";

export interface QuickBooksCaseEvent {
  eventId: string;
  eventKey: string;
  primaryFactId?: string;
  factIds: string[];
  sourceUnitIds: string[];
  disposition: QuickBooksCaseEventDisposition;
  reasonCodes: string[];
  route?: QuickBooksNativeDocumentType | "CONTACT_CREATE" | "JOURNAL_ENTRY";
  unsupportedEventType?: QuickBooksUnsupportedEventType;
}

/**
 * Ties the amounts in the provider-ready canonical payload back to the exact
 * source fact, so source/canonical drift (the observed 80 -> 800 class) is
 * caught before dispatch. A JOURNAL_ENTRY has no net/tax split: it reports the
 * entry's balanced total as both net and gross with zero tax, and the canonical
 * side is read as the debit total only after debits and credits are confirmed
 * equal in the payload itself.
 */
export interface QuickBooksCaseAmountBridge {
  sourceFactIds: string[];
  sourceLineHash: string;
  currency: string;
  sourceNet: string;
  sourceTax: string;
  sourceGross: string;
  canonicalNet: string;
  canonicalTax: string;
  canonicalGross: string;
}

export interface QuickBooksCaseOperationCandidate {
  operationId: string;
  eventId: string;
  actionId: string;
  entity: QuickBooksWritableEntity;
  operation: QuickBooksWriteOperation;
  sourceUnitIds: string[];
  primaryFactId: string;
  sourceRevisionHash: string;
  sourceFactHash: string;
  sourceEvidenceHash: string;
  /**
   * Case/version-independent business identity used to collapse the same
   * source event across retries or separately-created Cases. It is not a
   * substitute for the immutable Case/source revision hashes above.
   */
  stableOperationKey: string;
  amountBridge?: QuickBooksCaseAmountBridge;
}

export interface QuickBooksCaseCompilationDraft {
  caseId: string;
  version: number;
  providerId: "quickbooks";
  sourceRevisionHash: string;
  compilerVersion: string;
  policyVersion: string;
  sources: QuickBooksSourceArtifact[];
  activeFacts: QuickBooksAccountingFact[];
  events: QuickBooksCaseEvent[];
  operationCandidates: QuickBooksCaseOperationCandidate[];
  status: "BLOCKED_COVERAGE" | "BLOCKED_VALIDATION" | "PLANNED_NEEDS_PREFLIGHT" | "PLANNED_WITH_EXCEPTIONS";
  coverage: {
    expectedArtifactCount: number;
    expectedSourceUnitCount: number;
    expectedFactRequirementCount: number;
    satisfiedFactRequirementCount: number;
    missingFactRequirements: string[];
  };
}

export interface QuickBooksCaseOperation extends QuickBooksCaseOperationCandidate {
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  validationReceipt: DeterministicValidationReceipt;
}

export interface CompiledQuickBooksAccountingCase extends QuickBooksCaseCompilationDraft {
  realmId: string;
  companyName: string;
  baseCurrency: string;
  operations: QuickBooksCaseOperation[];
}

export type QuickBooksCaseOperationState =
  | "PENDING"
  | "PREPARED"
  | "READBACK_VERIFIED"
  | "WRITE_UNCERTAIN"
  | "READBACK_MISMATCH"
  | "PROVIDER_REJECTED"
  | "BLOCKED_VALIDATION";

export interface QuickBooksCaseOperationRecord {
  operation: QuickBooksCaseOperation;
  state: QuickBooksCaseOperationState;
  preparationId?: string;
  preparationPayloadHash?: string;
  operationSourceEvidenceHash?: string;
  mutationRequestId?: string;
  providerEntityId?: string;
  authorizationReceipt?: Record<string, unknown>;
  authorizationEvidence?: QuickBooksAutonomousAuthorizationEvidence;
  reuseEvidenceReceipt?: QuickBooksMutationReuseEvidence;
  writeReceipt?: Record<string, unknown>;
  readback?: Record<string, unknown>;
  errorReceipt?: Record<string, unknown>;
}

export type QuickBooksCaseState =
  | "BLOCKED_COVERAGE"
  | "BLOCKED_VALIDATION"
  | "PLANNED_NEEDS_PREFLIGHT"
  | "PLANNED_WITH_EXCEPTIONS"
  | "EXECUTING"
  | "RECOVERY_REQUIRED"
  | "TERMINAL";

export interface QuickBooksCaseBinding {
  actorId: string;
  workspaceId: string;
  subjectType: "USER" | "TEAM";
  subjectId: string;
  agentId: string;
  installationId: string;
  bindingId: string;
  bindingRevision: number;
  connectionId: string;
  realmId: string;
  targetSessionHash: string;
}

export interface QuickBooksAccountingCaseRecord {
  binding: QuickBooksCaseBinding;
  compiled: CompiledQuickBooksAccountingCase;
  compiledPlanHash: string;
  state: QuickBooksCaseState;
  executionRequestId?: string;
  operations: QuickBooksCaseOperationRecord[];
  terminalSummary?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
