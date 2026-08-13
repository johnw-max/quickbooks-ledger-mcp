import { hashObject } from "../security/hash.js";
import {
  QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION,
  QUICKBOOKS_ACCOUNTING_CASE_POLICY_VERSION,
  type QuickBooksAccountingFact,
  type QuickBooksCaseCompilationDraft,
  type QuickBooksCaseEvent,
  type QuickBooksCaseOperationCandidate,
  type QuickBooksNativeDocumentFact,
  type QuickBooksSourceArtifact,
} from "./accountingCase.js";

const SCALE = 10_000n;

function scaled(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "0000").slice(0, 4));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function stableFacts(facts: readonly QuickBooksAccountingFact[]): QuickBooksAccountingFact[] {
  const superseded = new Set(facts.flatMap((fact) => fact.supersedesFactId ? [fact.supersedesFactId] : []));
  return facts.filter((fact) => !superseded.has(fact.factId))
    .map((fact) => ({ ...fact, sourceUnitIds: uniqueSorted(fact.sourceUnitIds) }))
    .sort((left, right) => left.lineageKey.localeCompare(right.lineageKey, "en") || left.revision - right.revision ||
      left.factId.localeCompare(right.factId, "en"));
}

function documentValidation(fact: QuickBooksNativeDocumentFact): string[] {
  const reasons: string[] = [];
  const lineNet = fact.lines.reduce((sum, line) => sum + scaled(line.quantity) * scaled(line.unitAmount) / SCALE, 0n);
  const lineTax = fact.lines.reduce((sum, line) => sum + scaled(line.sourceTax), 0n);
  const declaredNet = scaled(fact.declaredNet);
  const declaredTax = scaled(fact.declaredTax);
  const declaredGross = scaled(fact.declaredGross);
  if (lineNet !== declaredNet) reasons.push("LINE_NET_DOES_NOT_MATCH_DECLARED_NET");
  if (lineTax !== declaredTax) reasons.push("LINE_TAX_DOES_NOT_MATCH_DECLARED_TAX");
  if (declaredNet + declaredTax !== declaredGross) reasons.push("NET_PLUS_TAX_DOES_NOT_MATCH_GROSS");
  if (fact.taxMode === "NO_TAX" && (declaredTax !== 0n || lineTax !== 0n)) reasons.push("NO_TAX_REQUIRES_ZERO_TAX");
  if (fact.taxMode !== "NO_TAX" && fact.lines.some((line) => !line.taxCodeName)) {
    reasons.push("TAX_CODE_REQUIRED");
  }
  return uniqueSorted(reasons);
}

function eventRoute(fact: QuickBooksAccountingFact): QuickBooksCaseEvent["route"] {
  if (fact.kind === "CONTACT_CANDIDATE") return "CONTACT_CREATE";
  if (fact.kind === "NATIVE_DOCUMENT") return fact.documentType;
  return undefined;
}

function operationCandidate(
  caseId: string,
  version: number,
  event: QuickBooksCaseEvent,
  primary: QuickBooksAccountingFact,
): QuickBooksCaseOperationCandidate | undefined {
  if (event.disposition !== "AUTO_EXECUTE" || !event.primaryFactId) return undefined;
  const operationId = `qboop_${hashObject({ caseId, version, eventId: event.eventId }).slice(0, 32)}`;
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
    };
  }
  if (primary.kind !== "NATIVE_DOCUMENT") return undefined;
  const mapping = {
    INVOICE: { actionId: "invoice.create", entity: "Invoice" as const },
    BILL: { actionId: "bill.create", entity: "Bill" as const },
    CREDIT_MEMO: { actionId: "credit_memo.create", entity: "CreditMemo" as const },
    VENDOR_CREDIT: { actionId: "vendor_credit.create", entity: "VendorCredit" as const },
  }[primary.documentType];
  return {
    operationId,
    eventId: event.eventId,
    actionId: mapping.actionId,
    entity: mapping.entity,
    operation: "CREATE",
    sourceUnitIds: event.sourceUnitIds,
    primaryFactId: primary.factId,
  };
}

export function compileQuickBooksAccountingCase(input: {
  caseId: string;
  expectedVersion: number;
  sources: readonly QuickBooksSourceArtifact[];
  facts: readonly QuickBooksAccountingFact[];
}): QuickBooksCaseCompilationDraft {
  const version = input.expectedVersion + 1;
  const activeFacts = stableFacts(input.facts);
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
    const primaryFacts = facts.filter((fact) => fact.kind === "CONTACT_CANDIDATE" || fact.kind === "NATIVE_DOCUMENT");
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
      if (primary.kind === "NATIVE_DOCUMENT") reasons.push(...documentValidation(primary));
      disposition = blockingControls.length > 0 || reasons.some((reason) => !reason.startsWith("CONTROL_WARNING_"))
        ? "BLOCKED_VALIDATION"
        : "AUTO_EXECUTE";
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
    const candidate = operationCandidate(input.caseId, version, event, primary);
    return candidate ? [candidate] : [];
  });
  const blockedCoverage = missingFactRequirements.length > 0 || events.some((event) => event.disposition === "BLOCKED_COVERAGE");
  const blockedValidation = events.some((event) => event.disposition === "BLOCKED_VALIDATION");
  const exceptions = events.some((event) => event.disposition === "REVIEW_REQUIRED");
  return {
    caseId: input.caseId,
    version,
    providerId: "quickbooks",
    sourceRevisionHash,
    compilerVersion: QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION,
    policyVersion: QUICKBOOKS_ACCOUNTING_CASE_POLICY_VERSION,
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
