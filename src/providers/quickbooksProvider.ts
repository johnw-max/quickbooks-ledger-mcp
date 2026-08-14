import { timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import { QuickBooksApiClient } from "./quickbooksClient.js";
import type {
  QuickBooksAccount,
  QuickBooksBill,
  QuickBooksBillLine,
  QuickBooksBillSnapshot,
  QuickBooksBillSnapshotLine,
  QuickBooksCompanyContext,
  QuickBooksCompanyInfo,
  QuickBooksCustomer,
  QuickBooksItem,
  QuickBooksPreferences,
  QuickBooksQueryResponse,
  QuickBooksReference,
  QuickBooksSupplierBillInput,
  QuickBooksTaxCode,
  QuickBooksTaxRate,
  QuickBooksVendor,
} from "./quickbooksTypes.js";
import type { QuickBooksWritableEntity } from "../quickbooks/writePolicy.js";
import {
  consumeQuickBooksProviderWritePermit,
  consumeQuickBooksSupplierBillProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../security/quickBooksProviderWritePermit.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,50}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_BILL_LINES = 100;

interface CompanyInfoResponse {
  CompanyInfo?: QuickBooksCompanyInfo;
}

interface PreferencesResponse {
  Preferences?: QuickBooksPreferences;
}

interface BillResponse {
  Bill?: QuickBooksBill;
  time?: string;
}

interface AccountResponse {
  Account?: QuickBooksAccount;
}

interface TaxCodeResponse {
  TaxCode?: QuickBooksTaxCode;
}

interface TaxRateResponse {
  TaxRate?: QuickBooksTaxRate;
}

interface VendorResponse {
  Vendor?: QuickBooksVendor;
}

function entityPath(entity: QuickBooksWritableEntity): string {
  return entity.toLocaleLowerCase("en-US");
}

function entityFromResponse(response: Record<string, unknown>, entity: QuickBooksWritableEntity): Record<string, unknown> | undefined {
  const candidate = response[entity];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function normalizeForMutationReadback(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForMutationReadback);
  if (!value || typeof value !== "object") return value;
  const ignored = new Set([
    "MetaData", "Domain", "sparse", "status", "time", "requestId",
  ]);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, candidate]) => !ignored.has(key) && candidate !== undefined)
      .map(([key, candidate]) => [key, normalizeForMutationReadback(candidate)]),
  );
}

function expectedSubset(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((entry, index) => expectedSubset(actual[index], entry));
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>)
    .every(([key, value]) => expectedSubset((actual as Record<string, unknown>)[key], value));
}

const TOTAL_BEARING_TRANSACTION_ENTITIES = new Set<QuickBooksWritableEntity>([
  "Invoice", "Bill", "CreditMemo", "VendorCredit",
]);

function expectedTransactionTotal(payload: Record<string, unknown>): number | undefined {
  if (typeof payload.TotalAmt === "number" && Number.isFinite(payload.TotalAmt)) return payload.TotalAmt;
  if (!Array.isArray(payload.Line)) return undefined;
  let lineTotal = 0;
  for (const line of payload.Line) {
    if (!line || typeof line !== "object" || Array.isArray(line)) continue;
    const amount = (line as Record<string, unknown>).Amount;
    if (typeof amount === "number" && Number.isFinite(amount)) lineTotal += amount;
  }
  const taxDetail = payload.TxnTaxDetail;
  const totalTax = taxDetail && typeof taxDetail === "object" && !Array.isArray(taxDetail)
    ? (taxDetail as Record<string, unknown>).TotalTax
    : undefined;
  const total = payload.GlobalTaxCalculation === "TaxExcluded" && typeof totalTax === "number" && Number.isFinite(totalTax)
    ? lineTotal + totalTax
    : lineTotal;
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

function expectedCreateReadback(
  entity: QuickBooksWritableEntity,
  providerPayload: Record<string, unknown>,
): Record<string, unknown> {
  if (!TOTAL_BEARING_TRANSACTION_ENTITIES.has(entity)) return providerPayload;
  const total = expectedTransactionTotal(providerPayload);
  return total === undefined ? providerPayload : { ...providerPayload, TotalAmt: total };
}

const QBO_ATTACHMENT_CONTENT_TYPES = new Set([
  "application/postscript", "text/csv", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/gif",
  "image/jpeg", "image/jpg", "application/vnd.oasis.opendocument.spreadsheet",
  "application/pdf", "image/png", "text/rtf", "image/tif", "text/plain",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/xml",
]);

function attachmentUpload(payload: Record<string, unknown>): {
  form: FormData;
  expected: Record<string, unknown>;
} | undefined {
  const encoded = payload.base64_content ?? payload.Base64Content;
  if (encoded === undefined) return undefined;
  const fileName = payload.file_name ?? payload.FileName;
  const contentType = payload.content_type ?? payload.ContentType;
  if (typeof fileName !== "string" || !fileName.trim() || /[\r\n"\\]/u.test(fileName)) {
    throw new AppError("VALIDATION_FAILED", "Attachable base64 upload requires a safe file_name.", { httpStatus: 400 });
  }
  if (typeof contentType !== "string" || !QBO_ATTACHMENT_CONTENT_TYPES.has(contentType)) {
    throw new AppError("VALIDATION_FAILED", "Attachable content_type is not supported by QuickBooks.", { httpStatus: 400 });
  }
  if (typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new AppError("VALIDATION_FAILED", "Attachable base64_content is invalid.", { httpStatus: 400 });
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > 384 * 1024) {
    throw new AppError("VALIDATION_FAILED", "Inline Attachable content must contain 1-393216 bytes; larger-file Host material transfer is not enabled in this release.", { httpStatus: 400 });
  }
  const attachableRef = payload.attachable_ref && typeof payload.attachable_ref === "object" && !Array.isArray(payload.attachable_ref)
    ? payload.attachable_ref as Record<string, unknown>
    : undefined;
  const metadata: Record<string, unknown> = {
    FileName: fileName,
    ContentType: contentType,
    ...(typeof payload.note === "string" ? { Note: payload.note } : {}),
    ...(typeof payload.category === "string" ? { Category: payload.category } : {}),
  };
  if (attachableRef) {
    const entityType = attachableRef.entity_ref_type;
    const entityId = attachableRef.entity_ref_value;
    if (typeof entityType !== "string" || typeof entityId !== "string") {
      throw new AppError("VALIDATION_FAILED", "attachable_ref requires entity_ref_type and entity_ref_value.", { httpStatus: 400 });
    }
    metadata.AttachableRef = [{
      EntityRef: { type: entityType, value: entityId },
      ...(typeof attachableRef.include_on_send === "boolean" ? { IncludeOnSend: attachableRef.include_on_send } : {}),
    }];
  }
  const form = new FormData();
  form.append("file_metadata_01", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file_content_01", new Blob([bytes], { type: contentType }), fileName);
  return { form, expected: metadata };
}

function uploadedAttachable(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = entityFromResponse(response, "Attachable");
  if (direct) return direct;
  const candidates = response.AttachableResponse;
  if (!Array.isArray(candidates)) return undefined;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const nested = (candidate as Record<string, unknown>).Attachable;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return undefined;
}

export interface QuickBooksBillListInput {
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface QuickBooksBillListResult {
  bills: QuickBooksBillSnapshot[];
  pagination: {
    page: number;
    pageSize: number;
    returned: number;
    totalCount?: number;
    hasNextPage: boolean;
  };
}

export const QUICKBOOKS_TRANSACTION_ENTITIES = [
  "Invoice",
  "Payment",
  "Purchase",
  "BillPayment",
  "JournalEntry",
  "CreditMemo",
  "SalesReceipt",
  "RefundReceipt",
  "VendorCredit",
] as const;

export type QuickBooksTransactionEntity = typeof QUICKBOOKS_TRANSACTION_ENTITIES[number];

export interface QuickBooksTransactionListInput {
  entity: QuickBooksTransactionEntity;
  dateFrom?: string;
  dateTo?: string;
  customerId?: string;
  vendorId?: string;
  openOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface QuickBooksTransactionListResult {
  entity: QuickBooksTransactionEntity;
  records: Record<string, unknown>[];
  pagination: QuickBooksBillListResult["pagination"];
}

export const QUICKBOOKS_REPORTS = [
  "ProfitAndLoss",
  "BalanceSheet",
  "CashFlow",
  "CustomerBalance",
  "AgedReceivables",
  "VendorBalance",
  "AgedPayables",
  "VendorExpenses",
  "GeneralLedgerDetail",
  "TrialBalance",
] as const;

export type QuickBooksReportName = typeof QUICKBOOKS_REPORTS[number];

export interface QuickBooksReportInput {
  report: QuickBooksReportName;
  startDate?: string;
  endDate?: string;
  asOfDate?: string;
  accountingMethod?: "Cash" | "Accrual";
  customerId?: string;
  vendorId?: string;
  maxRows?: number;
  view?: "normalized" | "raw" | "both";
}

export interface QuickBooksReferenceValidationResult {
  vendor: { id: string; name?: string; currencyCode?: string };
  accounts: Array<{ id: string; name?: string }>;
  taxCodes: Array<{ id: string; name?: string }>;
}

export interface QuickBooksExistingBillMatch {
  billId: string;
  vendorId: string;
  docNumber: string;
  txnDate?: string;
  total: string;
  balance?: string;
}

export interface QuickBooksExistingDocumentMatch {
  entity: "Invoice" | "Bill" | "CreditMemo" | "VendorCredit";
  providerEntityId: string;
  counterpartyId: string;
  docNumber: string;
  txnDate?: string;
  total?: string;
}

export interface QuickBooksSearchResult<T> {
  records: T[];
  searchWindow: {
    requestedLimit: number;
    returned: number;
    scanned: number;
    scanLimit: number;
    complete: boolean;
    stoppedReason: "source_exhausted" | "requested_limit" | "scan_limit";
  };
}

function requireId(reference: QuickBooksReference | undefined, label: string): string {
  if (!reference?.value) {
    throw new AppError("READBACK_MISMATCH", `QuickBooks readback omitted ${label}.`, { httpStatus: 502 });
  }
  return reference.value;
}

function decimal(value: number | undefined, fallback = "0.00"): string {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return value.toFixed(2);
}

function paymentStatus(balance: number | undefined): "OPEN" | "PAID" | "UNKNOWN" {
  if (balance === undefined || !Number.isFinite(balance)) return "UNKNOWN";
  return Math.abs(balance) < 0.000_001 ? "PAID" : "OPEN";
}

function billLine(line: QuickBooksBillLine): QuickBooksBillSnapshotLine | undefined {
  if (line.Amount === undefined) return undefined;
  if (line.DetailType === "AccountBasedExpenseLineDetail") {
    const account = line.AccountBasedExpenseLineDetail?.AccountRef;
    if (!account?.value) return undefined;
    return {
      ...(line.Id ? { lineId: line.Id } : {}),
      detailType: "ACCOUNT",
      amount: decimal(line.Amount),
      ...(line.Description ? { description: line.Description } : {}),
      account: { id: account.value, ...(account.name ? { name: account.name } : {}) },
      ...(line.AccountBasedExpenseLineDetail?.TaxCodeRef?.value
        ? {
            taxCode: {
              id: line.AccountBasedExpenseLineDetail.TaxCodeRef.value,
              ...(line.AccountBasedExpenseLineDetail.TaxCodeRef.name
                ? { name: line.AccountBasedExpenseLineDetail.TaxCodeRef.name }
                : {}),
            },
          }
        : {}),
    };
  }
  if (line.DetailType === "ItemBasedExpenseLineDetail") {
    const detail = line.ItemBasedExpenseLineDetail;
    const item = detail?.ItemRef;
    if (!item?.value) return undefined;
    return {
      ...(line.Id ? { lineId: line.Id } : {}),
      detailType: "ITEM",
      amount: decimal(line.Amount),
      ...(line.Description ? { description: line.Description } : {}),
      item: { id: item.value, ...(item.name ? { name: item.name } : {}) },
      ...(detail?.Qty === undefined ? {} : { quantity: decimal(detail.Qty) }),
      ...(detail?.UnitPrice === undefined ? {} : { unitPrice: decimal(detail.UnitPrice) }),
      ...(detail?.TaxCodeRef?.value
        ? {
            taxCode: {
              id: detail.TaxCodeRef.value,
              ...(detail.TaxCodeRef.name ? { name: detail.TaxCodeRef.name } : {}),
            },
          }
        : {}),
    };
  }
  return undefined;
}

function snapshot(realmId: string, bill: QuickBooksBill): QuickBooksBillSnapshot {
  if (!bill.Id) {
    throw new AppError("READBACK_MISMATCH", "QuickBooks Bill readback omitted its Id.", { httpStatus: 502 });
  }
  const vendorId = requireId(bill.VendorRef, "VendorRef");
  const lines = (bill.Line ?? []).map(billLine).filter((line): line is QuickBooksBillSnapshotLine => Boolean(line));
  return {
    billId: bill.Id,
    realmId,
    ...(bill.SyncToken ? { syncToken: bill.SyncToken } : {}),
    paymentStatus: paymentStatus(bill.Balance),
    vendor: { id: vendorId, ...(bill.VendorRef?.name ? { name: bill.VendorRef.name } : {}) },
    ...(bill.APAccountRef?.value
      ? { apAccount: { id: bill.APAccountRef.value, ...(bill.APAccountRef.name ? { name: bill.APAccountRef.name } : {}) } }
      : {}),
    ...(bill.TxnDate ? { txnDate: bill.TxnDate } : {}),
    ...(bill.DueDate ? { dueDate: bill.DueDate } : {}),
    ...(bill.DocNumber ? { docNumber: bill.DocNumber } : {}),
    ...(bill.CurrencyRef?.value ? { currencyCode: bill.CurrencyRef.value } : {}),
    ...(bill.ExchangeRate === undefined ? {} : { exchangeRate: decimal(bill.ExchangeRate) }),
    ...(bill.GlobalTaxCalculation ? { globalTaxCalculation: bill.GlobalTaxCalculation } : {}),
    total: decimal(bill.TotalAmt),
    ...(bill.Balance === undefined ? {} : { balance: decimal(bill.Balance) }),
    ...(bill.TxnTaxDetail?.TotalTax === undefined ? {} : { totalTax: decimal(bill.TxnTaxDetail.TotalTax) }),
    ...(bill.PrivateNote ? { privateNote: bill.PrivateNote } : {}),
    lines,
    ...(bill.MetaData?.LastUpdatedTime ? { updatedAt: bill.MetaData.LastUpdatedTime } : {}),
  };
}

function validateDate(value: string | undefined, label: string): void {
  if (value !== undefined && !DATE.test(value)) {
    throw new AppError("VALIDATION_FAILED", `${label} must use YYYY-MM-DD.`, { httpStatus: 400 });
  }
}

function parseAmount(value: string, index: number): number {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value)) {
    throw new AppError("VALIDATION_FAILED", `lines[${index}].amount must be a positive decimal with at most two places.`, {
      httpStatus: 400,
    });
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError("VALIDATION_FAILED", `lines[${index}].amount must be greater than zero.`, {
      httpStatus: 400,
    });
  }
  return parsed;
}

function validateInput(input: QuickBooksSupplierBillInput): void {
  if (!REQUEST_ID.test(input.requestId)) {
    throw new AppError("VALIDATION_FAILED", "requestId must be 1-50 safe ASCII characters.", { httpStatus: 400 });
  }
  if (!input.sourceRef.trim() || input.sourceRef.length > 256 || /[\r\n\u0000-\u001f\u007f]/u.test(input.sourceRef)) {
    throw new AppError("VALIDATION_FAILED", "sourceRef must contain 1-256 characters.", { httpStatus: 400 });
  }
  if (!SHA256.test(input.sourceSha256)) {
    throw new AppError("VALIDATION_FAILED", "sourceSha256 must be a lowercase SHA-256 digest.", { httpStatus: 400 });
  }
  if (/^0{64}$/.test(input.sourceSha256)) {
    throw new AppError("VALIDATION_FAILED", "sourceSha256 cannot be an all-zero placeholder.", { httpStatus: 400 });
  }
  if (!input.vendorId || input.vendorId.length > 64) {
    throw new AppError("VALIDATION_FAILED", "vendorId is required.", { httpStatus: 400 });
  }
  validateDate(input.txnDate, "txnDate");
  validateDate(input.dueDate, "dueDate");
  if (!input.docNumber && !input.missingDocNumberReason?.trim()) {
    throw new AppError("VALIDATION_FAILED", "A supplier document number or missing-document-number reason is required.", {
      httpStatus: 400,
    });
  }
  if (input.currencyCode && !CURRENCY.test(input.currencyCode)) {
    throw new AppError("VALIDATION_FAILED", "currencyCode must be a three-letter uppercase code.", { httpStatus: 400 });
  }
  if (input.lines.length === 0 || input.lines.length > MAX_BILL_LINES) {
    throw new AppError("VALIDATION_FAILED", `lines must contain 1-${MAX_BILL_LINES} entries.`, { httpStatus: 400 });
  }
  input.lines.forEach((line, index) => {
    if (!line.accountId || line.accountId.length > 64) {
      throw new AppError("VALIDATION_FAILED", `lines[${index}].accountId is required.`, { httpStatus: 400 });
    }
    parseAmount(line.amount, index);
    if (line.description && line.description.length > 4_000) {
      throw new AppError("VALIDATION_FAILED", `lines[${index}].description is too long.`, { httpStatus: 400 });
    }
  });
  if (!input.globalTaxCalculation || input.invoiceTotal === undefined || input.taxTotal === undefined) {
    throw new AppError("VALIDATION_FAILED", "globalTaxCalculation, invoiceTotal, and taxTotal are required.", {
      httpStatus: 400,
    });
  }
  const lineTotal = input.lines.reduce((total, line, index) => total + parseAmount(line.amount, index), 0);
  const invoiceTotal = parseAmount(input.invoiceTotal, input.lines.length);
  const taxTotal = Number(input.taxTotal);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(input.taxTotal) || !Number.isFinite(taxTotal) || taxTotal < 0) {
    throw new AppError("VALIDATION_FAILED", "taxTotal must be a non-negative decimal with at most two places.", {
      httpStatus: 400,
    });
  }
  if (input.globalTaxCalculation === "NotApplicable") {
    if (taxTotal !== 0 || input.lines.some((line) => line.taxCodeId)) {
      throw new AppError("VALIDATION_FAILED", "No-tax bills require zero taxTotal and no line taxCodeId.", { httpStatus: 400 });
    }
  } else if (input.lines.some((line) => !line.taxCodeId)) {
    throw new AppError("VALIDATION_FAILED", "TaxExcluded and TaxInclusive bills require a taxCodeId on every line.", {
      httpStatus: 400,
    });
  }
  const expectedInvoiceTotal = input.globalTaxCalculation === "TaxExcluded" ? lineTotal + taxTotal : lineTotal;
  if (Math.abs(expectedInvoiceTotal - invoiceTotal) > 0.001) {
    throw new AppError("VALIDATION_FAILED", "invoiceTotal does not reconcile to the approved lines and taxTotal.", {
      httpStatus: 400,
    });
  }
}

function queryArray<T>(response: QuickBooksQueryResponse<Record<string, unknown>>, entity: string): T[] {
  const value = response.QueryResponse?.[entity];
  return Array.isArray(value) ? value as T[] : [];
}

function queryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function searchTokens(value: string): string[] {
  return value.trim().toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
}

function matchesAllTokens(values: Array<string | undefined>, tokens: string[]): boolean {
  const searchable = values.filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase("en-US");
  return tokens.every((token) => searchable.includes(token));
}

interface NormalizedReportRow {
  path: string[];
  type: "DATA" | "SUMMARY";
  group?: string;
  columns: Array<{ index: number; value: string; id?: string }>;
}

function normalizedReportRows(response: Record<string, unknown>): NormalizedReportRow[] {
  const normalized: NormalizedReportRow[] = [];
  const colData = (value: unknown): NormalizedReportRow["columns"] => Array.isArray(value)
    ? value.map((cell, index) => {
      const record = cell && typeof cell === "object" && !Array.isArray(cell) ? cell as Record<string, unknown> : {};
      return {
        index,
        value: typeof record.value === "string" ? record.value : String(record.value ?? ""),
        ...(typeof record.id === "string" ? { id: record.id } : {}),
      };
    })
    : [];
  const walk = (value: unknown, path: string[] = []): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => walk(entry, path));
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const group = typeof record.group === "string" ? record.group : undefined;
    const header = record.Header && typeof record.Header === "object" && !Array.isArray(record.Header)
      ? record.Header as Record<string, unknown>
      : undefined;
    const headerColumns = colData(header?.ColData);
    const label = headerColumns.find((cell) => cell.value)?.value ?? group;
    const nextPath = label ? [...path, label] : path;
    const dataColumns = colData(record.ColData);
    if (dataColumns.length > 0) {
      normalized.push({ path, type: "DATA", ...(group ? { group } : {}), columns: dataColumns });
    }
    const summary = record.Summary && typeof record.Summary === "object" && !Array.isArray(record.Summary)
      ? record.Summary as Record<string, unknown>
      : undefined;
    const summaryColumns = colData(summary?.ColData);
    if (summaryColumns.length > 0) {
      normalized.push({ path: nextPath, type: "SUMMARY", ...(group ? { group } : {}), columns: summaryColumns });
    }
    if (record.Rows) walk(record.Rows, nextPath);
    if (record.Row) walk(record.Row, nextPath);
  };
  walk(response.Rows);
  return normalized;
}

function reportRows(
  response: Record<string, unknown>,
  maxRows: number,
  view: "normalized" | "raw" | "both",
): Record<string, unknown> {
  const normalized = normalizedReportRows(response);
  let totalRows = 0;
  let returnedRows = 0;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const limited: unknown[] = [];
      for (const entry of value) {
        const rowLike = Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && (
          "ColData" in entry || "Rows" in entry || "Header" in entry || "Summary" in entry
        ));
        if (rowLike) {
          totalRows += 1;
          if (returnedRows >= maxRows) continue;
          returnedRows += 1;
        }
        limited.push(visit(entry));
      }
      return limited;
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
  };
  const bounded = visit(response) as Record<string, unknown>;
  const window = {
    maxRows,
    returnedRows: Math.min(normalized.length || returnedRows, maxRows),
    totalRows: normalized.length || totalRows,
    truncated: (normalized.length || totalRows) > maxRows,
  };
  const headerAndColumns = Object.fromEntries(Object.entries(response).filter(([key]) => ["Header", "Columns"].includes(key)));
  if (view === "normalized") {
    return {
      ...headerAndColumns,
      normalizedRows: normalized.slice(0, maxRows),
      zcloakReportWindow: window,
    };
  }
  return {
    ...bounded,
    ...(view === "both" ? { normalizedRows: normalized.slice(0, maxRows) } : {}),
    zcloakReportWindow: {
      ...window,
    },
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class QuickBooksAccountingProvider {
  readonly #client: QuickBooksApiClient;

  constructor(client: QuickBooksApiClient) {
    this.#client = client;
  }

  async getCompany(): Promise<QuickBooksCompanyInfo> {
    const response = await this.#client.request<CompanyInfoResponse>(`/companyinfo/${this.#client.realmId}`);
    if (!response.CompanyInfo?.Id || !response.CompanyInfo.CompanyName) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks CompanyInfo did not include its identity.", {
        httpStatus: 502,
      });
    }
    return response.CompanyInfo;
  }

  async getCompanyContext(): Promise<QuickBooksCompanyContext> {
    const [company, preferencesResponse] = await Promise.all([
      this.getCompany(),
      this.#client.request<PreferencesResponse>("/preferences"),
    ]);
    const currency = preferencesResponse.Preferences?.CurrencyPrefs?.HomeCurrency;
    if (!currency?.value || !/^[A-Z]{3}$/u.test(currency.value)) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks Preferences did not include a valid home currency.", {
        httpStatus: 502,
      });
    }
    return {
      ...company,
      HomeCurrency: currency,
      ...(preferencesResponse.Preferences?.CurrencyPrefs?.MultiCurrencyEnabled === undefined
        ? {}
        : { MultiCurrencyEnabled: preferencesResponse.Preferences.CurrencyPrefs.MultiCurrencyEnabled }),
    };
  }

  async listAccounts(): Promise<QuickBooksAccount[]> {
    return this.#listActiveEntities<QuickBooksAccount>("Account")
      .then((accounts) => accounts.filter((account) => account.Id && account.Name));
  }

  async listTaxCodes(): Promise<QuickBooksTaxCode[]> {
    return this.#listActiveEntities<QuickBooksTaxCode>("TaxCode")
      .then((taxCodes) => taxCodes.filter((taxCode) => taxCode.Id && taxCode.Name));
  }

  async getTaxRate(taxRateId: string): Promise<QuickBooksTaxRate> {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(taxRateId)) {
      throw new AppError("VALIDATION_FAILED", "QuickBooks TaxRate Id is invalid.", { httpStatus: 400 });
    }
    const response = await this.#client.request<TaxRateResponse>(`/taxrate/${encodeURIComponent(taxRateId)}`);
    if (!response.TaxRate?.Id || response.TaxRate.Id !== taxRateId) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks TaxRate readback omitted the exact requested Id.", {
        httpStatus: 502,
      });
    }
    return response.TaxRate;
  }

  async searchVendors(search: string, limit = 25): Promise<QuickBooksSearchResult<QuickBooksVendor>> {
    const normalized = search.trim().toLocaleLowerCase("en-US");
    if (!normalized || normalized.length > 128 || limit < 1 || limit > 100) {
      throw new AppError("VALIDATION_FAILED", "Vendor search requires 1-128 characters and a limit from 1 to 100.", {
        httpStatus: 400,
      });
    }
    const tokens = searchTokens(normalized);
    const matches: QuickBooksVendor[] = [];
    let scanned = 0;
    for (let start = 1; start <= 10_000 && matches.length < limit; start += 1_000) {
      const response = await this.#client.query<Record<string, unknown>>(
        `SELECT * FROM Vendor WHERE Active = true STARTPOSITION ${start} MAXRESULTS 1000`,
      );
      const page = queryArray<QuickBooksVendor>(response, "Vendor");
      scanned += page.length;
      matches.push(...page.filter((vendor) => vendor.Id && matchesAllTokens([
        vendor.DisplayName,
        vendor.CompanyName,
        vendor.PrimaryEmailAddr?.Address,
      ], tokens)));
      if (page.length < 1_000) return this.#searchResult(matches, limit, scanned, true, "source_exhausted");
    }
    return this.#searchResult(
      matches,
      limit,
      scanned,
      false,
      matches.length >= limit ? "requested_limit" : "scan_limit",
    );
  }

  async searchCustomers(search: string, limit = 25): Promise<QuickBooksSearchResult<QuickBooksCustomer>> {
    const normalized = search.trim().toLocaleLowerCase("en-US");
    if (!normalized || normalized.length > 128 || limit < 1 || limit > 100) {
      throw new AppError("VALIDATION_FAILED", "Customer search requires 1-128 characters and a limit from 1 to 100.", {
        httpStatus: 400,
      });
    }
    const tokens = searchTokens(normalized);
    const matches: QuickBooksCustomer[] = [];
    let scanned = 0;
    for (let start = 1; start <= 10_000 && matches.length < limit; start += 1_000) {
      const response = await this.#client.query<Record<string, unknown>>(
        `SELECT * FROM Customer WHERE Active = true STARTPOSITION ${start} MAXRESULTS 1000`,
      );
      const page = queryArray<QuickBooksCustomer>(response, "Customer");
      scanned += page.length;
      matches.push(...page.filter((customer) => customer.Id && matchesAllTokens([
        customer.DisplayName,
        customer.CompanyName,
        customer.GivenName,
        customer.FamilyName,
        customer.PrimaryEmailAddr?.Address,
      ], tokens)));
      if (page.length < 1_000) return this.#searchResult(matches, limit, scanned, true, "source_exhausted");
    }
    return this.#searchResult(
      matches,
      limit,
      scanned,
      false,
      matches.length >= limit ? "requested_limit" : "scan_limit",
    );
  }

  async listItems(): Promise<QuickBooksItem[]> {
    return this.#listActiveEntities<QuickBooksItem>("Item")
      .then((items) => items.filter((item) => item.Id && item.Name));
  }

  async findExistingSupplierBills(input: { vendorId: string; docNumber: string }): Promise<QuickBooksExistingBillMatch[]> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(input.vendorId) || !input.docNumber.trim() || input.docNumber.length > 21) {
      throw new AppError("VALIDATION_FAILED", "Vendor Id or supplier document number is invalid for duplicate checking.", {
        httpStatus: 400,
      });
    }
    const response = await this.#client.query<Record<string, unknown>>(
      `SELECT * FROM Bill WHERE DocNumber = '${queryLiteral(input.docNumber.trim())}' MAXRESULTS 100`,
    );
    const normalizedDocNumber = input.docNumber.trim().toLocaleLowerCase("en-US");
    return queryArray<QuickBooksBill>(response, "Bill")
      .filter((bill) => bill.Id && bill.VendorRef?.value === input.vendorId &&
        bill.DocNumber?.trim().toLocaleLowerCase("en-US") === normalizedDocNumber)
      .map((bill) => ({
        billId: bill.Id as string,
        vendorId: input.vendorId,
        docNumber: bill.DocNumber as string,
        ...(bill.TxnDate ? { txnDate: bill.TxnDate } : {}),
        total: decimal(bill.TotalAmt),
        ...(bill.Balance === undefined ? {} : { balance: decimal(bill.Balance) }),
      }));
  }

  async findExistingAccountingDocuments(input: {
    entity: QuickBooksExistingDocumentMatch["entity"];
    counterpartyId: string;
    docNumber: string;
  }): Promise<QuickBooksExistingDocumentMatch[]> {
    if (!(["Invoice", "Bill", "CreditMemo", "VendorCredit"] as const).includes(input.entity) ||
        !/^[A-Za-z0-9-]{1,64}$/u.test(input.counterpartyId) || !input.docNumber.trim() ||
        input.docNumber.length > 21) {
      throw new AppError("VALIDATION_FAILED", "Document identity is invalid for duplicate checking.", {
        httpStatus: 400,
      });
    }
    const response = await this.#client.query<Record<string, unknown>>(
      `SELECT * FROM ${input.entity} WHERE DocNumber = '${queryLiteral(input.docNumber.trim())}' MAXRESULTS 100`,
    );
    const normalizedDocNumber = input.docNumber.trim().toLocaleLowerCase("en-US");
    const referenceField = input.entity === "Invoice" || input.entity === "CreditMemo" ? "CustomerRef" : "VendorRef";
    return queryArray<Record<string, unknown>>(response, input.entity)
      .flatMap((document) => {
        const id = typeof document.Id === "string" ? document.Id : undefined;
        const docNumber = typeof document.DocNumber === "string" ? document.DocNumber : undefined;
        const total = document.TotalAmt;
        const counterparty = document[referenceField] as QuickBooksReference | undefined;
        if (!id || !docNumber || counterparty?.value !== input.counterpartyId ||
            docNumber.trim().toLocaleLowerCase("en-US") !== normalizedDocNumber) return [];
        return [{
          entity: input.entity,
          providerEntityId: id,
          counterpartyId: input.counterpartyId,
          docNumber,
          ...(typeof document.TxnDate === "string" ? { txnDate: document.TxnDate } : {}),
          ...(typeof total === "number" ? { total: decimal(total) } : {}),
        } satisfies QuickBooksExistingDocumentMatch];
      });
  }

  async listTransactions(input: QuickBooksTransactionListInput): Promise<QuickBooksTransactionListResult> {
    validateDate(input.dateFrom, "dateFrom");
    validateDate(input.dateTo, "dateTo");
    if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) {
      throw new AppError("VALIDATION_FAILED", "dateFrom cannot be after dateTo.", { httpStatus: 400 });
    }
    if (!QUICKBOOKS_TRANSACTION_ENTITIES.includes(input.entity)) {
      throw new AppError("VALIDATION_FAILED", "Unsupported QuickBooks transaction entity.", { httpStatus: 400 });
    }
    const customerEntities: QuickBooksTransactionEntity[] = ["Invoice", "Payment", "CreditMemo", "SalesReceipt", "RefundReceipt"];
    const vendorFields: Partial<Record<QuickBooksTransactionEntity, string>> = {
      Purchase: "EntityRef",
      BillPayment: "VendorRef",
      VendorCredit: "VendorRef",
    };
    if (input.customerId && !customerEntities.includes(input.entity)) {
      throw new AppError("VALIDATION_FAILED", `${input.entity} does not support customerId.`, { httpStatus: 400 });
    }
    if (input.vendorId && !vendorFields[input.entity]) {
      throw new AppError("VALIDATION_FAILED", `${input.entity} does not support vendorId.`, { httpStatus: 400 });
    }
    if (input.openOnly && input.entity !== "Invoice") {
      throw new AppError("VALIDATION_FAILED", "openOnly is currently supported for Invoice only.", { httpStatus: 400 });
    }
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new AppError("VALIDATION_FAILED", "Transaction page must be positive and pageSize must be 1-50.", {
        httpStatus: 400,
      });
    }
    const clauses = [
      ...(input.dateFrom ? [`TxnDate >= '${input.dateFrom}'`] : []),
      ...(input.dateTo ? [`TxnDate <= '${input.dateTo}'`] : []),
      ...(input.customerId ? [`CustomerRef = '${queryLiteral(input.customerId)}'`] : []),
      ...(input.vendorId ? [`${vendorFields[input.entity]} = '${queryLiteral(input.vendorId)}'`] : []),
      ...(input.openOnly ? ["Balance > '0'"] : []),
    ];
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const start = (page - 1) * pageSize + 1;
    const response = await this.#client.query<Record<string, unknown>>(
      `SELECT * FROM ${input.entity}${where} ORDERBY TxnDate DESC STARTPOSITION ${start} MAXRESULTS ${pageSize}`,
    );
    const records = queryArray<Record<string, unknown>>(response, input.entity);
    const totalCount = response.QueryResponse?.totalCount;
    return {
      entity: input.entity,
      records,
      pagination: {
        page,
        pageSize,
        returned: records.length,
        ...(typeof totalCount === "number" ? { totalCount } : {}),
        hasNextPage: typeof totalCount === "number" ? start - 1 + records.length < totalCount : records.length === pageSize,
      },
    };
  }

  async getTransaction(entity: QuickBooksTransactionEntity, transactionId: string): Promise<Record<string, unknown>> {
    if (!QUICKBOOKS_TRANSACTION_ENTITIES.includes(entity) || !/^[A-Za-z0-9-]{1,64}$/.test(transactionId)) {
      throw new AppError("VALIDATION_FAILED", "QuickBooks transaction type or Id is invalid.", { httpStatus: 400 });
    }
    const endpoint: Record<QuickBooksTransactionEntity, string> = {
      Invoice: "invoice",
      Payment: "payment",
      Purchase: "purchase",
      BillPayment: "billpayment",
      JournalEntry: "journalentry",
      CreditMemo: "creditmemo",
      SalesReceipt: "salesreceipt",
      RefundReceipt: "refundreceipt",
      VendorCredit: "vendorcredit",
    };
    const response = await this.#client.request<Record<string, unknown>>(
      `/${endpoint[entity]}/${encodeURIComponent(transactionId)}`,
    );
    const record = response[entity];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new AppError("NOT_FOUND", `QuickBooks ${entity} was not found.`, { httpStatus: 404 });
    }
    return record as Record<string, unknown>;
  }

  async runReport(input: QuickBooksReportInput): Promise<Record<string, unknown>> {
    validateDate(input.startDate, "startDate");
    validateDate(input.endDate, "endDate");
    if (input.startDate && input.endDate && input.startDate > input.endDate) {
      throw new AppError("VALIDATION_FAILED", "startDate cannot be after endDate.", { httpStatus: 400 });
    }
    if (!QUICKBOOKS_REPORTS.includes(input.report)) {
      throw new AppError("VALIDATION_FAILED", "Unsupported QuickBooks report.", { httpStatus: 400 });
    }
    validateDate(input.asOfDate, "asOfDate");
    if (input.asOfDate && (input.startDate || input.endDate)) {
      throw new AppError("VALIDATION_FAILED", "Use either asOfDate or startDate/endDate; the report window is ambiguous.", {
        httpStatus: 400,
      });
    }
    if (input.customerId && input.vendorId) {
      throw new AppError("VALIDATION_FAILED", "Use either customerId or vendorId, not both.", { httpStatus: 400 });
    }
    if (input.customerId && !["CustomerBalance", "AgedReceivables"].includes(input.report)) {
      throw new AppError("VALIDATION_FAILED", `${input.report} does not support customerId.`, { httpStatus: 400 });
    }
    if (input.vendorId && !["VendorBalance", "AgedPayables", "VendorExpenses"].includes(input.report)) {
      throw new AppError("VALIDATION_FAILED", `${input.report} does not support vendorId.`, { httpStatus: 400 });
    }
    const maxRows = input.maxRows ?? 250;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1_000) {
      throw new AppError("VALIDATION_FAILED", "Report maxRows must be from 1 to 1000.", { httpStatus: 400 });
    }
    const response = await this.#client.request<Record<string, unknown>>(`/reports/${input.report}`, {
      query: {
        ...(input.startDate ? { start_date: input.startDate } : {}),
        ...(input.endDate ? { end_date: input.endDate } : {}),
        ...(input.asOfDate ? { report_date: input.asOfDate } : {}),
        ...(input.accountingMethod ? { accounting_method: input.accountingMethod } : {}),
        ...(input.customerId ? { customer: input.customerId } : {}),
        ...(input.vendorId ? { vendor: input.vendorId } : {}),
      },
    });
    return reportRows(response, maxRows, input.view ?? "normalized");
  }

  async listBills(input: QuickBooksBillListInput = {}): Promise<QuickBooksBillListResult> {
    validateDate(input.dateFrom, "dateFrom");
    validateDate(input.dateTo, "dateTo");
    if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) {
      throw new AppError("VALIDATION_FAILED", "dateFrom cannot be after dateTo.", { httpStatus: 400 });
    }
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new AppError("VALIDATION_FAILED", "Bill page must be positive and pageSize must be 1-100.", {
        httpStatus: 400,
      });
    }
    const clauses = [
      ...(input.dateFrom ? [`TxnDate >= '${input.dateFrom}'`] : []),
      ...(input.dateTo ? [`TxnDate <= '${input.dateTo}'`] : []),
    ];
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const start = (page - 1) * pageSize + 1;
    const response = await this.#client.query<Record<string, unknown>>(
      `SELECT * FROM Bill${where} ORDERBY TxnDate DESC STARTPOSITION ${start} MAXRESULTS ${pageSize}`,
    );
    const bills = queryArray<QuickBooksBill>(response, "Bill").map((bill) => snapshot(this.#client.realmId, bill));
    const totalCount = response.QueryResponse?.totalCount;
    return {
      bills,
      pagination: {
        page,
        pageSize,
        returned: bills.length,
        ...(typeof totalCount === "number" ? { totalCount } : {}),
        hasNextPage: typeof totalCount === "number" ? start - 1 + bills.length < totalCount : bills.length === pageSize,
      },
    };
  }

  async getBill(billId: string): Promise<QuickBooksBillSnapshot> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(billId)) {
      throw new AppError("VALIDATION_FAILED", "billId is invalid.", { httpStatus: 400 });
    }
    const response = await this.#client.request<BillResponse>(`/bill/${encodeURIComponent(billId)}`);
    if (!response.Bill) throw new AppError("NOT_FOUND", "QuickBooks Bill was not found.", { httpStatus: 404 });
    return snapshot(this.#client.realmId, response.Bill);
  }

  async createApprovedSupplierBill(
    input: QuickBooksSupplierBillInput,
    permit: QuickBooksProviderWritePermit,
  ): Promise<{
    bill: QuickBooksBillSnapshot;
    receipt: Record<string, unknown>;
  }> {
    consumeQuickBooksSupplierBillProviderWritePermit(permit, {
      realmId: this.#client.realmId,
      input,
    });
    await this.validateSupplierBill(input);
    const sourceMarker = `zCloak source=${input.sourceRef}; sha256=${input.sourceSha256}`;
    const privateNote = [input.memo?.trim(), sourceMarker].filter(Boolean).join("\n").slice(0, 4_000);
    const payload = {
      VendorRef: { value: input.vendorId },
      TxnDate: input.txnDate,
      ...(input.dueDate ? { DueDate: input.dueDate } : {}),
      ...(input.docNumber ? { DocNumber: input.docNumber } : {}),
      ...(input.currencyCode ? { CurrencyRef: { value: input.currencyCode } } : {}),
      ...(input.globalTaxCalculation ? { GlobalTaxCalculation: input.globalTaxCalculation } : {}),
      PrivateNote: [
        privateNote,
        ...(input.approvalRef ? [`zCloak approval=${input.approvalRef}`] : []),
        ...(input.supportingEvidence ?? []).map((evidence) => `zCloak evidence=${evidence.kind}:${evidence.ref}; sha256=${evidence.sha256}`),
        ...(input.invoiceTotal ? [`zCloak invoice_total=${input.invoiceTotal}; tax_total=${input.taxTotal ?? "unspecified"}`] : []),
        ...(input.missingDocNumberReason ? [`zCloak missing_doc_number_reason=${input.missingDocNumberReason}`] : []),
      ].filter(Boolean).join("\n").slice(0, 4_000),
      Line: input.lines.map((line, index) => ({
        Amount: parseAmount(line.amount, index),
        DetailType: "AccountBasedExpenseLineDetail",
        ...(line.description ? { Description: line.description } : {}),
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: line.accountId },
          BillableStatus: "NotBillable",
          ...(line.taxCodeId ? { TaxCodeRef: { value: line.taxCodeId } } : {}),
        },
      })),
    };
    const response = await this.#client.request<BillResponse>("/bill", {
      method: "POST",
      requestId: input.requestId,
      isWrite: true,
      body: payload,
    });
    if (!response.Bill?.Id) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks accepted the request without returning a Bill Id.", {
        httpStatus: 502,
        retryable: true,
        details: { requestId: input.requestId },
      });
    }
    const readback = await this.getBill(response.Bill.Id);
    this.#verifyReadback(input, readback);
    return {
      bill: readback,
      receipt: {
        provider: "quickbooks-online",
        realmId: this.#client.realmId,
        billId: readback.billId,
        requestId: input.requestId,
        providerTime: response.time,
        verified: true,
      },
    };
  }

  async executeMutation(
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
  }> {
    consumeQuickBooksProviderWritePermit(permit, {
      realmId: this.#client.realmId,
      command: input,
    });
    const path = entityPath(input.entity);
    const providerPayload = input.entity === "Attachable" && input.operation === "UPDATE"
      ? {
          ...(typeof input.payload.file_name === "string" ? { FileName: input.payload.file_name } : {}),
          ...(typeof input.payload.content_type === "string" ? { ContentType: input.payload.content_type } : {}),
          ...(typeof input.payload.note === "string" ? { Note: input.payload.note } : {}),
          ...(typeof input.payload.category === "string" ? { Category: input.payload.category } : {}),
          ...(typeof input.payload.FileName === "string" ? { FileName: input.payload.FileName } : {}),
          ...(typeof input.payload.ContentType === "string" ? { ContentType: input.payload.ContentType } : {}),
          ...(typeof input.payload.Note === "string" ? { Note: input.payload.Note } : {}),
          ...(typeof input.payload.Category === "string" ? { Category: input.payload.Category } : {}),
        }
      : input.payload;
    const attachment = input.entity === "Attachable" && input.operation === "CREATE"
      ? attachmentUpload(input.payload)
      : undefined;
    const softDeactivation = input.operation === "DELETE" &&
      ["Customer", "Employee", "Item", "Vendor"].includes(input.entity);
    let current: Record<string, unknown> | undefined;
    if (input.operation !== "CREATE") {
      const currentResponse = await this.#client.request<Record<string, unknown>>(
        `/${path}/${encodeURIComponent(input.targetId as string)}`,
      );
      current = entityFromResponse(currentResponse, input.entity);
      if (!current || current.Id !== input.targetId) {
        throw new AppError("NOT_FOUND", `QuickBooks ${input.entity} target was not found.`, { httpStatus: 404 });
      }
      if (current.SyncToken !== input.syncToken) {
        throw new AppError("CONFLICT", `QuickBooks ${input.entity} changed after it was prepared; read it again before updating or deleting.`, {
          httpStatus: 409,
        });
      }
    }
    const mutationBody = input.operation === "CREATE"
      ? structuredClone(providerPayload)
      : input.operation === "UPDATE"
        ? {
            ...structuredClone(current),
            ...structuredClone(providerPayload),
            Id: input.targetId,
            SyncToken: input.syncToken,
          }
        : softDeactivation
          ? {
              ...structuredClone(current),
              Id: input.targetId,
              SyncToken: input.syncToken,
              Active: false,
            }
      : {
          ...(["Deposit", "Transfer", "Attachable"].includes(input.entity) ? structuredClone(current) : {}),
          Id: input.targetId,
          SyncToken: input.syncToken,
        };
    let invoiceVoidFallback = false;
    let response: Record<string, unknown>;
    // This is the last awaited boundary before the first raw Provider POST.
    // The durable marker fences stale workers and makes every later no-Id
    // failure non-retryable without explicit operator resolution.
    await markProviderDispatch();
    try {
      response = await this.#client.request<Record<string, unknown>>(attachment ? "/upload" : `/${path}`, {
        method: "POST",
        requestId: input.requestId,
        isWrite: true,
        ...(attachment ? { multipart: attachment.form } : {}),
        ...(input.operation === "DELETE" && !softDeactivation ? { query: { operation: "delete" } } : {}),
        ...(attachment ? {} : { body: mutationBody }),
      });
    } catch (deleteError) {
      if (input.entity !== "Invoice" || input.operation !== "DELETE") throw deleteError;
      let invoiceAfterDelete: Record<string, unknown> | undefined;
      try {
        const readAfterDelete = await this.#client.request<Record<string, unknown>>(
          `/invoice/${encodeURIComponent(input.targetId as string)}`,
        );
        invoiceAfterDelete = entityFromResponse(readAfterDelete, "Invoice");
      } catch (readError) {
        if (readError instanceof AppError && readError.code === "NOT_FOUND") {
          await recordProviderOutcome({
            providerEntityId: input.targetId as string,
            receipt: {
              provider: "quickbooks-online", realmId: this.#client.realmId, entity: input.entity,
              operation: input.operation, providerEntityId: input.targetId, requestId: input.requestId,
              outcome: "EXACT_ID_ABSENT_AFTER_DELETE_ERROR",
            },
          });
          return {
            providerEntityId: input.targetId as string,
            receipt: {
              provider: "quickbooks-online",
              realmId: this.#client.realmId,
              entity: input.entity,
              operation: input.operation,
              providerEntityId: input.targetId,
              requestId: input.requestId,
              verified: true,
              verification: "EXACT_ID_ABSENCE_AFTER_DELETE_ERROR",
            },
            readback: {
              Id: input.targetId,
              operation: "DELETE",
              deleted: true,
              readbackAvailable: true,
              verifiedBy: "GET_NOT_FOUND",
            },
          };
        }
        throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks Invoice delete failed and its exact-Id outcome could not be recovered.", {
          httpStatus: 502,
          retryable: false,
          details: { providerEntityId: input.targetId, requestId: input.requestId },
          cause: new AggregateError([deleteError, readError], "Invoice delete and recovery read both failed."),
        });
      }
      if (!invoiceAfterDelete || invoiceAfterDelete.Id !== input.targetId) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks Invoice delete failed and recovery returned no exact target.", {
          httpStatus: 502,
          retryable: false,
        });
      }
      if (invoiceAfterDelete.TotalAmt === 0 && invoiceAfterDelete.Balance === 0) {
        await recordProviderOutcome({
          providerEntityId: input.targetId as string,
          receipt: {
            provider: "quickbooks-online", realmId: this.#client.realmId, entity: input.entity,
            operation: input.operation, providerEntityId: input.targetId, requestId: input.requestId,
            outcome: "EXACT_ID_ALREADY_VOID",
          },
        });
        return {
          providerEntityId: input.targetId as string,
          receipt: {
            provider: "quickbooks-online",
            realmId: this.#client.realmId,
            entity: input.entity,
            operation: input.operation,
            providerEntityId: input.targetId,
            requestId: input.requestId,
            verified: true,
            verification: "EXACT_ID_ALREADY_VOID_READBACK",
          },
          readback: invoiceAfterDelete,
        };
      }
      if (invoiceAfterDelete.SyncToken !== input.syncToken) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks Invoice changed while recovering a failed delete; automatic void was blocked.", {
          httpStatus: 409,
          retryable: false,
          details: { providerEntityId: input.targetId, requestId: input.requestId },
        });
      }
      response = await this.#client.request<Record<string, unknown>>("/invoice", {
        method: "POST",
        requestId: `${input.requestId.slice(0, 45)}.void`,
        isWrite: true,
        query: { operation: "void" },
        body: { Id: input.targetId, SyncToken: input.syncToken, sparse: true },
      });
      invoiceVoidFallback = true;
    }

    const responseEntity = attachment ? uploadedAttachable(response) : entityFromResponse(response, input.entity);
    const providerEntityId = typeof responseEntity?.Id === "string"
      ? responseEntity.Id
      : input.targetId;
    if (!providerEntityId) {
      throw new AppError("WRITE_RESULT_UNKNOWN", `QuickBooks accepted ${input.operation} ${input.entity} without returning an Id.`, {
        httpStatus: 502,
        retryable: false,
        details: {
          requestId: input.requestId,
          providerMutationPossible: true,
          providerMutationRetried: false,
          automaticRearmAllowed: false,
          operatorResolutionRequired: true,
          recoveryAction: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
        },
      });
    }

    await recordProviderOutcome({
      providerEntityId,
      receipt: {
        provider: "quickbooks-online",
        realmId: this.#client.realmId,
        entity: input.entity,
        operation: input.operation,
        providerEntityId,
        requestId: input.requestId,
        providerTime: typeof response.time === "string" ? response.time : undefined,
        outcome: "PROVIDER_RESPONSE_ACCEPTED",
      },
    });

    if (input.operation === "DELETE" && !softDeactivation && !invoiceVoidFallback) {
      let absenceVerified = false;
      try {
        await this.#client.request<Record<string, unknown>>(`/${path}/${encodeURIComponent(providerEntityId)}`);
      } catch (error) {
        if (error instanceof AppError && error.code === "NOT_FOUND") absenceVerified = true;
        else {
          throw new AppError("WRITE_RESULT_UNKNOWN", `QuickBooks returned a delete receipt but exact-Id absence could not be verified.`, {
            httpStatus: 502,
            retryable: false,
            details: { providerEntityId, requestId: input.requestId },
            cause: error,
          });
        }
      }
      if (!absenceVerified) {
        throw new AppError("READBACK_MISMATCH", `QuickBooks ${input.entity} still exists after the delete response.`, {
          httpStatus: 502,
        });
      }
      return {
        providerEntityId,
        receipt: {
          provider: "quickbooks-online",
          realmId: this.#client.realmId,
          entity: input.entity,
          operation: input.operation,
          providerEntityId,
          requestId: input.requestId,
          providerTime: typeof response.time === "string" ? response.time : undefined,
          verified: true,
          verification: "EXACT_ID_ABSENCE_READBACK",
        },
        readback: {
          Id: providerEntityId,
          operation: "DELETE",
          deleted: true,
          readbackAvailable: true,
          verifiedBy: "GET_NOT_FOUND",
          reason: "QuickBooks transaction deletion is permanent; exact-Id absence was verified after the provider receipt.",
        },
      };
    }

    let readResponse: Record<string, unknown>;
    try {
      readResponse = await this.#client.request<Record<string, unknown>>(
        `/${path}/${encodeURIComponent(providerEntityId)}`,
      );
    } catch (error) {
      throw new AppError("WRITE_RESULT_UNKNOWN", `QuickBooks returned a write receipt but exact-Id readback could not be completed.`, {
        httpStatus: 502,
        retryable: false,
        details: { providerEntityId, requestId: input.requestId },
        cause: error,
      });
    }
    const readback = entityFromResponse(readResponse, input.entity);
    if (!readback || readback.Id !== providerEntityId) {
      throw new AppError("READBACK_MISMATCH", `QuickBooks ${input.entity} readback did not return the exact written Id.`, {
        httpStatus: 502,
      });
    }
    if (invoiceVoidFallback && (readback.TotalAmt !== 0 || readback.Balance !== 0)) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks Invoice void fallback did not produce an exact zero-total, zero-balance readback.", {
        httpStatus: 502,
      });
    }
    const expected = input.operation === "CREATE"
      ? attachment?.expected ?? expectedCreateReadback(input.entity, providerPayload)
      : softDeactivation
        ? { Id: providerEntityId, Active: false }
        : { ...providerPayload, Id: providerEntityId };
    if (!invoiceVoidFallback && !expectedSubset(normalizeForMutationReadback(readback), normalizeForMutationReadback(expected))) {
      throw new AppError("READBACK_MISMATCH", `QuickBooks ${input.entity} readback did not contain the approved fields.`, {
        httpStatus: 502,
      });
    }
    return {
      providerEntityId,
      receipt: {
        provider: "quickbooks-online",
        realmId: this.#client.realmId,
        entity: input.entity,
        operation: input.operation,
        providerEntityId,
        requestId: input.requestId,
        providerTime: typeof response.time === "string" ? response.time : undefined,
        verified: true,
          verification: invoiceVoidFallback ? "EXACT_ID_VOID_READBACK" : "EXACT_ID_READBACK",
      },
      readback,
    };
  }

  async recoverMutation(
    input: QuickBooksProviderMutationCommand,
    providerEntityId: string,
  ): Promise<{
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  }> {
    const path = entityPath(input.entity);
    const providerPayload = input.entity === "Attachable" && input.operation === "UPDATE"
      ? {
          ...(typeof input.payload.file_name === "string" ? { FileName: input.payload.file_name } : {}),
          ...(typeof input.payload.content_type === "string" ? { ContentType: input.payload.content_type } : {}),
          ...(typeof input.payload.note === "string" ? { Note: input.payload.note } : {}),
          ...(typeof input.payload.category === "string" ? { Category: input.payload.category } : {}),
          ...(typeof input.payload.FileName === "string" ? { FileName: input.payload.FileName } : {}),
          ...(typeof input.payload.ContentType === "string" ? { ContentType: input.payload.ContentType } : {}),
          ...(typeof input.payload.Note === "string" ? { Note: input.payload.Note } : {}),
          ...(typeof input.payload.Category === "string" ? { Category: input.payload.Category } : {}),
        }
      : input.payload;
    const attachment = input.entity === "Attachable" && input.operation === "CREATE"
      ? attachmentUpload(input.payload)
      : undefined;
    const softDeactivation = input.operation === "DELETE" &&
      ["Customer", "Employee", "Item", "Vendor"].includes(input.entity);
    let readback: Record<string, unknown> | undefined;
    try {
      const response = await this.#client.request<Record<string, unknown>>(
        `/${path}/${encodeURIComponent(providerEntityId)}`,
      );
      readback = entityFromResponse(response, input.entity);
    } catch (error) {
      if (input.operation === "DELETE" && !softDeactivation && error instanceof AppError && error.code === "NOT_FOUND") {
        return {
          providerEntityId,
          receipt: {
            provider: "quickbooks-online", realmId: this.#client.realmId, entity: input.entity,
            operation: input.operation, providerEntityId, requestId: input.requestId,
            verified: true, verification: "RECOVERY_EXACT_ID_ABSENCE", recoveryOnly: true,
          },
          readback: { Id: providerEntityId, operation: "DELETE", deleted: true, readbackAvailable: true, verifiedBy: "GET_NOT_FOUND" },
        };
      }
      throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks exact-Id recovery readback could not be completed; no write was retried.", {
        httpStatus: 502, retryable: false,
        details: { providerEntityId, requestId: input.requestId, recoveryOnly: true }, cause: error,
      });
    }
    if (!readback || readback.Id !== providerEntityId) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks exact-Id recovery returned a different or missing entity.", {
        httpStatus: 502, details: { providerEntityId, recoveryOnly: true },
      });
    }
    const expected = input.operation === "CREATE"
      ? attachment?.expected ?? expectedCreateReadback(input.entity, providerPayload)
      : input.operation === "UPDATE"
        ? { ...providerPayload, Id: providerEntityId }
        : softDeactivation
          ? { Id: providerEntityId, Active: false }
          : input.entity === "Invoice"
            ? { Id: providerEntityId, TotalAmt: 0, Balance: 0 }
            : undefined;
    if (!expected || !expectedSubset(normalizeForMutationReadback(readback), normalizeForMutationReadback(expected))) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks exact-Id recovery did not match the immutable approved mutation.", {
        httpStatus: 502, details: { providerEntityId, recoveryOnly: true },
      });
    }
    return {
      providerEntityId,
      receipt: {
        provider: "quickbooks-online", realmId: this.#client.realmId, entity: input.entity,
        operation: input.operation, providerEntityId, requestId: input.requestId,
        verified: true, verification: "RECOVERY_EXACT_ID_READBACK", recoveryOnly: true,
      },
      readback,
    };
  }

  async getMutationTarget(
    entity: QuickBooksWritableEntity,
    targetId: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.#client.request<Record<string, unknown>>(
      `/${entityPath(entity)}/${encodeURIComponent(targetId)}`,
    );
    const target = entityFromResponse(response, entity);
    if (!target || target.Id !== targetId) {
      throw new AppError("NOT_FOUND", `QuickBooks ${entity} target was not found.`, { httpStatus: 404 });
    }
    return structuredClone(target);
  }

  getTrialBalance(date?: string): Promise<Record<string, unknown>> {
    return this.runReport({ report: "TrialBalance", ...(date ? { asOfDate: date } : {}) });
  }

  async validateSupplierBill(input: QuickBooksSupplierBillInput): Promise<QuickBooksReferenceValidationResult> {
    validateInput(input);
    const validated = await this.#validateReferencedRecords(input);
    if (input.currencyCode && validated.vendor.currencyCode && !safeEqual(input.currencyCode, validated.vendor.currencyCode)) {
      throw new AppError("VALIDATION_FAILED", "The bill currency does not match the selected vendor currency.", {
        httpStatus: 400,
      });
    }
    return validated;
  }

  async #validateReferencedRecords(input: QuickBooksSupplierBillInput): Promise<QuickBooksReferenceValidationResult> {
    const vendor = await this.#client.request<VendorResponse>(`/vendor/${encodeURIComponent(input.vendorId)}`);
    if (!vendor.Vendor?.Id || vendor.Vendor.Active === false) {
      throw new AppError("VALIDATION_FAILED", "Selected QuickBooks vendor is missing or inactive.", { httpStatus: 400 });
    }
    const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
    const taxCodeIds = [...new Set(input.lines.flatMap((line) => line.taxCodeId ? [line.taxCodeId] : []))];
    const [accounts, taxCodes] = await Promise.all([
      Promise.all(accountIds.map(async (accountId) => {
        const response = await this.#client.request<AccountResponse>(`/account/${encodeURIComponent(accountId)}`);
        return response.Account;
      })),
      Promise.all(taxCodeIds.map(async (taxCodeId) => {
        const response = await this.#client.request<TaxCodeResponse>(`/taxcode/${encodeURIComponent(taxCodeId)}`);
        return response.TaxCode;
      })),
    ]);
    if (accounts.some((account) => !account?.Id || account.Active === false)) {
      throw new AppError("VALIDATION_FAILED", "A selected QuickBooks account is missing or inactive.", {
        httpStatus: 400,
      });
    }
    if (taxCodes.some((taxCode) => !taxCode?.Id || taxCode.Active === false)) {
      throw new AppError("VALIDATION_FAILED", "A selected QuickBooks tax code is missing or inactive.", {
        httpStatus: 400,
      });
    }
    return {
      vendor: {
        id: vendor.Vendor.Id,
        ...(vendor.Vendor.DisplayName ? { name: vendor.Vendor.DisplayName } : {}),
        ...(vendor.Vendor.CurrencyRef?.value ? { currencyCode: vendor.Vendor.CurrencyRef.value } : {}),
      },
      accounts: accounts.map((account) => ({
        id: account?.Id as string,
        ...(account?.Name ? { name: account.Name } : {}),
      })),
      taxCodes: taxCodes.map((taxCode) => ({
        id: taxCode?.Id as string,
        ...(taxCode?.Name ? { name: taxCode.Name } : {}),
      })),
    };
  }

  async #listActiveEntities<T>(entity: "Account" | "TaxCode" | "Item"): Promise<T[]> {
    const records: T[] = [];
    for (let start = 1; start <= 10_000; start += 1_000) {
      const response = await this.#client.query<Record<string, unknown>>(
        `SELECT * FROM ${entity} WHERE Active = true STARTPOSITION ${start} MAXRESULTS 1000`,
      );
      const page = queryArray<T>(response, entity);
      records.push(...page);
      if (page.length < 1_000) return records;
    }
    throw new AppError("VALIDATION_FAILED", `${entity} listing exceeded 10,000 active records; a partial list was not returned.`, {
      httpStatus: 400,
    });
  }

  #searchResult<T>(
    matches: T[],
    requestedLimit: number,
    scanned: number,
    complete: boolean,
    stoppedReason: QuickBooksSearchResult<T>["searchWindow"]["stoppedReason"],
  ): QuickBooksSearchResult<T> {
    const records = matches.slice(0, requestedLimit);
    return {
      records,
      searchWindow: {
        requestedLimit,
        returned: records.length,
        scanned,
        scanLimit: 10_000,
        complete,
        stoppedReason,
      },
    };
  }

  #verifyReadback(input: QuickBooksSupplierBillInput, bill: QuickBooksBillSnapshot): void {
    if (!safeEqual(bill.vendor.id, input.vendorId) || !safeEqual(bill.txnDate ?? "", input.txnDate)) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks Bill readback does not match its approved vendor or date.", {
        httpStatus: 502,
      });
    }
    const headerChecks: Array<[label: string, expected: string | undefined, actual: string | undefined]> = [
      ["document number", input.docNumber, bill.docNumber],
      ["due date", input.dueDate, bill.dueDate],
      ["currency", input.currencyCode, bill.currencyCode],
      ["global tax calculation", input.globalTaxCalculation, bill.globalTaxCalculation],
      ["invoice total", input.invoiceTotal, bill.total],
      ["tax total", input.taxTotal, bill.totalTax ?? "0.00"],
    ];
    const headerMismatch = headerChecks.find(([label, expected, actual]) => {
      if (expected === undefined) return false;
      const normalizedExpected = ["invoice total", "tax total"].includes(label) ? Number(expected).toFixed(2) : expected;
      return !safeEqual(normalizedExpected, actual ?? "");
    });
    if (headerMismatch) {
      throw new AppError("READBACK_MISMATCH", `QuickBooks Bill readback does not match its approved ${headerMismatch[0]}.`, {
        httpStatus: 502,
      });
    }
    const linesMatch = bill.lines.length === input.lines.length && input.lines.every((line, index) => {
      const readbackLine = bill.lines[index];
      return readbackLine !== undefined &&
        safeEqual(readbackLine.account?.id ?? "", line.accountId) &&
        safeEqual(readbackLine.amount, parseAmount(line.amount, index).toFixed(2)) &&
        (line.description === undefined || safeEqual(readbackLine.description ?? "", line.description)) &&
        (line.taxCodeId === undefined || safeEqual(readbackLine.taxCode?.id ?? "", line.taxCodeId));
    });
    if (!linesMatch) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks Bill readback does not match its approved line accounts or amounts.", {
        httpStatus: 502,
      });
    }
    const expectedMarker = `sha256=${input.sourceSha256}`;
    if (!bill.privateNote?.includes(expectedMarker)) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks Bill readback lost its source-document evidence marker.", {
        httpStatus: 502,
      });
    }
  }
}
