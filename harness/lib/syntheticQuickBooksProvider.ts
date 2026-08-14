import { AppError } from "../../src/errors.js";
import type {
  QuickBooksBillListInput,
  QuickBooksBillListResult,
  QuickBooksExistingBillMatch,
  QuickBooksExistingDocumentMatch,
  QuickBooksReferenceValidationResult,
  QuickBooksReportInput,
  QuickBooksSearchResult,
  QuickBooksTransactionEntity,
  QuickBooksTransactionListInput,
  QuickBooksTransactionListResult,
} from "../../src/providers/quickbooksProvider.js";
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
} from "../../src/providers/quickbooksTypes.js";
import { hashObject } from "../../src/security/hash.js";
import {
  consumeQuickBooksProviderWritePermit,
  consumeQuickBooksSupplierBillProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../../src/security/quickBooksProviderWritePermit.js";
import type { QuickBooksProviderCapabilities } from "../../src/quickbooks/service.js";
import type { QuickBooksWritableEntity } from "../../src/quickbooks/writePolicy.js";

export const SYNTHETIC_QUICKBOOKS_REALM_ID = "9341457658718743";

const company: QuickBooksCompanyInfo = {
  Id: "1",
  CompanyName: "zCloak Accounting Sandbox Pte Ltd",
  LegalName: "zCloak Accounting Sandbox Pte. Ltd.",
  Country: "SG",
  FiscalYearStartMonth: "January",
};

const seedAccounts: QuickBooksAccount[] = [
  { Id: "7", Name: "Software subscriptions", AccountType: "Expense", Active: true },
  { Id: "8", Name: "Professional fees", AccountType: "Expense", Active: true },
  { Id: "9", Name: "Office Expenses", AccountType: "Expense", Active: true },
  { Id: "10", Name: "Cloud Subscriptions", AccountType: "Expense", Active: true },
  { Id: "33", Name: "Accounts Payable (A/P)", AccountType: "Accounts Payable", Active: true },
];

const seedTaxCodes: QuickBooksTaxCode[] = [
  { Id: "2", Name: "GST 9% Purchases", Active: true, Taxable: true,
    PurchaseTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: "902" } }] } },
  { Id: "4", Name: "GST 9%", Active: true, Taxable: true,
    PurchaseTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: "904" } }] },
    SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: "904" } }] } },
  { Id: "3", Name: "Out of Scope", Active: true, Taxable: false },
];

const seedTaxRates: QuickBooksTaxRate[] = [
  { Id: "902", Name: "GST 9% Purchases", RateValue: 9, Active: true },
  { Id: "904", Name: "GST 9%", RateValue: 9, Active: true },
];

const seedVendors: QuickBooksVendor[] = [
  {
    Id: "56",
    DisplayName: "Acme Cloud Services Pte Ltd",
    CompanyName: "Acme Cloud Services Pte Ltd",
    CurrencyRef: { value: "SGD", name: "Singapore Dollar" },
    Balance: 300,
    Active: true,
    SyncToken: "0",
  },
  {
    Id: "57",
    DisplayName: "Northwind Advisory LLP",
    CompanyName: "Northwind Advisory LLP",
    CurrencyRef: { value: "SGD", name: "Singapore Dollar" },
    Balance: 2_400,
    Active: true,
    SyncToken: "0",
  },
];

const seedCustomers: QuickBooksCustomer[] = [
  { Id: "91", DisplayName: "Blue Harbour Trading Pte Ltd", Balance: 4_300, Active: true, SyncToken: "0" },
];

const seedItems: QuickBooksItem[] = [
  { Id: "101", Name: "Monthly accounting support", Type: "Service", UnitPrice: 800, Active: true },
  { Id: "102", Name: "Consulting", Type: "Service", UnitPrice: 200, Active: true },
];

const seedBills: QuickBooksBillSnapshot[] = [
  {
    billId: "145",
    realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
    syncToken: "0",
    paymentStatus: "PAID",
    vendor: { id: "56", name: "Acme Cloud Services Pte Ltd" },
    apAccount: { id: "33", name: "Accounts Payable (A/P)" },
    txnDate: "2026-06-05",
    dueDate: "2026-07-05",
    docNumber: "ACME-2026-0605",
    currencyCode: "SGD",
    total: "1200.00",
    balance: "0.00",
    lines: [{ amount: "1200.00", account: { id: "7", name: "Software subscriptions" } }],
  },
  {
    billId: "146",
    realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
    syncToken: "0",
    paymentStatus: "OPEN",
    vendor: { id: "56", name: "Acme Cloud Services Pte Ltd" },
    apAccount: { id: "33", name: "Accounts Payable (A/P)" },
    txnDate: "2026-07-05",
    dueDate: "2026-08-04",
    docNumber: "ACME-2026-0705",
    currencyCode: "SGD",
    total: "800.00",
    balance: "300.00",
    lines: [{ amount: "800.00", account: { id: "7", name: "Software subscriptions" } }],
  },
  {
    billId: "201",
    realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
    syncToken: "0",
    paymentStatus: "OPEN",
    vendor: { id: "57", name: "Northwind Advisory LLP" },
    apAccount: { id: "33", name: "Accounts Payable (A/P)" },
    txnDate: "2026-07-20",
    dueDate: "2026-08-19",
    docNumber: "NW-260720",
    currencyCode: "SGD",
    total: "2400.00",
    balance: "2400.00",
    lines: [{ amount: "2400.00", account: { id: "8", name: "Professional fees" } }],
  },
];

const supportedMutationEntities = new Set<QuickBooksWritableEntity>([
  "Customer", "Vendor", "Invoice", "Bill", "CreditMemo", "VendorCredit",
]);

interface MutationReplay {
  fingerprint: string;
  result: {
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  };
}

function searchResult<T>(records: T[], limit = 25): QuickBooksSearchResult<T> {
  const limited = records.slice(0, limit);
  return {
    records: structuredClone(limited),
    searchWindow: {
      requestedLimit: limit,
      returned: limited.length,
      scanned: records.length,
      scanLimit: 10_000,
      complete: true,
      stoppedReason: "source_exhausted",
    },
  };
}

function includesText(values: Array<string | undefined>, search: string): boolean {
  const normalized = search.trim().toLocaleLowerCase("en-US");
  return values.some((value) => value?.toLocaleLowerCase("en-US").includes(normalized));
}

function withinDate(value: string | undefined, from?: string, to?: string): boolean {
  return value !== undefined && (!from || value >= from) && (!to || value <= to);
}

function recordId(record: Record<string, unknown>): string | undefined {
  return typeof record.Id === "string" ? record.Id : undefined;
}

function optionalName(id: string, name: string | undefined): { id: string; name?: string } {
  return { id, ...(name ? { name } : {}) };
}

function totalFromLines(record: Record<string, unknown>): number {
  if (typeof record.TotalAmt === "number") return record.TotalAmt;
  if (!Array.isArray(record.Line)) return 0;
  const lineTotal = record.Line.reduce((sum, line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) return sum;
    const amount = (line as Record<string, unknown>).Amount;
    return sum + (typeof amount === "number" ? amount : 0);
  }, 0);
  const taxDetail = record.TxnTaxDetail;
  const totalTax = taxDetail && typeof taxDetail === "object" && !Array.isArray(taxDetail)
    ? (taxDetail as Record<string, unknown>).TotalTax
    : undefined;
  const total = record.GlobalTaxCalculation === "TaxExcluded" && typeof totalTax === "number"
    ? lineTotal + totalTax
    : lineTotal;
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

function billRecord(snapshot: QuickBooksBillSnapshot): Record<string, unknown> {
  return {
    Id: snapshot.billId,
    SyncToken: snapshot.syncToken ?? "0",
    VendorRef: { value: snapshot.vendor.id, ...(snapshot.vendor.name ? { name: snapshot.vendor.name } : {}) },
    ...(snapshot.apAccount ? { APAccountRef: { value: snapshot.apAccount.id, ...(snapshot.apAccount.name ? { name: snapshot.apAccount.name } : {}) } } : {}),
    ...(snapshot.txnDate ? { TxnDate: snapshot.txnDate } : {}),
    ...(snapshot.dueDate ? { DueDate: snapshot.dueDate } : {}),
    ...(snapshot.docNumber ? { DocNumber: snapshot.docNumber } : {}),
    ...(snapshot.currencyCode ? { CurrencyRef: { value: snapshot.currencyCode } } : {}),
    TotalAmt: Number(snapshot.total),
    Balance: Number(snapshot.balance ?? snapshot.total),
    Line: snapshot.lines.map((line) => ({
      Amount: Number(line.amount),
      ...(line.description ? { Description: line.description } : {}),
      ...(line.account ? {
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: line.account.id, ...(line.account.name ? { name: line.account.name } : {}) } },
      } : {}),
    })),
  };
}

export class SyntheticQuickBooksProvider implements QuickBooksProviderCapabilities {
  readonly #accounts = structuredClone(seedAccounts);
  readonly #taxCodes = structuredClone(seedTaxCodes);
  readonly #taxRates = structuredClone(seedTaxRates);
  readonly #items = structuredClone(seedItems);
  readonly #records = new Map<QuickBooksWritableEntity, Map<string, Record<string, unknown>>>();
  readonly #replays = new Map<string, MutationReplay>();
  #nextId = 10_000;
  #mutationCount = 0;

  constructor() {
    this.#records.set("Customer", new Map(seedCustomers.map((record) => [record.Id as string, structuredClone(record) as Record<string, unknown>])));
    this.#records.set("Vendor", new Map(seedVendors.map((record) => [record.Id as string, structuredClone(record) as Record<string, unknown>])));
    this.#records.set("Invoice", new Map([["301", {
      Id: "301", SyncToken: "0", TxnDate: "2026-07-15", TotalAmt: 4_300, Balance: 4_300,
      CustomerRef: { value: "91", name: "Blue Harbour Trading Pte Ltd" },
    }]]));
    this.#records.set("Bill", new Map(seedBills.map((snapshot) => [snapshot.billId, billRecord(snapshot)])));
    this.#records.set("CreditMemo", new Map());
    this.#records.set("VendorCredit", new Map());
  }

  get mutationCount(): number {
    return this.#mutationCount;
  }

  mutationRequestCount(): number {
    return this.#replays.size;
  }

  async getCompany(): Promise<QuickBooksCompanyInfo> {
    return structuredClone(company);
  }

  async getCompanyContext(): Promise<QuickBooksCompanyContext> {
    return {
      ...structuredClone(company),
      HomeCurrency: { value: "SGD", name: "Singapore Dollar" },
      MultiCurrencyEnabled: true,
    };
  }

  async listAccounts(): Promise<QuickBooksAccount[]> {
    return structuredClone(this.#accounts);
  }

  async listTaxCodes(): Promise<QuickBooksTaxCode[]> {
    return structuredClone(this.#taxCodes);
  }

  async getTaxRate(taxRateId: string): Promise<QuickBooksTaxRate> {
    const rate = this.#taxRates.find((entry) => entry.Id === taxRateId && entry.Active !== false);
    if (!rate) throw new AppError("NOT_FOUND", "Synthetic QuickBooks TaxRate was not found.", { httpStatus: 404 });
    return structuredClone(rate);
  }

  async searchVendors(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksVendor>> {
    const records = [...(this.#records.get("Vendor")?.values() ?? [])] as unknown as QuickBooksVendor[];
    return searchResult(records.filter((vendor) => includesText([
      vendor.DisplayName,
      vendor.CompanyName,
      vendor.PrimaryEmailAddr?.Address,
    ], search)), limit);
  }

  async searchCustomers(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksCustomer>> {
    const records = [...(this.#records.get("Customer")?.values() ?? [])] as unknown as QuickBooksCustomer[];
    return searchResult(records.filter((customer) => includesText([
      customer.DisplayName,
      customer.CompanyName,
      customer.PrimaryEmailAddr?.Address,
    ], search)), limit);
  }

  async listItems(): Promise<QuickBooksItem[]> {
    return structuredClone(this.#items);
  }

  async listTransactions(input: QuickBooksTransactionListInput): Promise<QuickBooksTransactionListResult> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    const source = [...(this.#records.get(input.entity)?.values() ?? [])];
    const filtered = source.filter((record) => {
      const txnDate = typeof record.TxnDate === "string" ? record.TxnDate : undefined;
      if (!withinDate(txnDate, input.dateFrom, input.dateTo)) return false;
      const customerRef = record.CustomerRef as { value?: unknown } | undefined;
      const vendorRef = record.VendorRef as { value?: unknown } | undefined;
      if (input.customerId && customerRef?.value !== input.customerId) return false;
      if (input.vendorId && vendorRef?.value !== input.vendorId) return false;
      if (input.openOnly && typeof record.Balance === "number" && record.Balance === 0) return false;
      return true;
    });
    const start = (page - 1) * pageSize;
    const records = filtered.slice(start, start + pageSize);
    return {
      entity: input.entity,
      records: structuredClone(records),
      pagination: {
        page,
        pageSize,
        returned: records.length,
        totalCount: filtered.length,
        hasNextPage: start + records.length < filtered.length,
      },
    };
  }

  async getTransaction(entity: QuickBooksTransactionEntity, transactionId: string): Promise<Record<string, unknown>> {
    const record = this.#records.get(entity)?.get(transactionId);
    if (!record) throw new AppError("NOT_FOUND", `Synthetic QuickBooks ${entity} was not found.`, { httpStatus: 404 });
    return structuredClone(record);
  }

  async runReport(input: QuickBooksReportInput): Promise<Record<string, unknown>> {
    return {
      report: input.report,
      currency: "SGD",
      basis: input.accountingMethod ?? "Accrual",
      rows: input.report === "AgedPayables"
        ? [
            { vendor: "Acme Cloud Services Pte Ltd", openBalance: "300.00" },
            { vendor: "Northwind Advisory LLP", openBalance: "2400.00" },
          ]
        : [{ label: "Synthetic bounded report", amount: "2700.00" }],
      zcloakReportWindow: {
        maxRows: input.maxRows ?? 250,
        returnedRows: 2,
        truncated: false,
      },
    };
  }

  async listBills(input: QuickBooksBillListInput = {}): Promise<QuickBooksBillListResult> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    const snapshots = [...(this.#records.get("Bill")?.values() ?? [])].map((record) => this.#billSnapshot(record));
    const filtered = snapshots.filter((bill) => withinDate(bill.txnDate, input.dateFrom, input.dateTo));
    const start = (page - 1) * pageSize;
    const selected = filtered.slice(start, start + pageSize);
    return {
      bills: structuredClone(selected),
      pagination: {
        page,
        pageSize,
        returned: selected.length,
        totalCount: filtered.length,
        hasNextPage: start + selected.length < filtered.length,
      },
    };
  }

  async getBill(billId: string): Promise<QuickBooksBillSnapshot> {
    const bill = this.#records.get("Bill")?.get(billId);
    if (!bill) throw new AppError("NOT_FOUND", "Synthetic QuickBooks Bill was not found.", { httpStatus: 404 });
    return this.#billSnapshot(bill);
  }

  async findExistingSupplierBills(input: { vendorId: string; docNumber: string }): Promise<QuickBooksExistingBillMatch[]> {
    const listed = await this.listBills();
    return listed.bills
      .filter((bill) => bill.vendor.id === input.vendorId && bill.docNumber === input.docNumber)
      .map((bill) => ({
        billId: bill.billId,
        vendorId: bill.vendor.id,
        docNumber: bill.docNumber as string,
        ...(bill.txnDate ? { txnDate: bill.txnDate } : {}),
        total: bill.total,
        ...(bill.balance ? { balance: bill.balance } : {}),
      }));
  }

  async findExistingAccountingDocuments(input: {
    entity: QuickBooksExistingDocumentMatch["entity"];
    counterpartyId: string;
    docNumber: string;
  }): Promise<QuickBooksExistingDocumentMatch[]> {
    const referenceField = input.entity === "Invoice" || input.entity === "CreditMemo" ? "CustomerRef" : "VendorRef";
    const normalized = input.docNumber.trim().toLocaleLowerCase("en-US");
    return [...(this.#records.get(input.entity)?.values() ?? [])].flatMap((record) => {
      const reference = record[referenceField] as { value?: unknown } | undefined;
      if (reference?.value !== input.counterpartyId || typeof record.DocNumber !== "string" ||
          record.DocNumber.trim().toLocaleLowerCase("en-US") !== normalized || typeof record.Id !== "string") return [];
      return [{
        entity: input.entity,
        providerEntityId: record.Id,
        counterpartyId: input.counterpartyId,
        docNumber: record.DocNumber,
        ...(typeof record.TxnDate === "string" ? { txnDate: record.TxnDate } : {}),
        ...(record.TotalAmt === undefined ? {} : { total: String(record.TotalAmt) }),
      } satisfies QuickBooksExistingDocumentMatch];
    });
  }

  async validateSupplierBill(input: QuickBooksSupplierBillInput): Promise<QuickBooksReferenceValidationResult> {
    const vendor = this.#records.get("Vendor")?.get(input.vendorId) as unknown as QuickBooksVendor | undefined;
    const selectedAccounts = input.lines.map((line) => this.#accounts.find((account) => account.Id === line.accountId && account.Active !== false));
    const selectedTaxCodes = input.lines
      .filter((line) => line.taxCodeId)
      .map((line) => this.#taxCodes.find((taxCode) => taxCode.Id === line.taxCodeId && taxCode.Active !== false));
    if (!vendor || vendor.Active === false || selectedAccounts.some((account) => !account) || selectedTaxCodes.some((taxCode) => !taxCode)) {
      throw new AppError("VALIDATION_FAILED", "Synthetic QuickBooks references are missing or inactive.", { httpStatus: 400 });
    }
    return {
      vendor: {
        id: vendor.Id as string,
        ...(vendor.DisplayName ? { name: vendor.DisplayName } : {}),
        ...(vendor.CurrencyRef?.value ? { currencyCode: vendor.CurrencyRef.value } : {}),
      },
      accounts: selectedAccounts.map((account) => optionalName(account?.Id as string, account?.Name)),
      taxCodes: selectedTaxCodes.map((taxCode) => optionalName(taxCode?.Id as string, taxCode?.Name)),
    };
  }

  async createApprovedSupplierBill(
    input: QuickBooksSupplierBillInput,
    permit: QuickBooksProviderWritePermit,
  ): Promise<{
    bill: QuickBooksBillSnapshot;
    receipt: Record<string, unknown>;
  }> {
    consumeQuickBooksSupplierBillProviderWritePermit(permit, {
      realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
      input,
    });
    await this.validateSupplierBill(input);
    const result = await this.#executeMutation({
      entity: "Bill",
      operation: "CREATE",
      requestId: input.requestId,
      payload: {
        VendorRef: { value: input.vendorId },
        TxnDate: input.txnDate,
        ...(input.dueDate ? { DueDate: input.dueDate } : {}),
        ...(input.docNumber ? { DocNumber: input.docNumber } : {}),
        ...(input.currencyCode ? { CurrencyRef: { value: input.currencyCode } } : {}),
        ...(input.memo ? { PrivateNote: input.memo } : {}),
        Line: input.lines.map((line) => ({
          Amount: Number(line.amount),
          ...(line.description ? { Description: line.description } : {}),
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: line.accountId },
            ...(line.taxCodeId ? { TaxCodeRef: { value: line.taxCodeId } } : {}),
          },
        })),
      },
    });
    return { bill: this.#billSnapshot(result.readback), receipt: result.receipt };
  }

  async getTrialBalance(date?: string): Promise<Record<string, unknown>> {
    return {
      report: "TrialBalance",
      reportDate: date ?? "2026-08-12",
      currency: "SGD",
      rows: [
        { account: "Accounts Payable (A/P)", debit: "0.00", credit: "2700.00" },
        { account: "Software subscriptions", debit: "800.00", credit: "0.00" },
        { account: "Professional fees", debit: "2400.00", credit: "0.00" },
      ],
      zcloakReportWindow: { maxRows: 250, returnedRows: 3, truncated: false },
    };
  }

  async getMutationTarget(entity: QuickBooksWritableEntity, targetId: string): Promise<Record<string, unknown>> {
    const target = this.#records.get(entity)?.get(targetId);
    if (!target) throw new AppError("NOT_FOUND", `Synthetic QuickBooks ${entity} target was not found.`, { httpStatus: 404 });
    return structuredClone(target);
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
      realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
      command: input,
    });
    await markProviderDispatch();
    const result = await this.#executeMutation(input);
    await recordProviderOutcome({ providerEntityId: result.providerEntityId, receipt: {
      provider: "quickbooks-synthetic", realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
      entity: input.entity, operation: input.operation, providerEntityId: result.providerEntityId,
      requestId: input.requestId, outcome: "PROVIDER_RESPONSE_ACCEPTED",
    } });
    return result;
  }

  async recoverMutation(input: QuickBooksProviderMutationCommand, providerEntityId: string) {
    const readback = await this.getMutationTarget(input.entity, providerEntityId);
    return {
      providerEntityId,
      receipt: { provider: "quickbooks-synthetic", realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
        entity: input.entity, operation: input.operation, providerEntityId, requestId: input.requestId,
        verified: true, verification: "RECOVERY_EXACT_ID_READBACK", recoveryOnly: true },
      readback,
    };
  }

  async #executeMutation(input: QuickBooksProviderMutationCommand): Promise<{
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  }> {
    if (!supportedMutationEntities.has(input.entity)) {
      throw new AppError("VALIDATION_FAILED", `Synthetic provider does not support ${input.entity} mutations.`, { httpStatus: 422 });
    }
    const fingerprint = hashObject({
      entity: input.entity,
      operation: input.operation,
      payload: input.payload,
      targetId: input.targetId ?? null,
      syncToken: input.syncToken ?? null,
    });
    const replay = this.#replays.get(input.requestId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new AppError("CONFLICT", "Synthetic requestId was reused with a different mutation.", { httpStatus: 409 });
      }
      return structuredClone(replay.result);
    }

    const store = this.#records.get(input.entity) as Map<string, Record<string, unknown>>;
    let providerEntityId: string;
    let readback: Record<string, unknown>;
    if (input.operation === "CREATE") {
      providerEntityId = String(this.#nextId++);
      readback = {
        ...structuredClone(input.payload),
        Id: providerEntityId,
        SyncToken: "0",
      };
      if ((input.entity === "Customer" || input.entity === "Vendor") && readback.Active === undefined) readback.Active = true;
      if (["Invoice", "Bill", "CreditMemo", "VendorCredit"].includes(input.entity)) {
        const total = totalFromLines(readback);
        if (readback.TotalAmt === undefined) readback.TotalAmt = total;
        if (readback.Balance === undefined) readback.Balance = total;
      }
      store.set(providerEntityId, structuredClone(readback));
    } else {
      if (!input.targetId || !input.syncToken) {
        throw new AppError("VALIDATION_FAILED", "Synthetic UPDATE/DELETE requires targetId and syncToken.", { httpStatus: 422 });
      }
      const current = store.get(input.targetId);
      if (!current) throw new AppError("NOT_FOUND", `Synthetic QuickBooks ${input.entity} target was not found.`, { httpStatus: 404 });
      if (current.SyncToken !== input.syncToken) {
        throw new AppError("CONFLICT", `Synthetic QuickBooks ${input.entity} SyncToken is stale.`, { httpStatus: 409 });
      }
      providerEntityId = input.targetId;
      const nextSyncToken = String(Number(input.syncToken) + 1);
      if (input.operation === "UPDATE") {
        readback = { ...structuredClone(current), ...structuredClone(input.payload), Id: providerEntityId, SyncToken: nextSyncToken };
        store.set(providerEntityId, structuredClone(readback));
      } else if (input.entity === "Customer" || input.entity === "Vendor") {
        readback = { ...structuredClone(current), Id: providerEntityId, SyncToken: nextSyncToken, Active: false };
        store.set(providerEntityId, structuredClone(readback));
      } else {
        readback = { Id: providerEntityId, SyncToken: nextSyncToken, status: "Deleted" };
        store.delete(providerEntityId);
      }
    }

    this.#mutationCount += 1;
    const result = {
      providerEntityId,
      receipt: {
        provider: "synthetic-quickbooks-online",
        realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
        entity: input.entity,
        operation: input.operation,
        providerEntityId,
        requestId: input.requestId,
        verified: true,
        verification: "EXACT_ID_READBACK",
      },
      readback: structuredClone(readback),
    };
    this.#replays.set(input.requestId, { fingerprint, result: structuredClone(result) });
    return result;
  }

  #billSnapshot(record: Record<string, unknown>): QuickBooksBillSnapshot {
    const id = recordId(record);
    if (!id) throw new AppError("READBACK_MISMATCH", "Synthetic Bill readback has no Id.", { httpStatus: 502 });
    const vendorRef = record.VendorRef as { value?: unknown; name?: unknown } | undefined;
    if (typeof vendorRef?.value !== "string") {
      throw new AppError("READBACK_MISMATCH", "Synthetic Bill readback has no VendorRef.", { httpStatus: 502 });
    }
    const apRef = record.APAccountRef as { value?: unknown; name?: unknown } | undefined;
    const total = totalFromLines(record);
    const balance = typeof record.Balance === "number" ? record.Balance : total;
    const rawLines = Array.isArray(record.Line) ? record.Line : [];
    return {
      billId: id,
      realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
      ...(typeof record.SyncToken === "string" ? { syncToken: record.SyncToken } : {}),
      paymentStatus: balance === 0 ? "PAID" : "OPEN",
      vendor: optionalName(vendorRef.value, typeof vendorRef.name === "string" ? vendorRef.name : undefined),
      ...(typeof apRef?.value === "string" ? { apAccount: optionalName(apRef.value, typeof apRef.name === "string" ? apRef.name : undefined) } : {}),
      ...(typeof record.TxnDate === "string" ? { txnDate: record.TxnDate } : {}),
      ...(typeof record.DueDate === "string" ? { dueDate: record.DueDate } : {}),
      ...(typeof record.DocNumber === "string" ? { docNumber: record.DocNumber } : {}),
      ...(typeof (record.CurrencyRef as { value?: unknown } | undefined)?.value === "string"
        ? { currencyCode: (record.CurrencyRef as { value: string }).value }
        : {}),
      total: total.toFixed(2),
      balance: balance.toFixed(2),
      lines: rawLines.map((line) => {
        const value = line && typeof line === "object" && !Array.isArray(line) ? line as Record<string, unknown> : {};
        const detail = value.AccountBasedExpenseLineDetail as { AccountRef?: { value?: unknown; name?: unknown } } | undefined;
        const ref = detail?.AccountRef;
        return {
          amount: (typeof value.Amount === "number" ? value.Amount : 0).toFixed(2),
          ...(typeof value.Description === "string" ? { description: value.Description } : {}),
          ...(typeof ref?.value === "string" ? { account: optionalName(ref.value, typeof ref.name === "string" ? ref.name : undefined) } : {}),
        };
      }),
    };
  }
}
