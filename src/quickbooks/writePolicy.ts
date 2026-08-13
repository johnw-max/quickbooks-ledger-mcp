export const QUICKBOOKS_WRITE_OPERATIONS = ["CREATE", "UPDATE", "DELETE"] as const;

export type QuickBooksWriteOperation = typeof QUICKBOOKS_WRITE_OPERATIONS[number];

export const QUICKBOOKS_WRITABLE_ENTITIES = [
  "Account",
  "Attachable",
  "Bill",
  "BillPayment",
  "Class",
  "CompanyInfo",
  "CreditMemo",
  "Customer",
  "Department",
  "Deposit",
  "Employee",
  "Estimate",
  "Invoice",
  "Item",
  "JournalEntry",
  "Payment",
  "PaymentMethod",
  "Purchase",
  "PurchaseOrder",
  "RefundReceipt",
  "SalesReceipt",
  "Term",
  "TimeActivity",
  "Transfer",
  "Vendor",
  "VendorCredit",
] as const;

export type QuickBooksWritableEntity = typeof QUICKBOOKS_WRITABLE_ENTITIES[number];

export type QuickBooksWriteRisk =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type QuickBooksExecutionMode =
  | "EXPLICIT_CONFIRMATION"
  | "HUMAN_REVIEW"
  | "RESTRICTED_HUMAN_REVIEW";

export type QuickBooksProviderEffect =
  | "NON_POSTING"
  | "MASTER_DATA"
  | "POSTING_TRANSACTION"
  | "CASH_MOVEMENT"
  | "LEDGER_ADJUSTMENT"
  | "DEACTIVATION"
  | "VOID_OR_PERMANENT_DELETE"
  | "PERMANENT_DELETE"
  | "ATTACHMENT";

export interface QuickBooksWriteCapability {
  entity: QuickBooksWritableEntity;
  operation: QuickBooksWriteOperation;
  officialTool: string;
  risk: QuickBooksWriteRisk;
  executionMode: QuickBooksExecutionMode;
  providerEffect: QuickBooksProviderEffect;
  quickBooksDraftAvailable: boolean;
  agentMayExecute: boolean;
  enabledByDefault: boolean;
  rationale: string;
}

const CREATE_ENTITIES = [
  "Account", "Attachable", "Bill", "BillPayment", "Class", "CreditMemo", "Customer",
  "Department", "Deposit", "Employee", "Estimate", "Invoice", "Item", "JournalEntry",
  "Payment", "PaymentMethod", "Purchase", "PurchaseOrder", "RefundReceipt", "SalesReceipt",
  "Term", "TimeActivity", "Transfer", "Vendor", "VendorCredit",
] as const satisfies readonly QuickBooksWritableEntity[];

const UPDATE_ENTITIES = QUICKBOOKS_WRITABLE_ENTITIES;

const DELETE_ENTITIES = [
  "Attachable", "Bill", "BillPayment", "CreditMemo", "Customer", "Deposit", "Employee",
  "Estimate", "Invoice", "Item", "JournalEntry", "Payment", "Purchase", "PurchaseOrder",
  "RefundReceipt", "SalesReceipt", "TimeActivity", "Transfer", "Vendor", "VendorCredit",
] as const satisfies readonly QuickBooksWritableEntity[];

const MASTER_DATA = new Set<QuickBooksWritableEntity>([
  "Account", "Class", "Customer", "Department", "Employee", "Item", "PaymentMethod", "Term", "Vendor",
]);
const NON_POSTING = new Set<QuickBooksWritableEntity>(["Estimate", "PurchaseOrder", "TimeActivity"]);
const CASH = new Set<QuickBooksWritableEntity>([
  "BillPayment", "Deposit", "Payment", "RefundReceipt", "Transfer",
]);
const LEDGER = new Set<QuickBooksWritableEntity>(["JournalEntry"]);

function officialName(operation: QuickBooksWriteOperation, entity: QuickBooksWritableEntity): string {
  const snake = entity.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  // The official repository currently keeps legacy hyphenated tool names for
  // Bill and Vendor while the rest of the CRUD surface uses underscores.
  if (entity === "Bill" || entity === "Vendor") return `${operation.toLowerCase()}-${snake}`;
  return `${operation.toLowerCase()}_${snake}`;
}

function createCapability(
  entity: QuickBooksWritableEntity,
  operation: QuickBooksWriteOperation,
): QuickBooksWriteCapability {
  if (operation === "DELETE") {
    const deactivation = ["Customer", "Employee", "Item", "Vendor"].includes(entity);
    const invoiceVoidFallback = entity === "Invoice";
    return {
      entity,
      operation,
      officialTool: officialName(operation, entity),
      risk: "CRITICAL",
      executionMode: "RESTRICTED_HUMAN_REVIEW",
      providerEffect: deactivation
        ? "DEACTIVATION"
        : invoiceVoidFallback
          ? "VOID_OR_PERMANENT_DELETE"
          : "PERMANENT_DELETE",
      quickBooksDraftAvailable: false,
      agentMayExecute: false,
      enabledByDefault: false,
      rationale: deactivation
        ? "The operation hides an active master-data record and can disrupt future posting."
        : invoiceVoidFallback
          ? "QuickBooks may delete an Invoice or fall back to voiding it; either outcome materially changes receivables."
        : "QuickBooks transaction deletion is permanent and cannot be represented as a reversible draft.",
    };
  }

  if (entity === "CompanyInfo") {
    return {
      entity,
      operation,
      officialTool: officialName(operation, entity),
      risk: "CRITICAL",
      executionMode: "RESTRICTED_HUMAN_REVIEW",
      providerEffect: "MASTER_DATA",
      quickBooksDraftAvailable: false,
      agentMayExecute: false,
      enabledByDefault: false,
      rationale: "Company-wide legal and accounting settings must never be changed by an Agent without restricted review.",
    };
  }

  if (entity === "Attachable") {
    return {
      entity,
      operation,
      officialTool: officialName(operation, entity),
      risk: operation === "CREATE" ? "LOW" : "MEDIUM",
      executionMode: operation === "CREATE" ? "EXPLICIT_CONFIRMATION" : "HUMAN_REVIEW",
      providerEffect: "ATTACHMENT",
      quickBooksDraftAvailable: false,
      agentMayExecute: operation === "CREATE",
      enabledByDefault: true,
      rationale: operation === "CREATE"
        ? "Adding approved supporting evidence does not itself change ledger amounts."
        : "Changing attachment metadata can weaken an audit trail and therefore requires review.",
    };
  }

  if (CASH.has(entity)) {
    return {
      entity,
      operation,
      officialTool: officialName(operation, entity),
      risk: "CRITICAL",
      executionMode: "RESTRICTED_HUMAN_REVIEW",
      providerEffect: "CASH_MOVEMENT",
      quickBooksDraftAvailable: false,
      agentMayExecute: false,
      enabledByDefault: false,
      rationale: "The operation records settlement, refund, deposit, or transfer and can change cash and open-item status.",
    };
  }

  if (LEDGER.has(entity)) {
    return {
      entity,
      operation,
      officialTool: officialName(operation, entity),
      risk: "CRITICAL",
      executionMode: "RESTRICTED_HUMAN_REVIEW",
      providerEffect: "LEDGER_ADJUSTMENT",
      quickBooksDraftAvailable: false,
      agentMayExecute: false,
      enabledByDefault: false,
      rationale: "Journal entries post directly to the general ledger and are intended for corrections or adjustments.",
    };
  }

  if (NON_POSTING.has(entity)) {
    return {
      entity,
      operation,
      officialTool: officialName(operation, entity),
      risk: operation === "CREATE" ? "LOW" : "MEDIUM",
      executionMode: operation === "CREATE" ? "EXPLICIT_CONFIRMATION" : "HUMAN_REVIEW",
      providerEffect: "NON_POSTING",
      quickBooksDraftAvailable: true,
      agentMayExecute: operation === "CREATE",
      enabledByDefault: true,
      rationale: "The object is non-posting, but it can still drive purchasing, sales, or time workflows.",
    };
  }

  if (MASTER_DATA.has(entity)) {
    const lowRiskCreate = operation === "CREATE" && ["Class", "Customer", "Department", "PaymentMethod", "Term", "Vendor"].includes(entity);
    return {
      entity,
      operation,
      officialTool: officialName(operation, entity),
      risk: lowRiskCreate ? "LOW" : "MEDIUM",
      executionMode: lowRiskCreate ? "EXPLICIT_CONFIRMATION" : "HUMAN_REVIEW",
      providerEffect: "MASTER_DATA",
      quickBooksDraftAvailable: false,
      agentMayExecute: lowRiskCreate,
      enabledByDefault: true,
      rationale: lowRiskCreate
        ? "Creating this reference record does not post a transaction, but duplicate and exact-target checks still apply."
        : "The change can alter coding, payroll, inventory, or existing transaction behavior and requires review.",
    };
  }

  return {
    entity,
    operation,
    officialTool: officialName(operation, entity),
    risk: "HIGH",
    executionMode: "HUMAN_REVIEW",
    providerEffect: "POSTING_TRANSACTION",
    quickBooksDraftAvailable: false,
    agentMayExecute: false,
    enabledByDefault: true,
    rationale: "QuickBooks creates or changes this as a posted accounting transaction; our PREPARED record is the review draft.",
  };
}

export const QUICKBOOKS_WRITE_CAPABILITIES: readonly QuickBooksWriteCapability[] = [
  ...CREATE_ENTITIES.map((entity) => createCapability(entity, "CREATE")),
  ...UPDATE_ENTITIES.map((entity) => createCapability(entity, "UPDATE")),
  ...DELETE_ENTITIES.map((entity) => createCapability(entity, "DELETE")),
];

const CAPABILITY_INDEX = new Map(
  QUICKBOOKS_WRITE_CAPABILITIES.map((capability) => [`${capability.operation}:${capability.entity}`, capability]),
);

export function quickBooksWriteCapability(
  operation: QuickBooksWriteOperation,
  entity: QuickBooksWritableEntity,
): QuickBooksWriteCapability | undefined {
  return CAPABILITY_INDEX.get(`${operation}:${entity}`);
}

export function quickBooksWriteCapabilitySummary() {
  const count = (predicate: (capability: QuickBooksWriteCapability) => boolean) =>
    QUICKBOOKS_WRITE_CAPABILITIES.filter(predicate).length;
  return {
    source: "Intuit QuickBooks Online MCP Server",
    sourceCoverage: { total: QUICKBOOKS_WRITE_CAPABILITIES.length, create: 25, update: 26, delete: 20 },
    policy: {
      explicitConfirmation: count((capability) => capability.executionMode === "EXPLICIT_CONFIRMATION"),
      humanReview: count((capability) => capability.executionMode === "HUMAN_REVIEW"),
      restrictedHumanReview: count((capability) => capability.executionMode === "RESTRICTED_HUMAN_REVIEW"),
    },
    importantSemantics: {
      quickBooksHasUniversalDraftState: false,
      preparedIsLocalReviewDraft: true,
      providerWriteSuccessRequiresExactReadback: true,
      deletionMayBePermanent: true,
    },
    capabilities: QUICKBOOKS_WRITE_CAPABILITIES,
  };
}
