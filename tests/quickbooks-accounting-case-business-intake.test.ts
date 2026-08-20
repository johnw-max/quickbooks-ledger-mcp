import { describe, expect, it } from "vitest";
import type { QuickBooksAccountingFact, QuickBooksSourceArtifact } from "../src/quickbooks/accountingCase.js";
import {
  normalizeQuickBooksAccountingCaseBusinessIntake,
  quickBooksAccountingCaseBusinessIntakeSchema,
} from "../src/quickbooks/accountingCaseBusinessIntake.js";
import { compileQuickBooksAccountingCase } from "../src/quickbooks/accountingCaseCompiler.js";

const targetSessionRef = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;

const residualIntake = {
  target_session_ref: targetSessionRef,
  case_id: "case-business-residual-001",
  expected_version: 0,
  source_set_complete: true as const,
  sources: [{
    source_key: "bank-statement-2026-07",
    label: "July bank statement",
    units: [{
      unit_key: "customer-receipt-2026-07-25",
      facts: [{
        kind: "UNSUPPORTED_EVENT" as const,
        event_type: "PAYMENT" as const,
        date: "2026-07-25",
        currency: "SGD",
        amount: "25.00",
        note: "Customer settlement remains explicit because cash movement is out of scope in this release.",
      }, {
        kind: "EVIDENCE" as const,
        evidence_role: "SOURCE_DOCUMENT" as const,
        note: "The supplied bank statement supports the blocked settlement event.",
      }],
    }],
  }],
};

describe("QuickBooks Accounting Case business intake", () => {
  it("derives the strict internal Case and preserves a zero-operation residual", () => {
    const normalized = normalizeQuickBooksAccountingCaseBusinessIntake(residualIntake);
    expect(normalized.sources).toHaveLength(1);
    expect(normalized.facts).toHaveLength(2);
    expect(normalized.facts[0]).toMatchObject({
      kind: "UNSUPPORTED_EVENT",
      origin: "MODEL_EXTRACTED",
      revision: 1,
    });
    expect(normalized.facts[0]?.sourceUnitIds).toEqual(normalized.facts[1]?.sourceUnitIds);

    const compiled = compileQuickBooksAccountingCase({
      caseId: normalized.case_id,
      expectedVersion: normalized.expected_version,
      sources: normalized.sources as QuickBooksSourceArtifact[],
      facts: normalized.facts as QuickBooksAccountingFact[],
    });
    expect(compiled).toMatchObject({
      status: "PLANNED_WITH_EXCEPTIONS",
      coverage: { missingFactRequirements: [] },
      events: [{ disposition: "BLOCKED_UNSUPPORTED", unsupportedEventType: "PAYMENT" }],
      operationCandidates: [],
    });
  });

  it("derives identical internal ids for an identical retry", () => {
    const first = normalizeQuickBooksAccountingCaseBusinessIntake(residualIntake);
    const replay = normalizeQuickBooksAccountingCaseBusinessIntake(structuredClone(residualIntake));
    expect(replay.sources).toEqual(first.sources);
    expect(replay.facts).toEqual(first.facts);
  });

  it("keeps the source tax amount distinct from the QuickBooks tax-code name", () => {
    const normalized = normalizeQuickBooksAccountingCaseBusinessIntake({
      target_session_ref: targetSessionRef,
      case_id: "case-business-invoice-001",
      expected_version: 0,
      source_set_complete: true,
      sources: [{
        source_key: "INV-2026-0702",
        label: "Sales tax invoice",
        units: [{
          unit_key: "invoice-main",
          facts: [{
            kind: "DOCUMENT",
            document_type: "INVOICE",
            counterparty_name: "Lion City Digital Pte. Ltd.",
            document_date: "2026-07-02",
            document_number: "INV-2026-0702",
            currency: "SGD",
            tax_mode: "TAX_EXCLUDED",
            lines: [{
              description: "Consulting services",
              quantity: "20",
              unit_amount: "200.00",
              source_tax_amount: "360.00",
              coding_type: "ITEM",
              coding_name: "Consulting",
              tax_code_name: "GST 9%",
            }],
            declared_net: "4000.00",
            declared_tax: "360.00",
            declared_gross: "4360.00",
            business_reason: "Record the approved July consulting invoice.",
          }],
        }],
      }],
    });
    expect(normalized.facts[0]).toMatchObject({
      kind: "NATIVE_DOCUMENT",
      lines: [{ sourceTax: "360.00", taxCodeName: "GST 9%" }],
    });
  });

  it("refuses the four document rules at the Agent-facing boundary", () => {
    // Each of these used to pass the Agent-facing schema and fail only on the
    // internal re-parse inside the handler, where it surfaced as a retryable
    // provider outage against internal camelCase field names.
    const document = {
      kind: "DOCUMENT" as const,
      document_type: "INVOICE" as const,
      counterparty_name: "Lion City Digital Pte. Ltd.",
      document_date: "2026-07-02",
      currency: "SGD",
      tax_mode: "TAX_EXCLUDED" as const,
      lines: [{
        description: "Consulting services",
        quantity: "20",
        unit_amount: "200.00",
        source_tax_amount: "360.00",
        coding_type: "ITEM" as const,
        coding_name: "Consulting",
        tax_code_name: "GST 9%",
      }],
      declared_net: "4000.00",
      declared_tax: "360.00",
      declared_gross: "4360.00",
      business_reason: "Record the approved July consulting invoice.",
    };
    const intake = (overrides: Record<string, unknown>) => ({
      target_session_ref: targetSessionRef,
      case_id: "case-business-document-rules",
      expected_version: 0,
      source_set_complete: true as const,
      sources: [{
        source_key: "INV-2026-0702",
        label: "Sales tax invoice",
        units: [{ unit_key: "invoice-main", facts: [{ ...document, ...overrides }] }],
      }],
    });

    const violations: Array<[string, Record<string, unknown>, string[]]> = [
      ["due date before document date", { due_date: "2026-07-01" }, ["due_date"]],
      [
        "sales document coded to an account",
        { lines: [{ ...document.lines[0]!, coding_type: "ACCOUNT" }] },
        ["lines", "0", "coding_type"],
      ],
      [
        "NO_TAX line carrying a tax code",
        { tax_mode: "NO_TAX", lines: [{ ...document.lines[0]!, source_tax_amount: "0.00" }] },
        ["lines", "0", "tax_code_name"],
      ],
      [
        "taxable line missing its tax code",
        {
          lines: [{
            description: "Consulting services",
            quantity: "20",
            unit_amount: "200.00",
            source_tax_amount: "360.00",
            coding_type: "ITEM",
            coding_name: "Consulting",
          }],
        },
        ["lines", "0", "tax_code_name"],
      ],
    ];

    for (const [label, overrides, tail] of violations) {
      const parsed = quickBooksAccountingCaseBusinessIntakeSchema.safeParse(intake(overrides));
      expect(parsed.success, label).toBe(false);
      const paths = parsed.error?.issues.map((issue) => issue.path.join(".")) ?? [];
      expect(paths, label).toContain(["sources", "0", "units", "0", "facts", "0", ...tail].join("."));
    }

    expect(quickBooksAccountingCaseBusinessIntakeSchema.safeParse(intake({ due_date: "2026-08-01" })).success).toBe(true);
  });

  it("normalizes the wave-two business shapes into their internal fact kinds", () => {
    const normalized = normalizeQuickBooksAccountingCaseBusinessIntake({
      target_session_ref: targetSessionRef,
      case_id: "case-business-wave-two-001",
      expected_version: 0,
      source_set_complete: true as const,
      sources: [{
        source_key: "SR-2026-0802",
        label: "Counter receipt and chart request",
        units: [{
          unit_key: "counter-sale",
          facts: [{
            kind: "ACCOUNT" as const,
            name: "Software Subscriptions",
            account_type: "Expense" as const,
            parent_account_name: "Operating Expenses",
          }, {
            kind: "ITEM" as const,
            name: "Workshop Seat",
            item_type: "SERVICE" as const,
            income_account_name: "Services Income",
            expense_account_name: "Subcontractor Costs",
          }, {
            kind: "DOCUMENT" as const,
            document_type: "SALES_RECEIPT" as const,
            counterparty_name: "Walk-in Customer",
            document_date: "2026-08-02",
            document_number: "SR-2001",
            currency: "SGD",
            tax_mode: "NO_TAX" as const,
            lines: [{
              description: "Bookkeeping workshop seat",
              quantity: "2",
              unit_amount: "150.00",
              source_tax_amount: "0.00",
              coding_type: "ITEM" as const,
              coding_name: "Workshop Seat",
            }],
            declared_net: "300.00",
            declared_tax: "0.00",
            declared_gross: "300.00",
            business_reason: "Record the cash sale taken at the counter.",
            payment_account_name: "Undeposited Funds",
          }, {
            kind: "SOURCE_ATTACHMENT" as const,
            document_type: "SALES_RECEIPT" as const,
            counterparty_name: "Walk-in Customer",
            document_number: "SR-2001",
            note: "Counter receipt as printed at the till.",
          }],
        }],
      }],
    });
    expect(normalized.facts.map((fact) => fact.kind)).toEqual([
      "ACCOUNT_CANDIDATE", "ITEM_CANDIDATE", "NATIVE_DOCUMENT", "SOURCE_ATTACHMENT",
    ]);
    expect(normalized.facts[0]).toMatchObject({
      name: "Software Subscriptions", accountType: "Expense", parentAccountName: "Operating Expenses",
    });
    expect(normalized.facts[1]).toMatchObject({
      name: "Workshop Seat", itemType: "SERVICE",
      incomeAccountName: "Services Income", expenseAccountName: "Subcontractor Costs",
    });
    expect(normalized.facts[2]).toMatchObject({
      documentType: "SALES_RECEIPT", paymentAccountName: "Undeposited Funds",
    });
    expect(normalized.facts[2]).not.toHaveProperty("paymentType");
    expect(normalized.facts[3]).toMatchObject({
      documentType: "SALES_RECEIPT", counterpartyName: "Walk-in Customer", documentNumber: "SR-2001",
    });
    // The unit's declared coverage is derived, so it must name all four kinds.
    expect(normalized.sources[0]?.units[0]?.expectedFactKinds).toEqual([
      "ACCOUNT_CANDIDATE", "ITEM_CANDIDATE", "NATIVE_DOCUMENT", "SOURCE_ATTACHMENT",
    ]);
  });

  it("refuses the wave-two rules at the Agent-facing boundary", () => {
    const intake = (fact: Record<string, unknown>) => ({
      target_session_ref: targetSessionRef,
      case_id: "case-business-wave-two-rules",
      expected_version: 0,
      source_set_complete: true as const,
      sources: [{ source_key: "SR-2026-0802", label: "Counter receipt", units: [{ unit_key: "counter-sale", facts: [fact] }] }],
    });
    const salesReceipt = {
      kind: "DOCUMENT" as const,
      document_type: "SALES_RECEIPT" as const,
      counterparty_name: "Walk-in Customer",
      document_date: "2026-08-02",
      currency: "SGD",
      tax_mode: "NO_TAX" as const,
      lines: [{
        description: "Bookkeeping workshop seat", quantity: "2", unit_amount: "150.00",
        source_tax_amount: "0.00", coding_type: "ITEM" as const, coding_name: "Workshop Seat",
      }],
      declared_net: "300.00", declared_tax: "0.00", declared_gross: "300.00",
      business_reason: "Record the cash sale taken at the counter.",
      payment_account_name: "Undeposited Funds",
    };
    const attachment = {
      kind: "SOURCE_ATTACHMENT" as const,
      document_type: "BILL" as const,
      counterparty_name: "OfficeHub",
      document_number: "OH-1001",
      note: "Original supplier invoice.",
    };
    const refusals: Array<[string, Record<string, unknown>]> = [
      ["sales receipt with no deposit account", { ...salesReceipt, payment_account_name: undefined }],
      ["sales receipt carrying a payment type", { ...salesReceipt, payment_type: "CASH" }],
      ["attachment with no target document number", { ...attachment, document_number: undefined }],
      ["inventory item", { kind: "ITEM", name: "Widget", item_type: "INVENTORY", income_account_name: "Sales" }],
      ["account type QuickBooks does not have", { kind: "ACCOUNT", name: "Software", account_type: "Expenses" }],
    ];
    for (const [label, fact] of refusals) {
      expect(quickBooksAccountingCaseBusinessIntakeSchema.safeParse(intake(fact)).success, label).toBe(false);
    }
    expect(quickBooksAccountingCaseBusinessIntakeSchema.safeParse(intake(salesReceipt)).success).toBe(true);
    expect(quickBooksAccountingCaseBusinessIntakeSchema.safeParse(intake(attachment)).success).toBe(true);
  });

  it("rejects duplicate business source and unit keys", () => {
    const duplicateSource = {
      ...residualIntake,
      sources: [...residualIntake.sources, structuredClone(residualIntake.sources[0]!)],
    };
    expect(quickBooksAccountingCaseBusinessIntakeSchema.safeParse(duplicateSource).success).toBe(false);

    const duplicateUnit = structuredClone(residualIntake);
    duplicateUnit.sources[0]!.units.push(structuredClone(duplicateUnit.sources[0]!.units[0]!));
    expect(quickBooksAccountingCaseBusinessIntakeSchema.safeParse(duplicateUnit).success).toBe(false);
  });
});
