import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import type { QuickBooksApiClient, QuickBooksRequestOptions } from "../src/providers/quickbooksClient.js";
import { QuickBooksAccountingProvider } from "../src/providers/quickbooksProvider.js";
import type { QuickBooksSupplierBillInput } from "../src/providers/quickbooksTypes.js";
import type { QuickBooksProviderMutationCommand } from "../src/security/quickBooksProviderWritePermit.js";
import {
  issueQuickBooksProviderWriteTestPermit,
  issueQuickBooksSupplierBillProviderWriteTestPermit,
} from "./helpers/quickBooksProviderWritePermit.js";

const input: QuickBooksSupplierBillInput = {
  requestId: "zc.bill.case-001",
  sourceRef: "invoice-case-001.pdf",
  sourceSha256: "a".repeat(64),
  vendorId: "56",
  txnDate: "2026-08-05",
  dueDate: "2026-09-04",
  docNumber: "INV-CASE-001",
  currencyCode: "SGD",
  memo: "Approved supplier invoice",
  globalTaxCalculation: "TaxExcluded",
  invoiceTotal: "129.60",
  taxTotal: "9.60",
  lines: [
    { accountId: "7", amount: "100.00", description: "Bookkeeping subscription", taxCodeId: "3" },
    { accountId: "8", amount: "20.00", description: "Support", taxCodeId: "3" },
  ],
};

function fixtureBill(privateNote = `Approved supplier invoice\nzCloak source=invoice-case-001.pdf; sha256=${"a".repeat(64)}`) {
  return {
    Id: "145",
    SyncToken: "0",
    VendorRef: { value: "56", name: "Acme Pte Ltd" },
    TxnDate: "2026-08-05",
    DueDate: "2026-09-04",
    DocNumber: "INV-CASE-001",
    CurrencyRef: { value: "SGD" },
    GlobalTaxCalculation: "TaxExcluded",
    TotalAmt: 129.6,
    Balance: 129.6,
    TxnTaxDetail: { TotalTax: 9.6 },
    PrivateNote: privateNote,
    Line: [
      {
        Id: "1",
        Amount: 100,
        Description: "Bookkeeping subscription",
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "7", name: "Subscriptions" },
          TaxCodeRef: { value: "3", name: "GST" },
        },
      },
      {
        Id: "2",
        Amount: 20,
        Description: "Support",
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "8", name: "Professional fees" },
          TaxCodeRef: { value: "3", name: "GST" },
        },
      },
    ],
    MetaData: { LastUpdatedTime: "2026-08-05T08:00:00+08:00" },
  };
}

function providerWithRequest(readback = fixtureBill()) {
  const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
    if (path === "/vendor/56") return { Vendor: { Id: "56", Active: true } };
    if (path === "/account/7") return { Account: { Id: "7", Active: true } };
    if (path === "/account/8") return { Account: { Id: "8", Active: true } };
    if (path === "/taxcode/3") return { TaxCode: { Id: "3", Active: true } };
    if (path === "/bill" && options.method === "POST") return { Bill: { Id: "145" }, time: "2026-08-05T00:00:00Z" };
    if (path === "/bill/145") return { Bill: readback };
    throw new Error(`Unexpected request ${path}`);
  });
  const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
  return { provider: new QuickBooksAccountingProvider(client), request };
}

function executeProviderMutation(
  provider: QuickBooksAccountingProvider,
  command: QuickBooksProviderMutationCommand,
  recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void> = async () => undefined,
  markProviderDispatch: () => Promise<void> = async () => undefined,
) {
  return provider.executeMutation(
    command,
    issueQuickBooksProviderWriteTestPermit(command),
    recordProviderOutcome,
    markProviderDispatch,
  );
}

describe("QuickBooks accounting provider", () => {
  it("resolves Company identity and the official Preferences home currency together", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/companyinfo/934145") {
        return { CompanyInfo: { Id: "1", CompanyName: "Sandbox Company", Country: "SG" } };
      }
      if (path === "/preferences") {
        return {
          Preferences: {
            CurrencyPrefs: {
              MultiCurrencyEnabled: true,
              HomeCurrency: { value: "SGD", name: "Singapore Dollar" },
            },
          },
        };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.getCompanyContext()).resolves.toMatchObject({
      Id: "1",
      CompanyName: "Sandbox Company",
      Country: "SG",
      HomeCurrency: { value: "SGD" },
      MultiCurrencyEnabled: true,
    });
    expect(request).toHaveBeenCalledWith("/preferences");
  });

  it("supports bounded customer, transaction, exact-record, item, and report reads", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.startsWith("SELECT * FROM Customer")) {
        return { QueryResponse: { Customer: [
          { Id: "9", DisplayName: "Amy's Bird Sanctuary", PrimaryEmailAddr: { Address: "amy@example.com" } },
          { Id: "10", DisplayName: "Bob's Garage" },
        ] } };
      }
      if (statement.startsWith("SELECT * FROM Item")) {
        return { QueryResponse: { Item: [{ Id: "3", Name: "Design services", Active: true }] } };
      }
      if (statement.startsWith("SELECT * FROM Invoice")) {
        return { QueryResponse: { Invoice: [{ Id: "130", TxnDate: "2026-08-01", TotalAmt: 250 }], totalCount: 1 } };
      }
      throw new Error(`Unexpected query ${statement}`);
    });
    const request = vi.fn(async (path: string) => {
      if (path === "/invoice/130") return { Invoice: { Id: "130", TotalAmt: 250 } };
      if (path === "/reports/ProfitAndLoss") return { Header: { ReportName: "ProfitAndLoss" }, Rows: {} };
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.searchCustomers("amy", 10)).resolves.toMatchObject({
      records: [{ Id: "9" }],
      searchWindow: { complete: true, stoppedReason: "source_exhausted", scanned: 2 },
    });
    await expect(provider.listItems()).resolves.toMatchObject([{ Id: "3" }]);
    await expect(provider.listTransactions({
      entity: "Invoice",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
    })).resolves.toMatchObject({
      entity: "Invoice",
      records: [{ Id: "130" }],
      pagination: { returned: 1, totalCount: 1, hasNextPage: false },
    });
    await expect(provider.getTransaction("Invoice", "130")).resolves.toMatchObject({ Id: "130" });
    await expect(provider.runReport({
      report: "ProfitAndLoss",
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      accountingMethod: "Accrual",
    })).resolves.toMatchObject({ Header: { ReportName: "ProfitAndLoss" } });

    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM Invoice WHERE TxnDate >= '2026-08-01' AND TxnDate <= '2026-08-31' ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 25",
    );
    expect(request).toHaveBeenCalledWith("/reports/ProfitAndLoss", {
      query: { start_date: "2026-01-01", end_date: "2026-06-30", accounting_method: "Accrual" },
    });
  });

  it("filters customer activity, supports historical report dates, and bounds large report results", async () => {
    const query = vi.fn(async () => ({ QueryResponse: { Invoice: [{ Id: "130" }] } }));
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/reports/AgedReceivables") {
        return {
          Header: { ReportName: "GeneralLedgerDetail" },
          Rows: { Row: Array.from({ length: 5_000 }, (_, index) => ({ ColData: [{ value: String(index) }] })) },
        };
      }
      throw new Error(`Unexpected request ${path} ${JSON.stringify(options)}`);
    });
    const client = { realmId: "934145", request, query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await provider.listTransactions({ entity: "Invoice", customerId: "9", openOnly: true });
    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM Invoice WHERE CustomerRef = '9' AND Balance > '0' ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 25",
    );

    const report = await provider.runReport({
      report: "AgedReceivables",
      asOfDate: "2026-07-31",
      customerId: "9",
      maxRows: 250,
      view: "both",
    });
    expect(request).toHaveBeenCalledWith("/reports/AgedReceivables", {
      query: { report_date: "2026-07-31", customer: "9" },
    });
    expect(report).toMatchObject({
      zcloakReportWindow: { maxRows: 250, returnedRows: 250, totalRows: 5_000, truncated: true },
    });
    expect(((report.Rows as { Row: unknown[] }).Row)).toHaveLength(250);
  });

  it("pages item master data instead of silently stopping at 1000 records", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({ Id: String(index + 1), Name: `Item ${index + 1}` }));
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("STARTPOSITION 1 ")) return { QueryResponse: { Item: firstPage } };
      if (statement.includes("STARTPOSITION 1001 ")) return { QueryResponse: { Item: [{ Id: "1001", Name: "Final item" }] } };
      throw new Error(`Unexpected query ${statement}`);
    });
    const client = { realmId: "934145", request: vi.fn(), query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.listItems()).resolves.toHaveLength(1_001);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("finds an existing QuickBooks Bill by exact vendor and normalized supplier document number", async () => {
    const query = vi.fn().mockResolvedValue({ QueryResponse: { Bill: [
      { Id: "900", VendorRef: { value: "56" }, DocNumber: "INV-001", TxnDate: "2026-08-05", TotalAmt: 100 },
      { Id: "901", VendorRef: { value: "77" }, DocNumber: "INV-001", TotalAmt: 25 },
    ] } });
    const client = { realmId: "934145", request: vi.fn(), query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.findExistingSupplierBills({ vendorId: "56", docNumber: " inv-001 " }))
      .resolves.toEqual([{ billId: "900", vendorId: "56", docNumber: "INV-001", txnDate: "2026-08-05", total: "100.00" }]);
    expect(query).toHaveBeenCalledWith("SELECT * FROM Bill WHERE DocNumber = 'inv-001' MAXRESULTS 100");
  });

  it("resolves an exact TaxRate and checks document duplicates by entity, counterparty and DocNumber", async () => {
    const request = vi.fn().mockResolvedValueOnce({ TaxRate: { Id: "904", Name: "GST 9%", RateValue: 9, Active: true } });
    const query = vi.fn();
    const client = { realmId: "934145", request, query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(provider.getTaxRate("904")).resolves.toMatchObject({ Id: "904", RateValue: 9 });
    expect(request).toHaveBeenCalledWith("/taxrate/904");

    vi.mocked(query).mockResolvedValueOnce({ QueryResponse: { Invoice: [
      { Id: "501", DocNumber: " inv-1001 ", CustomerRef: { value: "12" }, TxnDate: "2026-08-10", TotalAmt: 109 },
      { Id: "502", DocNumber: "INV-1001", CustomerRef: { value: "another" }, TotalAmt: 109 },
    ] } });
    await expect(provider.findExistingAccountingDocuments({
      entity: "Invoice", counterpartyId: "12", docNumber: "INV-1001",
    })).resolves.toEqual([{
      entity: "Invoice", providerEntityId: "501", counterpartyId: "12", docNumber: " inv-1001 ",
      txnDate: "2026-08-10", total: "109.00",
    }]);
  });

  it("continues vendor search beyond the first 1000 records and matches words in either order", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({ Id: String(index + 1), DisplayName: `Vendor ${index + 1}` }));
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("STARTPOSITION 1 ")) return { QueryResponse: { Vendor: firstPage } };
      if (statement.includes("STARTPOSITION 1001 ")) {
        return { QueryResponse: { Vendor: [{ Id: "1001", DisplayName: "Hicks Hardware" }] } };
      }
      throw new Error(`Unexpected query ${statement}`);
    });
    const client = { realmId: "934145", request: vi.fn(), query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.searchVendors("Hardware Hicks", 10)).resolves.toMatchObject({
      records: [{ Id: "1001" }],
      searchWindow: { complete: true, stoppedReason: "source_exhausted", scanned: 1_001 },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns found vendors with explicit scan-limit evidence instead of discarding partial matches", async () => {
    const pages = Array.from({ length: 10 }, (_, pageIndex) => Array.from({ length: 1_000 }, (_, index) => ({
      Id: String(pageIndex * 1_000 + index + 1),
      DisplayName: pageIndex === 1 && index === 0 ? "Needle Supplier" : `Vendor ${pageIndex}-${index}`,
    })));
    const query = vi.fn(async (statement: string) => {
      const match = /STARTPOSITION (\d+)/u.exec(statement);
      const start = Number(match?.[1] ?? 1);
      return { QueryResponse: { Vendor: pages[(start - 1) / 1_000] } };
    });
    const client = { realmId: "934145", request: vi.fn(), query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.searchVendors("Needle Supplier", 10)).resolves.toMatchObject({
      records: [{ Id: "1001" }],
      searchWindow: {
        requestedLimit: 10,
        returned: 1,
        scanned: 10_000,
        complete: false,
        stoppedReason: "scan_limit",
      },
    });
  });

  it("validates references, writes once with requestid, and returns exact verified readback", async () => {
    const { provider, request } = providerWithRequest();

    const result = await provider.createApprovedSupplierBill(
      input,
      issueQuickBooksSupplierBillProviderWriteTestPermit(input),
    );

    expect(result.bill).toMatchObject({
      billId: "145",
      realmId: "934145",
      paymentStatus: "OPEN",
      vendor: { id: "56", name: "Acme Pte Ltd" },
      txnDate: "2026-08-05",
      currencyCode: "SGD",
      total: "129.60",
      totalTax: "9.60",
      lines: [
        { amount: "100.00", account: { id: "7" }, taxCode: { id: "3" } },
        { amount: "20.00", account: { id: "8" } },
      ],
    });
    expect(result.receipt).toMatchObject({
      provider: "quickbooks-online",
      realmId: "934145",
      billId: "145",
      requestId: "zc.bill.case-001",
      verified: true,
    });
    expect(request).toHaveBeenCalledWith("/bill", expect.objectContaining({
      method: "POST",
      requestId: "zc.bill.case-001",
      isWrite: true,
    }));
    expect(request.mock.calls.at(-1)?.[0]).toBe("/bill/145");
  });

  it("executes a generic create once and verifies the exact provider Id by readback", async () => {
    const sequence: string[] = [];
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/customer" && options.method === "POST") {
        sequence.push("provider-write");
        return { Customer: { Id: "901", DisplayName: "Harbour Kitchen Pte Ltd" }, time: "2026-08-12T00:00:00Z" };
      }
      if (path === "/customer/901") {
        sequence.push("exact-readback");
        return { Customer: { Id: "901", SyncToken: "0", DisplayName: "Harbour Kitchen Pte Ltd" } };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Customer",
      operation: "CREATE",
      payload: { DisplayName: "Harbour Kitchen Pte Ltd" },
      requestId: "zc.customer.001",
    }, async ({ providerEntityId, receipt }) => {
      sequence.push("durable-provider-outcome");
      expect(providerEntityId).toBe("901");
      expect(receipt).toMatchObject({ requestId: "zc.customer.001", outcome: "PROVIDER_RESPONSE_ACCEPTED" });
    }, async () => { sequence.push("durable-dispatch-marker"); })).resolves.toMatchObject({
      providerEntityId: "901",
      receipt: { verified: true, verification: "EXACT_ID_READBACK" },
      readback: { Id: "901", DisplayName: "Harbour Kitchen Pte Ltd" },
    });
    expect(request).toHaveBeenNthCalledWith(1, "/customer", expect.objectContaining({
      method: "POST",
      isWrite: true,
      requestId: "zc.customer.001",
      body: { DisplayName: "Harbour Kitchen Pte Ltd" },
    }));
    expect(request).toHaveBeenNthCalledWith(2, "/customer/901");
    expect(sequence).toEqual([
      "durable-dispatch-marker",
      "provider-write",
      "durable-provider-outcome",
      "exact-readback",
    ]);
  });

  it("recovers a mutation with one exact-Id GET and never issues another Provider write", async () => {
    const request = vi.fn(async (path: string, options?: QuickBooksRequestOptions) => {
      expect(options?.method).not.toBe("POST");
      if (path === "/customer/901") {
        return { Customer: { Id: "901", SyncToken: "0", DisplayName: "Harbour Kitchen Pte Ltd" } };
      }
      throw new Error(`Unexpected recovery request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(provider.recoverMutation({
      entity: "Customer", operation: "CREATE", payload: { DisplayName: "Harbour Kitchen Pte Ltd" },
      requestId: "zc.customer.001",
    }, "901")).resolves.toMatchObject({
      providerEntityId: "901", receipt: { verification: "RECOVERY_EXACT_ID_READBACK", recoveryOnly: true },
      readback: { Id: "901", DisplayName: "Harbour Kitchen Pte Ltd" },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/customer/901");
  });

  it("binds update Id and SyncToken outside the Agent payload and verifies readback", async () => {
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/vendor/77" && request.mock.calls.length === 1) {
        return { Vendor: { Id: "77", SyncToken: "3", DisplayName: "Old Vendor Name", Active: true } };
      }
      if (path === "/vendor" && options.method === "POST") return { Vendor: { Id: "77" } };
      if (path === "/vendor/77") return { Vendor: { Id: "77", SyncToken: "4", DisplayName: "New Vendor Name" } };
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await executeProviderMutation(provider, {
      entity: "Vendor",
      operation: "UPDATE",
      targetId: "77",
      syncToken: "3",
      payload: { DisplayName: "New Vendor Name" },
      requestId: "zc.vendor.update.001",
    });
    expect(request).toHaveBeenNthCalledWith(2, "/vendor", expect.objectContaining({
      body: { DisplayName: "New Vendor Name", Id: "77", SyncToken: "3", Active: true },
    }));
  });

  it("rejects generic readback when an approved amount changes or an extra line appears", async () => {
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/invoice" && options.method === "POST") return { Invoice: { Id: "902" } };
      if (path === "/invoice/902") return {
        Invoice: {
          Id: "902",
          CustomerRef: { value: "12", name: "Customer" },
          TotalAmt: 150,
          Line: [{ Amount: 100 }, { Amount: 50 }],
        },
      };
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Invoice",
      operation: "CREATE",
      payload: { CustomerRef: { value: "12" }, TotalAmt: 100, Line: [{ Amount: 100 }] },
      requestId: "zc.invoice.strict.001",
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
  });

  it("rejects a tax-excluded readback whose total omits the approved tax", async () => {
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/invoice" && options.method === "POST") return { Invoice: { Id: "903" } };
      if (path === "/invoice/903") return {
        Invoice: {
          Id: "903",
          CustomerRef: { value: "12" },
          GlobalTaxCalculation: "TaxExcluded",
          TxnTaxDetail: { TotalTax: 9 },
          TotalAmt: 100,
          Line: [{ Amount: 100 }],
        },
      };
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Invoice",
      operation: "CREATE",
      payload: {
        CustomerRef: { value: "12" },
        GlobalTaxCalculation: "TaxExcluded",
        TxnTaxDetail: { TotalTax: 9 },
        Line: [{ Amount: 100 }],
      },
      requestId: "zc.invoice.tax-total.001",
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
  });

  it("treats provider delete receipt as terminal evidence without inventing readback", async () => {
    let reads = 0;
    const request = vi.fn(async (path: string) => {
      if (path === "/invoice/88") {
        reads += 1;
        if (reads === 1) return { Invoice: { Id: "88", SyncToken: "2", TotalAmt: 100 } };
        throw new AppError("NOT_FOUND", "The requested QuickBooks record was not found.", { httpStatus: 404 });
      }
      return { Invoice: { Id: "88" }, time: "2026-08-12T00:00:00Z" };
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Invoice",
      operation: "DELETE",
      targetId: "88",
      syncToken: "2",
      payload: {},
      requestId: "zc.invoice.delete.001",
    })).resolves.toMatchObject({
      providerEntityId: "88",
      receipt: { verified: true, verification: "EXACT_ID_ABSENCE_READBACK" },
      readback: { deleted: true, readbackAvailable: true, verifiedBy: "GET_NOT_FOUND" },
    });
    expect(request).toHaveBeenNthCalledWith(2, "/invoice", expect.objectContaining({
      query: { operation: "delete" },
      body: { Id: "88", SyncToken: "2" },
    }));
  });

  it("falls back from Invoice delete to void and verifies the exact zeroed Invoice", async () => {
    let invoiceReads = 0;
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/invoice/89") {
        invoiceReads += 1;
        if (invoiceReads <= 2) return { Invoice: { Id: "89", SyncToken: "2", TotalAmt: 100, Balance: 100 } };
        return { Invoice: { Id: "89", SyncToken: "3", TotalAmt: 0, Balance: 0, Line: [{ Amount: 0 }] } };
      }
      if (path === "/invoice" && options.query?.operation === "delete") {
        throw new AppError("VALIDATION_FAILED", "Invoice cannot be deleted", { httpStatus: 400 });
      }
      if (path === "/invoice" && options.query?.operation === "void") return { Invoice: { Id: "89" } };
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Invoice",
      operation: "DELETE",
      targetId: "89",
      syncToken: "2",
      payload: {},
      requestId: "zc.invoice.delete.void.001",
    })).resolves.toMatchObject({
      providerEntityId: "89",
      receipt: { verified: true, verification: "EXACT_ID_VOID_READBACK" },
      readback: { Id: "89", TotalAmt: 0, Balance: 0 },
    });
    expect(request).toHaveBeenCalledWith("/invoice", expect.objectContaining({
      query: { operation: "void" },
      body: { Id: "89", SyncToken: "2", sparse: true },
    }));
  });

  it("implements list-entity delete as reversible deactivation and verifies Active=false", async () => {
    let reads = 0;
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/customer" && options.method === "POST") return { Customer: { Id: "91" } };
      if (path === "/customer/91") {
        reads += 1;
        return reads === 1
          ? { Customer: { Id: "91", SyncToken: "7", Active: true, DisplayName: "Customer A" } }
          : { Customer: { Id: "91", SyncToken: "8", Active: false, DisplayName: "Customer A" } };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Customer",
      operation: "DELETE",
      targetId: "91",
      syncToken: "7",
      payload: {},
      requestId: "zc.customer.deactivate.001",
    })).resolves.toMatchObject({
      providerEntityId: "91",
      receipt: { verified: true, verification: "EXACT_ID_READBACK" },
      readback: { Id: "91", Active: false },
    });
    expect(request).toHaveBeenNthCalledWith(2, "/customer", expect.objectContaining({
      body: { Id: "91", SyncToken: "7", Active: false, DisplayName: "Customer A" },
    }));
  });

  it("fails before mutation when the exact SyncToken changed after preparation", async () => {
    const request = vi.fn(async () => ({ Vendor: { Id: "77", SyncToken: "4", DisplayName: "Changed elsewhere" } }));
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Vendor",
      operation: "UPDATE",
      targetId: "77",
      syncToken: "3",
      payload: { DisplayName: "Approved name" },
      requestId: "zc.vendor.update.002",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uploads approved inline attachment bytes through multipart and verifies the Attachable Id", async () => {
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/upload") {
        expect(options.multipart).toBeInstanceOf(FormData);
        expect(options.body).toBeUndefined();
        return { AttachableResponse: [{ Attachable: { Id: "501", FileName: "receipt.txt", ContentType: "text/plain" } }] };
      }
      if (path === "/attachable/501") {
        return { Attachable: { Id: "501", SyncToken: "0", FileName: "receipt.txt", ContentType: "text/plain" } };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Attachable",
      operation: "CREATE",
      payload: {
        file_name: "receipt.txt",
        content_type: "text/plain",
        base64_content: Buffer.from("approved evidence", "utf8").toString("base64"),
      },
      requestId: "zc.attachable.001",
    })).resolves.toMatchObject({
      providerEntityId: "501",
      receipt: { verified: true, verification: "EXACT_ID_READBACK" },
      readback: { Id: "501", FileName: "receipt.txt" },
    });
  });

  it("maps governed Attachable update metadata to QBO fields without forwarding upload controls", async () => {
    let updated = false;
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/attachable/501") {
        return updated
          ? { Attachable: { Id: "501", SyncToken: "1", FileName: "receipt-reviewed.pdf", ContentType: "text/plain", Note: "Reviewed source" } }
          : { Attachable: { Id: "501", SyncToken: "0", FileName: "receipt.txt", ContentType: "text/plain" } };
      }
      if (path === "/attachable") {
        expect(options.body).toMatchObject({
          Id: "501",
          SyncToken: "0",
          FileName: "receipt-reviewed.pdf",
          Note: "Reviewed source",
        });
        expect(options.body).not.toHaveProperty("file_name");
        expect(options.body).not.toHaveProperty("base64_content");
        updated = true;
        return { Attachable: { Id: "501", SyncToken: "1", FileName: "receipt-reviewed.pdf", ContentType: "text/plain", Note: "Reviewed source" } };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    await expect(executeProviderMutation(provider, {
      entity: "Attachable",
      operation: "UPDATE",
      targetId: "501",
      syncToken: "0",
      payload: { file_name: "receipt-reviewed.pdf", note: "Reviewed source" },
      requestId: "zc.attachable.update.001",
    })).resolves.toMatchObject({
      providerEntityId: "501",
      readback: { FileName: "receipt-reviewed.pdf", Note: "Reviewed source" },
    });
  });

  it("rejects a readback that lost the source-document marker", async () => {
    const { provider } = providerWithRequest(fixtureBill("Approved supplier invoice"));

    await expect(provider.createApprovedSupplierBill(
      input,
      issueQuickBooksSupplierBillProviderWriteTestPermit(input),
    )).rejects.toMatchObject({
      code: "READBACK_MISMATCH",
    });
  });

  it("rejects a readback that changed an approved header or tax field", async () => {
    const changed = fixtureBill();
    changed.CurrencyRef = { value: "USD" };
    const { provider } = providerWithRequest(changed);

    await expect(provider.createApprovedSupplierBill(
      input,
      issueQuickBooksSupplierBillProviderWriteTestPermit(input),
    )).rejects.toMatchObject({
      code: "READBACK_MISMATCH",
      message: expect.stringContaining("currency"),
    });
  });

  it("does not call QuickBooks when local bill validation fails", async () => {
    const { provider, request } = providerWithRequest();

    const invalid = { ...input, sourceSha256: "not-a-hash" };
    await expect(provider.createApprovedSupplierBill(
      invalid,
      issueQuickBooksSupplierBillProviderWriteTestPermit(invalid),
    ))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(request).not.toHaveBeenCalled();
  });
});
