import { describe, expect, it } from "vitest";
import type { QuickBooksAccountingFact, QuickBooksSourceArtifact } from "../src/quickbooks/accountingCase.js";
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

function compileParsed(parsed: ReturnType<typeof quickBooksPrepareAccountingCaseSchema.parse>) {
  return compileQuickBooksAccountingCase({
    caseId: parsed.case_id,
    expectedVersion: parsed.expected_version,
    sources: parsed.sources as QuickBooksSourceArtifact[],
    // The strict public schema has already removed undefined-valued optional
    // properties; its inferred Zod type is wider than the exact domain type.
    facts: parsed.facts as QuickBooksAccountingFact[],
  });
}

describe("QuickBooks Accounting Case compiler", () => {
  it("recomputes line totals and emits one bounded operation", () => {
    const parsed = quickBooksPrepareAccountingCaseSchema.parse(clean);
    const compiled = compileParsed(parsed);
    expect(compiled).toMatchObject({
      status: "PLANNED_NEEDS_PREFLIGHT",
      coverage: { expectedSourceUnitCount: 1, satisfiedFactRequirementCount: 1, missingFactRequirements: [] },
      events: [{ disposition: "AUTO_EXECUTE", route: "BILL" }],
      operationCandidates: [{ actionId: "bill.create", entity: "Bill" }],
    });
  });

  it("persists a fully typed residual Case with zero Provider operations", () => {
    const parsed = quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref,
      case_id: "case-residual-001",
      expected_version: 0,
      sources: [{
        artifactId: "bank-statement.png",
        label: "Bank statement residual evidence",
        units: [{ unitId: "bank-fee-row", expectedFactKinds: ["UNSUPPORTED_EVENT", "EVIDENCE"] }],
      }],
      facts: [{
        factId: "bank-fee-v1", lineageKey: "bank-fee", eventKey: "bank-fee",
        sourceUnitIds: ["bank-fee-row"], origin: "MODEL_EXTRACTED", revision: 1,
        kind: "UNSUPPORTED_EVENT", eventType: "BANK_FEE", date: "2026-07-25",
        currency: "SGD", amount: "25.00", note: "Bank fee is not released in this Case version.",
      }, {
        factId: "bank-fee-evidence-v1", lineageKey: "bank-fee-evidence", eventKey: "bank-fee",
        sourceUnitIds: ["bank-fee-row"], origin: "MODEL_EXTRACTED", revision: 1,
        kind: "EVIDENCE", evidenceRole: "SOURCE_DOCUMENT", relatedEventKey: "bank-fee",
        note: "The supplied statement supports the blocked bank fee event.",
      }],
    });
    const compiled = compileParsed(parsed);
    expect(compiled).toMatchObject({
      status: "PLANNED_WITH_EXCEPTIONS",
      coverage: { missingFactRequirements: [] },
      events: [{ disposition: "BLOCKED_UNSUPPORTED", unsupportedEventType: "BANK_FEE" }],
      operationCandidates: [],
    });
  });

  it("blocks the original 800 + 7.20 but declared 87.20 near-miss", () => {
    const bad = structuredClone(clean);
    const [badFact] = bad.facts;
    if (!badFact) throw new Error("test fixture requires one fact");
    badFact.declaredNet = "87.20";
    badFact.declaredGross = "87.20";
    const parsed = quickBooksPrepareAccountingCaseSchema.parse(bad);
    const compiled = compileParsed(parsed);
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
    const compiled = compileParsed(parsed);
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
    const left = compileParsed(parsed);
    const right = compileParsed({ ...parsed, sources: [...parsed.sources].reverse(), facts: [...parsed.facts].reverse() });
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

  // A Customer/Vendor's CurrencyRef is frozen at creation in QuickBooks. There
  // is no Agent-stated currency field on CONTACT_CANDIDATE to get wrong: the
  // compiler derives it purely from the NATIVE_DOCUMENT facts in the same
  // Case that reference the contact. These three cover the three shapes that
  // derivation can take.
  const contactFact = (overrides: Record<string, unknown> = {}) => ({
    factId: "vendor-v1", lineageKey: "vendor", eventKey: "vendor", sourceUnitIds: ["page-1"],
    origin: "AGENT_ASSERTED" as const, revision: 1, kind: "CONTACT_CANDIDATE" as const,
    role: "VENDOR" as const, displayName: "OfficeHub",
    ...overrides,
  });

  it("leaves a contact-only Case's currency undefined and its event unblocked", () => {
    const parsed = quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref,
      case_id: "case-contact-only-001",
      expected_version: 0,
      sources: [{ artifactId: "contact.txt", label: "New vendor", units: [{ unitId: "page-1", expectedFactKinds: ["CONTACT_CANDIDATE" as const] }] }],
      facts: [contactFact()],
    });
    const compiled = compileParsed(parsed);
    expect(compiled).toMatchObject({
      status: "PLANNED_NEEDS_PREFLIGHT",
      events: [{ disposition: "AUTO_EXECUTE", route: "CONTACT_CREATE" }],
    });
    const [contact] = compiled.activeFacts;
    expect(contact).toMatchObject({ kind: "CONTACT_CANDIDATE" });
    expect((contact as { currency?: string }).currency).toBeUndefined();
  });

  it("derives a new contact's currency from the one document in the Case that references it", () => {
    const parsed = quickBooksPrepareAccountingCaseSchema.parse({
      ...clean,
      sources: [...clean.sources, { artifactId: "contact.txt", label: "New vendor", units: [{ unitId: "page-2", expectedFactKinds: ["CONTACT_CANDIDATE" as const] }] }],
      facts: [...clean.facts, contactFact({ sourceUnitIds: ["page-2"] })],
    });
    const compiled = compileParsed(parsed);
    const contactEvent = compiled.events.find((event) => event.route === "CONTACT_CREATE");
    expect(contactEvent).toMatchObject({ disposition: "AUTO_EXECUTE" });
    const contact = compiled.activeFacts.find((fact) => fact.kind === "CONTACT_CANDIDATE");
    expect((contact as { currency?: string } | undefined)?.currency).toBe("SGD");
  });

  it("blocks a contact referenced by documents that disagree on currency, before any dispatch", () => {
    const secondBill = {
      ...clean.facts[0],
      factId: "fact-invoice-v1-usd", lineageKey: "invoice-usd", eventKey: "invoice-usd",
      sourceUnitIds: ["page-3"], documentNumber: "OH-1002", currency: "USD", exchangeRate: "1.34",
    };
    const parsed = quickBooksPrepareAccountingCaseSchema.parse({
      ...clean,
      sources: [
        ...clean.sources,
        { artifactId: "contact.txt", label: "New vendor", units: [{ unitId: "page-2", expectedFactKinds: ["CONTACT_CANDIDATE" as const] }] },
        { artifactId: "invoice2.pdf", label: "Second OfficeHub bill", units: [{ unitId: "page-3", expectedFactKinds: ["NATIVE_DOCUMENT" as const] }] },
      ],
      facts: [...clean.facts, contactFact({ sourceUnitIds: ["page-2"] }), secondBill],
    });
    const compiled = compileParsed(parsed);
    expect(compiled.status).toBe("BLOCKED_VALIDATION");
    const contactEvent = compiled.events.find((event) => event.route === "CONTACT_CREATE");
    expect(contactEvent).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: ["CONTACT_DOCUMENT_CURRENCY_MISMATCH"],
    });
    const contact = compiled.activeFacts.find((fact) => fact.kind === "CONTACT_CANDIDATE");
    expect((contact as { currency?: string } | undefined)?.currency).toBeUndefined();
    expect(compiled.operationCandidates.some((candidate) => candidate.entity === "Vendor")).toBe(false);
  });
});
