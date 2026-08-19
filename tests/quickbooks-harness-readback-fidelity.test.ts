// Why this file exists (do not delete as "redundant with quickbooks-provider.test.ts"):
//
// Real QuickBooks Online, on read-back of a total-bearing transaction
// (Invoice, Bill, CreditMemo, VendorCredit), returns a derived,
// non-economic SubTotalLineDetail line that was never submitted, and never
// represents DueDate on CreditMemo/VendorCredit at all.
// src/providers/quickbooksProvider.ts's mutationReadbackMatches() exists
// specifically to tolerate those two presentation artifacts, written against
// defects found in real UAT.
//
// tests/quickbooks-provider.test.ts already exercises that tolerance, but
// with HAND-WRITTEN mock HTTP responses shaped to look like real QBO. That
// proves the tolerance is correct; it cannot prove the LOCAL harness ever
// produces a shape the tolerance would need. harness/lib/syntheticQuickBooksProvider.ts
// is a structurally separate implementation of the same provider interface
// and never calls mutationReadbackMatches() itself -- so if the synthetic
// double's read-back shape ever drifts back to "exactly what was submitted"
// (the shape real QuickBooks does not return), every local acceptance run
// goes green while the production tolerance path sits untested. That is
// exactly the failure class this whole test guards against: a double
// quietly diverging from the real API's shape, hiding a defect indefinitely.
//
// This file closes that gap by feeding the ACTUAL output of
// SyntheticQuickBooksProvider back into the real QuickBooksAccountingProvider
// (via a mocked HTTP client) and letting the real, unexported
// mutationReadbackMatches() judge it. It is a drift detector, not another
// hand-written fixture: if the synthetic provider ever stops emitting the
// derived SubTotalLineDetail line, or starts echoing DueDate on
// CreditMemo/VendorCredit again, the positive cases here fail. The negative
// control (corrupted SubTotalLineDetail amount) exists so this file cannot
// go vacuously green if the real tolerance is ever loosened -- without it, a
// bug that made every comparison trivially pass would look identical to a
// bug-free run.
import { describe, expect, it, vi } from "vitest";
import type { QuickBooksApiClient } from "../src/providers/quickbooksClient.js";
import { QuickBooksAccountingProvider } from "../src/providers/quickbooksProvider.js";
import { SyntheticQuickBooksProvider, SYNTHETIC_QUICKBOOKS_REALM_ID } from "../harness/lib/syntheticQuickBooksProvider.js";
import type { QuickBooksProviderMutationCommand } from "../src/security/quickBooksProviderWritePermit.js";
import { issueQuickBooksProviderWriteTestPermit } from "./helpers/quickBooksProviderWritePermit.js";

const entityPath: Record<string, string> = {
  Invoice: "invoice", Bill: "bill", CreditMemo: "creditmemo", VendorCredit: "vendorcredit",
};

/** Feeds the synthetic provider's real output into the real provider's recoverMutation. */
async function proveRealToleranceAccepts(command: QuickBooksProviderMutationCommand) {
  const synthetic = new SyntheticQuickBooksProvider();
  const { providerEntityId, readback } = await synthetic.executeMutation(
    command,
    issueQuickBooksProviderWriteTestPermit(command, SYNTHETIC_QUICKBOOKS_REALM_ID),
    async () => undefined,
    async () => undefined,
  );
  const path = `/${entityPath[command.entity]}/${providerEntityId}`;
  const request = vi.fn(async (requestPath: string) => {
    if (requestPath === path) return { [command.entity]: readback };
    throw new Error(`Unexpected request ${requestPath}`);
  });
  const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
  const real = new QuickBooksAccountingProvider(client);
  const result = await real.recoverMutation(command, providerEntityId);
  return { syntheticReadback: readback, realResult: result };
}

describe("synthetic provider read-back fidelity vs. real mutationReadbackMatches tolerance (drift detector)", () => {
  it("CreditMemo: synthetic readback drops submitted DueDate and adds SubTotalLineDetail; real tolerance accepts it", async () => {
    const command: QuickBooksProviderMutationCommand = {
      entity: "CreditMemo",
      operation: "CREATE",
      payload: {
        CustomerRef: { value: "91" },
        TxnDate: "2026-08-19",
        DueDate: "2026-09-18",
        DocNumber: "FIDELITY-CM-001",
        GlobalTaxCalculation: "NotApplicable",
        Line: [{ Amount: 400, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "1" } } }],
      },
      requestId: "fidelity-creditmemo-001",
    };
    const { syntheticReadback, realResult } = await proveRealToleranceAccepts(command);
    expect(syntheticReadback.DueDate).toBeUndefined();
    expect(syntheticReadback.Line).toContainEqual({ Amount: 400, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} });
    expect(realResult.receipt).toMatchObject({ verification: "RECOVERY_EXACT_ID_READBACK" });
  });

  it("VendorCredit: same two artifacts, real tolerance accepts it", async () => {
    const command: QuickBooksProviderMutationCommand = {
      entity: "VendorCredit",
      operation: "CREATE",
      payload: {
        VendorRef: { value: "56" },
        TxnDate: "2026-08-19",
        DueDate: "2026-09-18",
        DocNumber: "FIDELITY-VC-001",
        GlobalTaxCalculation: "NotApplicable",
        Line: [{ Amount: 250, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }],
      },
      requestId: "fidelity-vendorcredit-001",
    };
    const { syntheticReadback, realResult } = await proveRealToleranceAccepts(command);
    expect(syntheticReadback.DueDate).toBeUndefined();
    expect(syntheticReadback.Line).toContainEqual({ Amount: 250, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} });
    expect(realResult.receipt).toMatchObject({ verification: "RECOVERY_EXACT_ID_READBACK" });
  });

  it("Bill: DueDate is a real field and must survive, SubTotalLineDetail still appended; real tolerance accepts it", async () => {
    const command: QuickBooksProviderMutationCommand = {
      entity: "Bill",
      operation: "CREATE",
      payload: {
        VendorRef: { value: "56" },
        TxnDate: "2026-08-19",
        DueDate: "2026-09-18",
        DocNumber: "FIDELITY-BILL-001",
        Line: [{ Amount: 300, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }],
      },
      requestId: "fidelity-bill-001",
    };
    const { syntheticReadback, realResult } = await proveRealToleranceAccepts(command);
    expect(syntheticReadback.DueDate).toBe("2026-09-18");
    expect(syntheticReadback.Line).toContainEqual({ Amount: 300, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} });
    expect(realResult.receipt).toMatchObject({ verification: "RECOVERY_EXACT_ID_READBACK" });
  });

  it("Invoice: SubTotalLineDetail appended across two economic lines; real tolerance accepts it", async () => {
    const command: QuickBooksProviderMutationCommand = {
      entity: "Invoice",
      operation: "CREATE",
      payload: {
        CustomerRef: { value: "91" },
        TxnDate: "2026-08-19",
        DocNumber: "FIDELITY-INV-001",
        GlobalTaxCalculation: "NotApplicable",
        Line: [
          { Amount: 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "1" } } },
          { Amount: 50, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "2" } } },
        ],
      },
      requestId: "fidelity-invoice-001",
    };
    const { syntheticReadback, realResult } = await proveRealToleranceAccepts(command);
    expect(syntheticReadback.Line).toContainEqual({ Amount: 150, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} });
    expect(realResult.receipt).toMatchObject({ verification: "RECOVERY_EXACT_ID_READBACK" });
  });

  it("negative control: a wrong SubTotalLineDetail amount is still rejected (the check can actually fail)", async () => {
    const command: QuickBooksProviderMutationCommand = {
      entity: "Invoice",
      operation: "CREATE",
      payload: {
        CustomerRef: { value: "91" },
        TxnDate: "2026-08-19",
        DocNumber: "FIDELITY-INV-NEG-001",
        GlobalTaxCalculation: "NotApplicable",
        Line: [{ Amount: 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "1" } } }],
      },
      requestId: "fidelity-invoice-negative-001",
    };
    const synthetic = new SyntheticQuickBooksProvider();
    const { providerEntityId, readback } = await synthetic.executeMutation(
      command,
      issueQuickBooksProviderWriteTestPermit(command, SYNTHETIC_QUICKBOOKS_REALM_ID),
      async () => undefined,
      async () => undefined,
    );
    const corrupted = structuredClone(readback);
    const lines = corrupted.Line as Array<Record<string, unknown>>;
    const subtotal = lines.find((line) => line.DetailType === "SubTotalLineDetail");
    if (!subtotal) throw new Error("test setup expected a derived SubTotalLineDetail line");
    subtotal.Amount = 999;
    const path = `/invoice/${providerEntityId}`;
    const request = vi.fn(async (requestPath: string) => {
      if (requestPath === path) return { Invoice: corrupted };
      throw new Error(`Unexpected request ${requestPath}`);
    });
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const real = new QuickBooksAccountingProvider(client);
    await expect(real.recoverMutation(command, providerEntityId)).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
  });
});
