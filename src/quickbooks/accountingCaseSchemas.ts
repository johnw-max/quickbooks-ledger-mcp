import { z } from "zod/v4";
import {
  QUICKBOOKS_ACCOUNTING_FACT_KINDS,
  QUICKBOOKS_UNSUPPORTED_EVENT_TYPES,
} from "./accountingCase.js";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/u);
const targetSessionRef = z.string().startsWith("qbts_v1.").max(2_048);

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(isRealDate, "must be a real calendar date");
const currency = z.string().regex(/^[A-Z]{3}$/u);
const decimal4 = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/u);
const money = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u).refine((value) => !/^0{64}$/u.test(value), "must not be all zeroes");
const positiveDecimal4 = decimal4.refine((value) => Number(value) > 0, "must be greater than zero");

const sourceUnit = z.object({
  unitId: id.describe("Stable id for one accounting source unit. Use this exact id in every fact that covers the unit."),
  expectedFactKinds: z.array(z.enum(QUICKBOOKS_ACCOUNTING_FACT_KINDS)).min(1)
    .refine((values) => new Set(values).size === values.length, "expected fact kinds must be unique")
    .describe("Fact kinds required to give this source unit complete typed coverage."),
}).strict().describe("One typed source unit. Do not pass a bare string.");

const sourceArtifact = z.object({
  artifactId: id,
  label: z.string().trim().min(1).max(256),
  units: z.array(sourceUnit).min(1).max(256)
    .describe("Objects shaped as {unitId, expectedFactKinds}; bare string unit ids are invalid."),
  sourceRef: z.string().trim().min(1).max(2_048).optional(),
  sourceSha256: sha256.optional(),
  sourceDigestProvenance: z.enum([
    "AGENT_SUPPLIED_TEXT_FINGERPRINT",
    "HOST_PROVIDED_ORIGINAL_FILE_SHA256",
    "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256",
  ]).optional(),
  sourceAttestationRef: z.string().trim().min(1).max(2_048).optional()
    .describe("Use only with HOST_PROVIDED_ORIGINAL_FILE_SHA256 and a server-verifiable host attestation. Never invent this for chat images."),
}).strict().superRefine((value, context) => {
  const identityCount = [value.sourceRef, value.sourceSha256, value.sourceDigestProvenance]
    .filter((candidate) => candidate !== undefined).length;
  if (identityCount !== 0 && identityCount !== 3) {
    context.addIssue({
      code: "custom",
      path: ["sourceRef"],
      message: "sourceRef, sourceSha256 and sourceDigestProvenance must be supplied together",
    });
  }
  if (value.sourceDigestProvenance === "HOST_PROVIDED_ORIGINAL_FILE_SHA256" && !value.sourceAttestationRef) {
    context.addIssue({
      code: "custom",
      path: ["sourceAttestationRef"],
      message: "host-provided source identity requires a server-verifiable attestation reference",
    });
  }
  if (value.sourceDigestProvenance !== "HOST_PROVIDED_ORIGINAL_FILE_SHA256" && value.sourceAttestationRef) {
    context.addIssue({
      code: "custom",
      path: ["sourceAttestationRef"],
      message: "sourceAttestationRef is only valid for host-provided source identity",
    });
  }
});

const factBase = {
  factId: id,
  lineageKey: id,
  eventKey: id,
  sourceUnitIds: z.array(id).min(1).max(64)
    .refine((values) => new Set(values).size === values.length, "source units must be unique"),
  origin: z.enum(["MODEL_EXTRACTED", "AGENT_ASSERTED"]),
  revision: z.number().int().min(1).max(1_000_000),
  supersedesFactId: id.optional(),
};

const contact = z.object({
  ...factBase,
  kind: z.literal("CONTACT_CANDIDATE"),
  role: z.enum(["CUSTOMER", "VENDOR"]),
  displayName: z.string().trim().min(1).max(255),
  email: z.string().email().optional(),
  companyName: z.string().trim().min(1).max(255).optional(),
}).strict();

const documentLine = z.object({
  lineId: id,
  description: z.string().trim().min(1).max(1_000),
  quantity: positiveDecimal4,
  unitAmount: decimal4,
  sourceTax: money,
  codingType: z.enum(["ITEM", "ACCOUNT"]),
  codingName: z.string().trim().min(1).max(255),
  taxCodeName: z.string().trim().min(1).max(255).optional(),
}).strict();

const document = z.object({
  ...factBase,
  kind: z.literal("NATIVE_DOCUMENT"),
  documentType: z.enum(["INVOICE", "BILL", "CREDIT_MEMO", "VENDOR_CREDIT"]),
  counterpartyName: z.string().trim().min(1).max(255),
  documentDate: date,
  dueDate: date.optional(),
  documentNumber: z.string().trim().min(1).max(21).optional(),
  currency,
  taxMode: z.enum(["NO_TAX", "TAX_EXCLUDED", "TAX_INCLUSIVE"]),
  lines: z.array(documentLine).min(1).max(100)
    .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, "line IDs must be unique"),
  declaredNet: money,
  declaredTax: money,
  declaredGross: money,
  businessReason: z.string().trim().min(3).max(1_000),
}).strict().superRefine((value, context) => {
  if (value.dueDate && value.dueDate < value.documentDate) {
    context.addIssue({ code: "custom", path: ["dueDate"], message: "must not be before documentDate" });
  }
  const salesSide = value.documentType === "INVOICE" || value.documentType === "CREDIT_MEMO";
  for (const [index, line] of value.lines.entries()) {
    if (salesSide && line.codingType !== "ITEM") {
      context.addIssue({ code: "custom", path: ["lines", index, "codingType"], message: "sales documents require ITEM coding" });
    }
    if (value.taxMode === "NO_TAX" && line.taxCodeName !== undefined) {
      context.addIssue({ code: "custom", path: ["lines", index, "taxCodeName"], message: "NO_TAX lines must not provide a tax code" });
    }
    if (value.taxMode !== "NO_TAX" && line.taxCodeName === undefined) {
      context.addIssue({ code: "custom", path: ["lines", index, "taxCodeName"], message: "taxable lines require an exact tax code name" });
    }
  }
});

const unsupportedEvent = z.object({
  ...factBase,
  kind: z.literal("UNSUPPORTED_EVENT"),
  eventType: z.enum(QUICKBOOKS_UNSUPPORTED_EVENT_TYPES),
  date,
  currency,
  amount: money,
  counterpartyName: z.string().trim().min(1).max(255).optional(),
  note: z.string().trim().min(1).max(1_000),
}).strict();

const evidence = z.object({
  ...factBase,
  kind: z.literal("EVIDENCE"),
  evidenceRole: z.enum(["SOURCE_DOCUMENT", "APPROVAL", "CORRESPONDENCE", "CONTROL_SUPPORT"]),
  relatedEventKey: id.optional(),
  note: z.string().trim().min(1).max(1_000),
}).strict();

const control = z.object({
  ...factBase,
  kind: z.literal("CONTROL_FINDING"),
  severity: z.enum(["INFO", "WARNING", "BLOCK_WRITE"]),
  relatedEventKey: id.optional(),
  code: z.string().trim().min(1).max(128).regex(/^[A-Z0-9_]+$/u),
  note: z.string().trim().min(1).max(1_000),
}).strict();

export const quickBooksAccountingFactSchema = z.discriminatedUnion("kind", [
  contact,
  document,
  unsupportedEvent,
  evidence,
  control,
]);

export const quickBooksPrepareAccountingCaseSchema = z.object({
  target_session_ref: targetSessionRef,
  case_id: id,
  expected_version: z.number().int().min(0),
  sources: z.array(sourceArtifact).min(1).max(1_000),
  facts: z.array(quickBooksAccountingFactSchema).min(1).max(10_000)
    .describe("Typed facts covering the declared units. A residual Case may compile to zero operations, but it still requires UNSUPPORTED_EVENT, EVIDENCE, or CONTROL_FINDING facts; never send an empty facts array."),
}).strict().superRefine((value, context) => {
  const artifactIds = value.sources.map((source) => source.artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "artifact IDs must be globally unique" });
  }
  const unitIds = value.sources.flatMap((source) => source.units.map((unit) => unit.unitId));
  if (new Set(unitIds).size !== unitIds.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "source unit IDs must be globally unique" });
  }
  const knownUnits = new Set(unitIds);
  const byId = new Map(value.facts.map((fact) => [fact.factId, fact]));
  if (byId.size !== value.facts.length) {
    context.addIssue({ code: "custom", path: ["facts"], message: "fact IDs must be globally unique" });
  }
  const successors = new Map<string, number>();
  for (const [index, fact] of value.facts.entries()) {
    for (const unitId of fact.sourceUnitIds) {
      if (!knownUnits.has(unitId)) {
        context.addIssue({ code: "custom", path: ["facts", index, "sourceUnitIds"], message: `unknown source unit ${unitId}` });
      }
    }
    if (fact.revision === 1 && fact.supersedesFactId) {
      context.addIssue({ code: "custom", path: ["facts", index, "supersedesFactId"], message: "revision 1 cannot supersede another fact" });
    }
    if (fact.revision > 1 && !fact.supersedesFactId) {
      context.addIssue({ code: "custom", path: ["facts", index, "supersedesFactId"], message: "revision greater than 1 must supersede its predecessor" });
    }
    if (!fact.supersedesFactId) continue;
    const predecessor = byId.get(fact.supersedesFactId);
    successors.set(fact.supersedesFactId, (successors.get(fact.supersedesFactId) ?? 0) + 1);
    if (!predecessor || predecessor.kind !== fact.kind || predecessor.lineageKey !== fact.lineageKey ||
        predecessor.eventKey !== fact.eventKey || predecessor.revision + 1 !== fact.revision) {
      context.addIssue({ code: "custom", path: ["facts", index, "supersedesFactId"], message: "invalid fact revision lineage" });
    }
  }
  if ([...successors.values()].some((count) => count > 1)) {
    context.addIssue({ code: "custom", path: ["facts"], message: "fact revision lineage cannot branch" });
  }
});

export const quickBooksExecuteAccountingCaseSchema = z.object({
  target_session_ref: targetSessionRef,
  case_id: id,
  case_version: z.number().int().positive(),
  request_id: id,
}).strict();

export const quickBooksGetAccountingCaseStatusSchema = z.object({
  target_session_ref: targetSessionRef,
  case_id: id,
  case_version: z.number().int().positive().optional(),
}).strict();

export type QuickBooksPrepareAccountingCaseInput = z.infer<typeof quickBooksPrepareAccountingCaseSchema>;
export type QuickBooksExecuteAccountingCaseInput = z.infer<typeof quickBooksExecuteAccountingCaseSchema>;
export type QuickBooksGetAccountingCaseStatusInput = z.infer<typeof quickBooksGetAccountingCaseStatusSchema>;
