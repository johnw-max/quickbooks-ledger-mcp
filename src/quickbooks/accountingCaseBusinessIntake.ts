import { z } from "zod/v4";
import { hashObject } from "../security/hash.js";
import {
  QUICKBOOKS_ACCOUNTING_FACT_KINDS,
  QUICKBOOKS_UNSUPPORTED_EVENT_TYPES,
} from "./accountingCase.js";
import { quickBooksPrepareAccountingCaseSchema } from "./accountingCaseSchemas.js";

const publicId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/u);
const targetSessionRef = z.string().startsWith("qbts_v1.").max(2_048);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");
const currency = z.string().regex(/^[A-Z]{3}$/u);
// A rate needs finer precision than money and must be strictly positive;
// "0" and "0.0" are rejected by the leading-digit alternation.
const exchangeRate = z.string().regex(/^(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d{1,10})?)$/u);
const decimal4 = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/u);
const money = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u);
const positiveDecimal4 = decimal4.refine((value) => Number(value) > 0, "must be greater than zero");
const origin = z.enum(["MODEL_EXTRACTED", "AGENT_ASSERTED"]).optional().describe(
  "Use AGENT_ASSERTED for a value explicitly corrected or confirmed by the user; otherwise omit for MODEL_EXTRACTED.",
);

const businessContact = z.object({
  kind: z.literal("CONTACT"),
  origin,
  event_key: publicId.optional(),
  role: z.enum(["CUSTOMER", "VENDOR"]),
  display_name: z.string().trim().min(1).max(255),
  email: z.string().email().optional(),
  company_name: z.string().trim().min(1).max(255).optional(),
}).strict();

const businessDocumentLine = z.object({
  description: z.string().trim().min(1).max(1_000),
  quantity: positiveDecimal4,
  unit_amount: decimal4,
  source_tax_amount: money.describe("Numeric tax amount for this line, for example 72.00; never put a tax-code name here."),
  coding_type: z.enum(["ITEM", "ACCOUNT"]),
  coding_name: z.string().trim().min(1).max(255),
  tax_code_name: z.string().trim().min(1).max(255).optional(),
}).strict();

const businessDocument = z.object({
  kind: z.literal("DOCUMENT"),
  origin,
  event_key: publicId.optional(),
  document_type: z.enum(["INVOICE", "BILL", "CREDIT_MEMO", "VENDOR_CREDIT", "PURCHASE"]),
  counterparty_name: z.string().trim().min(1).max(255),
  document_date: date,
  due_date: date.optional(),
  document_number: z.string().trim().min(1).max(21).optional(),
  currency,
  /**
   * Home-currency units per one unit of `currency`, as QuickBooks defines it.
   * Required only when `currency` differs from the ledger's home currency —
   * which this schema cannot know, so the service enforces it and says which
   * currencies it compared. Omit it for a home-currency document.
   */
  exchange_rate: exchangeRate.optional(),
  tax_mode: z.enum(["NO_TAX", "TAX_EXCLUDED", "TAX_INCLUSIVE"]),
  lines: z.array(businessDocumentLine).min(1).max(100),
  declared_net: money,
  declared_tax: money,
  declared_gross: money,
  business_reason: z.string().trim().min(3).max(1_000),
  payment_account_name: z.string().trim().min(1).max(255).optional().describe(
    "PURCHASE only, and required there: the exact QuickBooks bank or credit card account the money left from.",
  ),
  payment_type: z.enum(["CASH", "CHECK", "CREDIT_CARD"]).optional().describe(
    "PURCHASE only, and required there: how the money left. A Purchase records an outflow that already happened; it never initiates one.",
  ),
}).strict().superRefine((value, context) => {
  // These rules also exist on the internal Case schema, which stays the
  // trusted boundary. Stating them here as well is what makes them reachable:
  // the SDK validates this schema before the handler runs, so an Agent gets
  // the snake_case path it actually sent instead of a re-parse failure raised
  // from inside the handler against internal camelCase field names.
  if (value.due_date && value.due_date < value.document_date) {
    context.addIssue({ code: "custom", path: ["due_date"], message: "must not be before document_date" });
  }
  if (value.document_type === "PURCHASE") {
    if (!value.payment_account_name) {
      context.addIssue({ code: "custom", path: ["payment_account_name"], message: "a purchase requires the exact bank or credit card account the money came from" });
    }
    if (!value.payment_type) {
      context.addIssue({ code: "custom", path: ["payment_type"], message: "a purchase requires payment_type CASH, CHECK or CREDIT_CARD" });
    }
  } else {
    if (value.payment_account_name !== undefined) {
      context.addIssue({ code: "custom", path: ["payment_account_name"], message: "only a PURCHASE names a payment account" });
    }
    if (value.payment_type !== undefined) {
      context.addIssue({ code: "custom", path: ["payment_type"], message: "only a PURCHASE names a payment type" });
    }
  }
  const salesSide = value.document_type === "INVOICE" || value.document_type === "CREDIT_MEMO";
  for (const [index, line] of value.lines.entries()) {
    if (salesSide && line.coding_type !== "ITEM") {
      context.addIssue({ code: "custom", path: ["lines", index, "coding_type"], message: "sales documents require ITEM coding" });
    }
    if (value.tax_mode === "NO_TAX" && line.tax_code_name !== undefined) {
      context.addIssue({ code: "custom", path: ["lines", index, "tax_code_name"], message: "NO_TAX lines must not provide a tax code" });
    }
    if (value.tax_mode !== "NO_TAX" && line.tax_code_name === undefined) {
      context.addIssue({ code: "custom", path: ["lines", index, "tax_code_name"], message: "taxable lines require an exact tax code name" });
    }
  }
});

const businessJournalEntryLine = z.object({
  description: z.string().trim().min(1).max(1_000),
  posting_type: z.enum(["DEBIT", "CREDIT"]),
  account_name: z.string().trim().min(1).max(255).describe(
    "Exact QuickBooks chart-of-accounts name. Read it from `quickbooks_list_accounts`; the server resolves it exactly and refuses an absent or ambiguous name rather than guessing.",
  ),
  amount: money.refine((value) => Number(value) > 0, "must be greater than zero"),
}).strict();

const businessJournalEntry = z.object({
  kind: z.literal("JOURNAL_ENTRY"),
  origin,
  event_key: publicId.optional(),
  entry_date: date,
  document_number: z.string().trim().min(1).max(21).optional(),
  currency,
  exchange_rate: exchangeRate.optional(),
  lines: z.array(businessJournalEntryLine).min(2).max(100),
  declared_total: money.refine((value) => Number(value) > 0, "must be greater than zero").describe(
    "The entry's own total. Total debits and total credits must each equal it exactly.",
  ),
  business_reason: z.string().trim().min(3).max(1_000),
}).strict().superRefine((value, context) => {
  if (!value.lines.some((line) => line.posting_type === "DEBIT")) {
    context.addIssue({ code: "custom", path: ["lines"], message: "a journal entry requires at least one debit line" });
  }
  if (!value.lines.some((line) => line.posting_type === "CREDIT")) {
    context.addIssue({ code: "custom", path: ["lines"], message: "a journal entry requires at least one credit line" });
  }
});

const businessUnsupportedEvent = z.object({
  kind: z.literal("UNSUPPORTED_EVENT"),
  origin,
  event_key: publicId.optional(),
  event_type: z.enum(QUICKBOOKS_UNSUPPORTED_EVENT_TYPES),
  date,
  currency,
  amount: money,
  counterparty_name: z.string().trim().min(1).max(255).optional(),
  note: z.string().trim().min(1).max(1_000),
}).strict();

const businessEvidence = z.object({
  kind: z.literal("EVIDENCE"),
  origin,
  event_key: publicId.optional(),
  evidence_role: z.enum(["SOURCE_DOCUMENT", "APPROVAL", "CORRESPONDENCE", "CONTROL_SUPPORT"]),
  note: z.string().trim().min(1).max(1_000),
}).strict();

const businessControlFinding = z.object({
  kind: z.literal("CONTROL_FINDING"),
  origin,
  event_key: publicId.optional(),
  severity: z.enum(["INFO", "WARNING", "BLOCK_WRITE"]),
  code: z.string().trim().min(1).max(128).regex(/^[A-Z0-9_]+$/u),
  note: z.string().trim().min(1).max(1_000),
}).strict();

const businessFact = z.discriminatedUnion("kind", [
  businessContact,
  businessDocument,
  businessJournalEntry,
  businessUnsupportedEvent,
  businessEvidence,
  businessControlFinding,
]);

const businessSourceUnit = z.object({
  unit_key: publicId.describe("Stable business key for this source unit, for example bank-row-2026-07-25."),
  facts: z.array(businessFact).min(1).max(64).describe(
    "Business facts for this unit. The server creates fact ids, lineage, source links, and default event keys.",
  ),
}).strict();

const businessSource = z.object({
  source_key: publicId.describe("Stable source key such as a document number or upload manifest id."),
  label: z.string().trim().min(1).max(256),
  units: z.array(businessSourceUnit).min(1).max(256),
}).strict();

/**
 * Agent-facing business intake. The strict internal Case schema remains the
 * trusted compiler boundary; Agents never manufacture its ids or lineage.
 */
export const quickBooksAccountingCaseBusinessIntakeSchema = z.object({
  target_session_ref: targetSessionRef,
  case_id: publicId,
  expected_version: z.number().int().min(0),
  source_set_complete: z.literal(true).describe(
    "The submitted bounded set is complete; this never claims the whole ledger or real-world population is complete.",
  ),
  sources: z.array(businessSource).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  const sourceKeys = value.sources.map((source) => source.source_key);
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "source keys must be unique" });
  }
  for (const [sourceIndex, source] of value.sources.entries()) {
    const unitKeys = source.units.map((unit) => unit.unit_key);
    if (new Set(unitKeys).size !== unitKeys.length) {
      context.addIssue({ code: "custom", path: ["sources", sourceIndex, "units"], message: "unit keys must be unique within one source" });
    }
  }
});

export type QuickBooksAccountingCaseBusinessIntake = z.infer<typeof quickBooksAccountingCaseBusinessIntakeSchema>;

function derivedId(prefix: string, material: unknown): string {
  return `${prefix}-${hashObject(material).slice(0, 32)}`;
}

function internalKind(kind: z.infer<typeof businessFact>["kind"]): typeof QUICKBOOKS_ACCOUNTING_FACT_KINDS[number] {
  if (kind === "CONTACT") return "CONTACT_CANDIDATE";
  if (kind === "DOCUMENT") return "NATIVE_DOCUMENT";
  return kind;
}

/** Deterministic transport normalization; no provider or accounting-policy decision occurs here. */
export function normalizeQuickBooksAccountingCaseBusinessIntake(raw: QuickBooksAccountingCaseBusinessIntake) {
  const intake = quickBooksAccountingCaseBusinessIntakeSchema.parse(raw);
  const sources = intake.sources.map((source) => ({
    artifactId: derivedId("source", { caseId: intake.case_id, sourceKey: source.source_key }),
    label: source.label,
    units: source.units.map((unit) => ({
      unitId: derivedId("unit", { caseId: intake.case_id, sourceKey: source.source_key, unitKey: unit.unit_key }),
      expectedFactKinds: [...new Set(unit.facts.map((fact) => internalKind(fact.kind)))].sort(),
    })),
  }));

  const facts = intake.sources.flatMap((source, sourceIndex) => source.units.flatMap((unit, unitIndex) =>
    unit.facts.map((fact, factIndex) => {
      const sourceUnitIds = [sources[sourceIndex]!.units[unitIndex]!.unitId];
      const identity = {
        caseId: intake.case_id,
        sourceKey: source.source_key,
        unitKey: unit.unit_key,
        factIndex,
        kind: fact.kind,
      };
      const factId = derivedId("fact", identity);
      const lineageKey = derivedId("lineage", identity);
      const eventKey = fact.event_key ?? derivedId("event", {
        caseId: intake.case_id,
        sourceKey: source.source_key,
        unitKey: unit.unit_key,
      });
      const base = {
        factId,
        lineageKey,
        eventKey,
        sourceUnitIds,
        origin: fact.origin ?? "MODEL_EXTRACTED" as const,
        revision: 1,
      };
      if (fact.kind === "CONTACT") return {
        ...base,
        kind: "CONTACT_CANDIDATE" as const,
        role: fact.role,
        displayName: fact.display_name,
        ...(fact.email ? { email: fact.email } : {}),
        ...(fact.company_name ? { companyName: fact.company_name } : {}),
      };
      if (fact.kind === "DOCUMENT") return {
        ...base,
        kind: "NATIVE_DOCUMENT" as const,
        documentType: fact.document_type,
        counterpartyName: fact.counterparty_name,
        documentDate: fact.document_date,
        ...(fact.due_date ? { dueDate: fact.due_date } : {}),
        ...(fact.document_number ? { documentNumber: fact.document_number } : {}),
        currency: fact.currency,
        ...(fact.exchange_rate ? { exchangeRate: fact.exchange_rate } : {}),
        taxMode: fact.tax_mode,
        lines: fact.lines.map((line, lineIndex) => ({
          lineId: derivedId("line", { ...identity, lineIndex }),
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unit_amount,
          sourceTax: line.source_tax_amount,
          codingType: line.coding_type,
          codingName: line.coding_name,
          ...(line.tax_code_name ? { taxCodeName: line.tax_code_name } : {}),
        })),
        declaredNet: fact.declared_net,
        declaredTax: fact.declared_tax,
        declaredGross: fact.declared_gross,
        businessReason: fact.business_reason,
        ...(fact.payment_account_name ? { paymentAccountName: fact.payment_account_name } : {}),
        ...(fact.payment_type ? { paymentType: fact.payment_type } : {}),
      };
      if (fact.kind === "JOURNAL_ENTRY") return {
        ...base,
        kind: "JOURNAL_ENTRY" as const,
        entryDate: fact.entry_date,
        ...(fact.document_number ? { documentNumber: fact.document_number } : {}),
        currency: fact.currency,
        ...(fact.exchange_rate ? { exchangeRate: fact.exchange_rate } : {}),
        lines: fact.lines.map((line, lineIndex) => ({
          lineId: derivedId("line", { ...identity, lineIndex }),
          description: line.description,
          postingType: line.posting_type,
          accountName: line.account_name,
          amount: line.amount,
        })),
        declaredTotal: fact.declared_total,
        businessReason: fact.business_reason,
      };
      if (fact.kind === "UNSUPPORTED_EVENT") return {
        ...base,
        kind: fact.kind,
        eventType: fact.event_type,
        date: fact.date,
        currency: fact.currency,
        amount: fact.amount,
        ...(fact.counterparty_name ? { counterpartyName: fact.counterparty_name } : {}),
        note: fact.note,
      };
      if (fact.kind === "EVIDENCE") return {
        ...base,
        kind: fact.kind,
        evidenceRole: fact.evidence_role,
        note: fact.note,
      };
      return {
        ...base,
        kind: fact.kind,
        severity: fact.severity,
        code: fact.code,
        note: fact.note,
      };
    })));

  return quickBooksPrepareAccountingCaseSchema.parse({
    target_session_ref: intake.target_session_ref,
    case_id: intake.case_id,
    expected_version: intake.expected_version,
    sources,
    facts,
  });
}
