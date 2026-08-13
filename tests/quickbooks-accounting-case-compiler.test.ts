import { describe, expect, it } from "vitest";
import { compileQuickBooksAccountingCase } from "../src/quickbooks/accountingCaseCompiler.js";
import { quickBooksPrepareAccountingCaseSchema } from "../src/quickbooks/accountingCaseSchemas.js";

const target_session_ref = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
const clean = {
  target_session_ref,
  case_id: "case-officehub-001",
  expected_version: 0,
  sources: [{ artifactId: "invoice.pdf", label: "OfficeHub invoice", units: [{ unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT" as const] }] }],
  facts: [{
    factId: "fact-invoice-v1", lineageKey: "invoice-main", eventKey: "invoice-main", sourceUnitIds: ["page-1"],
    origin: "MODEL_EXTRACTED" as const, revision: 1, kind: "NATIVE_DOCUMENT" as const,
    documentType: "BILL" as const, counterpartyName: "OfficeHub", documentDate: "2026-08-01",
    documentNumber: "OH-1001", currency: "SGD", taxMode: "NO_TAX" as const,
    lines: [
      { lineId: "office", description: "Office furniture", quantity: "1", unitAmount: "800.00", sourceTax: "0.00", codingType: "ACCOUNT" as const, codingName: "Office Expenses" },
      { lineId: "fee", description: "Delivery", quantity: "1", unitAmount: "7.20", sourceTax: "0.00", codingType: "ACCOUNT" as const, codingName: "Office Expenses" },
    ],
    declaredNet: "807.20", declaredTax: "0.00", declaredGross: "807.20",
    businessReason: "Record the supplied OfficeHub invoice.",
  }],
};

describe("QuickBooks Accounting Case compiler", () => {
  it("recomputes line totals and emits one bounded operation", () => {
    const parsed = quickBooksPrepareAccountingCaseSchema.parse(clean);
    const compiled = compileQuickBooksAccountingCase({
      caseId: parsed.case_id, expectedVersion: parsed.expected_version, sources: parsed.sources, facts: parsed.facts,
    });
    expect(compiled).toMatchObject({
      status: "PLANNED_NEEDS_PREFLIGHT",
      coverage: { expectedSourceUnitCount: 1, satisfiedFactRequirementCount: 1, missingFactRequirements: [] },
      events: [{ disposition: "AUTO_EXECUTE", route: "BILL" }],
      operationCandidates: [{ actionId: "bill.create", entity: "Bill" }],
    });
  });

  it("blocks the original 800 + 7.20 but declared 87.20 near-miss", () => {
    const bad = structuredClone(clean);
    bad.facts[0].declaredNet = "87.20";
    bad.facts[0].declaredGross = "87.20";
    const parsed = quickBooksPrepareAccountingCaseSchema.parse(bad);
    const compiled = compileQuickBooksAccountingCase({ caseId: parsed.case_id, expectedVersion: 0, sources: parsed.sources, facts: parsed.facts });
    expect(compiled.status).toBe("BLOCKED_VALIDATION");
    expect(compiled.events[0]?.reasonCodes).toContain("LINE_NET_DOES_NOT_MATCH_DECLARED_NET");
  });

  it("blocks missing submitted source-unit facts instead of claiming completeness", () => {
    const parsed = quickBooksPrepareAccountingCaseSchema.parse({
      ...clean,
      sources: [{ artifactId: "bank.pdf", label: "Bank statement", units: [
        { unitId: "row-1", expectedFactKinds: ["NATIVE_DOCUMENT"] },
        { unitId: "row-2", expectedFactKinds: ["NATIVE_DOCUMENT"] },
      ] }],
      facts: [{ ...clean.facts[0], sourceUnitIds: ["row-1"] }],
    });
    const compiled = compileQuickBooksAccountingCase({ caseId: parsed.case_id, expectedVersion: 0, sources: parsed.sources, facts: parsed.facts });
    expect(compiled.status).toBe("BLOCKED_COVERAGE");
    expect(compiled.coverage.missingFactRequirements).toEqual(["row-2:NATIVE_DOCUMENT"]);
  });

  it("is invariant to source and fact ordering", () => {
    const parsed = quickBooksPrepareAccountingCaseSchema.parse({
      ...clean,
      facts: [...clean.facts, {
        factId: "evidence-v1", lineageKey: "support", eventKey: "support", sourceUnitIds: ["page-1"],
        origin: "AGENT_ASSERTED", revision: 1, kind: "EVIDENCE", evidenceRole: "SOURCE_DOCUMENT", note: "Invoice source supplied",
      }],
    });
    const left = compileQuickBooksAccountingCase({ caseId: parsed.case_id, expectedVersion: 0, sources: parsed.sources, facts: parsed.facts });
    const right = compileQuickBooksAccountingCase({ caseId: parsed.case_id, expectedVersion: 0, sources: [...parsed.sources].reverse(), facts: [...parsed.facts].reverse() });
    expect(right.sourceRevisionHash).toBe(left.sourceRevisionHash);
    expect(right.events).toEqual(left.events);
  });

  it("rejects Agent-supplied provider IDs and revision branches at the public boundary", () => {
    expect(quickBooksPrepareAccountingCaseSchema.safeParse({ ...clean, facts: [{ ...clean.facts[0], vendorId: "12" }] }).success).toBe(false);
    const branched = [
      { ...clean.facts[0], factId: "v1" },
      { ...clean.facts[0], factId: "v2a", revision: 2, supersedesFactId: "v1", declaredGross: "807.20" },
      { ...clean.facts[0], factId: "v2b", revision: 2, supersedesFactId: "v1", declaredGross: "807.20" },
    ];
    expect(quickBooksPrepareAccountingCaseSchema.safeParse({ ...clean, facts: branched }).success).toBe(false);
  });
});
