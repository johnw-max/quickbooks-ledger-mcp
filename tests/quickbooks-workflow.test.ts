import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { InMemoryQuickBooksPostingRepository } from "../src/quickbooks/inMemoryRepository.js";
import { quickBooksPrepareSupplierBillSchema, quickBooksRunReportSchema } from "../src/quickbooks/schemas.js";
import type { QuickBooksProviderResolver } from "../src/quickbooks/service.js";
import { QuickBooksWorkflowService } from "../src/quickbooks/service.js";
import type { QuickBooksAccountingProvider } from "../src/providers/quickbooksProvider.js";

const TARGET_SESSION_REF = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;

const bill = {
  billId: "145",
  realmId: "934145",
  paymentStatus: "OPEN" as const,
  vendor: { id: "56", name: "Acme Pte Ltd" },
  txnDate: "2026-08-05",
  currencyCode: "SGD",
  total: "100.00",
  balance: "100.00",
  privateNote: `zCloak source=invoice.pdf; sha256=${"a".repeat(64)}`,
  lines: [{ amount: "100.00", account: { id: "7", name: "Subscriptions" } }],
};

const toolInput = quickBooksPrepareSupplierBillSchema.parse({
  target_session_ref: TARGET_SESSION_REF,
  request_id: "case-quickbooks-001",
  source_ref: "invoice.pdf",
  source_sha256: "a".repeat(64),
  vendor_id: "56",
  txn_date: "2026-08-05",
  due_date: "2026-09-04",
  doc_number: "INV-001",
  currency_code: "SGD",
  memo: "Approved supplier invoice",
  global_tax_calculation: "NotApplicable",
  invoice_total: "100.00",
  tax_total: "0.00",
  lines: [{ account_id: "7", amount: "100", description: "Subscription" }],
});

function setup(createApprovedSupplierBill = vi.fn().mockResolvedValue({
  bill,
  receipt: { provider: "quickbooks-online", billId: "145", verified: true },
})) {
  const provider = {
    getCompany: vi.fn(),
    listAccounts: vi.fn(),
    listTaxCodes: vi.fn(),
    searchVendors: vi.fn(),
    listBills: vi.fn(),
    getBill: vi.fn(),
    findExistingSupplierBills: vi.fn().mockResolvedValue([]),
    validateSupplierBill: vi.fn().mockResolvedValue({
      vendor: { id: "56", name: "Acme Pte Ltd", currencyCode: "SGD" },
      accounts: [{ id: "7", name: "Subscriptions" }],
      taxCodes: [],
    }),
    createApprovedSupplierBill,
    getTrialBalance: vi.fn(),
  } as unknown as QuickBooksAccountingProvider;
  const resolver: QuickBooksProviderResolver = {
    connectionStatus: vi.fn().mockResolvedValue({
      connected: true,
      company: { realmId: "934145", name: "Sandbox Company" },
      scopes: ["com.intuit.quickbooks.accounting"],
    }),
    resolve: vi.fn().mockResolvedValue({
      realmId: "934145",
      companyName: "Sandbox Company",
      connectionRefSafe: `quickbooks-connection:${"a".repeat(32)}`,
      boundTargetRefSafe: `quickbooks-target:${"b".repeat(32)}`,
      bindingRevision: `quickbooks-binding-revision:${"c".repeat(32)}`,
      provider,
    }),
  };
  const repository = new InMemoryQuickBooksPostingRepository();
  const service = new QuickBooksWorkflowService({
    repository,
    resolver,
    publicBaseUrl: "https://agent2.zcloak.ai/",
    writeEnabled: true,
    allowedRealmId: "934145",
  });
  return { service, repository, resolver, createApprovedSupplierBill };
}

describe("QuickBooks controlled workflow", () => {
  it("computes the real UTF-8 source digest without retaining content", () => {
    const { service } = setup();

    expect(service.hashSourceDocument({ source_ref: "invoice.txt", content: "abc" })).toEqual({
      sourceRef: "invoice.txt",
      algorithm: "sha256",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      utf8ByteLength: 3,
      evidenceType: "AGENT_SUPPLIED_TEXT_FINGERPRINT",
      originalFileVerified: false,
      storedByQuickBooksMcp: false,
    });
  });

  it("rejects ambiguous report windows and mixed customer/vendor filters", () => {
    expect(quickBooksRunReportSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      report: "AgedReceivables",
      start_date: "2026-08-01",
      end_date: "2026-08-31",
      as_of_date: "2026-08-31",
    }).success).toBe(false);
    expect(quickBooksRunReportSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      report: "CustomerBalance",
      customer_id: "9",
      vendor_id: "56",
    }).success).toBe(false);
    expect(quickBooksRunReportSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      report: "AgedReceivables",
      as_of_date: "2026-08-31",
      customer_id: "9",
    }).success).toBe(true);
  });

  it("rejects NON as a record TaxCode Id and accepts no-tax bills as NotApplicable without a line TaxCode Id", () => {
    const base = {
      target_session_ref: TARGET_SESSION_REF,
      request_id: "case-quickbooks-tax-001",
      source_ref: "invoice.pdf",
      source_sha256: "a".repeat(64),
      vendor_id: "56",
      txn_date: "2026-08-05",
      global_tax_calculation: "NotApplicable",
      invoice_total: "100.00",
      tax_total: "0.00",
      doc_number: "INV-TAX-001",
    };

    expect(quickBooksPrepareSupplierBillSchema.safeParse({
      ...base,
      lines: [{ account_id: "7", amount: "100.00", tax_code_id: "NON" }],
    }).success).toBe(false);
    expect(quickBooksPrepareSupplierBillSchema.safeParse({
      ...base,
      lines: [{ account_id: "7", amount: "100.00" }],
    }).success).toBe(true);
  });

  it("requires totals to reconcile before a bill can enter review", () => {
    expect(quickBooksPrepareSupplierBillSchema.safeParse({
      ...toolInput,
      invoice_total: "101.00",
    }).success).toBe(false);
  });

  it("preflights vendor, account, and tax references before creating a review request", async () => {
    const { service, repository, resolver } = setup();
    const resolved = await resolver.resolve("actor-a");
    vi.mocked(resolved.provider.validateSupplierBill).mockRejectedValueOnce(
      new AppError("VALIDATION_FAILED", "Selected QuickBooks vendor is missing or inactive."),
    );

    await expect(service.prepareSupplierBill("actor-a", toolInput)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(repository.findActiveDuplicate({
      actorId: "actor-a",
      realmId: "934145",
      sourceSha256: "a".repeat(64),
      vendorId: "56",
      docNumber: "INV-001",
    })).resolves.toBeUndefined();
  });

  it("blocks a supplier document already recorded as a QuickBooks Bill", async () => {
    const { service, resolver } = setup();
    const resolved = await resolver.resolve("actor-a");
    vi.mocked(resolved.provider.findExistingSupplierBills).mockResolvedValueOnce([{
      billId: "900",
      vendorId: "56",
      docNumber: "INV-001",
      txnDate: "2026-08-05",
      total: "100.00",
      balance: "100.00",
    }]);

    await expect(service.prepareSupplierBill("actor-a", toolInput)).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        duplicateSource: "quickbooks",
        existingBills: [expect.objectContaining({ billId: "900", docNumber: "INV-001" })],
      },
    });
    expect(resolved.provider.validateSupplierBill).not.toHaveBeenCalled();
  });

  it("prepares locally without writing to QuickBooks, then human approval posts and exact replay is local", async () => {
    const { service, repository, createApprovedSupplierBill } = setup();

    const prepared = await service.prepareSupplierBill("actor-a", toolInput);

    expect(prepared).toMatchObject({
      state: "PREPARED",
      companyName: "Sandbox Company",
      connectionRefSafe: `quickbooks-connection:${"a".repeat(32)}`,
      boundTargetRefSafe: `quickbooks-target:${"b".repeat(32)}`,
      bindingRevision: `quickbooks-binding-revision:${"c".repeat(32)}`,
      reviewUrl: expect.stringMatching(/^https:\/\/agent2\.zcloak\.ai\/quickbooks\/review\/qbp_/),
      idempotentReplay: false,
      payload: { clientRequestId: "case-quickbooks-001", lines: [{ amount: "100.00" }] },
    });
    expect(prepared).not.toHaveProperty("realmId");
    expect(createApprovedSupplierBill).not.toHaveBeenCalled();
    const stored = await repository.get(prepared.postingRequestId);
    expect(stored?.providerRequestId).toMatch(/^zc\.[a-f0-9]{47}$/);
    expect(stored?.providerRequestId).toHaveLength(50);

    const posted = await service.approveAndPost({
      actorId: "actor-a",
      postingRequestId: prepared.postingRequestId,
      approvedPayloadHash: prepared.approvedPayloadHash,
      approvedBy: "reviewer@zcloak.network",
    });

    expect(posted).toMatchObject({
      state: "POSTED_READBACK_VERIFIED",
      bill: { billId: "145" },
      receipt: { verified: true },
      idempotentReplay: false,
    });
    expect(createApprovedSupplierBill).toHaveBeenCalledOnce();
    expect(createApprovedSupplierBill).toHaveBeenCalledWith(expect.objectContaining({
      requestId: stored?.providerRequestId,
      sourceSha256: "a".repeat(64),
      lines: [{ accountId: "7", amount: "100.00", description: "Subscription" }],
    }));

    const replay = await service.approveAndPost({
      actorId: "actor-a",
      postingRequestId: prepared.postingRequestId,
      approvedPayloadHash: prepared.approvedPayloadHash,
      approvedBy: "reviewer@zcloak.network",
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(createApprovedSupplierBill).toHaveBeenCalledOnce();
  });

  it("retries an unknown write only with the same provider request id", async () => {
    const createApprovedSupplierBill = vi.fn()
      .mockRejectedValueOnce(new AppError(
        "WRITE_RESULT_UNKNOWN",
        "unknown",
        { retryable: true, details: { requestId: "hidden" } },
      ))
      .mockResolvedValueOnce({
        bill,
        receipt: { provider: "quickbooks-online", billId: "145", verified: true },
      });
    const { service, repository } = setup(createApprovedSupplierBill);
    const prepared = await service.prepareSupplierBill("actor-a", toolInput);
    const stored = await repository.get(prepared.postingRequestId);

    await expect(service.approveAndPost({
      actorId: "actor-a",
      postingRequestId: prepared.postingRequestId,
      approvedPayloadHash: prepared.approvedPayloadHash,
      approvedBy: "reviewer@zcloak.network",
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    await expect(repository.get(prepared.postingRequestId)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN",
    });

    const recovered = await service.approveAndPost({
      actorId: "actor-a",
      postingRequestId: prepared.postingRequestId,
      approvedPayloadHash: prepared.approvedPayloadHash,
      approvedBy: "reviewer@zcloak.network",
    });

    expect(recovered.state).toBe("POSTED_READBACK_VERIFIED");
    expect(createApprovedSupplierBill).toHaveBeenCalledTimes(2);
    expect(createApprovedSupplierBill.mock.calls[0]?.[0].requestId).toBe(stored?.providerRequestId);
    expect(createApprovedSupplierBill.mock.calls[1]?.[0].requestId).toBe(stored?.providerRequestId);
  });

  it("rejects reuse of the same client request id with a changed payload", async () => {
    const { service } = setup();
    await service.prepareSupplierBill("actor-a", toolInput);

    await expect(service.prepareSupplierBill("actor-a", {
      ...toolInput,
      lines: [{ ...toolInput.lines[0], amount: "101.00" }],
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("blocks the same source document under a different request id", async () => {
    const { service } = setup();
    await service.prepareSupplierBill("actor-a", toolInput);

    await expect(service.prepareSupplierBill("actor-a", {
      ...toolInput,
      request_id: "case-quickbooks-002",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("blocks the same company document across different OAuth actors", async () => {
    const { service } = setup();
    await service.prepareSupplierBill("actor-a", toolInput);

    await expect(service.prepareSupplierBill("actor-b", {
      ...toolInput,
      request_id: "case-quickbooks-actor-b",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { duplicateSource: "local-company" },
    });
  });

  it("rechecks QuickBooks immediately before first approval and blocks a newly created Bill", async () => {
    const { service, repository, resolver, createApprovedSupplierBill } = setup();
    const prepared = await service.prepareSupplierBill("actor-a", toolInput);
    const resolved = await resolver.resolve("actor-a");
    vi.mocked(resolved.provider.findExistingSupplierBills).mockResolvedValueOnce([{
      billId: "901",
      vendorId: "56",
      docNumber: "INV-001",
      txnDate: "2026-08-05",
      total: "100.00",
    }]);

    await expect(service.approveAndPost({
      actorId: "actor-a",
      postingRequestId: prepared.postingRequestId,
      approvedPayloadHash: prepared.approvedPayloadHash,
      approvedBy: "reviewer@zcloak.network",
    })).rejects.toMatchObject({ code: "CONFLICT", details: { duplicateSource: "quickbooks" } });
    await expect(repository.get(prepared.postingRequestId)).resolves.toMatchObject({ state: "BLOCKED_VALIDATION" });
    expect(createApprovedSupplierBill).not.toHaveBeenCalled();
  });

  it("invalidates a prepared Bill when the OAuth binding revision changes before approval", async () => {
    const { service, resolver, createApprovedSupplierBill } = setup();
    const prepared = await service.prepareSupplierBill("actor-a", toolInput);
    const current = await resolver.resolve("actor-a");
    vi.mocked(resolver.resolve).mockResolvedValueOnce({
      ...current,
      bindingRevision: `quickbooks-binding-revision:${"d".repeat(32)}`,
    });

    await expect(service.approveAndPost({
      actorId: "actor-a",
      postingRequestId: prepared.postingRequestId,
      approvedPayloadHash: prepared.approvedPayloadHash,
      approvedBy: "reviewer@zcloak.network",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(createApprovedSupplierBill).not.toHaveBeenCalled();
  });

  it("keeps a rejected request out of QuickBooks", async () => {
    const { service, createApprovedSupplierBill } = setup();
    const prepared = await service.prepareSupplierBill("actor-a", toolInput);

    const rejected = await service.reject({
      actorId: "actor-a",
      postingRequestId: prepared.postingRequestId,
      rejectedBy: "reviewer@zcloak.network",
    });

    expect(rejected.state).toBe("REJECTED");
    expect(createApprovedSupplierBill).not.toHaveBeenCalled();
  });

  it("keeps the deployment write gate and exact-realm gate closed by default", async () => {
    const { repository, resolver, createApprovedSupplierBill } = setup();
    const closedService = new QuickBooksWorkflowService({
      repository,
      resolver,
      publicBaseUrl: "https://agent2.zcloak.ai",
    });
    const prepared = await closedService.prepareSupplierBill("actor-a", toolInput);

    await expect(closedService.approveAndPost({
      actorId: "actor-a",
      postingRequestId: prepared.postingRequestId,
      approvedPayloadHash: prepared.approvedPayloadHash,
      approvedBy: "reviewer@zcloak.network",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(repository.get(prepared.postingRequestId)).resolves.toMatchObject({ state: "PREPARED" });
    expect(createApprovedSupplierBill).not.toHaveBeenCalled();
  });
});
