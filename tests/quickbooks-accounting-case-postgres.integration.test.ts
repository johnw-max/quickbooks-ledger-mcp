import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQuickBooksMigrations } from "../src/quickbooks/migrate.js";
import { QuickBooksPostgresAccountingCaseRepository } from "../src/quickbooks/postgresAccountingCaseRepository.js";
import { compileQuickBooksAccountingCase } from "../src/quickbooks/accountingCaseCompiler.js";
import { hashObject } from "../src/security/hash.js";
import { issueDeterministicValidationReceipt } from "../src/ledger-control/deterministicValidation.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres QuickBooks Accounting Case integration", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 4 }) : undefined;
  const repository = pool ? new QuickBooksPostgresAccountingCaseRepository(pool) : undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runQuickBooksMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });
  afterAll(async () => { await pool?.end(); });

  it("persists an immutable plan, gates transitions, and records terminal evidence once", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const binding = {
      actorId: `ws-${suffix}:user:user-${suffix}`,
      workspaceId: `ws-${suffix}`,
      subjectType: "USER" as const,
      subjectId: `user-${suffix}`,
      agentId: `agent-${suffix}`,
      installationId: `installation-${suffix}`,
      bindingId: `binding-${suffix}`,
      bindingRevision: 1,
      connectionId: `connection-${suffix}`,
      realmId: "9341457701636490",
      targetSessionHash: hashObject({ suffix, target: "session" }),
    };
    const draft = compileQuickBooksAccountingCase({
      caseId: `case-${suffix}`,
      expectedVersion: 0,
      sources: [{ artifactId: `source-${suffix}`, label: "contact", units: [{
        unitId: `unit-${suffix}`, expectedFactKinds: ["CONTACT_CANDIDATE"],
      }] }],
      facts: [{
        factId: `fact-${suffix}`, lineageKey: `contact-${suffix}`, eventKey: `event-${suffix}`,
        sourceUnitIds: [`unit-${suffix}`], origin: "AGENT_ASSERTED", revision: 1,
        kind: "CONTACT_CANDIDATE", role: "CUSTOMER", displayName: `Customer ${suffix}`,
      }],
    });
    const payload = { DisplayName: `Customer ${suffix}` };
    const operation = draft.operationCandidates[0];
    if (!operation) throw new Error("expected operation");
    const compiled = {
      ...draft,
      realmId: binding.realmId,
      companyName: "Sandbox",
      baseCurrency: "SGD",
      operations: [{
        ...operation,
        canonicalPayload: payload,
        canonicalPayloadHash: hashObject(payload),
        validationReceipt: issueDeterministicValidationReceipt({
          actionId: operation.actionId,
          canonicalPayloadHash: hashObject(payload),
          sourceRevisionHash: draft.sourceRevisionHash,
          caseId: draft.caseId,
          caseVersion: draft.version,
          policyVersion: draft.policyVersion,
          compilerVersion: draft.compilerVersion,
          checks: [{ code: "TEST", evidence: { passed: true } }],
          now: new Date(),
        }),
      }],
    };
    const compiledPlanHash = hashObject({ schemaVersion: "quickbooks-accounting-case-plan:v1", binding, compiled });
    const created = await repository.createOrAdvance({ binding, compiled, compiledPlanHash, now: new Date() });
    expect(created).toMatchObject({ mode: "CREATED", record: { state: "PLANNED_NEEDS_PREFLIGHT" } });
    await expect(repository.createOrAdvance({ binding, compiled, compiledPlanHash, now: new Date() }))
      .resolves.toMatchObject({ mode: "IDEMPOTENT_REPLAY" });

    const requestId = `execute-${suffix}`;
    await repository.claimExecution({
      binding, caseId: compiled.caseId, version: 1, requestId, expectedPlanHash: compiledPlanHash, now: new Date(),
    });
    await repository.updateOperation({
      binding, caseId: compiled.caseId, version: 1, operationId: operation.operationId,
      requestId, expectedStates: ["PENDING"], state: "PREPARED", preparationId: `qbm_${suffix}`, now: new Date(),
    });
    const verified = await repository.updateOperation({
      binding, caseId: compiled.caseId, version: 1, operationId: operation.operationId,
      requestId, expectedStates: ["PREPARED"], state: "READBACK_VERIFIED", preparationId: `qbm_${suffix}`,
      mutationRequestId: `mutation-${suffix}`, providerEntityId: `customer-${suffix}`,
      authorizationReceipt: { allowed: true }, writeReceipt: { requestId: `provider-${suffix}` },
      readback: { Id: `customer-${suffix}` }, now: new Date(),
    });
    expect(verified.operations[0]).toMatchObject({ state: "READBACK_VERIFIED", providerEntityId: `customer-${suffix}` });
    await expect(repository.finalize({
      binding, caseId: compiled.caseId, version: 1, requestId, state: "TERMINAL",
      terminalSummary: { completion: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" }, now: new Date(),
    })).resolves.toMatchObject({ state: "TERMINAL" });
    await expect(repository.updateOperation({
      binding, caseId: compiled.caseId, version: 1, operationId: operation.operationId,
      requestId, expectedStates: ["READBACK_VERIFIED"], state: "PROVIDER_REJECTED",
      errorReceipt: { code: "LATE_REWRITE" }, now: new Date(),
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
