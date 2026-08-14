import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashObject } from "../src/security/hash.js";
import type {
  QuickBooksAccountingFact,
  QuickBooksCaseOperation,
  QuickBooksNativeDocumentFact,
} from "../src/quickbooks/accountingCase.js";
import {
  compileQuickBooksAccountingCase,
  validateQuickBooksCompiledOperationAgainstSource,
} from "../src/quickbooks/accountingCaseCompiler.js";
import { quickBooksPrepareAccountingCaseSchema } from "../src/quickbooks/accountingCaseSchemas.js";

const raw = JSON.parse(readFileSync(fileURLToPath(new URL(
  "./fixtures/quickbooks-golden-14-case.v1.json",
  import.meta.url,
)), "utf8"));
const input = quickBooksPrepareAccountingCaseSchema.parse(raw);

function compile() {
  return compileQuickBooksAccountingCase({
    caseId: input.case_id,
    expectedVersion: input.expected_version,
    sources: input.sources.map((source) => ({
      artifactId: source.artifactId,
      label: source.label,
      units: source.units,
      ...(source.sourceRef ? { sourceRef: source.sourceRef } : {}),
      ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}),
      ...(source.sourceDigestProvenance ? { sourceDigestProvenance: source.sourceDigestProvenance } : {}),
      ...(source.sourceAttestationRef ? { sourceAttestationRef: source.sourceAttestationRef } : {}),
    })),
    facts: input.facts as QuickBooksAccountingFact[],
  });
}

describe("QuickBooks Accounting Case golden-14", () => {
  it("accounts for 14 supplied artifacts without pretending that 14 artifacts mean 14 writes", () => {
    const compiled = compile();
    expect(compiled).toMatchObject({
      status: "PLANNED_WITH_EXCEPTIONS",
      coverage: {
        expectedArtifactCount: 14,
        expectedSourceUnitCount: 18,
        missingFactRequirements: [],
      },
    });
    expect(compiled.events).toHaveLength(15);
    expect(compiled.operationCandidates).toHaveLength(6);
    expect(compiled.events.filter((event) => event.disposition === "BLOCKED_UNSUPPORTED")).toHaveLength(8);
    expect(compiled.events.find((event) => event.eventKey === "cloudhost-bill")).toMatchObject({
      disposition: "BLOCKED_UNSUPPORTED",
      unsupportedEventType: "FOREIGN_CURRENCY_BILL",
      reasonCodes: ["UNSUPPORTED_EVENT_FOREIGN_CURRENCY_BILL"],
    });
    expect(compiled.operationCandidates.every((operation) =>
      !compiled.events.some((event) => event.eventId === operation.eventId && event.disposition === "BLOCKED_UNSUPPORTED")))
      .toBe(true);
  });

  it("gives every source unit at least one explicit terminal business disposition", () => {
    const compiled = compile();
    const terminal = new Set(compiled.events.flatMap((event) => event.sourceUnitIds));
    for (const unit of compiled.sources.flatMap((source) => source.units)) {
      expect(terminal.has(unit.unitId), `${unit.unitId} must have a typed terminal event`).toBe(true);
    }
    expect(compiled.events.find((event) => event.eventKey === "customer-payment")).toMatchObject({
      disposition: "BLOCKED_UNSUPPORTED",
      unsupportedEventType: "PAYMENT",
      reasonCodes: ["UNSUPPORTED_EVENT_PAYMENT"],
    });
  });

  it("bridges the genuine OfficeHub 80 + 7.20 vendor credit and rejects an 80-to-800 mutation", () => {
    const compiled = compile();
    const candidate = compiled.operationCandidates.find((operation) => operation.entity === "VendorCredit");
    const fact = compiled.activeFacts.find((entry): entry is QuickBooksNativeDocumentFact =>
      entry.kind === "NATIVE_DOCUMENT" && entry.factId === candidate?.primaryFactId);
    if (!candidate || !fact) throw new Error("golden vendor credit operation missing");
    const canonicalPayload = {
      VendorRef: { value: "vendor-1" },
      Line: [{ Amount: 80, DetailType: "AccountBasedExpenseLineDetail" }],
      TxnTaxDetail: { TotalTax: 7.2 },
    };
    const operation = {
      ...candidate,
      canonicalPayload,
      canonicalPayloadHash: hashObject(canonicalPayload),
      validationReceipt: {} as QuickBooksCaseOperation["validationReceipt"],
    } satisfies QuickBooksCaseOperation;
    expect(validateQuickBooksCompiledOperationAgainstSource(operation, fact)).toEqual([]);

    const mutatedPayload = {
      ...canonicalPayload,
      Line: [{ Amount: 800, DetailType: "AccountBasedExpenseLineDetail" }],
    };
    const mutated = {
      ...operation,
      canonicalPayload: mutatedPayload,
      canonicalPayloadHash: hashObject(mutatedPayload),
    };
    expect(validateQuickBooksCompiledOperationAgainstSource(mutated, fact)).toEqual(expect.arrayContaining([
      "CANONICAL_NET_MISMATCH",
      "CANONICAL_GROSS_MISMATCH",
    ]));
  });

  it("keeps source attestation optional, but rejects incomplete or self-labelled host claims", () => {
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(raw).success).toBe(true);
    const incomplete = structuredClone(raw);
    incomplete.sources[0].sourceRef = "workstore:file-1";
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(incomplete).success).toBe(false);

    const unverified = structuredClone(raw);
    Object.assign(unverified.sources[0], {
      sourceRef: "external:file-1",
      sourceSha256: "a".repeat(64),
      sourceDigestProvenance: "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256",
    });
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(unverified).success).toBe(true);

    const falseHostClaim = structuredClone(unverified);
    falseHostClaim.sources[0].sourceDigestProvenance = "HOST_PROVIDED_ORIGINAL_FILE_SHA256";
    expect(quickBooksPrepareAccountingCaseSchema.safeParse(falseHostClaim).success).toBe(false);
  });
});
