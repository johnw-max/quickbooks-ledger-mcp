import { hashObject } from "../security/hash.js";
import {
  QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION,
  QUICKBOOKS_ACCOUNTING_CASE_POLICY_VERSION,
  type QuickBooksAccountingFact,
  type QuickBooksCaseAmountBridge,
  type QuickBooksCaseCompilationDraft,
  type QuickBooksCaseEvent,
  type QuickBooksCaseOperation,
  type QuickBooksCaseOperationCandidate,
  type QuickBooksJournalEntryFact,
  type QuickBooksNativeDocumentFact,
  type QuickBooksSourceArtifact,
} from "./accountingCase.js";

const CONTACT_DOCUMENT_CURRENCY_MISMATCH = "CONTACT_DOCUMENT_CURRENCY_MISMATCH";

const SCALE = 10_000n;

function scaled(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "0000").slice(0, 4));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function decimal4(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
}

/** Every fact kind that carries amounts into a Provider payload, and is therefore bridged. */
type QuickBooksAmountBearingFact = QuickBooksNativeDocumentFact | QuickBooksJournalEntryFact;

function isAmountBearing(fact: QuickBooksAccountingFact): fact is QuickBooksAmountBearingFact {
  return fact.kind === "NATIVE_DOCUMENT" || fact.kind === "JOURNAL_ENTRY";
}

function amountBridge(fact: QuickBooksAmountBearingFact): QuickBooksCaseAmountBridge {
  const [net, tax, gross] = fact.kind === "JOURNAL_ENTRY"
    ? [scaled(fact.declaredTotal), 0n, scaled(fact.declaredTotal)] as const
    : [scaled(fact.declaredNet), scaled(fact.declaredTax), scaled(fact.declaredGross)] as const;
  return {
    sourceFactIds: [fact.factId],
    sourceLineHash: hashObject(fact.lines),
    currency: fact.currency,
    sourceNet: decimal4(net),
    sourceTax: decimal4(tax),
    sourceGross: decimal4(gross),
    canonicalNet: decimal4(net),
    canonicalTax: decimal4(tax),
    canonicalGross: decimal4(gross),
  };
}

function lineAmounts(payload: Record<string, unknown>): bigint[] | undefined {
  if (!Array.isArray(payload.Line)) return undefined;
  const amounts: bigint[] = [];
  for (const rawLine of payload.Line) {
    if (!rawLine || typeof rawLine !== "object") return undefined;
    const amount = (rawLine as Record<string, unknown>).Amount;
    if (typeof amount !== "number" && typeof amount !== "string") return undefined;
    try {
      amounts.push(scaled(String(amount)));
    } catch {
      return undefined;
    }
  }
  return amounts;
}

/**
 * A journal entry's canonical amount is its balanced total, which only exists
 * if the payload's own debit and credit sides agree. Reading it therefore
 * re-derives balance from the provider-ready payload rather than trusting the
 * source-side check: an unbalanced payload reports as unreadable and blocks.
 */
function canonicalJournalTotal(payload: Record<string, unknown>): bigint | undefined {
  const amounts = lineAmounts(payload);
  if (!amounts || !Array.isArray(payload.Line) || amounts.length !== payload.Line.length) return undefined;
  let debit = 0n;
  let credit = 0n;
  for (const [index, rawLine] of payload.Line.entries()) {
    const detail = (rawLine as Record<string, unknown>).JournalEntryLineDetail;
    if (!detail || typeof detail !== "object") return undefined;
    const postingType = (detail as Record<string, unknown>).PostingType;
    const amount = amounts[index] as bigint;
    if (postingType === "Debit") debit += amount;
    else if (postingType === "Credit") credit += amount;
    else return undefined;
  }
  return debit === credit ? debit : undefined;
}

function canonicalPayloadAmounts(
  kind: QuickBooksAmountBearingFact["kind"],
  payload: Record<string, unknown>,
): { net: string; tax: string; gross: string } | undefined {
  if (kind === "JOURNAL_ENTRY") {
    const total = canonicalJournalTotal(payload);
    return total === undefined ? undefined : { net: decimal4(total), tax: decimal4(0n), gross: decimal4(total) };
  }
  const amounts = lineAmounts(payload);
  if (!amounts) return undefined;
  const net = amounts.reduce((sum, amount) => sum + amount, 0n);
  const rawTax = payload.TxnTaxDetail && typeof payload.TxnTaxDetail === "object"
    ? (payload.TxnTaxDetail as Record<string, unknown>).TotalTax
    : 0;
  if (typeof rawTax !== "number" && typeof rawTax !== "string") return undefined;
  try {
    const tax = scaled(String(rawTax));
    if (payload.GlobalTaxCalculation === "TaxInclusive") {
      return { net: decimal4(net - tax), tax: decimal4(tax), gross: decimal4(net) };
    }
    return { net: decimal4(net), tax: decimal4(tax), gross: decimal4(net + tax) };
  } catch {
    return undefined;
  }
}

function stableFacts(facts: readonly QuickBooksAccountingFact[]): QuickBooksAccountingFact[] {
  const superseded = new Set(facts.flatMap((fact) => fact.supersedesFactId ? [fact.supersedesFactId] : []));
  return facts.filter((fact) => !superseded.has(fact.factId))
    .map((fact) => ({ ...fact, sourceUnitIds: uniqueSorted(fact.sourceUnitIds) }))
    .sort((left, right) => left.lineageKey.localeCompare(right.lineageKey, "en") || left.revision - right.revision ||
      left.factId.localeCompare(right.factId, "en"));
}

function contactRoleForDocument(fact: QuickBooksNativeDocumentFact): "CUSTOMER" | "VENDOR" {
  return fact.documentType === "INVOICE" || fact.documentType === "CREDIT_MEMO" ? "CUSTOMER" : "VENDOR";
}

function contactCurrencyKey(role: "CUSTOMER" | "VENDOR", displayName: string): string {
  return `${role}:${displayName.trim().toLocaleLowerCase("en")}`;
}

/**
 * A Customer/Vendor's CurrencyRef is set once at creation and is immutable in
 * QuickBooks afterwards; QuickBooks refuses any document whose currency
 * differs from its contact's. There is no separate agent-stated currency for
 * a contact candidate to ask for or get wrong: a contact is only ever staged
 * because some document in the Case references it, and that document already
 * carries the currency. So this always derives, never asks -- it fills in
 * each contact's currency purely from the NATIVE_DOCUMENT facts in this Case
 * that reference it (matched by role and exact display name):
 *
 *  - No referencing document: leave the contact's currency undefined. A
 *    contact-only Case (no document staged yet) is legitimate and QuickBooks
 *    will default the new contact to the company's home currency.
 *  - Referencing documents that agree on one currency: that is the
 *    contact's currency.
 *  - Referencing documents that name two or more distinct currencies: this
 *    is genuinely impossible in QuickBooks, since one contact can hold only
 *    one currency. The contact is left without a derived currency and its
 *    factId is reported as conflicted so the caller can block that contact's
 *    event pre-dispatch with CONTACT_DOCUMENT_CURRENCY_MISMATCH, before any
 *    write is attempted, while it is still cleanly recoverable.
 */
function reconcileContactCurrencies(facts: readonly QuickBooksAccountingFact[]): {
  facts: QuickBooksAccountingFact[];
  conflictedContactFactIds: Set<string>;
} {
  const documentCurrenciesByContact = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (fact.kind !== "NATIVE_DOCUMENT") continue;
    const key = contactCurrencyKey(contactRoleForDocument(fact), fact.counterpartyName);
    const currencies = documentCurrenciesByContact.get(key) ?? new Set<string>();
    currencies.add(fact.currency);
    documentCurrenciesByContact.set(key, currencies);
  }
  const conflictedContactFactIds = new Set<string>();
  const reconciled = facts.map((fact): QuickBooksAccountingFact => {
    if (fact.kind !== "CONTACT_CANDIDATE") return fact;
    const referenced = documentCurrenciesByContact.get(contactCurrencyKey(fact.role, fact.displayName));
    if (!referenced || referenced.size === 0) return fact;
    if (referenced.size > 1) {
      conflictedContactFactIds.add(fact.factId);
      return fact;
    }
    const [derivedCurrency] = [...referenced];
    return derivedCurrency === undefined ? fact : { ...fact, currency: derivedCurrency };
  });
  return { facts: reconciled, conflictedContactFactIds };
}

function documentValidation(fact: QuickBooksNativeDocumentFact): string[] {
  const reasons: string[] = [];
  const lineNet = fact.lines.reduce((sum, line) => sum + scaled(line.quantity) * scaled(line.unitAmount) / SCALE, 0n);
  const lineTax = fact.lines.reduce((sum, line) => sum + scaled(line.sourceTax), 0n);
  const declaredNet = scaled(fact.declaredNet);
  const declaredTax = scaled(fact.declaredTax);
  const declaredGross = scaled(fact.declaredGross);
  if (fact.taxMode === "TAX_INCLUSIVE") {
    if (lineNet !== declaredGross) reasons.push("LINE_GROSS_DOES_NOT_MATCH_DECLARED_GROSS");
  } else if (lineNet !== declaredNet) {
    reasons.push("LINE_NET_DOES_NOT_MATCH_DECLARED_NET");
  }
  if (lineTax !== declaredTax) reasons.push("LINE_TAX_DOES_NOT_MATCH_DECLARED_TAX");
  if (declaredNet + declaredTax !== declaredGross) reasons.push("NET_PLUS_TAX_DOES_NOT_MATCH_GROSS");
  if (fact.taxMode === "NO_TAX" && (declaredTax !== 0n || lineTax !== 0n)) reasons.push("NO_TAX_REQUIRES_ZERO_TAX");
  if (fact.taxMode !== "NO_TAX" && fact.lines.some((line) => !line.taxCodeName)) {
    reasons.push("TAX_CODE_REQUIRED");
  }
  if (fact.documentType === "PURCHASE") {
    if (!fact.paymentAccountName) reasons.push("PURCHASE_REQUIRES_PAYMENT_ACCOUNT");
    if (!fact.paymentType) reasons.push("PURCHASE_REQUIRES_PAYMENT_TYPE");
  } else if (fact.paymentAccountName !== undefined || fact.paymentType !== undefined) {
    reasons.push("PAYMENT_SOURCE_NOT_APPLICABLE_TO_DOCUMENT_TYPE");
  }
  return uniqueSorted(reasons);
}

/**
 * Debits equal credits is not accounting judgment, it is addition, and it is
 * checked with the same exactness as the tax recomputation: integer units at
 * four decimal places, no tolerance. Which account is debited stays entirely
 * the Agent's call.
 */
function journalEntryValidation(fact: QuickBooksJournalEntryFact): string[] {
  const reasons: string[] = [];
  let debit = 0n;
  let credit = 0n;
  for (const line of fact.lines) {
    const amount = scaled(line.amount);
    if (amount <= 0n) reasons.push("JOURNAL_LINE_AMOUNT_MUST_BE_POSITIVE");
    if (line.postingType === "DEBIT") debit += amount;
    else credit += amount;
  }
  if (fact.lines.length < 2) reasons.push("JOURNAL_ENTRY_REQUIRES_AT_LEAST_TWO_LINES");
  if (!fact.lines.some((line) => line.postingType === "DEBIT") ||
      !fact.lines.some((line) => line.postingType === "CREDIT")) {
    reasons.push("JOURNAL_ENTRY_REQUIRES_A_DEBIT_AND_A_CREDIT");
  }
  if (debit !== credit) reasons.push("JOURNAL_ENTRY_DEBITS_DO_NOT_EQUAL_CREDITS");
  const declaredTotal = scaled(fact.declaredTotal);
  if (debit !== declaredTotal || credit !== declaredTotal) {
    reasons.push("JOURNAL_TOTAL_DOES_NOT_MATCH_DECLARED_TOTAL");
  }
  return uniqueSorted(reasons);
}

/**
 * Adding a fact kind touches three dispatch points in this file — whether it is
 * a primary fact, what it routes to, and what makes two of them the same
 * logical write. Each one used to end in a fallthrough, so missing one produced
 * a fact that compiled to nothing at all rather than an error. Routing every
 * one of them through this makes a new kind a compile error instead.
 */
function unhandledFactKind(fact: never): never {
  throw new Error(
    `unhandled QuickBooks Accounting Case fact kind ${String((fact as { kind?: unknown }).kind)}`,
  );
}

/**
 * Whether this fact is the subject of an event, as opposed to something that
 * rides along with one. Evidence and control findings attach to another fact's
 * event; everything else is the thing the event is about.
 */
function isPrimaryFact(kind: QuickBooksAccountingFact["kind"]): boolean {
  switch (kind) {
    case "CONTACT_CANDIDATE":
    case "NATIVE_DOCUMENT":
    case "JOURNAL_ENTRY":
    case "UNSUPPORTED_EVENT":
      return true;
    case "EVIDENCE":
    case "CONTROL_FINDING":
      return false;
    // No cast here. `kind` must already be `never` for this to compile, which
    // is the entire point — a cast would silently restore the fallthrough this
    // exists to remove.
    default: return unhandledFactKind(kind);
  }
}

function stableOperationKey(fact: QuickBooksAccountingFact): string {
  if (fact.kind === "CONTACT_CANDIDATE") {
    return hashObject({
      schemaVersion: "quickbooks-accounting-case-stable-operation:v1",
      kind: fact.kind,
      role: fact.role,
      displayName: fact.displayName.trim().toLocaleLowerCase("en"),
    });
  }
  if (fact.kind === "NATIVE_DOCUMENT") {
    const exactDocumentIdentity = fact.documentNumber?.trim().toLocaleLowerCase("en");
    return hashObject({
      schemaVersion: "quickbooks-accounting-case-stable-operation:v1",
      kind: fact.kind,
      documentType: fact.documentType,
      counterpartyName: fact.counterpartyName.trim().toLocaleLowerCase("en"),
      documentIdentity: exactDocumentIdentity ?? {
        documentDate: fact.documentDate,
        currency: fact.currency,
        declaredGross: fact.declaredGross,
        lines: fact.lines.map((line) => ({
          description: line.description.trim().toLocaleLowerCase("en"),
          quantity: line.quantity,
          unitAmount: line.unitAmount,
        })),
      },
    });
  }
  if (fact.kind === "JOURNAL_ENTRY") {
    // A journal entry has no counterparty and usually no document number, so
    // unlike a numbered document its identity has to be its content. Two
    // entries that agree on date, currency, total and every line are the same
    // adjustment; changing any of those is a different adjustment and opens a
    // different logical operation, which is the correct answer for a
    // correction.
    return hashObject({
      schemaVersion: "quickbooks-accounting-case-stable-operation:v1",
      kind: fact.kind,
      entryDate: fact.entryDate,
      currency: fact.currency,
      declaredTotal: fact.declaredTotal,
      documentNumber: fact.documentNumber?.trim().toLocaleLowerCase("en") ?? null,
      lines: fact.lines.map((line) => ({
        postingType: line.postingType,
        accountName: line.accountName.trim().toLocaleLowerCase("en"),
        amount: line.amount,
        description: line.description.trim().toLocaleLowerCase("en"),
      })),
    });
  }
  // A residual, evidence and a control finding are all identified by the event
  // they belong to rather than by content: none of them becomes a Provider
  // write, so there is nothing to make idempotent beyond the event itself.
  if (fact.kind === "UNSUPPORTED_EVENT" || fact.kind === "EVIDENCE" || fact.kind === "CONTROL_FINDING") {
    return hashObject({
      schemaVersion: "quickbooks-accounting-case-stable-operation:v1",
      kind: fact.kind,
      eventKey: fact.eventKey,
    });
  }
  return unhandledFactKind(fact);
}

function eventRoute(fact: QuickBooksAccountingFact): QuickBooksCaseEvent["route"] {
  switch (fact.kind) {
    case "CONTACT_CANDIDATE": return "CONTACT_CREATE";
    case "NATIVE_DOCUMENT": return fact.documentType;
    case "JOURNAL_ENTRY": return "JOURNAL_ENTRY";
    // Carries no route by design: a residual is recorded, not planned, and
    // evidence and control findings ride along with someone else's event.
    case "UNSUPPORTED_EVENT":
    case "EVIDENCE":
    case "CONTROL_FINDING":
      return undefined;
    default: return unhandledFactKind(fact);
  }
}

function operationCandidate(
  caseId: string,
  version: number,
  sourceRevisionHash: string,
  event: QuickBooksCaseEvent,
  primary: QuickBooksAccountingFact,
): QuickBooksCaseOperationCandidate | undefined {
  if (event.disposition !== "AUTO_EXECUTE" || !event.primaryFactId) return undefined;
  const operationId = `qboop_${hashObject({ caseId, version, eventId: event.eventId }).slice(0, 32)}`;
  const sourceFactHash = hashObject(primary);
  const sourceEvidenceHash = hashObject({
    sourceRevisionHash,
    sourceUnitIds: event.sourceUnitIds,
    primaryFactId: primary.factId,
    sourceFactHash,
  });
  if (primary.kind === "CONTACT_CANDIDATE") {
    const entity = primary.role === "CUSTOMER" ? "Customer" as const : "Vendor" as const;
    return {
      operationId,
      eventId: event.eventId,
      actionId: `${entity === "Customer" ? "customer" : "vendor"}.create_basic`,
      entity,
      operation: "CREATE",
      sourceUnitIds: event.sourceUnitIds,
      primaryFactId: primary.factId,
      sourceRevisionHash,
      sourceFactHash,
      sourceEvidenceHash,
      stableOperationKey: stableOperationKey(primary),
    };
  }
  if (!isAmountBearing(primary)) return undefined;
  const mapping = primary.kind === "JOURNAL_ENTRY"
    ? { actionId: "journal_entry.create", entity: "JournalEntry" as const }
    : {
      INVOICE: { actionId: "invoice.create", entity: "Invoice" as const },
      BILL: { actionId: "bill.create", entity: "Bill" as const },
      CREDIT_MEMO: { actionId: "credit_memo.create", entity: "CreditMemo" as const },
      VENDOR_CREDIT: { actionId: "vendor_credit.create", entity: "VendorCredit" as const },
      PURCHASE: { actionId: "purchase.create", entity: "Purchase" as const },
    }[primary.documentType];
  return {
    operationId,
    eventId: event.eventId,
    actionId: mapping.actionId,
    entity: mapping.entity,
    operation: "CREATE",
    sourceUnitIds: event.sourceUnitIds,
    primaryFactId: primary.factId,
    sourceRevisionHash,
    sourceFactHash,
    sourceEvidenceHash,
    stableOperationKey: stableOperationKey(primary),
    amountBridge: amountBridge(primary),
  };
}

/**
 * Re-checks the immutable Case operation against its exact active source fact
 * and the provider-ready canonical payload. This catches source/canonical
 * drift (including the observed 80 -> 800 class) before autonomous execution.
 */
export function validateQuickBooksCompiledOperationAgainstSource(
  operation: QuickBooksCaseOperation,
  fact: QuickBooksAccountingFact,
): string[] {
  const reasons: string[] = [];
  const sourceFactHash = hashObject(fact);
  const sourceEvidenceHash = hashObject({
    sourceRevisionHash: operation.sourceRevisionHash,
    sourceUnitIds: operation.sourceUnitIds,
    primaryFactId: fact.factId,
    sourceFactHash,
  });
  if (operation.primaryFactId !== fact.factId) reasons.push("SOURCE_FACT_ID_MISMATCH");
  if (operation.sourceFactHash !== sourceFactHash) reasons.push("SOURCE_FACT_HASH_MISMATCH");
  if (operation.sourceEvidenceHash !== sourceEvidenceHash) reasons.push("SOURCE_EVIDENCE_HASH_MISMATCH");
  if (operation.stableOperationKey !== stableOperationKey(fact)) reasons.push("STABLE_OPERATION_KEY_MISMATCH");
  if (operation.canonicalPayloadHash !== hashObject(operation.canonicalPayload)) {
    reasons.push("CANONICAL_PAYLOAD_HASH_MISMATCH");
  }
  if (isAmountBearing(fact)) {
    const expectedBridge = amountBridge(fact);
    if (hashObject(operation.amountBridge) !== hashObject(expectedBridge)) reasons.push("AMOUNT_BRIDGE_MISMATCH");
    if (operation.amountBridge?.sourceLineHash !== hashObject(fact.lines)) reasons.push("SOURCE_LINE_HASH_MISMATCH");
    const payloadAmounts = canonicalPayloadAmounts(fact.kind, operation.canonicalPayload);
    if (!payloadAmounts) {
      reasons.push("CANONICAL_PAYLOAD_AMOUNTS_UNREADABLE");
    } else {
      if (payloadAmounts.net !== expectedBridge.canonicalNet) reasons.push("CANONICAL_NET_MISMATCH");
      if (payloadAmounts.tax !== expectedBridge.canonicalTax) reasons.push("CANONICAL_TAX_MISMATCH");
      if (payloadAmounts.gross !== expectedBridge.canonicalGross) reasons.push("CANONICAL_GROSS_MISMATCH");
    }
  } else if (operation.amountBridge !== undefined) {
    reasons.push("UNEXPECTED_AMOUNT_BRIDGE");
  }
  return uniqueSorted(reasons);
}

export function compileQuickBooksAccountingCase(input: {
  caseId: string;
  expectedVersion: number;
  sources: readonly QuickBooksSourceArtifact[];
  facts: readonly QuickBooksAccountingFact[];
}): QuickBooksCaseCompilationDraft {
  const version = input.expectedVersion + 1;
  const { facts: activeFacts, conflictedContactFactIds } = reconcileContactCurrencies(stableFacts(input.facts));
  const sortedSources = [...input.sources].sort((left, right) => left.artifactId.localeCompare(right.artifactId, "en"))
    .map((source) => ({
      ...source,
      units: [...source.units]
        .map((unit) => ({ ...unit, expectedFactKinds: [...unit.expectedFactKinds].sort() }))
        .sort((left, right) => left.unitId.localeCompare(right.unitId, "en")),
    }));
  const sourceRevisionHash = hashObject({ sources: sortedSources, activeFacts });

  const missingFactRequirements: string[] = [];
  let expectedFactRequirementCount = 0;
  let satisfiedFactRequirementCount = 0;
  for (const source of sortedSources) {
    for (const unit of source.units) {
      for (const kind of unit.expectedFactKinds) {
        expectedFactRequirementCount += 1;
        if (activeFacts.some((fact) => fact.kind === kind && fact.sourceUnitIds.includes(unit.unitId))) {
          satisfiedFactRequirementCount += 1;
        } else {
          missingFactRequirements.push(`${unit.unitId}:${kind}`);
        }
      }
    }
  }

  const byEvent = new Map<string, QuickBooksAccountingFact[]>();
  for (const fact of activeFacts) {
    const bucket = byEvent.get(fact.eventKey) ?? [];
    bucket.push(fact);
    byEvent.set(fact.eventKey, bucket);
  }
  const events: QuickBooksCaseEvent[] = [];
  for (const eventKey of [...byEvent.keys()].sort((left, right) => left.localeCompare(right, "en"))) {
    const facts = (byEvent.get(eventKey) ?? []).sort((left, right) => left.factId.localeCompare(right.factId, "en"));
    const primaryFacts = facts.filter((fact) => isPrimaryFact(fact.kind));
    const blockingControls = facts.filter((fact): fact is Extract<QuickBooksAccountingFact, { kind: "CONTROL_FINDING" }> =>
      fact.kind === "CONTROL_FINDING" && fact.severity === "BLOCK_WRITE");
    const warningControls = facts.filter((fact): fact is Extract<QuickBooksAccountingFact, { kind: "CONTROL_FINDING" }> =>
      fact.kind === "CONTROL_FINDING" && fact.severity === "WARNING");
    const reasons: string[] = [
      ...blockingControls.map((fact) => `CONTROL_${fact.code}`),
      ...warningControls.map((fact) => `CONTROL_WARNING_${fact.code}`),
    ];
    let disposition: QuickBooksCaseEvent["disposition"] = "EVIDENCE_ONLY";
    const primary = primaryFacts.length === 1 ? primaryFacts[0] : undefined;
    if (primaryFacts.length > 1) {
      disposition = "BLOCKED_VALIDATION";
      reasons.push("MULTIPLE_PRIMARY_FACTS_FOR_EVENT");
    } else if (primary) {
      if (primary.kind === "UNSUPPORTED_EVENT") {
        disposition = "BLOCKED_UNSUPPORTED";
        reasons.push(`UNSUPPORTED_EVENT_${primary.eventType}`);
      } else {
        if (primary.kind === "NATIVE_DOCUMENT") reasons.push(...documentValidation(primary));
        if (primary.kind === "JOURNAL_ENTRY") reasons.push(...journalEntryValidation(primary));
        if (primary.kind === "CONTACT_CANDIDATE" && conflictedContactFactIds.has(primary.factId)) {
          reasons.push(CONTACT_DOCUMENT_CURRENCY_MISMATCH);
        }
        disposition = blockingControls.length > 0 || reasons.some((reason) => !reason.startsWith("CONTROL_WARNING_"))
          ? "BLOCKED_VALIDATION"
          : "AUTO_EXECUTE";
      }
    }
    const route = primary ? eventRoute(primary) : undefined;
    events.push({
      eventId: `qboevt_${hashObject({ caseId: input.caseId, version, eventKey }).slice(0, 32)}`,
      eventKey,
      ...(primary ? { primaryFactId: primary.factId } : {}),
      factIds: facts.map((fact) => fact.factId),
      sourceUnitIds: uniqueSorted(facts.flatMap((fact) => fact.sourceUnitIds)),
      disposition,
      reasonCodes: uniqueSorted(reasons),
      ...(route ? { route } : {}),
      ...(primary?.kind === "UNSUPPORTED_EVENT" ? { unsupportedEventType: primary.eventType } : {}),
    });
  }

  if (missingFactRequirements.length > 0) {
    const affected = new Set(missingFactRequirements.map((entry) => entry.slice(0, entry.lastIndexOf(":"))));
    for (const event of events) {
      if (event.sourceUnitIds.some((unitId) => affected.has(unitId))) {
        event.disposition = "BLOCKED_COVERAGE";
        event.reasonCodes = uniqueSorted([...event.reasonCodes, "SOURCE_FACT_COVERAGE_INCOMPLETE"]);
      }
    }
  }

  const factById = new Map(activeFacts.map((fact) => [fact.factId, fact]));
  const operationCandidates = events.flatMap((event) => {
    const primary = event.primaryFactId ? factById.get(event.primaryFactId) : undefined;
    if (!primary) return [];
    const candidate = operationCandidate(input.caseId, version, sourceRevisionHash, event, primary);
    return candidate ? [candidate] : [];
  });
  const blockedCoverage = missingFactRequirements.length > 0 || events.some((event) => event.disposition === "BLOCKED_COVERAGE");
  const blockedValidation = events.some((event) => event.disposition === "BLOCKED_VALIDATION");
  const exceptions = events.some((event) =>
    event.disposition === "REVIEW_REQUIRED" || event.disposition === "BLOCKED_UNSUPPORTED");
  return {
    caseId: input.caseId,
    version,
    providerId: "quickbooks",
    sourceRevisionHash,
    compilerVersion: QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION,
    policyVersion: QUICKBOOKS_ACCOUNTING_CASE_POLICY_VERSION,
    sources: sortedSources,
    activeFacts,
    events,
    operationCandidates,
    status: blockedCoverage ? "BLOCKED_COVERAGE" : blockedValidation ? "BLOCKED_VALIDATION" :
      exceptions ? "PLANNED_WITH_EXCEPTIONS" : "PLANNED_NEEDS_PREFLIGHT",
    coverage: {
      expectedArtifactCount: sortedSources.length,
      expectedSourceUnitCount: sortedSources.reduce((sum, source) => sum + source.units.length, 0),
      expectedFactRequirementCount,
      satisfiedFactRequirementCount,
      missingFactRequirements: uniqueSorted(missingFactRequirements),
    },
  };
}
