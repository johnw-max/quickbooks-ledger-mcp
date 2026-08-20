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
  QuickBooksTaxCode,
  QuickBooksTaxRate,
  QuickBooksVendor,
} from "./quickbooksTypes.js";
import type { QuickBooksWritableEntity } from "../quickbooks/writePolicy.js";
import {
  consumeQuickBooksProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../security/quickBooksProviderWritePermit.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

interface TaxRateResponse {
  TaxRate?: QuickBooksTaxRate;
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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roundedAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Compare the immutable approved accounting meaning, not QBO's presentation
 * serialization. QBO may add a derived SubTotalLineDetail and may omit fields
 * that are not represented by CreditMemo/VendorCredit. All economic lines,
 * references, amounts, tax and the provider-computed TotalAmt remain strict.
 */
function mutationReadbackMatches(
  entity: QuickBooksWritableEntity,
  actualValue: Record<string, unknown>,
  expectedValue: Record<string, unknown>,
): boolean {
  const normalizedActual = objectRecord(normalizeForMutationReadback(actualValue));
  const normalizedExpected = objectRecord(normalizeForMutationReadback(expectedValue));
  if (!normalizedActual || !normalizedExpected) return false;

  if (TOTAL_BEARING_TRANSACTION_ENTITIES.has(entity)) {
    const expectedLines = Array.isArray(normalizedExpected.Line) ? normalizedExpected.Line : undefined;
    const actualLines = Array.isArray(normalizedActual.Line) ? normalizedActual.Line : undefined;
    if (expectedLines && actualLines) {
      const expectedHasSubtotal = expectedLines.some((line) => objectRecord(line)?.DetailType === "SubTotalLineDetail");
      if (!expectedHasSubtotal) {
        const expectedLineTotal = roundedAmount(expectedLines.reduce((sum, line) => {
          const amount = finiteNumber(objectRecord(line)?.Amount);
          return amount === undefined ? sum : sum + amount;
        }, 0));
        let derivedSubtotalCount = 0;
        const economicLines: unknown[] = [];
        for (const line of actualLines) {
          const record = objectRecord(line);
          if (record?.DetailType === "SubTotalLineDetail") {
            derivedSubtotalCount += 1;
            if (derivedSubtotalCount > 1 || finiteNumber(record.Amount) !== expectedLineTotal ||
                !objectRecord(record.SubTotalLineDetail)) return false;
            continue;
          }
          economicLines.push(line);
        }
        normalizedActual.Line = economicLines;
      }
    }

    if (normalizedExpected.GlobalTaxCalculation === "NotApplicable") {
      const actualTax = objectRecord(normalizedActual.TxnTaxDetail)?.TotalTax;
      if (actualTax !== undefined && finiteNumber(actualTax) !== 0) return false;
      delete normalizedActual.GlobalTaxCalculation;
      delete normalizedExpected.GlobalTaxCalculation;
    }
  }

  if (entity === "CreditMemo" || entity === "VendorCredit") {
    delete normalizedActual.DueDate;
    delete normalizedExpected.DueDate;
  }

  return expectedSubset(normalizedActual, normalizedExpected);
}

/**
 * Transactions whose provider-computed TotalAmt is asserted on read-back and
 * whose presentation serialization QBO may embellish with a derived subtotal
 * line. A Purchase is line-and-tax shaped exactly as a Bill is, and a
 * SalesReceipt exactly as an Invoice is, so both verify on the same terms --
 * and a SalesReceipt must be here, because QBO returns one with the same
 * derived SubTotalLineDetail it adds to an Invoice and the strict array
 * comparison would otherwise read that as a read-back mismatch.
 * JournalEntry is deliberately absent: its TotalAmt is the debit side alone,
 * not the sum of its lines, so the strict field-for-field subset comparison of
 * what we actually sent is the stronger check there.
 */
const TOTAL_BEARING_TRANSACTION_ENTITIES = new Set<QuickBooksWritableEntity>([
  "Invoice", "Bill", "CreditMemo", "VendorCredit", "Purchase", "SalesReceipt",
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

export interface QuickBooksExistingDocumentMatch {
  entity: "Invoice" | "Bill" | "CreditMemo" | "VendorCredit" | "Purchase" | "SalesReceipt";
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
  async findExistingAccountingDocuments(input: {
    entity: QuickBooksExistingDocumentMatch["entity"];
    counterpartyId: string;
    docNumber: string;
  }): Promise<QuickBooksExistingDocumentMatch[]> {
    if (!(["Invoice", "Bill", "CreditMemo", "VendorCredit", "Purchase", "SalesReceipt"] as const).includes(input.entity) ||
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
    // Purchase records its payee in EntityRef; the other five use a typed
    // Customer/Vendor ref. Reading the wrong field would silently match nothing
    // and report a duplicate document as absent.
    const referenceField = input.entity === "Purchase"
      ? "EntityRef"
      : input.entity === "Invoice" || input.entity === "CreditMemo" || input.entity === "SalesReceipt"
        ? "CustomerRef"
        : "VendorRef";
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
    if (!invoiceVoidFallback && !mutationReadbackMatches(input.entity, readback, expected)) {
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
    if (!expected || !mutationReadbackMatches(input.entity, readback, expected)) {
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
}
