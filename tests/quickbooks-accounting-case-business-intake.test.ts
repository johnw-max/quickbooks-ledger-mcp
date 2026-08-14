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
      unit_key: "bank-fee-2026-07-25",
      facts: [{
        kind: "UNSUPPORTED_EVENT" as const,
        event_type: "BANK_FEE" as const,
        date: "2026-07-25",
        currency: "SGD",
        amount: "25.00",
        note: "Bank fee remains explicit because this release does not write it.",
      }, {
        kind: "EVIDENCE" as const,
        evidence_role: "SOURCE_DOCUMENT" as const,
        note: "The supplied bank statement supports the blocked bank fee event.",
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
      events: [{ disposition: "BLOCKED_UNSUPPORTED", unsupportedEventType: "BANK_FEE" }],
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
