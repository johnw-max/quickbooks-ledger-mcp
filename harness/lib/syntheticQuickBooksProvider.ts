import { AppError } from "../../src/errors.js";
import type {
  QuickBooksBillListInput,
  QuickBooksBillListResult,
  QuickBooksExistingBillMatch,
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
  QuickBooksVendor,
} from "../../src/providers/quickbooksTypes.js";
import type { QuickBooksProviderCapabilities } from "../../src/quickbooks/service.js";

export const SYNTHETIC_QUICKBOOKS_REALM_ID = "9341457658718743";

const company: QuickBooksCompanyInfo = {
  Id: "1",
  CompanyName: "zCloak Accounting Sandbox Pte Ltd",
  LegalName: "zCloak Accounting Sandbox Pte. Ltd.",
  Country: "SG",
  FiscalYearStartMonth: "January",
};

const accounts: QuickBooksAccount[] = [
  { Id: "7", Name: "Software subscriptions", AccountType: "Expense", Active: true },
  { Id: "8", Name: "Professional fees", AccountType: "Expense", Active: true },
  { Id: "33", Name: "Accounts Payable (A/P)", AccountType: "Accounts Payable", Active: true },
];

const taxCodes: QuickBooksTaxCode[] = [
  { Id: "2", Name: "GST 9% Purchases", Active: true, Taxable: true },
  { Id: "3", Name: "Out of Scope", Active: true, Taxable: false },
];

const vendors: QuickBooksVendor[] = [
  {
    Id: "56",
    DisplayName: "Acme Cloud Services Pte Ltd",
    CompanyName: "Acme Cloud Services Pte Ltd",
    CurrencyRef: { value: "SGD", name: "Singapore Dollar" },
    Balance: 300,
    Active: true,
  },
  {
    Id: "57",
    DisplayName: "Northwind Advisory LLP",
    CompanyName: "Northwind Advisory LLP",
    CurrencyRef: { value: "SGD", name: "Singapore Dollar" },
    Balance: 2_400,
    Active: true,
  },
];

const customers: QuickBooksCustomer[] = [
  { Id: "91", DisplayName: "Blue Harbour Trading Pte Ltd", Balance: 4_300, Active: true },
];

const items: QuickBooksItem[] = [
  { Id: "101", Name: "Monthly accounting support", Type: "Service", UnitPrice: 800, Active: true },
];

const bills: QuickBooksBillSnapshot[] = [
  {
    billId: "145",
    realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
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

function searchResult<T>(records: T[], limit = 25): QuickBooksSearchResult<T> {
  const limited = records.slice(0, limit);
  return {
    records: limited,
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
  return Boolean(value) && (!from || (value as string) >= from) && (!to || (value as string) <= to);
}

export class SyntheticQuickBooksProvider implements QuickBooksProviderCapabilities {
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
    return structuredClone(accounts);
  }

  async listTaxCodes(): Promise<QuickBooksTaxCode[]> {
    return structuredClone(taxCodes);
  }

  async searchVendors(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksVendor>> {
    return searchResult(vendors.filter((vendor) => includesText([
      vendor.DisplayName,
      vendor.CompanyName,
      vendor.PrimaryEmailAddr?.Address,
    ], search)), limit);
  }

  async searchCustomers(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksCustomer>> {
    return searchResult(customers.filter((customer) => includesText([
      customer.DisplayName,
      customer.CompanyName,
      customer.PrimaryEmailAddr?.Address,
    ], search)), limit);
  }

  async listItems(): Promise<QuickBooksItem[]> {
    return structuredClone(items);
  }

  async listTransactions(input: QuickBooksTransactionListInput): Promise<QuickBooksTransactionListResult> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    const source = input.entity === "Invoice"
      ? [{ Id: "301", TxnDate: "2026-07-15", TotalAmt: 4_300, Balance: 4_300, CustomerRef: { value: "91", name: "Blue Harbour Trading Pte Ltd" } }]
      : [];
    const filtered = source.filter((record) => withinDate(record.TxnDate, input.dateFrom, input.dateTo));
    const start = (page - 1) * pageSize;
    const records = filtered.slice(start, start + pageSize);
    return {
      entity: input.entity,
      records,
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
    const result = await this.listTransactions({ entity });
    const record = result.records.find((candidate) => candidate.Id === transactionId);
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
    const filtered = bills.filter((bill) => withinDate(bill.txnDate, input.dateFrom, input.dateTo));
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
    const bill = bills.find((candidate) => candidate.billId === billId);
    if (!bill) throw new AppError("NOT_FOUND", "Synthetic QuickBooks Bill was not found.", { httpStatus: 404 });
    return structuredClone(bill);
  }

  async findExistingSupplierBills(input: { vendorId: string; docNumber: string }): Promise<QuickBooksExistingBillMatch[]> {
    return bills
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

  async validateSupplierBill(input: QuickBooksSupplierBillInput): Promise<QuickBooksReferenceValidationResult> {
    const vendor = vendors.find((candidate) => candidate.Id === input.vendorId && candidate.Active !== false);
    const selectedAccounts = input.lines.map((line) => accounts.find((account) => account.Id === line.accountId && account.Active !== false));
    const selectedTaxCodes = input.lines
      .filter((line) => line.taxCodeId)
      .map((line) => taxCodes.find((taxCode) => taxCode.Id === line.taxCodeId && taxCode.Active !== false));
    if (!vendor || selectedAccounts.some((account) => !account) || selectedTaxCodes.some((taxCode) => !taxCode)) {
      throw new AppError("VALIDATION_FAILED", "Synthetic QuickBooks references are missing or inactive.", { httpStatus: 400 });
    }
    return {
      vendor: {
        id: vendor.Id as string,
        ...(vendor.DisplayName ? { name: vendor.DisplayName } : {}),
        ...(vendor.CurrencyRef?.value ? { currencyCode: vendor.CurrencyRef.value } : {}),
      },
      accounts: selectedAccounts.map((account) => ({ id: account?.Id as string, name: account?.Name })),
      taxCodes: selectedTaxCodes.map((taxCode) => ({ id: taxCode?.Id as string, name: taxCode?.Name })),
    };
  }

  async createApprovedSupplierBill(): Promise<{ bill: QuickBooksBillSnapshot; receipt: Record<string, unknown> }> {
    throw new AppError("FORBIDDEN", "The synthetic local Agent harness never writes to QuickBooks.", { httpStatus: 403 });
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
}
