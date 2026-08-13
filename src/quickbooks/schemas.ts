import { z } from "zod/v4";
import { Buffer } from "node:buffer";
import { QUICKBOOKS_REPORTS, QUICKBOOKS_TRANSACTION_ENTITIES } from "../providers/quickbooksProvider.js";
import {
  QUICKBOOKS_WRITABLE_ENTITIES,
  QUICKBOOKS_WRITE_OPERATIONS,
} from "./writePolicy.js";
import type { QuickBooksWritableEntity, QuickBooksWriteOperation } from "./writePolicy.js";

const yyyyMmDd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");

const providerId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);
const taxCodeId = providerId.refine((value) => /^\d+$/.test(value), {
  message: "must use a numeric TaxCode Id returned by quickbooks_list_tax_codes; for NON/no-tax use global_tax_calculation=NotApplicable and omit tax_code_id",
});
const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const targetSessionRef = z.string().trim().min(64).max(2_048).regex(
  /^qbts_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  "must be an opaque target session returned by quickbooks_resolve_target",
);
const nonNegativeMoney = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/);
const money = nonNegativeMoney.refine(
  (value) => Number(value) > 0,
  "must be greater than zero",
);

export const quickBooksNoInputSchema = z.object({}).strict();

export const quickBooksTargetSessionSchema = z.object({
  target_session_ref: targetSessionRef,
}).strict();

export const quickBooksSearchVendorsSchema = z.object({
  target_session_ref: targetSessionRef,
  query: z.string().trim().min(1).max(128),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();

export const quickBooksSearchCustomersSchema = quickBooksSearchVendorsSchema;

export const quickBooksListItemsSchema = quickBooksTargetSessionSchema;

export const quickBooksListTransactionsSchema = z.object({
  target_session_ref: targetSessionRef,
  entity: z.enum(QUICKBOOKS_TRANSACTION_ENTITIES),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  customer_id: providerId.optional(),
  vendor_id: providerId.optional(),
  open_only: z.boolean().optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  page_size: z.number().int().min(1).max(50).default(25),
}).strict().superRefine((value, context) => {
  if (value.date_from && value.date_to && value.date_to < value.date_from) {
    context.addIssue({ code: "custom", message: "date_to must not be before date_from", path: ["date_to"] });
  }
  const customerEntities = ["Invoice", "Payment", "CreditMemo", "SalesReceipt", "RefundReceipt"];
  const vendorEntities = ["Purchase", "BillPayment", "VendorCredit"];
  if (value.customer_id && !customerEntities.includes(value.entity)) {
    context.addIssue({ code: "custom", message: `${value.entity} does not support customer_id`, path: ["customer_id"] });
  }
  if (value.vendor_id && !vendorEntities.includes(value.entity)) {
    context.addIssue({ code: "custom", message: `${value.entity} does not support vendor_id`, path: ["vendor_id"] });
  }
  if (value.customer_id && value.vendor_id) {
    context.addIssue({ code: "custom", message: "use either customer_id or vendor_id, not both", path: ["vendor_id"] });
  }
  if (value.open_only && value.entity !== "Invoice") {
    context.addIssue({ code: "custom", message: "open_only is currently supported for Invoice only", path: ["open_only"] });
  }
});

export const quickBooksGetTransactionSchema = z.object({
  target_session_ref: targetSessionRef,
  entity: z.enum(QUICKBOOKS_TRANSACTION_ENTITIES),
  transaction_id: providerId,
}).strict();

export const quickBooksRunReportSchema = z.object({
  target_session_ref: targetSessionRef,
  report: z.enum(QUICKBOOKS_REPORTS),
  start_date: yyyyMmDd.optional(),
  end_date: yyyyMmDd.optional(),
  as_of_date: yyyyMmDd.optional(),
  accounting_method: z.enum(["Cash", "Accrual"]).optional(),
  customer_id: providerId.optional(),
  vendor_id: providerId.optional(),
  max_rows: z.number().int().min(1).max(1_000).default(250),
  view: z.enum(["normalized", "raw", "both"]).default("normalized"),
}).strict().superRefine((value, context) => {
  if (value.start_date && value.end_date && value.end_date < value.start_date) {
    context.addIssue({ code: "custom", message: "end_date must not be before start_date", path: ["end_date"] });
  }
  if (value.as_of_date && (value.start_date || value.end_date)) {
    context.addIssue({
      code: "custom",
      message: "use either as_of_date or start_date/end_date; mixing point-in-time and period windows is ambiguous",
      path: ["as_of_date"],
    });
  }
  if (value.customer_id && value.vendor_id) {
    context.addIssue({ code: "custom", message: "use either customer_id or vendor_id, not both", path: ["vendor_id"] });
  }
  const customerReports = ["CustomerBalance", "AgedReceivables"];
  const vendorReports = ["VendorBalance", "AgedPayables", "VendorExpenses"];
  if (value.customer_id && !customerReports.includes(value.report)) {
    context.addIssue({ code: "custom", message: `${value.report} does not support customer_id`, path: ["customer_id"] });
  }
  if (value.vendor_id && !vendorReports.includes(value.report)) {
    context.addIssue({ code: "custom", message: `${value.report} does not support vendor_id`, path: ["vendor_id"] });
  }
});

export const quickBooksListBillsSchema = z.object({
  target_session_ref: targetSessionRef,
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  page_size: z.number().int().min(1).max(100).default(25),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
});

export const quickBooksGetBillSchema = z.object({
  target_session_ref: targetSessionRef,
  bill_id: providerId,
}).strict();

export const quickBooksHashSourceDocumentSchema = z.object({
  source_ref: z.string().trim().min(1).max(256).regex(/^[^\r\n\u0000-\u001f\u007f]+$/u),
  content: z.string().min(1).max(262_144).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 262_144,
    "UTF-8 content must not exceed 262144 bytes",
  ),
}).strict();

const quickBooksBillLineSchema = z.object({
  account_id: providerId,
  amount: money,
  description: z.string().trim().min(1).max(4_000).optional(),
  tax_code_id: taxCodeId.optional(),
}).strict();

export const quickBooksPrepareSupplierBillSchema = z.object({
  target_session_ref: targetSessionRef,
  request_id: requestId,
  source_ref: z.string().trim().min(1).max(256).regex(/^[^\r\n\u0000-\u001f\u007f]+$/u),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0{64}$/.test(value), {
    message: "must be a real content digest, not the all-zero placeholder",
  }),
  source_digest_provenance: z.enum([
    "AGENT_SUPPLIED_TEXT_FINGERPRINT",
    "HOST_PROVIDED_ORIGINAL_FILE_SHA256",
    "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256",
  ]).default("EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256"),
  source_attestation_ref: z.string().trim().min(16).max(2_048).optional(),
  vendor_id: providerId,
  txn_date: yyyyMmDd,
  due_date: yyyyMmDd.optional(),
  doc_number: z.string().trim().min(1).max(21).optional(),
  missing_doc_number_reason: z.string().trim().min(3).max(256).optional(),
  currency_code: z.string().regex(/^[A-Z]{3}$/).optional(),
  memo: z.string().trim().min(1).max(3_000).optional(),
  approval_ref: z.string().trim().min(1).max(256).optional(),
  supporting_evidence: z.array(z.object({
    kind: z.enum(["approval", "coding", "correspondence", "other"]),
    ref: z.string().trim().min(1).max(256),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0{64}$/.test(value)),
  }).strict()).max(20).default([]),
  global_tax_calculation: z.enum(["TaxExcluded", "TaxInclusive", "NotApplicable"]),
  invoice_total: money,
  tax_total: nonNegativeMoney,
  lines: z.array(quickBooksBillLineSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.source_digest_provenance === "HOST_PROVIDED_ORIGINAL_FILE_SHA256" && !value.source_attestation_ref) {
    context.addIssue({ code: "custom", message: "HOST_PROVIDED provenance requires source_attestation_ref from WorkStore", path: ["source_attestation_ref"] });
  }
  if (value.source_digest_provenance !== "HOST_PROVIDED_ORIGINAL_FILE_SHA256" && value.source_attestation_ref) {
    context.addIssue({ code: "custom", message: "source_attestation_ref is only valid for HOST_PROVIDED provenance", path: ["source_attestation_ref"] });
  }
  if (value.due_date && value.due_date < value.txn_date) {
    context.addIssue({ code: "custom", message: "due_date must not be before txn_date", path: ["due_date"] });
  }
  if (!value.doc_number && !value.missing_doc_number_reason) {
    context.addIssue({ code: "custom", message: "provide doc_number or explain why it is missing", path: ["missing_doc_number_reason"] });
  }
  if (value.doc_number && value.missing_doc_number_reason) {
    context.addIssue({ code: "custom", message: "omit missing_doc_number_reason when doc_number is present", path: ["missing_doc_number_reason"] });
  }
  if (value.global_tax_calculation === "NotApplicable" && value.lines.some((line) => line.tax_code_id)) {
    context.addIssue({ code: "custom", message: "tax_code_id must be omitted when global_tax_calculation is NotApplicable", path: ["lines"] });
  }
  if (value.global_tax_calculation !== "NotApplicable" && value.lines.some((line) => !line.tax_code_id)) {
    context.addIssue({ code: "custom", message: "every line needs a QuickBooks tax_code_id for TaxExcluded or TaxInclusive", path: ["lines"] });
  }
  const cents = (amount: string) => Math.round(Number(amount) * 100);
  const lineCents = value.lines.reduce((total, line) => total + cents(line.amount), 0);
  const invoiceCents = cents(value.invoice_total);
  const taxCents = cents(value.tax_total);
  if (value.global_tax_calculation === "NotApplicable" && taxCents !== 0) {
    context.addIssue({ code: "custom", message: "tax_total must be zero when tax is NotApplicable", path: ["tax_total"] });
  }
  const expectedInvoiceCents = value.global_tax_calculation === "TaxExcluded" ? lineCents + taxCents : lineCents;
  if (invoiceCents !== expectedInvoiceCents) {
    context.addIssue({
      code: "custom",
      message: `invoice_total does not reconcile: expected ${(expectedInvoiceCents / 100).toFixed(2)} from lines and tax_total`,
      path: ["invoice_total"],
    });
  }
  if (taxCents > invoiceCents) {
    context.addIssue({ code: "custom", message: "tax_total cannot exceed invoice_total", path: ["tax_total"] });
  }
});

export const quickBooksTrialBalanceSchema = z.object({
  target_session_ref: targetSessionRef,
  date: yyyyMmDd.optional(),
}).strict();

const MUTATION_FIELDS: Readonly<Record<QuickBooksWritableEntity, ReadonlySet<string>>> = {
  Account: new Set(["Name", "AcctNum", "AccountType", "AccountSubType", "Description", "CurrencyRef", "TaxCodeRef", "Classification", "Active", "ParentRef", "SubAccount", "CurrentBalance"]),
  Attachable: new Set(["file_name", "note", "category", "content_type", "base64_content", "attachable_ref", "FileName", "Note", "Category", "ContentType", "AttachableRef"]),
  Bill: new Set(["VendorRef", "Line", "TxnDate", "DueDate", "DocNumber", "CurrencyRef", "ExchangeRate", "APAccountRef", "SalesTermRef", "GlobalTaxCalculation", "TxnTaxDetail", "PrivateNote", "DepartmentRef", "Balance", "TotalAmt", "CustomField"]),
  BillPayment: new Set(["VendorRef", "PayType", "TotalAmt", "TxnDate", "DocNumber", "CurrencyRef", "ExchangeRate", "APAccountRef", "CheckPayment", "CreditCardPayment", "Line", "PrivateNote"]),
  Class: new Set(["Name", "SubClass", "ParentRef", "Active"]),
  CompanyInfo: new Set(["CompanyName", "LegalName", "CompanyAddr", "CustomerCommunicationAddr", "LegalAddr", "PrimaryPhone", "CompanyEmailAddr", "CustomerCommunicationEmailAddr", "WebAddr", "FiscalYearStartMonth", "Country", "Email"]),
  CreditMemo: new Set(["CustomerRef", "Line", "TxnDate", "DocNumber", "CurrencyRef", "ExchangeRate", "DepartmentRef", "GlobalTaxCalculation", "TxnTaxDetail", "PrivateNote", "CustomerMemo", "BillEmail", "ShipAddr", "BillAddr", "CustomField"]),
  Customer: new Set(["DisplayName", "Title", "GivenName", "MiddleName", "FamilyName", "Suffix", "CompanyName", "PrintOnCheckName", "PrimaryEmailAddr", "PrimaryPhone", "AlternatePhone", "Mobile", "Fax", "BillAddr", "ShipAddr", "Notes", "Taxable", "DefaultTaxCodeRef", "PrimaryTaxIdentifier", "CurrencyRef", "PaymentMethodRef", "SalesTermRef", "Active", "ParentRef", "Job", "CustomField"]),
  Department: new Set(["Name", "SubDepartment", "ParentRef", "Active"]),
  Deposit: new Set(["DepositToAccountRef", "Line", "TxnDate", "TotalAmt", "CurrencyRef", "ExchangeRate", "PrivateNote", "DepartmentRef", "CustomField"]),
  Employee: new Set(["DisplayName", "Title", "GivenName", "MiddleName", "FamilyName", "Suffix", "PrintOnCheckName", "PrimaryPhone", "Mobile", "PrimaryEmailAddr", "Address", "BillableTime", "BillRate", "EmployeeNumber", "SSN", "Gender", "BirthDate", "HiredDate", "ReleasedDate", "Active"]),
  Estimate: new Set(["CustomerRef", "Line", "TxnDate", "ExpirationDate", "DocNumber", "CurrencyRef", "ExchangeRate", "DepartmentRef", "GlobalTaxCalculation", "TxnTaxDetail", "PrivateNote", "CustomerMemo", "BillEmail", "ShipAddr", "BillAddr", "AcceptedBy", "AcceptedDate", "SalesTermRef", "CustomField"]),
  Invoice: new Set(["CustomerRef", "Line", "TxnDate", "DueDate", "DocNumber", "CurrencyRef", "ExchangeRate", "DepartmentRef", "SalesTermRef", "GlobalTaxCalculation", "TxnTaxDetail", "PrivateNote", "CustomerMemo", "BillEmail", "ShipAddr", "BillAddr", "LinkedTxn", "AllowOnlinePayment", "AllowOnlineCreditCardPayment", "AllowOnlineACHPayment", "ApplyTaxAfterDiscount", "TotalAmt", "CustomField"]),
  Item: new Set(["Name", "Sku", "Description", "PurchaseDesc", "Active", "SubItem", "ParentRef", "Level", "FullyQualifiedName", "Taxable", "SalesTaxIncluded", "UnitPrice", "Type", "IncomeAccountRef", "PurchaseTaxIncluded", "PurchaseCost", "ExpenseAccountRef", "AssetAccountRef", "TrackQtyOnHand", "QtyOnHand", "InvStartDate", "SalesTaxCodeRef", "PurchaseTaxCodeRef"]),
  JournalEntry: new Set(["Line", "TxnDate", "DocNumber", "CurrencyRef", "ExchangeRate", "PrivateNote", "Adjustment", "TxnTaxDetail", "CustomField"]),
  Payment: new Set(["CustomerRef", "TotalAmt", "TxnDate", "CurrencyRef", "ExchangeRate", "DepositToAccountRef", "PaymentMethodRef", "PaymentRefNum", "PrivateNote", "Line", "UnappliedAmt"]),
  PaymentMethod: new Set(["Name", "Type", "Active"]),
  Purchase: new Set(["PaymentType", "AccountRef", "EntityRef", "Line", "TxnDate", "DocNumber", "CurrencyRef", "ExchangeRate", "Credit", "PrivateNote", "DepartmentRef", "GlobalTaxCalculation", "TxnTaxDetail", "PaymentMethodRef", "CustomField"]),
  PurchaseOrder: new Set(["VendorRef", "Line", "TxnDate", "DueDate", "DocNumber", "CurrencyRef", "ExchangeRate", "APAccountRef", "ShipAddr", "VendorAddr", "EmailStatus", "POEmail", "PrivateNote", "Memo", "DepartmentRef", "GlobalTaxCalculation", "TxnTaxDetail", "CustomField"]),
  RefundReceipt: new Set(["CustomerRef", "Line", "TxnDate", "DocNumber", "CurrencyRef", "ExchangeRate", "DepositToAccountRef", "PaymentMethodRef", "PaymentRefNum", "DepartmentRef", "GlobalTaxCalculation", "TxnTaxDetail", "PrivateNote", "CustomerMemo", "BillEmail", "ShipAddr", "BillAddr", "CustomField"]),
  SalesReceipt: new Set(["CustomerRef", "Line", "TxnDate", "DocNumber", "CurrencyRef", "ExchangeRate", "DepositToAccountRef", "PaymentMethodRef", "PaymentRefNum", "DepartmentRef", "GlobalTaxCalculation", "TxnTaxDetail", "PrivateNote", "CustomerMemo", "BillEmail", "ShipAddr", "BillAddr", "CustomField"]),
  Term: new Set(["Name", "Active", "Type", "DiscountPercent", "DueDays", "DiscountDays", "DayOfMonthDue", "DueNextMonthDays", "DiscountDayOfMonth"]),
  TimeActivity: new Set(["TxnDate", "NameOf", "EmployeeRef", "VendorRef", "CustomerRef", "ItemRef", "ClassRef", "DepartmentRef", "Taxable", "BillableStatus", "HourlyRate", "Hours", "Minutes", "Description", "StartTime", "EndTime", "BreakHours", "BreakMinutes"]),
  Transfer: new Set(["FromAccountRef", "ToAccountRef", "Amount", "TxnDate", "CurrencyRef", "ExchangeRate", "PrivateNote"]),
  Vendor: new Set(["DisplayName", "Title", "GivenName", "MiddleName", "FamilyName", "Suffix", "CompanyName", "PrintOnCheckName", "PrimaryEmailAddr", "PrimaryPhone", "AlternatePhone", "Mobile", "Fax", "BillAddr", "TermRef", "Balance", "AcctNum", "Vendor1099", "CurrencyRef", "TaxIdentifier", "BusinessNumber", "WebAddr", "Active", "CustomField"]),
  VendorCredit: new Set(["VendorRef", "Line", "TxnDate", "DocNumber", "CurrencyRef", "ExchangeRate", "APAccountRef", "DepartmentRef", "GlobalTaxCalculation", "TxnTaxDetail", "PrivateNote", "CustomField"]),
};

const FORBIDDEN_MUTATION_KEYS = new Set([
  "__proto__", "prototype", "constructor", "realmId", "realm_id", "companyId", "company_id",
  "accessToken", "access_token", "refreshToken", "refresh_token", "requestid", "request_id",
]);

const REFERENCE_KEYS = new Set(["value", "name", "type"]);
const ADDRESS_KEYS = new Set([
  "Id", "Line1", "Line2", "Line3", "Line4", "Line5", "City", "Country", "CountryCode",
  "CountrySubDivisionCode", "PostalCode", "Lat", "Long", "Tag", "Note",
]);
const EMAIL_KEYS = new Set(["Address"]);
const PHONE_KEYS = new Set(["FreeFormNumber"]);
const WEB_KEYS = new Set(["URI"]);
const LINE_KEYS = new Set([
  "Id", "LineNum", "Description", "Amount", "DetailType", "LinkedTxn",
  "SalesItemLineDetail", "GroupLineDetail", "DescriptionOnly", "DiscountLineDetail",
  "SubTotalLineDetail", "ItemBasedExpenseLineDetail", "AccountBasedExpenseLineDetail",
  "DepositLineDetail", "JournalEntryLineDetail", "PaymentLineDetail", "PurchaseOrderItemLineDetail",
]);
const SALES_ITEM_DETAIL_KEYS = new Set([
  "ItemRef", "ClassRef", "UnitPrice", "RatePercent", "PriceLevelRef", "MarkupInfo", "Qty",
  "UOMRef", "ItemAccountRef", "ServiceDate", "TaxCodeRef", "TaxInclusiveAmt", "DiscountRate",
  "DiscountAmt", "ItemAgentRef", "ItemElementRef",
]);
const EXPENSE_DETAIL_KEYS = new Set([
  "AccountRef", "ItemRef", "ClassRef", "CustomerRef", "BillableStatus", "MarkupInfo", "Qty",
  "UnitPrice", "TaxCodeRef", "TaxAmount", "TaxInclusiveAmt", "ServiceDate", "PurchaseOrderRef",
]);
const JOURNAL_DETAIL_KEYS = new Set([
  "PostingType", "Entity", "AccountRef", "ClassRef", "DepartmentRef", "TaxCodeRef", "TaxApplicableOn",
  "TaxAmount", "BillableStatus", "CustomerRef",
]);
const PAYMENT_LINE_DETAIL_KEYS = new Set(["ItemRef", "ServiceDate", "ClassRef", "Balance"]);
const DEPOSIT_LINE_DETAIL_KEYS = new Set(["Entity", "ClassRef", "AccountRef", "PaymentMethodRef", "CheckNum", "TxnType", "TaxCodeRef", "TaxApplicableOn", "TaxAmount"]);
const GROUP_LINE_DETAIL_KEYS = new Set(["GroupItemRef", "Quantity", "Line"]);
const DISCOUNT_LINE_DETAIL_KEYS = new Set(["PercentBased", "DiscountPercent", "DiscountAccountRef", "ClassRef", "TaxCodeRef"]);
const LINKED_TXN_KEYS = new Set(["TxnId", "TxnType", "TxnLineId"]);
const ENTITY_KEYS = new Set(["EntityRef", "Type"]);
const TAX_DETAIL_KEYS = new Set(["TxnTaxCodeRef", "TotalTax", "TaxLine"]);
const TAX_LINE_KEYS = new Set(["Amount", "DetailType", "TaxLineDetail"]);
const TAX_LINE_DETAIL_KEYS = new Set(["TaxRateRef", "PercentBased", "TaxPercent", "NetAmountTaxable"]);
const MARKUP_KEYS = new Set(["PriceLevelRef", "Percent", "MarkUpIncomeAccountRef"]);
const ATTACHABLE_REF_KEYS = new Set(["EntityRef", "IncludeOnSend", "NoRefOnly"]);
const PAYMENT_CHECK_KEYS = new Set(["BankAccountRef", "PrintStatus", "CheckDetail"]);
const PAYMENT_CARD_KEYS = new Set(["CCAccountRef", "CreditCardAccountRef", "CCDetail"]);
const CHECK_DETAIL_KEYS = new Set(["BankName", "AccountNum", "CheckNum", "Memo"]);
const CARD_DETAIL_KEYS = new Set(["Number", "Type", "NameOnAcct", "CcExpiryMonth", "CcExpiryYear", "BillAddrStreet", "PostalCode", "CommercialCardCode", "TxnMode"]);
const CUSTOM_FIELD_KEYS = new Set(["DefinitionId", "Name", "Type", "StringValue", "BooleanValue", "DateValue", "NumberValue"]);
const VALUE_KEYS = new Set(["value"]);

const ARRAY_MUTATION_KEYS = new Set(["Line", "LinkedTxn", "TaxLine", "AttachableRef", "CustomField"]);
const NUMBER_MUTATION_KEYS = new Set([
  "Amount", "Balance", "BillRate", "BreakHours", "BreakMinutes", "DiscountAmt", "DiscountDayOfMonth",
  "DiscountDays", "DiscountPercent", "DiscountRate", "DueDays", "DueNextMonthDays", "ExchangeRate",
  "HourlyRate", "Hours", "Level", "LineNum", "Minutes", "NetAmountTaxable", "NumberValue", "Percent",
  "Quantity", "Qty", "QtyOnHand", "RatePercent", "PurchaseCost", "CurrentBalance", "TaxAmount", "TaxInclusiveAmt",
  "TaxPercent", "TotalAmt", "TotalTax", "UnitPrice", "UnappliedAmt", "DayOfMonthDue",
]);
const BOOLEAN_MUTATION_KEYS = new Set([
  "Active", "Adjustment", "AllowOnlineACHPayment", "AllowOnlineCreditCardPayment", "AllowOnlinePayment",
  "ApplyTaxAfterDiscount", "BillableTime", "BooleanValue", "Credit", "IncludeOnSend", "Job", "NoRefOnly", "PercentBased",
  "PurchaseTaxIncluded", "SalesTaxIncluded", "SubAccount", "SubClass", "SubDepartment", "SubItem",
  "Taxable", "TrackQtyOnHand", "Vendor1099",
]);
const DATE_MUTATION_KEYS = new Set([
  "AcceptedDate", "BirthDate", "DateValue", "DueDate", "ExpirationDate", "HiredDate", "InvStartDate",
  "ReleasedDate", "ServiceDate", "TxnDate",
]);
const DATETIME_MUTATION_KEYS = new Set(["EndTime", "StartTime"]);
const CLEARABLE_UPDATE_STRING_FIELDS = new Set([
  "AcceptedBy", "AcctNum", "BusinessNumber", "Category", "CompanyName", "Description", "DocNumber",
  "FamilyName", "FileName", "GivenName", "MiddleName", "Memo", "Note", "Notes", "PaymentRefNum",
  "PrintOnCheckName", "PrivateNote", "PurchaseDesc", "Suffix", "TaxIdentifier", "Title", "file_name",
  "note", "category",
]);
const ENUM_MUTATION_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  BillableStatus: new Set(["Billable", "NotBillable", "HasBeenBilled"]),
  DetailType: new Set([
    "AccountBasedExpenseLineDetail", "DepositLineDetail", "DescriptionOnly", "DiscountLineDetail",
    "GroupLineDetail", "ItemBasedExpenseLineDetail", "JournalEntryLineDetail", "PaymentLineDetail",
    "PurchaseOrderItemLineDetail", "SalesItemLineDetail", "SubTotalLineDetail", "TaxLineDetail",
  ]),
  GlobalTaxCalculation: new Set(["TaxExcluded", "TaxInclusive", "NotApplicable"]),
  NameOf: new Set(["Vendor", "Employee"]),
  PayType: new Set(["Check", "CreditCard"]),
  PaymentType: new Set(["Cash", "Check", "CreditCard"]),
  PostingType: new Set(["Debit", "Credit"]),
};
const CREATE_REQUIRED_FIELDS: Readonly<Partial<Record<QuickBooksWritableEntity, readonly string[]>>> = {
  Account: ["Name", "AccountType"],
  Bill: ["VendorRef", "Line"],
  BillPayment: ["VendorRef", "PayType", "TotalAmt"],
  Class: ["Name"],
  CreditMemo: ["CustomerRef", "Line"],
  Customer: ["DisplayName"],
  Department: ["Name"],
  Deposit: ["DepositToAccountRef", "Line"],
  Employee: ["DisplayName"],
  Estimate: ["CustomerRef", "Line"],
  Invoice: ["CustomerRef", "Line"],
  Item: ["Name", "Type", "IncomeAccountRef"],
  JournalEntry: ["TxnDate", "Line"],
  Payment: ["CustomerRef", "TotalAmt"],
  PaymentMethod: ["Name"],
  Purchase: ["PaymentType", "AccountRef", "Line"],
  PurchaseOrder: ["VendorRef", "Line"],
  RefundReceipt: ["CustomerRef", "Line"],
  SalesReceipt: ["CustomerRef", "Line"],
  Term: ["Name"],
  TimeActivity: ["NameOf"],
  Transfer: ["FromAccountRef", "ToAccountRef", "Amount"],
  Vendor: ["DisplayName"],
  VendorCredit: ["VendorRef", "Line"],
};
const LINE_DETAIL_KEYS = [
  "SalesItemLineDetail", "GroupLineDetail", "DescriptionOnly", "DiscountLineDetail", "SubTotalLineDetail",
  "ItemBasedExpenseLineDetail", "AccountBasedExpenseLineDetail", "DepositLineDetail",
  "JournalEntryLineDetail", "PaymentLineDetail", "PurchaseOrderItemLineDetail",
] as const;

function referenceLike(key: string): boolean {
  return key.endsWith("Ref") || key === "EntityRef" || key === "UOMRef";
}

function nestedAllowedKeys(parentKey: string): ReadonlySet<string> | undefined {
  if (referenceLike(parentKey)) return REFERENCE_KEYS;
  if (["BillAddr", "ShipAddr", "VendorAddr", "CompanyAddr", "CustomerCommunicationAddr", "LegalAddr", "Address", "PhysicalAddress"].includes(parentKey)) return ADDRESS_KEYS;
  if (["PrimaryEmailAddr", "CompanyEmailAddr", "CustomerCommunicationEmailAddr", "BillEmail", "POEmail", "Email"].includes(parentKey)) return EMAIL_KEYS;
  if (["PrimaryPhone", "AlternatePhone", "Mobile", "Fax"].includes(parentKey)) return PHONE_KEYS;
  if (parentKey === "WebAddr") return WEB_KEYS;
  if (parentKey === "CustomerMemo") return VALUE_KEYS;
  if (parentKey === "Line") return LINE_KEYS;
  if (["SalesItemLineDetail", "PurchaseOrderItemLineDetail"].includes(parentKey)) return SALES_ITEM_DETAIL_KEYS;
  if (["ItemBasedExpenseLineDetail", "AccountBasedExpenseLineDetail"].includes(parentKey)) return EXPENSE_DETAIL_KEYS;
  if (parentKey === "JournalEntryLineDetail") return JOURNAL_DETAIL_KEYS;
  if (parentKey === "PaymentLineDetail") return PAYMENT_LINE_DETAIL_KEYS;
  if (parentKey === "DepositLineDetail") return DEPOSIT_LINE_DETAIL_KEYS;
  if (parentKey === "GroupLineDetail") return GROUP_LINE_DETAIL_KEYS;
  if (parentKey === "DiscountLineDetail") return DISCOUNT_LINE_DETAIL_KEYS;
  if (parentKey === "SubTotalLineDetail" || parentKey === "DescriptionOnly") return new Set<string>();
  if (parentKey === "LinkedTxn") return LINKED_TXN_KEYS;
  if (parentKey === "Entity") return ENTITY_KEYS;
  if (parentKey === "TxnTaxDetail") return TAX_DETAIL_KEYS;
  if (parentKey === "TaxLine") return TAX_LINE_KEYS;
  if (parentKey === "TaxLineDetail") return TAX_LINE_DETAIL_KEYS;
  if (parentKey === "MarkupInfo") return MARKUP_KEYS;
  if (parentKey === "AttachableRef" || parentKey === "attachable_ref") {
    return parentKey === "attachable_ref"
      ? new Set(["entity_ref_type", "entity_ref_value", "include_on_send"])
      : ATTACHABLE_REF_KEYS;
  }
  if (parentKey === "CheckPayment") return PAYMENT_CHECK_KEYS;
  if (parentKey === "CreditCardPayment") return PAYMENT_CARD_KEYS;
  if (parentKey === "CheckDetail") return CHECK_DETAIL_KEYS;
  if (parentKey === "CCDetail") return CARD_DETAIL_KEYS;
  if (parentKey === "CustomField") return CUSTOM_FIELD_KEYS;
  return undefined;
}

function expectsArray(key: string): boolean {
  return ARRAY_MUTATION_KEYS.has(key);
}

function expectsObject(key: string): boolean {
  return !expectsArray(key) && nestedAllowedKeys(key) !== undefined;
}

function validateScalarMutationValue(
  candidate: unknown,
  entity: QuickBooksWritableEntity,
  operation: QuickBooksWriteOperation,
  context: z.RefinementCtx,
  path: Array<string | number>,
  key: string,
): void {
  if (candidate === null || candidate === undefined) {
    context.addIssue({ code: "custom", message: `${key} must be omitted instead of null`, path });
    return;
  }
  if (expectsArray(key)) {
    context.addIssue({ code: "custom", message: `${key} must be an array`, path });
    return;
  }
  if (expectsObject(key)) {
    context.addIssue({ code: "custom", message: `${key} must be an object`, path });
    return;
  }
  if (NUMBER_MUTATION_KEYS.has(key)) {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      context.addIssue({ code: "custom", message: `${key} must be a finite number`, path });
    } else if (["Qty", "Quantity"].includes(key) && candidate <= 0) {
      context.addIssue({ code: "custom", message: `${key} must be greater than zero`, path });
    } else if (["UnitPrice", "PurchaseCost", "DiscountPercent", "DiscountRate", "RatePercent", "TaxAmount", "TaxInclusiveAmt", "TaxPercent"].includes(key) && candidate < 0) {
      context.addIssue({ code: "custom", message: `${key} must not be negative`, path });
    }
    return;
  }
  if (BOOLEAN_MUTATION_KEYS.has(key)) {
    if (typeof candidate !== "boolean") context.addIssue({ code: "custom", message: `${key} must be a boolean`, path });
    return;
  }
  if (typeof candidate !== "string") {
    context.addIssue({ code: "custom", message: `${key} must be a string`, path });
    return;
  }
  if (!candidate.trim() && !(operation === "UPDATE" && CLEARABLE_UPDATE_STRING_FIELDS.has(key))) {
    context.addIssue({ code: "custom", message: `${key} must not be empty`, path });
    return;
  }
  if (DATE_MUTATION_KEYS.has(key) && !/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) {
    context.addIssue({ code: "custom", message: `${key} must use YYYY-MM-DD`, path });
  }
  if (DATETIME_MUTATION_KEYS.has(key) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(candidate)) {
    context.addIssue({ code: "custom", message: `${key} must be an ISO-8601 timestamp with timezone`, path });
  }
  const allowedEnum = ENUM_MUTATION_VALUES[key];
  if (allowedEnum && !allowedEnum.has(candidate)) {
    context.addIssue({ code: "custom", message: `${key} must be one of ${[...allowedEnum].join(", ")}`, path });
  }
  if (key === "Type" && entity === "PaymentMethod" && !new Set(["CREDIT_CARD", "NON_CREDIT_CARD"]).has(candidate)) {
    context.addIssue({ code: "custom", message: "PaymentMethod Type must be CREDIT_CARD or NON_CREDIT_CARD", path });
  }
  if (key === "Type" && entity === "Term" && !new Set(["STANDARD", "DATE_DRIVEN"]).has(candidate)) {
    context.addIssue({ code: "custom", message: "Term Type must be STANDARD or DATE_DRIVEN", path });
  }
}

function validateLineStructure(
  entity: QuickBooksWritableEntity,
  line: Record<string, unknown>,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const detailType = line.DetailType;
  if (detailType === undefined) {
    if (!Array.isArray(line.LinkedTxn)) {
      context.addIssue({ code: "custom", message: "Line requires DetailType or a Payment LinkedTxn array", path });
    }
    if (entity === "Payment" && !("Amount" in line)) {
      context.addIssue({ code: "custom", message: "Payment Line requires Amount", path: [...path, "Amount"] });
    }
    return;
  }
  if (typeof detailType !== "string" || !ENUM_MUTATION_VALUES.DetailType!.has(detailType)) return;
  const presentDetails = LINE_DETAIL_KEYS.filter((key) => key in line);
  if (presentDetails.length !== 1 || presentDetails[0] !== detailType) {
    context.addIssue({
      code: "custom",
      message: `Line must contain exactly one detail object matching DetailType ${detailType}`,
      path,
    });
  }
  if (["DescriptionOnly", "SubTotalLineDetail"].includes(detailType)) return;
  if (!(detailType in line)) {
    context.addIssue({ code: "custom", message: `Line DetailType ${detailType} requires ${detailType}`, path: [...path, detailType] });
    return;
  }
  const detail = line[detailType];
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
  const detailRecord = detail as Record<string, unknown>;
  const required = detailType === "JournalEntryLineDetail"
    ? ["PostingType", "AccountRef"]
    : detailType === "SalesItemLineDetail"
      ? ["ItemRef", "Qty", "UnitPrice"]
      : detailType === "PurchaseOrderItemLineDetail"
        ? ["ItemRef", "Qty", "UnitPrice"]
        : detailType === "ItemBasedExpenseLineDetail"
          ? entity === "PurchaseOrder" ? ["ItemRef", "Qty", "UnitPrice"] : ["ItemRef"]
          : detailType === "AccountBasedExpenseLineDetail"
            ? ["AccountRef"]
            : [];
  for (const key of required) {
    if (!(key in detailRecord)) {
      context.addIssue({ code: "custom", message: `${detailType} requires ${key}`, path: [...path, detailType, key] });
    }
  }
  if (!["DescriptionOnly", "SubTotalLineDetail"].includes(detailType) && !("Amount" in line)) {
    context.addIssue({ code: "custom", message: "Posting Line requires Amount", path: [...path, "Amount"] });
  }
  if (["Invoice", "CreditMemo", "RefundReceipt", "SalesReceipt"].includes(entity) && detailType !== "SalesItemLineDetail") {
    context.addIssue({ code: "custom", message: `${entity} lines must use SalesItemLineDetail`, path: [...path, "DetailType"] });
  }
  if (entity === "PurchaseOrder" && !["ItemBasedExpenseLineDetail", "PurchaseOrderItemLineDetail"].includes(detailType)) {
    context.addIssue({ code: "custom", message: "PurchaseOrder lines must use an item expense detail", path: [...path, "DetailType"] });
  }
  if (entity === "JournalEntry" && detailType !== "JournalEntryLineDetail") {
    context.addIssue({ code: "custom", message: "JournalEntry lines must use JournalEntryLineDetail", path: [...path, "DetailType"] });
  }
}

function validateNestedMutationValue(
  candidate: unknown,
  entity: QuickBooksWritableEntity,
  operation: QuickBooksWriteOperation,
  context: z.RefinementCtx,
  path: Array<string | number>,
  parentKey: string,
  arrayElement = false,
): void {
  if (Array.isArray(candidate)) {
    if (!expectsArray(parentKey)) {
      context.addIssue({ code: "custom", message: `${parentKey} must not be an array`, path });
      return;
    }
    if (candidate.length === 0) {
      context.addIssue({ code: "custom", message: `${parentKey} must contain at least one entry`, path });
      return;
    }
    candidate.forEach((entry, index) => validateNestedMutationValue(entry, entity, operation, context, [...path, index], parentKey, true));
    return;
  }
  if (!candidate || typeof candidate !== "object") {
    if (arrayElement) {
      context.addIssue({ code: "custom", message: `${parentKey} entries must be objects`, path });
      return;
    }
    validateScalarMutationValue(candidate, entity, operation, context, path, parentKey);
    return;
  }
  if (expectsArray(parentKey) && !arrayElement) {
    context.addIssue({ code: "custom", message: `${parentKey} must be an array`, path });
    return;
  }
  const allowed = nestedAllowedKeys(parentKey);
  if (!allowed) {
    context.addIssue({ code: "custom", message: `nested object ${parentKey} is not supported by the governed schema`, path });
    return;
  }
  const record = candidate as Record<string, unknown>;
  if (referenceLike(parentKey) && (typeof record.value !== "string" || !record.value.trim())) {
    context.addIssue({ code: "custom", message: `${parentKey} requires a non-empty string value`, path: [...path, "value"] });
  }
  if (parentKey === "CustomerMemo" && (typeof record.value !== "string" || !record.value.trim())) {
    context.addIssue({ code: "custom", message: "CustomerMemo requires a string value", path: [...path, "value"] });
  }
  if (parentKey === "Line") validateLineStructure(entity, record, context, path);
  const nestedRequired = parentKey === "LinkedTxn"
    ? ["TxnId", "TxnType"]
    : parentKey === "attachable_ref"
      ? ["entity_ref_type", "entity_ref_value"]
      : [];
  for (const required of nestedRequired) {
    if (typeof record[required] !== "string" || !(record[required] as string).trim()) {
      context.addIssue({ code: "custom", message: `${parentKey} requires ${required}`, path: [...path, required] });
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (!allowed.has(key)) {
      context.addIssue({ code: "custom", message: `${key} is not allowed inside ${parentKey}`, path: [...path, key] });
      continue;
    }
    validateNestedMutationValue(value, entity, operation, context, [...path, key], key);
  }
}

function validateMutationPayload(
  entity: QuickBooksWritableEntity,
  operation: QuickBooksWriteOperation,
  payload: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  const keys = Object.keys(payload);
  if (operation === "DELETE" && keys.length > 0) {
    context.addIssue({ code: "custom", message: "DELETE payload must be empty; target_id and sync_token are separate trusted fields", path: ["payload"] });
  }
  const allowed = MUTATION_FIELDS[entity];
  if (operation === "CREATE") {
    for (const required of CREATE_REQUIRED_FIELDS[entity] ?? []) {
      if (!(required in payload)) {
        context.addIssue({ code: "custom", message: `CREATE ${entity} requires ${required}`, path: ["payload", required] });
      }
    }
    if (entity === "Attachable") {
      for (const required of ["file_name", "content_type", "base64_content"] as const) {
        if (!(required in payload)) {
          context.addIssue({ code: "custom", message: `CREATE Attachable requires ${required}`, path: ["payload", required] });
        }
      }
    }
  }
  if (entity === "Attachable" && operation === "UPDATE") {
    const forbiddenUpdateFields = ["base64_content", "attachable_ref", "AttachableRef"];
    for (const field of forbiddenUpdateFields) {
      if (field in payload) {
        context.addIssue({ code: "custom", message: `UPDATE Attachable cannot use create/upload field ${field}`, path: ["payload", field] });
      }
    }
    for (const key of keys) {
      if (!["file_name", "content_type", "note", "category", "FileName", "ContentType", "Note", "Category"].includes(key)) {
        context.addIssue({ code: "custom", message: `UPDATE Attachable supports metadata fields only`, path: ["payload", key] });
      }
    }
  }
  if (operation === "CREATE" && ["Payment", "BillPayment"].includes(entity) && typeof payload.TotalAmt === "number" && payload.TotalAmt <= 0) {
    context.addIssue({ code: "custom", message: `CREATE ${entity} TotalAmt must be greater than zero`, path: ["payload", "TotalAmt"] });
  }
  if (operation === "CREATE" && entity === "Transfer" && typeof payload.Amount === "number" && payload.Amount <= 0) {
    context.addIssue({ code: "custom", message: "CREATE Transfer Amount must be greater than zero", path: ["payload", "Amount"] });
  }
  for (const key of keys) {
    if (!allowed.has(key)) {
      context.addIssue({ code: "custom", message: `${key} is not an allowed ${entity} field`, path: ["payload", key] });
      continue;
    }
    validateNestedMutationValue(payload[key], entity, operation, context, ["payload", key], key);
  }
}

const genericMutationPayload = z.record(z.string().min(1).max(128), z.unknown()).superRefine((value, context) => {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    context.addIssue({ code: "custom", message: "payload must be JSON serializable" });
    return;
  }
  if (Buffer.byteLength(encoded, "utf8") > 640 * 1024) {
    context.addIssue({ code: "custom", message: "payload must not exceed 640 KiB" });
  }
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 12) {
      context.addIssue({ code: "custom", message: "payload nesting must not exceed 12 levels" });
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 1_000) context.addIssue({ code: "custom", message: "payload arrays must not exceed 1000 entries" });
      candidate.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
        if (FORBIDDEN_MUTATION_KEYS.has(key)) {
          context.addIssue({ code: "custom", message: `${key} is a forbidden provider-controlled field` });
        }
        visit(entry, depth + 1);
      }
      return;
    }
    if (typeof candidate === "number" && !Number.isFinite(candidate)) {
      context.addIssue({ code: "custom", message: "payload numbers must be finite" });
    }
    if (typeof candidate === "string" && Buffer.byteLength(candidate, "utf8") > 512 * 1024) {
      context.addIssue({ code: "custom", message: "individual payload strings must not exceed 512 KiB" });
    }
  };
  visit(value, 0);
});

export const quickBooksGetWriteCapabilitiesSchema = z.object({
  entity: z.enum(QUICKBOOKS_WRITABLE_ENTITIES).optional(),
  operation: z.enum(QUICKBOOKS_WRITE_OPERATIONS).optional(),
}).strict();

export const quickBooksPrepareMutationSchema = z.object({
  target_session_ref: targetSessionRef,
  request_id: requestId,
  entity: z.enum(QUICKBOOKS_WRITABLE_ENTITIES),
  operation: z.enum(QUICKBOOKS_WRITE_OPERATIONS),
  target_id: providerId.optional(),
  sync_token: z.string().trim().min(1).max(64).optional(),
  payload: genericMutationPayload.default({}),
  business_reason: z.string().trim().min(3).max(1_000),
  source_ref: z.string().trim().min(1).max(256).regex(/^[^\r\n\u0000-\u001f\u007f]+$/u).optional(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0{64}$/.test(value)).optional(),
  source_digest_provenance: z.enum([
    "AGENT_SUPPLIED_TEXT_FINGERPRINT",
    "HOST_PROVIDED_ORIGINAL_FILE_SHA256",
    "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256",
  ]).optional(),
  source_attestation_ref: z.string().trim().min(16).max(2_048).optional(),
  approval_ref: z.string().trim().min(1).max(256).optional(),
}).strict().superRefine((value, context) => {
  if (value.operation === "CREATE" && (value.target_id || value.sync_token)) {
    context.addIssue({ code: "custom", message: "CREATE must not provide target_id or sync_token", path: ["target_id"] });
  }
  if (value.operation !== "CREATE" && (!value.target_id || !value.sync_token)) {
    context.addIssue({ code: "custom", message: `${value.operation} requires exact target_id and sync_token`, path: ["target_id"] });
  }
  const sourceParts = [value.source_ref, value.source_sha256, value.source_digest_provenance];
  const suppliedSourceParts = sourceParts.filter((entry) => entry !== undefined).length;
  if (suppliedSourceParts !== 0 && suppliedSourceParts !== sourceParts.length) {
    context.addIssue({ code: "custom", message: "source_ref, source_sha256 and source_digest_provenance must be supplied together", path: ["source_ref"] });
  }
  if (value.source_digest_provenance === "HOST_PROVIDED_ORIGINAL_FILE_SHA256" && !value.source_attestation_ref) {
    context.addIssue({ code: "custom", message: "HOST_PROVIDED provenance requires source_attestation_ref from WorkStore", path: ["source_attestation_ref"] });
  }
  if (value.source_digest_provenance !== "HOST_PROVIDED_ORIGINAL_FILE_SHA256" && value.source_attestation_ref) {
    context.addIssue({ code: "custom", message: "source_attestation_ref is only valid for HOST_PROVIDED provenance", path: ["source_attestation_ref"] });
  }
  const forbiddenTopLevel = ["realmId", "realm_id", "companyId", "company_id", "accessToken", "refreshToken"];
  for (const key of forbiddenTopLevel) {
    if (key in value.payload) context.addIssue({ code: "custom", message: `${key} is controlled by the OAuth binding and must not appear in payload`, path: ["payload", key] });
  }
  if (value.operation === "CREATE" && ("Id" in value.payload || "SyncToken" in value.payload)) {
    context.addIssue({ code: "custom", message: "CREATE payload must not contain Id or SyncToken", path: ["payload"] });
  }
  if (value.operation !== "CREATE" && ("Id" in value.payload || "SyncToken" in value.payload)) {
    context.addIssue({ code: "custom", message: "Use target_id and sync_token; payload must not override them", path: ["payload"] });
  }
  validateMutationPayload(value.entity, value.operation, value.payload, context);
});

export const quickBooksExecutePreparedMutationSchema = z.object({
  preparation_id: z.string().regex(/^qbm_[a-f0-9]{32}$/),
  request_id: requestId,
  confirmation_phrase: z.string().min(1).max(256)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace")
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain control characters"),
}).strict();

export type QuickBooksSearchVendorsInput = z.infer<typeof quickBooksSearchVendorsSchema>;
export type QuickBooksTargetSessionInput = z.infer<typeof quickBooksTargetSessionSchema>;
export type QuickBooksSearchCustomersInput = z.infer<typeof quickBooksSearchCustomersSchema>;
export type QuickBooksListTransactionsInput = z.infer<typeof quickBooksListTransactionsSchema>;
export type QuickBooksGetTransactionInput = z.infer<typeof quickBooksGetTransactionSchema>;
export type QuickBooksRunReportInput = z.infer<typeof quickBooksRunReportSchema>;
export type QuickBooksListBillsToolInput = z.infer<typeof quickBooksListBillsSchema>;
export type QuickBooksGetBillInput = z.infer<typeof quickBooksGetBillSchema>;
export type QuickBooksHashSourceDocumentInput = z.infer<typeof quickBooksHashSourceDocumentSchema>;
export type QuickBooksPrepareSupplierBillToolInput = z.infer<typeof quickBooksPrepareSupplierBillSchema>;
export type QuickBooksTrialBalanceInput = z.infer<typeof quickBooksTrialBalanceSchema>;
export type QuickBooksGetWriteCapabilitiesInput = z.infer<typeof quickBooksGetWriteCapabilitiesSchema>;
export type QuickBooksPrepareMutationInput = z.infer<typeof quickBooksPrepareMutationSchema>;
export type QuickBooksExecutePreparedMutationInput = z.infer<typeof quickBooksExecutePreparedMutationSchema>;
