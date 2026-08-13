import { describe, expect, it } from "vitest";
import {
  QUICKBOOKS_WRITE_CAPABILITIES,
  quickBooksWriteCapability,
  quickBooksWriteCapabilitySummary,
} from "../src/quickbooks/writePolicy.js";
import { quickBooksPrepareMutationSchema } from "../src/quickbooks/schemas.js";

const TARGET_SESSION_REF = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;

describe("QuickBooks official write coverage and zCloak policy", () => {
  it("tracks the complete current official MCP write surface", () => {
    const summary = quickBooksWriteCapabilitySummary();
    expect(summary.sourceCoverage).toEqual({ total: 71, create: 25, update: 26, delete: 20 });
    expect(QUICKBOOKS_WRITE_CAPABILITIES).toHaveLength(71);
    expect(new Set(QUICKBOOKS_WRITE_CAPABILITIES.map((capability) =>
      `${capability.operation}:${capability.entity}`)).size).toBe(71);
    expect(quickBooksWriteCapability("CREATE", "Bill")?.officialTool).toBe("create-bill");
    expect(quickBooksWriteCapability("UPDATE", "Vendor")?.officialTool).toBe("update-vendor");
    expect(quickBooksWriteCapability("CREATE", "Invoice")?.officialTool).toBe("create_invoice");
  });

  it("does not pretend QuickBooks has a universal draft state", () => {
    expect(quickBooksWriteCapabilitySummary().importantSemantics).toMatchObject({
      quickBooksHasUniversalDraftState: false,
      preparedIsLocalReviewDraft: true,
      providerWriteSuccessRequiresExactReadback: true,
      deletionMayBePermanent: true,
    });
    expect(quickBooksWriteCapability("CREATE", "Estimate")).toMatchObject({
      providerEffect: "NON_POSTING",
      quickBooksDraftAvailable: true,
      executionMode: "EXPLICIT_CONFIRMATION",
    });
    expect(quickBooksWriteCapability("CREATE", "Bill")).toMatchObject({
      providerEffect: "POSTING_TRANSACTION",
      quickBooksDraftAvailable: false,
      executionMode: "HUMAN_REVIEW",
    });
  });

  it("keeps cash, journals, company settings and deletion out of Agent execution", () => {
    for (const [operation, entity] of [
      ["CREATE", "Payment"],
      ["CREATE", "BillPayment"],
      ["CREATE", "JournalEntry"],
      ["UPDATE", "CompanyInfo"],
      ["DELETE", "Invoice"],
    ] as const) {
      expect(quickBooksWriteCapability(operation, entity)).toMatchObject({
        risk: "CRITICAL",
        executionMode: "RESTRICTED_HUMAN_REVIEW",
        agentMayExecute: false,
        enabledByDefault: false,
      });
    }
  });

  it("permits only bounded low-risk creates through exact Agent confirmation", () => {
    for (const entity of ["Customer", "Vendor", "Class", "Department", "Term", "PaymentMethod"] as const) {
      expect(quickBooksWriteCapability("CREATE", entity)).toMatchObject({
        risk: "LOW",
        executionMode: "EXPLICIT_CONFIRMATION",
        agentMayExecute: true,
        enabledByDefault: true,
      });
    }
  });

  it("requires exact Id and SyncToken for update/delete and rejects tenant override fields", () => {
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.vendor.update.001",
      entity: "Vendor",
      operation: "UPDATE",
      payload: { DisplayName: "Updated" },
      business_reason: "Correct the accepted vendor display name.",
    }).success).toBe(false);
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.customer.create.001",
      entity: "Customer",
      operation: "CREATE",
      payload: { DisplayName: "Harbour Kitchen", realmId: "999" },
      business_reason: "Create an accepted engagement customer.",
    }).success).toBe(false);
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.vendor.update.002",
      entity: "Vendor",
      operation: "UPDATE",
      target_id: "77",
      sync_token: "3",
      payload: { DisplayName: "Updated" },
      business_reason: "Correct the accepted vendor display name.",
    }).success).toBe(true);
  });

  it("rejects unknown nested provider fields before a proposal is persisted", () => {
    const baseInvoice = {
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.invoice.create.001",
      entity: "Invoice" as const,
      operation: "CREATE" as const,
      business_reason: "Create the reviewed customer invoice.",
    };

    expect(quickBooksPrepareMutationSchema.safeParse({
      ...baseInvoice,
      payload: {
        CustomerRef: { value: "12", BogusNestedField: "must be rejected" },
        Line: [{
          Amount: 100,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: 1, UnitPrice: 100 },
        }],
      },
    }).success).toBe(false);

    expect(quickBooksPrepareMutationSchema.safeParse({
      ...baseInvoice,
      request_id: "qbo.invoice.create.002",
      payload: {
        CustomerRef: { value: "12" },
        Line: [{
          Amount: 100,
          BogusLineField: "must be rejected",
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: 1, UnitPrice: 100 },
        }],
      },
    }).success).toBe(false);
  });

  it("accepts a governed nested Invoice payload", () => {
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.invoice.create.003",
      entity: "Invoice",
      operation: "CREATE",
      payload: {
        CustomerRef: { value: "12" },
        Line: [{
          Amount: 100,
          Description: "Reviewed bookkeeping service",
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            ItemRef: { value: "5" },
            Qty: 1,
            UnitPrice: 100,
            TaxCodeRef: { value: "NON" },
          },
        }],
      },
      business_reason: "Create the reviewed customer invoice.",
    }).success).toBe(true);
  });

  it("enforces object, array and scalar types in nested Invoice fields", () => {
    const baseInvoice = {
      target_session_ref: TARGET_SESSION_REF,
      entity: "Invoice" as const,
      operation: "CREATE" as const,
      business_reason: "Create the reviewed customer invoice.",
    };
    const validLine = {
      Amount: 100,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: 1, UnitPrice: 100 },
    };

    expect(quickBooksPrepareMutationSchema.safeParse({
      ...baseInvoice,
      request_id: "qbo.invoice.typed.001",
      payload: { CustomerRef: "12", Line: [validLine] },
    }).success).toBe(false);
    expect(quickBooksPrepareMutationSchema.safeParse({
      ...baseInvoice,
      request_id: "qbo.invoice.typed.002",
      payload: { CustomerRef: { value: "12" }, Line: ["not-a-line-object"] },
    }).success).toBe(false);
    expect(quickBooksPrepareMutationSchema.safeParse({
      ...baseInvoice,
      request_id: "qbo.invoice.typed.003",
      payload: { CustomerRef: { value: "12" }, Line: [{ ...validLine, Amount: "one hundred" }] },
    }).success).toBe(false);
  });

  it("accepts the current official create_invoice CustomerMemo shape", () => {
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.invoice.memo.001",
      entity: "Invoice",
      operation: "CREATE",
      payload: {
        CustomerRef: { value: "12" },
        CustomerMemo: { value: "Thank you" },
        Line: [{
          Id: "1",
          LineNum: 1,
          Amount: 100,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: 1, UnitPrice: 100 },
        }],
      },
      business_reason: "Create the reviewed customer invoice.",
    }).success).toBe(true);
  });

  it("rejects empty and conflicting Invoice detail structures", () => {
    const baseInvoice = {
      target_session_ref: TARGET_SESSION_REF,
      entity: "Invoice" as const,
      operation: "CREATE" as const,
      business_reason: "Create the reviewed customer invoice.",
    };
    const invalidPayloads = [
      { CustomerRef: { value: "12" }, Line: [] },
      { CustomerRef: { value: "" }, Line: [{ Amount: 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: 1, UnitPrice: 100 } }] },
      { CustomerRef: { value: "12" }, Line: [{ Amount: 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }] },
      { CustomerRef: { value: "12" }, Line: [{ Amount: 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: 1, UnitPrice: 100 }, AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }] },
      { CustomerRef: { value: "12" }, Line: [{ Amount: 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: -1, UnitPrice: -10 } }] },
    ];
    invalidPayloads.forEach((payload, index) => {
      expect(quickBooksPrepareMutationSchema.safeParse({
        ...baseInvoice,
        request_id: `qbo.invoice.structure.00${index + 1}`,
        payload,
      }).success).toBe(false);
    });
  });

  it("keeps Attachable update metadata-only", () => {
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.attachable.update.001",
      entity: "Attachable",
      operation: "UPDATE",
      target_id: "501",
      sync_token: "0",
      payload: { file_name: "receipt-reviewed.pdf", note: "Reviewed source" },
      business_reason: "Correct reviewed attachment metadata.",
    }).success).toBe(true);
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.attachable.update.002",
      entity: "Attachable",
      operation: "UPDATE",
      target_id: "501",
      sync_token: "0",
      payload: { base64_content: "YQ==" },
      business_reason: "Attempt to replace attachment bytes.",
    }).success).toBe(false);
  });

  it("permits governed update clearing without allowing empty create values", () => {
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.invoice.clear-note.001",
      entity: "Invoice",
      operation: "UPDATE",
      target_id: "81",
      sync_token: "2",
      payload: { PrivateNote: "" },
      business_reason: "Remove the obsolete private note.",
    }).success).toBe(true);
    expect(quickBooksPrepareMutationSchema.safeParse({
      target_session_ref: TARGET_SESSION_REF,
      request_id: "qbo.customer.empty-name.001",
      entity: "Customer",
      operation: "CREATE",
      payload: { DisplayName: "" },
      business_reason: "Attempt an invalid empty customer name.",
    }).success).toBe(false);
  });
});
