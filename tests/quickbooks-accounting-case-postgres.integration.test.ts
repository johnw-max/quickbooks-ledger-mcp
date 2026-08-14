import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runQuickBooksMigrations } from "../src/quickbooks/migrate.js";
import { QuickBooksPostgresAccountingCaseRepository } from "../src/quickbooks/postgresAccountingCaseRepository.js";
import { compileQuickBooksAccountingCase } from "../src/quickbooks/accountingCaseCompiler.js";
import { hashObject } from "../src/security/hash.js";
import { issueDeterministicValidationReceipt } from "../src/ledger-control/deterministicValidation.js";
import { evaluateAutonomousLedgerWrite } from "../src/ledger-control/ledgerControlKernel.js";
import { issueQuickBooksAutonomousAuthorizationEvidence } from "../src/quickbooks/autonomousAuthorizationEvidence.js";
import { QuickBooksPostgresMutationRepository } from "../src/quickbooks/postgresMutationRepository.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";
import { quickBooksPrepareAccountingCaseSchema } from "../src/quickbooks/accountingCaseSchemas.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES } from "../src/quickbooks/accountingCase.js";
import type { RequestContext } from "../src/security/requestContext.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";

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
    if (!repository || !pool) throw new Error("TEST_DATABASE_URL is required");
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
    const validationReceipt = issueDeterministicValidationReceipt({
      actionId: operation.actionId,
      canonicalPayloadHash: hashObject(payload),
      sourceRevisionHash: draft.sourceRevisionHash,
      caseId: draft.caseId,
      caseVersion: draft.version,
      policyVersion: draft.policyVersion,
      compilerVersion: draft.compilerVersion,
      checks: [{ code: "TEST", evidence: { passed: true } }],
      now: new Date(),
    });
    const compiled = {
      ...draft,
      realmId: binding.realmId,
      companyName: "Sandbox",
      baseCurrency: "SGD",
      operations: [{
        ...operation,
        canonicalPayload: payload,
        canonicalPayloadHash: hashObject(payload),
        validationReceipt,
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
    const preparationId = `qbm_${suffix.replaceAll("-", "").slice(0, 32)}`;
    const preparationPayloadHash = hashObject(payload);
    const clientRequestId = `client-${suffix}`;
    const providerRequestId = `provider-${suffix}`;
    await pool?.query(`INSERT INTO quickbooks_mutation_preparations(
      preparation_id,actor_id,realm_id,connection_ref_safe,bound_target_ref_safe,binding_revision,
      entity,operation,risk,execution_mode,provider_effect,client_request_id,provider_request_id,
      payload,payload_hash,business_reason,confirmation_phrase_hash,state,created_at,expires_at,updated_at
    ) VALUES($1,$2,$3,'qbc-test','qbt-test','qbr-test','Customer','CREATE','LOW','EXPLICIT_CONFIRMATION',
      'MASTER_DATA',$4,$5,$6::jsonb,$7,'Postgres Case linkage integration test',$8,'PREPARED',$9,$10,$9)`, [
      preparationId, binding.actorId, binding.realmId, clientRequestId, providerRequestId,
      JSON.stringify(payload), preparationPayloadHash, hashObject({ confirmation: suffix }),
      new Date(), new Date(Date.now() + 60_000),
    ]);
    await repository.updateOperation({
      binding, caseId: compiled.caseId, version: 1, operationId: operation.operationId,
      requestId, expectedStates: ["PENDING"], state: "PREPARED", preparationId,
      preparationPayloadHash, operationSourceEvidenceHash: operation.sourceEvidenceHash,
      now: new Date(),
    });
    const uncertain = await repository.updateOperation({
      binding, caseId: compiled.caseId, version: 1, operationId: operation.operationId,
      requestId, expectedStates: ["PREPARED"], state: "WRITE_UNCERTAIN", preparationId,
      mutationRequestId: clientRequestId, providerEntityId: `customer-${suffix}`,
      errorReceipt: { code: "WRITE_RESULT_UNKNOWN", providerMutationRetried: false }, now: new Date(),
    });
    expect(uncertain.operations[0]).toMatchObject({ state: "WRITE_UNCERTAIN", providerEntityId: `customer-${suffix}` });
    await expect(repository.finalize({
      binding, caseId: compiled.caseId, version: 1, requestId, state: "RECOVERY_REQUIRED",
      terminalSummary: { completion: "RECOVERY_REQUIRED" }, now: new Date(),
    })).resolves.toMatchObject({ state: "RECOVERY_REQUIRED" });

    const providerCapabilityReceiptHash = hashObject({ capability: "CREATE:Customer", suffix });
    const decision = evaluateAutonomousLedgerWrite({
      actionId: operation.actionId,
      canonicalPayloadHash: hashObject(payload),
      sourceRevisionHash: draft.sourceRevisionHash,
      caseVersion: 1,
      principal: {
        actorId: binding.actorId,
        workspaceId: binding.workspaceId,
        agentId: binding.agentId,
        installationId: binding.installationId,
        bindingId: binding.bindingId,
        bindingRevision: binding.bindingRevision,
        connectionId: binding.connectionId,
      },
      target: {
        providerId: "quickbooks",
        tenantId: binding.realmId,
        targetSessionId: `target-${suffix}`,
        targetSessionExpiresAt: new Date(Date.now() + 60_000),
      },
      standingDelegations: [{
        delegationId: `delegation-${suffix}`,
        revision: 1,
        status: "ACTIVE",
        providerId: "quickbooks",
        workspaceId: binding.workspaceId,
        agentId: binding.agentId,
        installationId: binding.installationId,
        tenantIds: [binding.realmId],
        actionIds: [operation.actionId],
      }],
      writeKillSwitchEnabled: true,
      staticActionReleased: true,
      transportScopeAllowed: true,
      providerAccessDenyReasons: [],
      providerCapabilityReceiptHash,
      validation: { passed: true, receiptHash: validationReceipt.receiptHash },
      now: new Date(validationReceipt.issuedAt),
    });
    if (!decision.allowed) throw new Error("expected autonomous authorization");
    const authorizationRecordedAt = new Date();
    const authorizationEvidence = issueQuickBooksAutonomousAuthorizationEvidence({
      preparationId,
      providerRequestId,
      stableOperationKey: operation.stableOperationKey,
      actionId: operation.actionId,
      preparationPayloadHash,
      canonicalPayloadHash: hashObject(payload),
      caseId: compiled.caseId,
      caseVersion: 1,
      sourceRevisionHash: draft.sourceRevisionHash,
      deterministicValidationReceipt: validationReceipt,
      authorizationReceipt: decision.receipt,
      recordedAt: authorizationRecordedAt,
    });
    const providerEntityId = `customer-${suffix}`;
    const writeReceipt = { requestId: providerRequestId, providerEntityId, verified: true };
    const readback = { Id: providerEntityId };
    const mutationRepository = new QuickBooksPostgresMutationRepository(pool);
    await mutationRepository.recordAutonomousAuthorizationEvidence({
      preparationId,
      actorId: binding.actorId,
      evidence: authorizationEvidence,
      now: authorizationRecordedAt,
    });
    const leaseTokenHash = hashObject({ lease: suffix });
    await expect(mutationRepository.claimForExecution({
      preparationId,
      actorId: binding.actorId,
      requestId: clientRequestId,
      approvedBy: binding.actorId,
      leaseOwner: `human-worker-${suffix}`,
      leaseTokenHash,
      leaseDurationMs: 120_000,
      now: new Date(authorizationRecordedAt.getTime() + 1),
    })).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
      details: {
        failureLayer: "AUTHORIZATION_CAUSALITY",
        reasonCodes: ["AUTHORIZATION_CLAIM_ACTOR_MISMATCH"],
      },
    });
    await expect(pool.query(
      `UPDATE quickbooks_mutation_preparations
       SET state='EXECUTING',approved_by=$2,approved_at=$3
       WHERE preparation_id=$1`,
      [preparationId, binding.actorId, new Date(authorizationRecordedAt.getTime() + 1)],
    )).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("only be claimed by its original standing delegation"),
    });
    const claimed = await mutationRepository.claimForExecution({
      preparationId,
      actorId: binding.actorId,
      requestId: clientRequestId,
      approvedBy: `standing:${decision.delegation.delegationId}`,
      leaseOwner: `test-worker-${suffix}`,
      leaseTokenHash,
      leaseDurationMs: 120_000,
      now: new Date(authorizationRecordedAt.getTime() + 1),
    });
    const attemptId = claimed.preparation.executionAttempt?.attemptId;
    if (!attemptId) throw new Error("expected durable execution attempt");
    await mutationRepository.markDispatchStarted({
      preparationId,
      attemptId,
      leaseTokenHash,
      now: new Date(authorizationRecordedAt.getTime() + 2),
    });
    await mutationRepository.recordProviderOutcome({
      preparationId,
      attemptId,
      leaseTokenHash,
      providerEntityId,
      providerOutcomeReceipt: { evidenceType: "PROVIDER_OUTCOME_CHECKPOINT", providerEntityId },
      now: new Date(authorizationRecordedAt.getTime() + 3),
    });
    await mutationRepository.completeVerified({
      preparationId,
      providerEntityId,
      receipt: writeReceipt,
      readback,
      now: new Date(authorizationRecordedAt.getTime() + 4),
    });

    const verified = await repository.updateOperation({
      binding, caseId: compiled.caseId, version: 1, operationId: operation.operationId,
      requestId, expectedStates: ["WRITE_UNCERTAIN"], state: "READBACK_VERIFIED", preparationId,
      mutationRequestId: clientRequestId, providerEntityId,
      authorizationReceipt: decision.receipt as unknown as Record<string, unknown>,
      authorizationEvidence,
      writeReceipt,
      readback,
      now: new Date(),
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

  it("shares one stable mutation across concurrent Cases and preserves one original authorization chain", async () => {
    if (!repository || !pool) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID().replaceAll("-", "");
    const realmId = "9341457701636490";
    const targetRef = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
    const workspaceId = `workspace-${suffix}`;
    const agentId = `agent-${suffix}`;
    const installationId = `installation-${suffix}`;
    const context: RequestContext = {
      requestId: `request-${suffix}`,
      actorId: `${workspaceId}:user:user-${suffix}`,
      workspaceId,
      subjectType: "USER",
      subjectId: `user-${suffix}`,
      userId: `user-${suffix}`,
      agentId,
      oauthInstallationId: installationId,
      bindingId: `binding-${suffix}`,
      connectionId: `connection-${suffix}`,
      bindingRevision: 1,
      scopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
      roles: [],
      authn: { issuer: "postgres-test", subject: `user:${suffix}`, audience: "https://mcp.test", tokenId: `token-${suffix}` },
      legacyDemo: false,
    };
    const executeMutation = vi.fn(async (
      mutation: { requestId: string },
      _permit: unknown,
      recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      await markProviderDispatch();
      await recordProviderOutcome({ providerEntityId: `invoice-${suffix}`, receipt: { requestId: mutation.requestId } });
      return {
        providerEntityId: `invoice-${suffix}`,
        receipt: { requestId: mutation.requestId, providerEntityId: `invoice-${suffix}`, verified: true },
        readback: { Id: `invoice-${suffix}`, TotalAmt: 100 },
      };
    });
    const provider = {
      getCompanyContext: vi.fn(async () => ({ CompanyName: "Sandbox", HomeCurrency: { value: "SGD" } })),
      searchCustomers: vi.fn(async () => ({ records: [{ Id: "12", DisplayName: "Harbour Kitchen", Active: true }], searchWindow: {} })),
      searchVendors: vi.fn(async () => ({ records: [], searchWindow: {} })),
      listItems: vi.fn(async () => [{ Id: "21", Name: "Bookkeeping", Active: true }]),
      listAccounts: vi.fn(async () => []),
      listTaxCodes: vi.fn(async () => []),
      getTaxRate: vi.fn(),
      findExistingAccountingDocuments: vi.fn(async () => []),
      getMutationTarget: vi.fn(),
      executeMutation,
      recoverMutation: vi.fn(),
    } as unknown as QuickBooksProviderCapabilities;
    const resolver: QuickBooksProviderResolver = {
      connectionStatus: vi.fn(),
      resolve: vi.fn(async () => ({
        realmId,
        companyName: "Sandbox",
        connectionRefSafe: `qbc-${suffix}`,
        boundTargetRefSafe: `qbt-${suffix}`,
        bindingRevision: `quickbooks-binding-revision:${"a".repeat(32)}`,
        targetSessionId: `target-${suffix}`,
        targetSessionExpiresAt: new Date(Date.now() + 60_000),
        provider,
      })),
    };
    const mutations = new QuickBooksMutationService(
      new QuickBooksPostgresMutationRepository(pool),
      resolver,
      {
        writeEnabled: true,
        writeTargetMode: "exact_allowlist",
        allowedRealmId: realmId,
        publicBaseUrl: "https://mcp.test",
        accountingCaseReleasedCapabilities: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
        standingDelegationProvider: async () => [{
          delegationId: `delegation-${suffix}`,
          revision: 1,
          status: "ACTIVE",
          providerId: "quickbooks",
          workspaceId,
          agentId,
          installationId,
          tenantIds: [realmId],
          actionIds: ["invoice.create"],
        }],
      },
    );
    const service = new QuickBooksAccountingCaseService(repository, resolver, mutations);
    const baseInput = quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref: targetRef,
      case_id: `case-a-${suffix}`,
      expected_version: 0,
      sources: [{ artifactId: `invoice-${suffix}.pdf`, label: "Customer invoice", units: [{
        unitId: `page-${suffix}`, expectedFactKinds: ["NATIVE_DOCUMENT"],
      }] }],
      facts: [{
        factId: `invoice-${suffix}`,
        lineageKey: `invoice-${suffix}`,
        eventKey: `invoice-${suffix}`,
        sourceUnitIds: [`page-${suffix}`],
        origin: "MODEL_EXTRACTED",
        revision: 1,
        kind: "NATIVE_DOCUMENT",
        documentType: "INVOICE",
        counterpartyName: "Harbour Kitchen",
        documentDate: "2026-08-13",
        documentNumber: `INV-${suffix.slice(0, 12)}`,
        currency: "SGD",
        taxMode: "NO_TAX",
        lines: [{
          lineId: "line-1",
          description: "Bookkeeping services",
          quantity: "1",
          unitAmount: "100.00",
          sourceTax: "0.00",
          codingType: "ITEM",
          codingName: "Bookkeeping",
        }],
        declaredNet: "100.00",
        declaredTax: "0.00",
        declaredGross: "100.00",
        businessReason: "Postgres cross-Case idempotency test.",
      }],
    });
    const secondInput = structuredClone(baseInput);
    secondInput.case_id = `case-b-${suffix}`;
    await Promise.all([service.prepare(context, baseInput), service.prepare(context, secondInput)]);
    const executions = [
      { target_session_ref: targetRef, case_id: baseInput.case_id, case_version: 1, request_id: `execute-a-${suffix}` },
      { target_session_ref: targetRef, case_id: secondInput.case_id, case_version: 1, request_id: `execute-b-${suffix}` },
    ] as const;
    const raced = await Promise.allSettled(executions.map((execution) => service.execute(context, execution)));
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedIndex = raced.findIndex((result) => result.status === "rejected");
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    expect((raced[rejectedIndex] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_ACTIVE"] },
    });
    await expect(service.execute(context, executions[rejectedIndex] as typeof executions[number]))
      .resolves.toMatchObject({ state: "TERMINAL", operations: [{ state: "READBACK_VERIFIED" }] });
    expect(executeMutation).toHaveBeenCalledTimes(1);

    const evidence = await pool.query<{
      operation_count: string;
      preparation_count: string;
      authorization_count: string;
      reuse_count: string;
    }>(`SELECT count(*)::text AS operation_count,
      count(DISTINCT preparation_id)::text AS preparation_count,
      count(DISTINCT authorization_evidence->>'authorizationIdentityHash')::text AS authorization_count,
      count(reuse_evidence_receipt)::text AS reuse_count
      FROM quickbooks_accounting_case_operations
      WHERE workspace_id=$1 AND case_id IN ($2,$3)`, [workspaceId, baseInput.case_id, secondInput.case_id]);
    expect(evidence.rows[0]).toMatchObject({
      operation_count: "2",
      preparation_count: "1",
      authorization_count: "1",
    });
    expect(Number(evidence.rows[0]?.reuse_count)).toBeGreaterThanOrEqual(1);
  });
});
