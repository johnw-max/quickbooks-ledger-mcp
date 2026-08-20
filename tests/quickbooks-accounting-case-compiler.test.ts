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
        units: [{ unitId: "settlement-row", expectedFactKinds: ["UNSUPPORTED_EVENT", "EVIDENCE"] }],
      }],
      facts: [{
        factId: "settlement-v1", lineageKey: "settlement", eventKey: "settlement",
        sourceUnitIds: ["settlement-row"], origin: "MODEL_EXTRACTED", revision: 1,
        kind: "UNSUPPORTED_EVENT", eventType: "PAYMENT", date: "2026-07-25",
        currency: "SGD", amount: "25.00", note: "Cash movement is out of scope in this Case version.",
      }, {
        factId: "settlement-evidence-v1", lineageKey: "settlement-evidence", eventKey: "settlement",
        sourceUnitIds: ["settlement-row"], origin: "MODEL_EXTRACTED", revision: 1,
        kind: "EVIDENCE", evidenceRole: "SOURCE_DOCUMENT", relatedEventKey: "settlement",
        note: "The supplied statement supports the blocked settlement event.",
      }],
    });
    const compiled = compileParsed(parsed);
    expect(compiled).toMatchObject({
      status: "PLANNED_WITH_EXCEPTIONS",
      coverage: { missingFactRequirements: [] },
      events: [{ disposition: "BLOCKED_UNSUPPORTED", unsupportedEventType: "PAYMENT" }],
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

  // Whether the debit belongs in Depreciation or Repairs is the Agent's
  // judgment and is never second-guessed here. Whether the debits add up to
  // the credits is arithmetic, and is.
  const journalCase = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "accrual-v1", lineageKey: "accrual", eventKey: "accrual", sourceUnitIds: ["page-1"],
      origin: "AGENT_ASSERTED", revision: 1, kind: "JOURNAL_ENTRY",
      entryDate: "2026-07-31", currency: "SGD",
      lines: [
        { lineId: "expense", description: "July audit fee accrual", postingType: "DEBIT", accountName: "Professional Fees", amount: "1200.00" },
        { lineId: "accrual", description: "Accrued audit fee", postingType: "CREDIT", accountName: "Accrued Liabilities", amount: "1200.00" },
      ],
      declaredTotal: "1200.00",
      businessReason: "Accrue the July audit fee before the month is closed.",
    };
    mutate(fact);
    return {
      target_session_ref,
      case_id: "case-accrual-001",
      expected_version: 0,
      sources: [{ artifactId: "accrual.md", label: "Month-end accrual schedule", units: [{ unitId: "page-1", expectedFactKinds: ["JOURNAL_ENTRY" as const] }] }],
      facts: [fact],
    };
  };

  it("plans a balanced journal entry and bridges its total", () => {
    const compiled = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(journalCase()));
    expect(compiled).toMatchObject({
      status: "PLANNED_NEEDS_PREFLIGHT",
      events: [{ disposition: "AUTO_EXECUTE", route: "JOURNAL_ENTRY", reasonCodes: [] }],
      operationCandidates: [{
        actionId: "journal_entry.create",
        entity: "JournalEntry",
        amountBridge: { currency: "SGD", sourceNet: "1200.0000", sourceTax: "0.0000", sourceGross: "1200.0000" },
      }],
    });
  });

  it("blocks a journal entry whose debits do not equal its credits", () => {
    const compiled = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(journalCase((fact) => {
      (fact.lines as Array<Record<string, unknown>>)[1]!.amount = "1100.00";
    })));
    expect(compiled.status).toBe("BLOCKED_VALIDATION");
    expect(compiled.events[0]?.reasonCodes).toEqual([
      "JOURNAL_ENTRY_DEBITS_DO_NOT_EQUAL_CREDITS",
      "JOURNAL_TOTAL_DOES_NOT_MATCH_DECLARED_TOTAL",
    ]);
    expect(compiled.operationCandidates).toEqual([]);
  });

  it("blocks a balanced journal entry that disagrees with its own declared total", () => {
    const compiled = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(journalCase((fact) => {
      fact.declaredTotal = "120.00";
    })));
    expect(compiled.status).toBe("BLOCKED_VALIDATION");
    expect(compiled.events[0]?.reasonCodes).toEqual(["JOURNAL_TOTAL_DOES_NOT_MATCH_DECLARED_TOTAL"]);
  });

  it("refuses a one-sided, single-line or zero-amount journal entry at the public boundary", () => {
    const oneSided = journalCase((fact) => {
      (fact.lines as Array<Record<string, unknown>>)[1]!.postingType = "DEBIT";
    });
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(oneSided).success).toBe(false);

    const singleLine = journalCase((fact) => {
      fact.lines = [(fact.lines as unknown[])[0]];
    });
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(singleLine).success).toBe(false);

    const zeroLine = journalCase((fact) => {
      const lines = fact.lines as Array<Record<string, unknown>>;
      lines[0]!.amount = "0.00";
      lines[1]!.amount = "0.00";
      fact.declaredTotal = "0.00";
    });
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(zeroLine).success).toBe(false);
  });

  const purchaseCase = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "card-expense-v1", lineageKey: "card-expense", eventKey: "card-expense", sourceUnitIds: ["page-1"],
      origin: "MODEL_EXTRACTED", revision: 1, kind: "NATIVE_DOCUMENT",
      documentType: "PURCHASE", counterpartyName: "Kopi Roasters", documentDate: "2026-07-14",
      currency: "SGD", taxMode: "NO_TAX",
      lines: [
        { lineId: "beans", description: "Office coffee", quantity: "2", unitAmount: "22.50", sourceTax: "0.00", codingType: "ACCOUNT", codingName: "Staff Welfare" },
      ],
      declaredNet: "45.00", declaredTax: "0.00", declaredGross: "45.00",
      businessReason: "Record the company card purchase already charged to the card.",
      paymentAccountName: "OCBC Business Card",
      paymentType: "CREDIT_CARD",
    };
    mutate(fact);
    return {
      target_session_ref,
      case_id: "case-card-expense-001",
      expected_version: 0,
      sources: [{ artifactId: "card-receipt.jpg", label: "Card receipt", units: [{ unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT" as const] }] }],
      facts: [fact],
    };
  };

  it("plans a card purchase as its own document route", () => {
    const compiled = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(purchaseCase()));
    expect(compiled).toMatchObject({
      status: "PLANNED_NEEDS_PREFLIGHT",
      events: [{ disposition: "AUTO_EXECUTE", route: "PURCHASE" }],
      operationCandidates: [{ actionId: "purchase.create", entity: "Purchase" }],
    });
  });

  it("requires the money source on a purchase and forbids it on every other document", () => {
    for (const missing of ["paymentAccountName", "paymentType"] as const) {
      const parsed = quickBooksPrepareAccountingCaseSchema.safeParse(purchaseCase((fact) => { delete fact[missing]; }));
      expect(parsed.success, missing).toBe(false);
    }
    const onABill = purchaseCase((fact) => {
      fact.documentType = "BILL";
      fact.documentNumber = "KR-9001";
    });
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(onABill).success).toBe(false);
  });

  // ---- POSTING_TRANSACTION: SalesReceipt --------------------------------

  const salesReceiptCase = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "counter-sale-v1", lineageKey: "counter-sale", eventKey: "counter-sale", sourceUnitIds: ["page-1"],
      origin: "MODEL_EXTRACTED", revision: 1, kind: "NATIVE_DOCUMENT",
      documentType: "SALES_RECEIPT", counterpartyName: "Walk-in Customer", documentDate: "2026-08-02",
      documentNumber: "SR-2001", currency: "SGD", taxMode: "NO_TAX",
      lines: [{
        lineId: "workshop", description: "Bookkeeping workshop seat", quantity: "2", unitAmount: "150.00",
        sourceTax: "0.00", codingType: "ITEM", codingName: "Training",
      }],
      declaredNet: "300.00", declaredTax: "0.00", declaredGross: "300.00",
      businessReason: "Record the cash sale taken at the counter.",
      paymentAccountName: "Undeposited Funds",
    };
    mutate(fact);
    return {
      target_session_ref,
      case_id: "case-counter-sale-001",
      expected_version: 0,
      sources: [{ artifactId: "receipt.pdf", label: "Counter receipt", units: [{ unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT" as const] }] }],
      facts: [fact],
    };
  };

  it("plans a cash sale as its own document route and derives its contact as a Customer", () => {
    const compiled = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(salesReceiptCase()));
    expect(compiled).toMatchObject({
      status: "PLANNED_NEEDS_PREFLIGHT",
      events: [{ disposition: "AUTO_EXECUTE", route: "SALES_RECEIPT" }],
      operationCandidates: [{ actionId: "sales_receipt.create", entity: "SalesReceipt" }],
    });
  });

  it("requires a deposit account on a sales receipt, refuses a payment type on one, and demands ITEM coding", () => {
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(
      salesReceiptCase((fact) => { delete fact.paymentAccountName; }),
    ).success).toBe(false);
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(
      salesReceiptCase((fact) => { fact.paymentType = "CASH"; }),
    ).success).toBe(false);
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(
      salesReceiptCase((fact) => { (fact.lines as Array<Record<string, unknown>>)[0]!.codingType = "ACCOUNT"; }),
    ).success).toBe(false);
  });

  // ---- MASTER_DATA: Account and Item ------------------------------------

  const masterDataCase = (facts: Array<Record<string, unknown>>, expectedFactKinds: string[]) => ({
    target_session_ref,
    case_id: "case-master-data-001",
    expected_version: 0,
    sources: [{ artifactId: "chart-request.md", label: "Chart of accounts request", units: [{ unitId: "row-1", expectedFactKinds }] }],
    facts,
  });

  const accountFact = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "account-v1", lineageKey: "account", eventKey: "account", sourceUnitIds: ["row-1"],
      origin: "AGENT_ASSERTED", revision: 1, kind: "ACCOUNT_CANDIDATE",
      name: "Software Subscriptions", accountType: "Expense",
    };
    mutate(fact);
    return fact;
  };

  const itemFact = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "item-v1", lineageKey: "item", eventKey: "item", sourceUnitIds: ["row-1"],
      origin: "AGENT_ASSERTED", revision: 1, kind: "ITEM_CANDIDATE",
      name: "Training", itemType: "SERVICE", incomeAccountName: "Services Income",
    };
    mutate(fact);
    return fact;
  };

  it("plans an account and an item as their own master-data routes", () => {
    const compiled = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      masterDataCase([accountFact(), itemFact()], ["ACCOUNT_CANDIDATE", "ITEM_CANDIDATE"]),
    ));
    expect(compiled.status).toBe("PLANNED_NEEDS_PREFLIGHT");
    expect(compiled.events.map((event) => event.route).sort()).toEqual(["ACCOUNT_CREATE", "ITEM_CREATE"]);
    expect(compiled.operationCandidates.map((candidate) => ({ actionId: candidate.actionId, entity: candidate.entity })))
      .toEqual(expect.arrayContaining([
        { actionId: "account.create", entity: "Account" },
        { actionId: "item.create", entity: "Item" },
      ]));
    // Master data carries no amounts, so it must carry no amount bridge either;
    // an unexpected bridge is a hard source-integrity mismatch downstream.
    expect(compiled.operationCandidates.every((candidate) => candidate.amountBridge === undefined)).toBe(true);
  });

  it("keys an account on its qualified path, so a sub-account is not the same operation as a top-level one", () => {
    const topLevel = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      masterDataCase([accountFact()], ["ACCOUNT_CANDIDATE"]),
    )).operationCandidates[0]?.stableOperationKey;
    const subAccount = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      masterDataCase([accountFact((fact) => { fact.parentAccountName = "Operating Expenses"; })], ["ACCOUNT_CANDIDATE"]),
    )).operationCandidates[0]?.stableOperationKey;
    expect(topLevel).toBeDefined();
    expect(subAccount).toBeDefined();
    expect(subAccount).not.toBe(topLevel);
    // The account type is deliberately outside the key: restating the same
    // account with a corrected type must retry that same logical create, not
    // open a second one that would collide on the name in QuickBooks.
    const retypedTopLevel = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      masterDataCase([accountFact((fact) => { fact.accountType = "Other Expense"; })], ["ACCOUNT_CANDIDATE"]),
    )).operationCandidates[0]?.stableOperationKey;
    expect(retypedTopLevel).toBe(topLevel);
  });

  it("blocks master-data names that would make their own qualified identity ambiguous", () => {
    const colonInName = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      masterDataCase([accountFact((fact) => { fact.name = "Operating Expenses:Software"; })], ["ACCOUNT_CANDIDATE"]),
    ));
    expect(colonInName).toMatchObject({
      status: "BLOCKED_VALIDATION",
      events: [{ reasonCodes: ["MASTER_DATA_NAME_MUST_NOT_CONTAIN_A_QUALIFIED_NAME_SEPARATOR"] }],
    });
    expect(colonInName.operationCandidates).toEqual([]);

    const ownParent = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      masterDataCase([accountFact((fact) => { fact.parentAccountName = "Software Subscriptions"; })], ["ACCOUNT_CANDIDATE"]),
    ));
    expect(ownParent).toMatchObject({
      status: "BLOCKED_VALIDATION",
      events: [{ reasonCodes: ["ACCOUNT_CANNOT_BE_ITS_OWN_PARENT"] }],
    });

    const itemColon = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      masterDataCase([itemFact((fact) => { fact.name = "Services:Training"; })], ["ITEM_CANDIDATE"]),
    ));
    expect(itemColon.status).toBe("BLOCKED_VALIDATION");
  });

  it("refuses an inventory item and an account type QuickBooks does not have", () => {
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(
      masterDataCase([itemFact((fact) => { fact.itemType = "INVENTORY"; })], ["ITEM_CANDIDATE"]),
    ).success).toBe(false);
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(
      masterDataCase([accountFact((fact) => { fact.accountType = "Expenses"; })], ["ACCOUNT_CANDIDATE"]),
    ).success).toBe(false);
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(
      masterDataCase([itemFact((fact) => { delete fact.incomeAccountName; })], ["ITEM_CANDIDATE"]),
    ).success).toBe(false);
  });

  // ---- ATTACHMENT: the source document follows the entry ----------------

  const attachmentCase = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "attachment-v1", lineageKey: "attachment", eventKey: "attachment", sourceUnitIds: ["page-1"],
      origin: "MODEL_EXTRACTED", revision: 1, kind: "SOURCE_ATTACHMENT",
      documentType: "BILL", counterpartyName: "OfficeHub", documentNumber: "OH-1001",
      note: "Original supplier invoice as received by email.",
    };
    mutate(fact);
    return {
      target_session_ref,
      case_id: "case-attachment-001",
      expected_version: 0,
      sources: [{
        artifactId: "invoice.pdf",
        label: "OfficeHub invoice",
        units: [{ unitId: "page-1", expectedFactKinds: ["SOURCE_ATTACHMENT" as const] }],
        sourceRef: "drive://officehub/OH-1001.pdf",
        sourceSha256: "b".repeat(64),
        sourceDigestProvenance: "AGENT_SUPPLIED_TEXT_FINGERPRINT" as const,
      }],
      facts: [fact],
    };
  };

  it("plans an attachment as its own route with no amount bridge", () => {
    const compiled = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(attachmentCase()));
    expect(compiled).toMatchObject({
      status: "PLANNED_NEEDS_PREFLIGHT",
      events: [{ disposition: "AUTO_EXECUTE", route: "ATTACHMENT_CREATE" }],
      operationCandidates: [{ actionId: "attachment.create", entity: "Attachable" }],
    });
    expect(compiled.operationCandidates[0]).not.toHaveProperty("amountBridge");
  });

  it("keys an attachment on its target transaction and its own note", () => {
    const base = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(attachmentCase()))
      .operationCandidates[0]?.stableOperationKey;
    const otherNote = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      attachmentCase((fact) => { fact.note = "Approval email from the finance director."; }),
    )).operationCandidates[0]?.stableOperationKey;
    const otherDocument = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      attachmentCase((fact) => { fact.documentNumber = "OH-1002"; }),
    )).operationCandidates[0]?.stableOperationKey;
    // Restating the same evidence differently-cased is the same attachment.
    const recased = compileParsed(quickBooksPrepareAccountingCaseSchema.parse(
      attachmentCase((fact) => { fact.counterpartyName = "officehub"; }),
    )).operationCandidates[0]?.stableOperationKey;
    expect(base).toBeDefined();
    expect(otherNote).not.toBe(base);
    expect(otherDocument).not.toBe(base);
    expect(recased).toBe(base);
  });

  it("requires the attachment's target document number, because that is how the posted transaction is found", () => {
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(
      attachmentCase((fact) => { delete fact.documentNumber; }),
    ).success).toBe(false);
  });
});
