import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { sha256 } from "../src/security/hash.js";
import type { RequestContext } from "../src/security/requestContext.js";
import { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";
import { quickBooksPrepareAccountingCaseSchema } from "../src/quickbooks/accountingCaseSchemas.js";
import { InMemoryQuickBooksAccountingCaseRepository } from "../src/quickbooks/inMemoryAccountingCaseRepository.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES } from "../src/quickbooks/accountingCase.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";
import {
  quickBooksFaultResponse,
  quickBooksWriteFailure,
} from "./helpers/quickBooksCompletedProviderResponse.js";

const targetSessionRef = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
const rotatedTargetSessionRef = `qbts_v1.${"d".repeat(16)}.${"e".repeat(22)}.${"f".repeat(64)}`;
const now = new Date("2026-08-13T04:00:00.000Z");
const context: RequestContext = {
  requestId: "request-1",
  actorId: "ws-1:user:user-1",
  workspaceId: "ws-1",
  subjectType: "USER",
  subjectId: "user-1",
  userId: "user-1",
  agentId: "agent-1",
  oauthInstallationId: "inst-1",
  bindingId: "binding-1",
  connectionId: "connection-1",
  bindingRevision: 1,
  scopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
  roles: [],
  authn: { issuer: "test", subject: "user:user-1", audience: "https://mcp.test", tokenId: "token-1" },
  legacyDemo: false,
};

const input = quickBooksPrepareAccountingCaseSchema.parse({
  target_session_ref: targetSessionRef,
  case_id: "case-invoice-001",
  expected_version: 0,
  sources: [{ artifactId: "invoice.pdf", label: "Customer invoice", units: [{ unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT"] }] }],
  facts: [{
    factId: "invoice-v1", lineageKey: "invoice", eventKey: "invoice", sourceUnitIds: ["page-1"],
    origin: "MODEL_EXTRACTED", revision: 1, kind: "NATIVE_DOCUMENT", documentType: "INVOICE",
    counterpartyName: "Harbour Kitchen", documentDate: "2026-08-10", documentNumber: "INV-1001",
    currency: "SGD", taxMode: "NO_TAX",
    lines: [{ lineId: "line-1", description: "Bookkeeping services", quantity: "1", unitAmount: "100.00", sourceTax: "0.00", codingType: "ITEM", codingName: "Bookkeeping" }],
    declaredNet: "100.00", declaredTax: "0.00", declaredGross: "100.00",
    businessReason: "Record approved monthly bookkeeping services.",
  }],
});

function fixture(options: {
  writeEnabled?: boolean;
  delegationActions?: string[];
  unknown?: boolean;
  crashAfterProviderOutcome?: boolean;
  customerInitiallyMissing?: boolean;
  providerDelayMs?: number;
  beforeProviderDispatch?: () => Promise<void>;
  afterProviderDispatch?: () => Promise<void>;
  executeScopeAllowed?: boolean;
  /** Share one durable mutation ledger across Cases, as production does. */
  mutationRepository?: InMemoryQuickBooksMutationRepository;
  /** Completed Provider refusal raised after the durable dispatch marker. */
  refuseAfterDispatchWithStatus?: number;
} = {}) {
  let customerExists = !options.customerInitiallyMissing;
  let delegationActions = options.delegationActions ?? ["invoice.create"];
  const documents = new Map<string, { entity: string; counterpartyId: string; docNumber: string; providerEntityId: string }>();
  let crashAfterProviderOutcome = options.crashAfterProviderOutcome ?? false;
  let executeScopeAllowed = options.executeScopeAllowed ?? true;
  let refuseAfterDispatchWithStatus = options.refuseAfterDispatchWithStatus;
  const executeMutation = vi.fn(async (
    mutation: { entity: string; requestId: string; payload?: Record<string, unknown> },
    _permit: unknown,
    recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
    markProviderDispatch: () => Promise<void>,
  ) => {
    if (options.providerDelayMs) await new Promise((resolve) => setTimeout(resolve, options.providerDelayMs));
    if (options.beforeProviderDispatch) await options.beforeProviderDispatch();
    await markProviderDispatch();
    if (options.afterProviderDispatch) await options.afterProviderDispatch();
    if (refuseAfterDispatchWithStatus !== undefined) {
      throw await quickBooksWriteFailure(
        async () => quickBooksFaultResponse(refuseAfterDispatchWithStatus as number),
        "9341457701636490",
      );
    }
    if (options.unknown) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "Provider outcome has no exact Id.", {
        httpStatus: 503, retryable: false,
      });
    }
    if (mutation.entity === "Customer") customerExists = true;
    const providerEntityId = mutation.entity === "Customer" ? "12" : "9001";
    await recordProviderOutcome({ providerEntityId, receipt: { requestId: mutation.requestId } });
    if (crashAfterProviderOutcome) {
      crashAfterProviderOutcome = false;
      throw new AppError("WRITE_RESULT_UNKNOWN", "crash after provider outcome", {
        httpStatus: 503, retryable: false,
      });
    }
    const readback = { Id: providerEntityId, TotalAmt: 100 };
    return { providerEntityId, receipt: { requestId: "provider-1", providerEntityId, verified: true }, readback };
  });
  const recoverMutation = vi.fn(async (mutation: { requestId: string }, providerEntityId: string) => ({
    providerEntityId, receipt: { requestId: mutation.requestId, recoveryOnly: true },
    readback: { Id: providerEntityId, TotalAmt: 100 },
  }));
  const provider = {
    getCompanyContext: vi.fn(async () => ({ CompanyName: "Sandbox", HomeCurrency: { value: "SGD" }, MultiCurrencyEnabled: true })),
    searchCustomers: vi.fn(async () => ({
      records: customerExists ? [{ Id: "12", DisplayName: "Harbour Kitchen", Active: true }] : [],
      searchWindow: {},
    })),
    searchVendors: vi.fn(async () => ({ records: [], searchWindow: {} })),
    listItems: vi.fn(async () => [{ Id: "21", Name: "Bookkeeping", Active: true }]),
    listAccounts: vi.fn(async () => []),
    listTaxCodes: vi.fn(async () => []),
    getTaxRate: vi.fn(),
    findExistingAccountingDocuments: vi.fn(async (query: { entity: string; counterpartyId: string; docNumber: string }) => {
      const match = documents.get(`${query.entity}:${query.counterpartyId}:${query.docNumber.toLocaleLowerCase("en")}`);
      return match ? [{ ...match, entity: query.entity }] : [];
    }),
    getMutationTarget: vi.fn(),
    executeMutation,
    recoverMutation,
  } as unknown as QuickBooksProviderCapabilities;
  const resolver: QuickBooksProviderResolver = {
    connectionStatus: vi.fn(),
    resolve: vi.fn(async () => ({
      realmId: "9341457701636490", companyName: "Sandbox", connectionRefSafe: "qbc-safe",
      boundTargetRefSafe: "qbt-safe", bindingRevision: "quickbooks-binding-revision:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetSessionId: "target-session-1", targetSessionExpiresAt: new Date("2026-08-13T04:15:00.000Z"), provider,
    })),
  };
  const mutationRepository = options.mutationRepository ?? new InMemoryQuickBooksMutationRepository();
  const mutations = new QuickBooksMutationService(
    mutationRepository, resolver,
    {
      writeEnabled: options.writeEnabled ?? true,
      writeTargetMode: "exact_allowlist",
      allowedRealmId: "9341457701636490",
      publicBaseUrl: "https://mcp.test",
      // Production pins the runtime allowlist from QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES,
      // and must: CREATE:JournalEntry is deliberately not enabledByDefault in
      // writePolicy, so releasing it through the Case compiler is not by itself
      // enough to let an unconfigured deployment post to the general ledger.
      allowedCapabilities: [...QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES],
      accountingCaseReleasedCapabilities: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
      executeScopeAuthorizer: async (_actorId, requiredScope) =>
        executeScopeAllowed && requiredScope === "quickbooks.mutation.execute",
      standingDelegationProvider: async () => [{
        delegationId: "delegation-1", revision: 1, status: "ACTIVE", providerId: "quickbooks",
        workspaceId: "ws-1", agentId: "agent-1", installationId: "inst-1",
        tenantIds: ["9341457701636490"], actionIds: delegationActions,
      }],
    },
    undefined,
    undefined,
    () => now,
  );
  const repository = new InMemoryQuickBooksAccountingCaseRepository();
  const service = new QuickBooksAccountingCaseService(repository, resolver, mutations, { clock: () => now });
  return {
    service, repository, mutationRepository, executeMutation, recoverMutation, provider, documents,
    setDelegationActions: (actions: string[]) => { delegationActions = [...actions]; },
    setExecuteScopeAllowed: (allowed: boolean) => { executeScopeAllowed = allowed; },
    setRefuseAfterDispatchWithStatus: (status: number | undefined) => { refuseAfterDispatchWithStatus = status; },
  };
}

describe("QuickBooks Accounting Case service", () => {
  it("prepares without writing, then auto-executes under standing delegation and exact readback", async () => {
    const { service, executeMutation } = fixture();
    const prepared = await service.prepare(context, input);
    expect(prepared).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      completion_claim: { ledger_write_claim: "NOT_WRITTEN" },
      operations: [{ state: "PENDING" }],
    });
    expect(executeMutation).not.toHaveBeenCalled();

    const executed = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-1",
    });
    expect(executed).toMatchObject({
      state: "TERMINAL",
      events: [{ disposition: "POSTED_READBACK_VERIFIED", source_unit_ids: ["page-1"], next_action: "NONE" }],
      operations: [{
        state: "READBACK_VERIFIED", provider_entity_id: "9001", authorization_receipt_recorded: true,
        authorization_receipt_ref: expect.stringMatching(/^[a-f0-9]{64}$/u),
        provider_receipt_ref: expect.stringMatching(/^[a-f0-9]{64}$/u),
        exact_readback_ref: expect.stringMatching(/^[a-f0-9]{64}$/u),
        authorization_receipt: expect.objectContaining({ receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION" }),
        provider_receipt: expect.objectContaining({ providerEntityId: "9001", verified: true }),
        exact_readback: expect.objectContaining({ Id: "9001" }),
        assurance: { all_required_evidence_verified: true },
        next_action: "NONE",
      }],
      source_unit_terminal_coverage: {
        expected_source_units: 1, terminal_source_units: 1, all_source_units_terminal: true,
      },
      completion_claim: {
        ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED",
        case_processing_completeness: "ALL_TYPED_EVENTS_TERMINAL",
      },
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);

    const replay = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-1",
    });
    expect(replay.completion_claim.ledger_write_claim).toBe("ALL_ELIGIBLE_WRITES_READBACK_VERIFIED");
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("resumes with a fresh short-lived target proof for the unchanged OAuth Company binding", async () => {
    const { service, executeMutation } = fixture();
    await service.prepare(context, input);

    const executed = await service.execute(context, {
      target_session_ref: rotatedTargetSessionRef,
      case_id: input.case_id,
      case_version: 1,
      request_id: "execute-with-rotated-target",
    });
    expect(executed).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED", provider_entity_id: "9001" }],
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);

    await expect(service.status(context, {
      target_session_ref: rotatedTargetSessionRef,
      case_id: input.case_id,
      case_version: 1,
    })).resolves.toMatchObject({ state: "TERMINAL" });
  });

  it("resumes a RECOVERY_REQUIRED Case by exact Provider Id and never repeats its write", async () => {
    const { service, executeMutation, recoverMutation } = fixture({ crashAfterProviderOutcome: true });
    await service.prepare(context, input);
    const execution = {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-recovery-1",
    };
    await expect(service.execute(context, execution)).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    await expect(service.status(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1,
    })).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED", operations: [{ state: "WRITE_UNCERTAIN" }],
      completion_claim: { ledger_write_claim: "RECOVERY_REQUIRED" },
    });

    const recovered = await service.execute(context, execution);
    expect(recovered).toMatchObject({
      state: "TERMINAL", operations: [{ state: "READBACK_VERIFIED", provider_entity_id: "9001" }],
      completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(recoverMutation).toHaveBeenCalledTimes(1);
  });

  it("re-arms an historical MCP-scope rejection only while the durable mutation still proves no dispatch", async () => {
    const { service, repository, executeMutation, setExecuteScopeAllowed } = fixture({ executeScopeAllowed: false });
    await service.prepare(context, input);
    const execution = {
      target_session_ref: targetSessionRef,
      case_id: input.case_id,
      case_version: 1,
      request_id: "execute-scope-rearm",
    };
    await expect(service.execute(context, execution)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { failureLayer: "MCP_SCOPE" },
    });
    const status = await service.status(context, {
      target_session_ref: targetSessionRef,
      case_id: input.case_id,
      case_version: 1,
    });
    const operationId = status.operations[0]?.operation_id as string;
    const preparationId = (await repository.getBound({
      binding: {
        actorId: context.actorId,
        workspaceId: context.workspaceId as string,
        subjectType: context.subjectType as "USER",
        subjectId: context.subjectId as string,
        agentId: context.agentId as string,
        installationId: context.oauthInstallationId as string,
        bindingId: context.bindingId as string,
        bindingRevision: context.bindingRevision as number,
        connectionId: context.connectionId as string,
        realmId: "9341457701636490",
        targetSessionHash: sha256(targetSessionRef),
      },
      caseId: input.case_id,
      version: 1,
    }))?.operations[0]?.preparationId as string;
    await repository.updateOperation({
      binding: {
        actorId: context.actorId,
        workspaceId: context.workspaceId as string,
        subjectType: context.subjectType as "USER",
        subjectId: context.subjectId as string,
        agentId: context.agentId as string,
        installationId: context.oauthInstallationId as string,
        bindingId: context.bindingId as string,
        bindingRevision: context.bindingRevision as number,
        connectionId: context.connectionId as string,
        realmId: "9341457701636490",
        targetSessionHash: sha256(targetSessionRef),
      },
      caseId: input.case_id,
      version: 1,
      operationId,
      requestId: execution.request_id,
      expectedStates: ["PREPARED"],
      state: "PROVIDER_REJECTED",
      preparationId,
      errorReceipt: {
        code: "FORBIDDEN",
        message: "The connected MCP installation does not grant mutation execution.",
        retryable: false,
        details: { failureLayer: "MCP_SCOPE", denyReasons: ["TRANSPORT_SCOPE_MISSING"] },
      },
      now,
    });

    setExecuteScopeAllowed(true);
    const recovered = await service.execute(context, execution);
    expect(recovered).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED", provider_entity_id: "9001" }],
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("classifies post-dispatch no-Id as operator recovery and never terminalizes it as Provider rejection", async () => {
    const { service, executeMutation } = fixture({ unknown: true });
    await service.prepare(context, input);
    const execution = {
      target_session_ref: targetSessionRef,
      case_id: input.case_id,
      case_version: 1,
      request_id: "execute-unknown-no-id",
    };
    await expect(service.execute(context, execution)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN_NO_ID",
      retryable: false,
      details: { automaticRearmAllowed: false, operatorResolutionRequired: true },
    });
    await expect(service.status(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1,
    })).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      operations: [{
        state: "WRITE_UNCERTAIN",
        next_action: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
      }],
      completion_claim: { ledger_write_claim: "RECOVERY_REQUIRED" },
    });
    await expect(service.execute(context, execution)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN_NO_ID",
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("keeps durable no-Id write uncertainty when current delegation is later denied", async () => {
    const { service, executeMutation, setDelegationActions } = fixture({ unknown: true });
    await service.prepare(context, input);
    const execution = {
      target_session_ref: targetSessionRef,
      case_id: input.case_id,
      case_version: 1,
      request_id: "execute-unknown-auth-changed",
    };
    await expect(service.execute(context, execution)).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });
    setDelegationActions([]);

    await expect(service.execute(context, execution)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN_NO_ID",
      details: {
        durableMutationState: "WRITE_RESULT_UNKNOWN_NO_ID",
        automaticRearmAllowed: false,
        operatorResolutionRequired: true,
        currentControlFailure: { code: "FORBIDDEN", failureLayer: "STANDING_DELEGATION" },
      },
    });
    await expect(service.status(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1,
    })).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      operations: [{
        state: "WRITE_UNCERTAIN",
        next_action: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
      }],
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("keeps the exact-Id recovery path when current delegation is later denied", async () => {
    const { service, executeMutation, recoverMutation, setDelegationActions } = fixture({
      crashAfterProviderOutcome: true,
    });
    await service.prepare(context, input);
    const execution = {
      target_session_ref: targetSessionRef,
      case_id: input.case_id,
      case_version: 1,
      request_id: "execute-exact-auth-changed",
    };
    await expect(service.execute(context, execution)).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    setDelegationActions([]);

    await expect(service.execute(context, execution)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      details: {
        durableMutationState: "WRITE_RESULT_UNKNOWN",
        providerEntityId: "9001",
        recoveryAction: "RECOVER_BY_EXACT_PROVIDER_ID_NO_SECOND_WRITE",
        currentControlFailure: { code: "FORBIDDEN", failureLayer: "STANDING_DELEGATION" },
      },
    });
    await expect(service.status(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1,
    })).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      operations: [{
        state: "WRITE_UNCERTAIN",
        provider_entity_id: "9001",
        next_action: "RECOVER_BY_EXACT_PROVIDER_ID_NO_SECOND_WRITE",
      }],
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(recoverMutation).not.toHaveBeenCalled();
  });

  it("does not terminalize a Case when authorization changes during another active pre-dispatch attempt", async () => {
    let releaseProviderDispatch!: () => void;
    const providerDispatchGate = new Promise<void>((resolve) => { releaseProviderDispatch = resolve; });
    const { service, executeMutation, setDelegationActions } = fixture({
      beforeProviderDispatch: () => providerDispatchGate,
    });
    await service.prepare(context, input);
    const execution = {
      target_session_ref: targetSessionRef,
      case_id: input.case_id,
      case_version: 1,
      request_id: "execute-active-predispatch-auth-changed",
    };
    const firstWorker = service.execute(context, execution);
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(1));
    setDelegationActions([]);

    await expect(service.execute(context, execution)).rejects.toMatchObject({
      code: "CONFLICT",
      retryable: true,
      details: {
        failureLayer: "EXECUTION_FENCING",
        reasonCodes: ["EXECUTION_LEASE_ACTIVE_OR_RECLAIMABLE"],
        providerMutationPossible: false,
        caseTerminalizationAllowed: false,
        currentControlFailure: { code: "FORBIDDEN", failureLayer: "STANDING_DELEGATION" },
      },
    });
    await expect(service.status(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1,
    })).resolves.toMatchObject({ state: "EXECUTING", operations: [{ state: "PREPARED" }] });

    releaseProviderDispatch();
    await expect(firstWorker).resolves.toMatchObject({
      state: "TERMINAL", operations: [{ state: "READBACK_VERIFIED", provider_entity_id: "9001" }],
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("projects an active dispatch as recovery when authorization changes before its exact-Id callback", async () => {
    let reportDispatchStarted!: () => void;
    let releaseProviderOutcome!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { reportDispatchStarted = resolve; });
    const providerOutcomeGate = new Promise<void>((resolve) => { releaseProviderOutcome = resolve; });
    const { service, executeMutation, setDelegationActions } = fixture({
      afterProviderDispatch: async () => {
        reportDispatchStarted();
        await providerOutcomeGate;
      },
    });
    await service.prepare(context, input);
    const execution = {
      target_session_ref: targetSessionRef,
      case_id: input.case_id,
      case_version: 1,
      request_id: "execute-active-dispatch-auth-changed",
    };
    const firstWorker = service.execute(context, execution);
    await dispatchStarted;
    setDelegationActions([]);

    await expect(service.execute(context, execution)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
      details: {
        durableMutationState: "EXECUTING",
        executionAttemptState: "DISPATCH_STARTED",
        providerMutationPossible: true,
        secondProviderDispatchAllowed: false,
        recoveryAction: "WAIT_FOR_ACTIVE_ATTEMPT_OR_STALE_RECONCILIATION",
        currentControlFailure: { code: "FORBIDDEN", failureLayer: "STANDING_DELEGATION" },
      },
    });
    await expect(service.status(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1,
    })).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      operations: [{ state: "WRITE_UNCERTAIN", next_action: "INSPECT_DURABLE_MUTATION_BEFORE_RECOVERY" }],
    });

    releaseProviderOutcome();
    await expect(firstWorker).resolves.toMatchObject({
      state: "TERMINAL", operations: [{ state: "READBACK_VERIFIED", provider_entity_id: "9001" }],
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("replays preparation idempotently with a rotated target proof for the same durable binding", async () => {
    const { service, executeMutation } = fixture();
    const first = await service.prepare(context, input);
    const replay = await service.prepare(context, {
      ...input,
      target_session_ref: rotatedTargetSessionRef,
    });
    expect(first.compiled_plan_hash).toBe(replay.compiled_plan_hash);
    expect(replay).toMatchObject({
      persistence_mode: "IDEMPOTENT_REPLAY",
      case_version: 1,
      state: "PLANNED_NEEDS_PREFLIGHT",
    });
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it("fails closed when delegation does not grant the exact action", async () => {
    const { service, executeMutation } = fixture({ delegationActions: ["vendor.create_basic"] });
    await service.prepare(context, input);
    await expect(service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-denied",
    })).rejects.toMatchObject({ code: "FORBIDDEN", details: { failureLayer: "STANDING_DELEGATION" } });
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it("does not allow a second case version to mutate a terminal version", async () => {
    const { service } = fixture();
    await service.prepare(context, input);
    await service.execute(context, { target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-v1" });
    const corrected = structuredClone(input);
    corrected.expected_version = 1;
    const [correctedFact] = corrected.facts;
    if (!correctedFact || correctedFact.kind !== "NATIVE_DOCUMENT") throw new Error("test fixture requires a native document");
    const [correctedLine] = correctedFact.lines;
    if (!correctedLine) throw new Error("test fixture requires one document line");
    correctedFact.factId = "invoice-v2";
    correctedFact.revision = 2;
    correctedFact.supersedesFactId = "invoice-v1";
    correctedFact.declaredNet = "120.00";
    correctedFact.declaredGross = "120.00";
    correctedLine.unitAmount = "120.00";
    const v2 = await service.prepare(context, corrected);
    expect(v2.case_version).toBe(2);
    const v1 = await service.status(context, { target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1 });
    expect(v1.operations[0]?.provider_entity_id).toBe("9001");
  });

  it("stages a new contact before its document, then avoids duplicating the contact in the next Case version", async () => {
    const { service, executeMutation } = fixture({
      customerInitiallyMissing: true,
      delegationActions: ["customer.create_basic", "invoice.create"],
    });
    const staged = structuredClone(input);
    staged.case_id = "case-new-customer-001";
    staged.sources[0]?.units.push({ unitId: "contact-1", expectedFactKinds: ["CONTACT_CANDIDATE"] });
    staged.facts.push({
      factId: "customer-v1",
      lineageKey: "customer",
      eventKey: "customer",
      sourceUnitIds: ["contact-1"],
      origin: "AGENT_ASSERTED",
      revision: 1,
      kind: "CONTACT_CANDIDATE",
      role: "CUSTOMER",
      displayName: "Harbour Kitchen",
    });

    const v1 = await service.prepare(context, staged);
    expect(v1).toMatchObject({
      state: "PLANNED_WITH_EXCEPTIONS",
      operations: [{ entity: "Customer", state: "PENDING" }],
    });
    expect(v1.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "INVOICE", disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_NOT_FOUND"] }),
    ]));
    await service.execute(context, {
      target_session_ref: targetSessionRef,
      case_id: staged.case_id,
      case_version: 1,
      request_id: "execute-contact-v1",
    });

    staged.expected_version = 1;
    const v2 = await service.prepare(context, staged);
    expect(v2).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      operations: [{ entity: "Invoice", state: "PENDING" }],
    });
    expect(v2.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "CONTACT_CREATE", disposition: "EVIDENCE_ONLY", reason_codes: ["CONTACT_ALREADY_EXISTS"] }),
    ]));
    await service.execute(context, {
      target_session_ref: targetSessionRef,
      case_id: staged.case_id,
      case_version: 2,
      request_id: "execute-invoice-v2",
    });
    expect(executeMutation.mock.calls.map(([mutation]) => mutation.entity)).toEqual(["Customer", "Invoice"]);
  });

  // A foreign-currency document was previously refused outright, with a message
  // naming an exchange-rate policy the intake had no way to supply. Deciding the
  // rate is not this service's job; the Agent names one and the ledger is what
  // the claim is checked against. These three assert the checks that replaced it.
  let foreignCurrencyCaseSeq = 0;
  const foreignCurrencyCase = (mutate: (fact: Record<string, unknown>) => void) => {
    const foreign = structuredClone(input);
    foreign.case_id = `case-foreign-currency-${++foreignCurrencyCaseSeq}`;
    const [foreignFact] = foreign.facts;
    if (!foreignFact || foreignFact.kind !== "NATIVE_DOCUMENT") throw new Error("test fixture requires a native document");
    mutate(foreignFact as unknown as Record<string, unknown>);
    return foreign;
  };

  it("refuses a foreign-currency NativeDocument that carries no exchange rate, and names the field", async () => {
    const { service } = fixture();
    const prepared = await service.prepare(context, foreignCurrencyCase((fact) => { fact.currency = "USD"; }));
    expect(prepared).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: "BLOCKED_VALIDATION",
        reason_codes: ["EXCHANGE_RATE_REQUIRED_FOR_FOREIGN_CURRENCY"],
      }),
    ]));
  });

  it("refuses a foreign-currency NativeDocument when the company has multicurrency turned off", async () => {
    const { service, provider } = fixture();
    vi.mocked(provider.getCompanyContext).mockResolvedValue({
      CompanyName: "Sandbox", HomeCurrency: { value: "SGD" }, MultiCurrencyEnabled: false,
    } as never);
    const prepared = await service.prepare(context, foreignCurrencyCase((fact) => {
      fact.currency = "USD";
      fact.exchangeRate = "1.34";
    }));
    // Not BLOCKED_VALIDATION: nothing about the submitted facts is wrong, and
    // re-preparing cannot clear it. Someone has to decide something in QuickBooks.
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: "REVIEW_REQUIRED",
        reason_codes: ["COMPANY_MULTICURRENCY_DISABLED"],
      }),
    ]));
  });

  it("refuses an exchange rate on a home-currency NativeDocument", async () => {
    const { service } = fixture();
    const prepared = await service.prepare(context, foreignCurrencyCase((fact) => { fact.exchangeRate = "1.34"; }));
    expect(prepared).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: "BLOCKED_VALIDATION",
        reason_codes: ["EXCHANGE_RATE_NOT_APPLICABLE_TO_HOME_CURRENCY"],
      }),
    ]));
  });

  it("recomputes OfficeHub 9% GST and blocks 7.21 while accepting 7.20", async () => {
    const { service, provider, executeMutation, setDelegationActions } = fixture();
    vi.mocked(provider.searchVendors).mockResolvedValue({
      records: [{ Id: "56", DisplayName: "OfficeHub", Active: true }], searchWindow: {} as never,
    });
    vi.mocked(provider.listAccounts).mockResolvedValue([{ Id: "9", Name: "Office Expenses", Active: true }]);
    vi.mocked(provider.listTaxCodes).mockResolvedValue([{
      Id: "4", Name: "GST 9%", Active: true, Taxable: true,
      PurchaseTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: "904" } }] },
    }]);
    vi.mocked(provider.getTaxRate).mockResolvedValue({ Id: "904", Name: "GST 9%", Active: true, RateValue: 9 });
    const vendorCredit = structuredClone(input);
    vendorCredit.case_id = "case-officehub-721";
    const fact = vendorCredit.facts[0];
    if (!fact || fact.kind !== "NATIVE_DOCUMENT") throw new Error("native fact required");
    const line = fact.lines[0];
    if (!line) throw new Error("native document line required");
    Object.assign(fact, {
      documentType: "VENDOR_CREDIT", counterpartyName: "OfficeHub", documentNumber: "OH-CN-721",
      taxMode: "TAX_EXCLUDED", declaredNet: "80.00", declaredTax: "7.21", declaredGross: "87.21",
    });
    Object.assign(line, {
      description: "One undelivered carton", quantity: "1", unitAmount: "80.00", sourceTax: "7.21",
      codingType: "ACCOUNT", codingName: "Office Expenses", taxCodeName: "GST 9%",
    });
    const blocked = await service.prepare(context, vendorCredit);
    expect(blocked).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(blocked.events).toEqual(expect.arrayContaining([expect.objectContaining({
      reason_codes: ["SOURCE_TAX_RECOMPUTATION_MISMATCH"],
    })]));

    vendorCredit.case_id = "case-officehub-720";
    fact.documentNumber = "OH-CN-720";
    fact.declaredTax = "7.20";
    fact.declaredGross = "87.20";
    line.sourceTax = "7.20";
    const valid = await service.prepare(context, vendorCredit);
    expect(valid).toMatchObject({ state: "PLANNED_NEEDS_PREFLIGHT", operations: [{ entity: "VendorCredit" }] });
    setDelegationActions(["vendor_credit.create"]);
    await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: vendorCredit.case_id, case_version: 1,
      request_id: "execute-officehub-720",
    });
    expect(executeMutation.mock.calls.at(-1)?.[0].payload).not.toHaveProperty("DueDate");
  });

  it("fails closed for unresolved and compound QuickBooks tax definitions", async () => {
    const { service, provider } = fixture();
    vi.mocked(provider.searchVendors).mockResolvedValue({
      records: [{ Id: "56", DisplayName: "OfficeHub", Active: true }], searchWindow: {} as never,
    });
    vi.mocked(provider.listAccounts).mockResolvedValue([{ Id: "9", Name: "Office Expenses", Active: true }]);
    const vendorCredit = structuredClone(input);
    vendorCredit.case_id = "case-tax-unresolved";
    const fact = vendorCredit.facts[0];
    if (!fact || fact.kind !== "NATIVE_DOCUMENT") throw new Error("native fact required");
    const line = fact.lines[0];
    if (!line) throw new Error("native document line required");
    Object.assign(fact, {
      documentType: "VENDOR_CREDIT", counterpartyName: "OfficeHub", documentNumber: "OH-TAX-UNRESOLVED",
      taxMode: "TAX_EXCLUDED", declaredNet: "80.00", declaredTax: "7.20", declaredGross: "87.20",
    });
    Object.assign(line, {
      quantity: "1", unitAmount: "80.00", sourceTax: "7.20", codingType: "ACCOUNT",
      codingName: "Office Expenses", taxCodeName: "GST 9%",
    });
    vi.mocked(provider.listTaxCodes).mockResolvedValue([{
      Id: "4", Name: "GST 9%", Active: true, Taxable: true,
    }]);
    const unresolved = await service.prepare(context, vendorCredit);
    expect(unresolved.events).toEqual(expect.arrayContaining([expect.objectContaining({
      reason_codes: ["TAX_RATE_UNRESOLVED"],
    })]));

    vendorCredit.case_id = "case-tax-compound";
    fact.documentNumber = "OH-TAX-COMPOUND";
    vi.mocked(provider.listTaxCodes).mockResolvedValue([{
      Id: "4", Name: "GST 9%", Active: true, Taxable: true, TaxGroup: true,
      PurchaseTaxRateList: { TaxRateDetail: [
        { TaxRateRef: { value: "904" } }, { TaxRateRef: { value: "905" } },
      ] },
    }]);
    const compound = await service.prepare(context, vendorCredit);
    expect(compound.events).toEqual(expect.arrayContaining([expect.objectContaining({
      reason_codes: ["COMPOUND_TAX_CODE_NOT_RELEASED"],
    })]));
  });

  it("recomputes TAX_INCLUSIVE GST from the gross line amount", async () => {
    const { service, provider } = fixture();
    vi.mocked(provider.searchVendors).mockResolvedValue({
      records: [{ Id: "56", DisplayName: "OfficeHub", Active: true }], searchWindow: {} as never,
    });
    vi.mocked(provider.listAccounts).mockResolvedValue([{ Id: "9", Name: "Office Expenses", Active: true }]);
    vi.mocked(provider.listTaxCodes).mockResolvedValue([{
      Id: "4", Name: "GST 9%", Active: true, Taxable: true,
      PurchaseTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: "904" } }] },
    }]);
    vi.mocked(provider.getTaxRate).mockResolvedValue({ Id: "904", Name: "GST 9%", Active: true, RateValue: 9 });
    const included = structuredClone(input);
    included.case_id = "case-tax-inclusive";
    const fact = included.facts[0];
    if (!fact || fact.kind !== "NATIVE_DOCUMENT") throw new Error("native fact required");
    const line = fact.lines[0];
    if (!line) throw new Error("native document line required");
    Object.assign(fact, {
      documentType: "VENDOR_CREDIT", counterpartyName: "OfficeHub", documentNumber: "OH-INCLUSIVE",
      taxMode: "TAX_INCLUSIVE", declaredNet: "80.00", declaredTax: "7.20", declaredGross: "87.20",
    });
    Object.assign(line, {
      quantity: "1", unitAmount: "87.20", sourceTax: "7.20", codingType: "ACCOUNT",
      codingName: "Office Expenses", taxCodeName: "GST 9%",
    });
    await expect(service.prepare(context, included)).resolves.toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT", operations: [{ entity: "VendorCredit" }],
    });
  });

  it("treats an exact document number and counterparty in a new Case as already satisfied", async () => {
    const { service, executeMutation, provider } = fixture();
    const first = await service.prepare(context, input);
    await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "cross-case-first",
    });
    vi.mocked(provider.findExistingAccountingDocuments).mockResolvedValue([{
      entity: "Invoice", providerEntityId: "9001", counterpartyId: "12", docNumber: "INV-1001",
    }]);
    const duplicate = structuredClone(input);
    duplicate.case_id = "different-case-same-document";
    const prepared = await service.prepare(context, duplicate);
    expect(first.operations).toHaveLength(1);
    expect(prepared).toMatchObject({ operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([expect.objectContaining({
      compiled_disposition: "EVIDENCE_ONLY", disposition: "EVIDENCE_ONLY",
      reason_codes: ["DOCUMENT_ALREADY_EXISTS"],
    })]));
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("collapses two separately-prepared Cases with the same stable document identity to one Provider call", async () => {
    const { service, executeMutation } = fixture();
    const second = structuredClone(input);
    second.case_id = "parallel-case-same-invoice";
    await Promise.all([service.prepare(context, input), service.prepare(context, second)]);
    const firstExecution = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "stable-first",
    });
    const secondExecution = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: second.case_id, case_version: 1, request_id: "stable-second",
    });
    expect(firstExecution.operations[0]).toMatchObject({ state: "READBACK_VERIFIED", provider_entity_id: "9001" });
    expect(secondExecution.operations[0]).toMatchObject({
      state: "READBACK_VERIFIED",
      provider_entity_id: "9001",
      original_authorization_origin: { case_id: input.case_id, case_version: 1 },
      deterministic_reuse_evidence: expect.objectContaining({
        evidenceType: "QUICKBOOKS_ACCOUNTING_CASE_MUTATION_REUSE",
        caseId: second.case_id,
      }),
      assurance: {
        all_required_evidence_verified: true,
        authorization_causal_evidence_verified: true,
        deterministic_reuse_evidence_verified: true,
      },
    });
    expect(firstExecution.operations[0]?.authorization_receipt_ref)
      .toBe(secondExecution.operations[0]?.authorization_receipt_ref);
    expect(firstExecution.operations[0]?.original_authorization_identity_ref)
      .toBe(secondExecution.operations[0]?.original_authorization_identity_ref);
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent cross-Case reuse and preserves one original authorization causal chain", async () => {
    const { service, executeMutation } = fixture({ providerDelayMs: 30 });
    const second = structuredClone(input);
    second.case_id = "concurrent-case-same-invoice";
    await Promise.all([service.prepare(context, input), service.prepare(context, second)]);
    const executions = [
      { target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "concurrent-stable-a" },
      { target_session_ref: targetSessionRef, case_id: second.case_id, case_version: 1, request_id: "concurrent-stable-b" },
    ] as const;
    const raced = await Promise.allSettled(executions.map((execution) => service.execute(context, execution)));
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedIndex = raced.findIndex((result) => result.status === "rejected");
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    const rejected = raced[rejectedIndex] as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({
      code: "CONFLICT",
      retryable: true,
      details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_ACTIVE"] },
    });
    const retried = await service.execute(context, executions[rejectedIndex] as typeof executions[number]);
    const fulfilled = raced.find((result): result is PromiseFulfilledResult<Awaited<typeof retried>> =>
      result.status === "fulfilled")?.value;
    expect(fulfilled).toBeDefined();
    const summaries = [fulfilled as Awaited<typeof retried>, retried];
    expect(new Set(summaries.map((summary) =>
      summary.operations[0]?.original_authorization_identity_ref)).size).toBe(1);
    expect(summaries.filter((summary) =>
      summary.operations[0]?.deterministic_reuse_evidence !== undefined).length).toBeGreaterThanOrEqual(1);
    expect(summaries.every((summary) =>
      summary.operations[0]?.assurance.all_required_evidence_verified === true)).toBe(true);
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("terminalizes a completed Provider refusal as blocked, and never as an unrecoverable possible write", async () => {
    const { service } = fixture({ refuseAfterDispatchWithStatus: 400 });
    await service.prepare(context, input);

    await expect(service.execute(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "execute-refused",
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { providerErrors: [{ code: "6000", element: "CurrencyRef" }] },
    });

    // Before this change the Case parked in RECOVERY_REQUIRED / WRITE_UNCERTAIN
    // and there is no implemented operator-resolution path, so it could never
    // reach TERMINAL again.
    await expect(service.status(context, {
      target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1,
    })).resolves.toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "BLOCKED_VALIDATION" }],
      completion_claim: { ledger_write_claim: "NOT_WRITTEN" },
    });
  });

  it("allows only one execution request to own a Case and never duplicates the Provider write", async () => {
    const { service, executeMutation } = fixture();
    await service.prepare(context, input);
    const results = await Promise.allSettled([
      service.execute(context, {
        target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "concurrent-a",
      }),
      service.execute(context, {
        target_session_ref: targetSessionRef, case_id: input.case_id, case_version: 1, request_id: "concurrent-b",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "CONFLICT" });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  // A Customer/Vendor's CurrencyRef is frozen at creation in QuickBooks and
  // QuickBooks refuses any document whose currency differs from its
  // contact's. There is no Agent-stated currency on CONTACT_CANDIDATE to get
  // wrong: the compiler derives it purely from the NATIVE_DOCUMENT facts in
  // the same Case that reference the contact (see reconcileContactCurrencies
  // in accountingCaseCompiler.ts), and #contactPayload turns that derived
  // currency into CurrencyRef only when the company can actually hold it.
  const newForeignVendorCase = (documentOverrides: Record<string, unknown> = {}) => quickBooksPrepareAccountingCaseSchema.parse({
    target_session_ref: targetSessionRef,
    case_id: `case-new-vendor-currency-${Math.random().toString(36).slice(2)}`,
    expected_version: 0,
    sources: [{
      artifactId: "bill.pdf",
      label: "Marina Bay Consulting bill",
      units: [
        { unitId: "contact-1", expectedFactKinds: ["CONTACT_CANDIDATE"] },
        { unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT"] },
      ],
    }],
    facts: [{
      factId: "vendor-v1", lineageKey: "vendor", eventKey: "vendor", sourceUnitIds: ["contact-1"],
      origin: "AGENT_ASSERTED", revision: 1, kind: "CONTACT_CANDIDATE", role: "VENDOR",
      displayName: "Marina Bay Consulting Pte Ltd",
    }, {
      factId: "bill-v1", lineageKey: "bill", eventKey: "bill", sourceUnitIds: ["page-1"],
      origin: "MODEL_EXTRACTED", revision: 1, kind: "NATIVE_DOCUMENT", documentType: "BILL",
      counterpartyName: "Marina Bay Consulting Pte Ltd", documentDate: "2026-08-10",
      documentNumber: "MB-1001", currency: "SGD", taxMode: "NO_TAX",
      lines: [{
        lineId: "line-1", description: "Advisory services", quantity: "1", unitAmount: "500.00",
        sourceTax: "0.00", codingType: "ACCOUNT", codingName: "Office Expenses",
      }],
      declaredNet: "500.00", declaredTax: "0.00", declaredGross: "500.00",
      businessReason: "Record the Marina Bay Consulting advisory bill.",
      ...documentOverrides,
    }],
  });

  it("derives a new Vendor's currency from the one foreign-currency Bill that references it, and names CurrencyRef", async () => {
    const { service, executeMutation, provider } = fixture({
      delegationActions: ["vendor.create_basic", "bill.create"],
    });
    vi.mocked(provider.listAccounts).mockResolvedValue([{ Id: "9", Name: "Office Expenses", Active: true }]);
    const staged = newForeignVendorCase({ currency: "USD", exchangeRate: "1.34" });

    const prepared = await service.prepare(context, staged);
    expect(prepared).toMatchObject({
      state: "PLANNED_WITH_EXCEPTIONS",
      operations: [{ entity: "Vendor", state: "PENDING" }],
    });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "BILL", disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_NOT_FOUND"] }),
    ]));

    await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-vendor-currency-v1",
    });
    expect(executeMutation.mock.calls.at(-1)?.[0]).toMatchObject({
      entity: "Vendor",
      payload: { DisplayName: "Marina Bay Consulting Pte Ltd", CurrencyRef: { value: "USD" } },
    });
  });

  it("never names CurrencyRef for a new contact when the company has not turned multicurrency on", async () => {
    const { service, executeMutation, provider } = fixture({
      delegationActions: ["vendor.create_basic", "bill.create"],
    });
    vi.mocked(provider.getCompanyContext).mockResolvedValue({
      CompanyName: "Sandbox", HomeCurrency: { value: "SGD" }, MultiCurrencyEnabled: false,
    } as never);
    vi.mocked(provider.listAccounts).mockResolvedValue([{ Id: "9", Name: "Office Expenses", Active: true }]);
    const staged = newForeignVendorCase();

    await service.prepare(context, staged);
    await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-vendor-home-v1",
    });
    const payload = executeMutation.mock.calls.at(-1)?.[0].payload;
    expect(payload).toMatchObject({ DisplayName: "Marina Bay Consulting Pte Ltd" });
    expect(payload).not.toHaveProperty("CurrencyRef");
  });

  it("reports an existing contact's frozen currency as unfixable when a referencing document needs a different one", async () => {
    const { service, provider } = fixture({
      delegationActions: ["vendor.create_basic", "bill.create"],
    });
    vi.mocked(provider.searchVendors).mockResolvedValue({
      records: [{ Id: "77", DisplayName: "Marina Bay Consulting Pte Ltd", Active: true, CurrencyRef: { value: "USD" } }],
      searchWindow: {} as never,
    });
    vi.mocked(provider.listAccounts).mockResolvedValue([{ Id: "9", Name: "Office Expenses", Active: true }]);
    const staged = newForeignVendorCase();

    const prepared = await service.prepare(context, staged);
    const contactEvent = prepared.events.find((event) => event.route === "CONTACT_CREATE");
    expect(contactEvent).toMatchObject({
      disposition: "REVIEW_REQUIRED",
      reason_codes: ["EXISTING_CONTACT_CURRENCY_MISMATCH"],
    });
    expect(prepared.operations.some((operation) => (operation as { entity?: string }).entity === "Vendor")).toBe(false);
  });
  it("catches a frozen counterparty currency before dispatch when the Case stages no contact", async () => {
    // The same immutability from the other direction: the contact already
    // exists, so nothing is staged for it and the contact-side check never
    // runs. Before this was checked here, the mismatch only surfaced as a
    // Provider refusal after dispatch.
    const { service, provider } = fixture({ delegationActions: ["bill.create"] });
    vi.mocked(provider.getCompanyContext).mockResolvedValue({
      CompanyName: "Sandbox", HomeCurrency: { value: "USD" }, MultiCurrencyEnabled: true,
    } as never);
    vi.mocked(provider.searchVendors).mockResolvedValue({
      records: [{ Id: "63", DisplayName: "Marina Bay Consulting Pte Ltd", Active: true, CurrencyRef: { value: "USD" } }],
      searchWindow: {} as never,
    });
    vi.mocked(provider.listAccounts).mockResolvedValue([{ Id: "9", Name: "Office Expenses", Active: true }]);
    const staged = quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref: targetSessionRef,
      case_id: `case-existing-counterparty-currency-${Math.random().toString(36).slice(2)}`,
      expected_version: 0,
      sources: [{
        artifactId: "bill.pdf",
        label: "Marina Bay Consulting bill",
        units: [{ unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
      }],
      facts: [{
        factId: "bill-v1", lineageKey: "bill", eventKey: "bill", sourceUnitIds: ["page-1"],
        origin: "MODEL_EXTRACTED", revision: 1, kind: "NATIVE_DOCUMENT", documentType: "BILL",
        counterpartyName: "Marina Bay Consulting Pte Ltd", documentDate: "2026-08-19",
        documentNumber: "MBC-2026-0820", currency: "SGD", exchangeRate: "0.783503", taxMode: "NO_TAX",
        lines: [{
          lineId: "line-1", description: "Corporate secretarial - Q3 2026", quantity: "1", unitAmount: "1635.00",
          sourceTax: "0.00", codingType: "ACCOUNT", codingName: "Office Expenses",
        }],
        declaredNet: "1635.00", declaredTax: "0.00", declaredGross: "1635.00",
        businessReason: "Record the Marina Bay Consulting secretarial bill.",
      }],
    });

    const prepared = await service.prepare(context, staged);
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: "BILL",
        disposition: "REVIEW_REQUIRED",
        reason_codes: ["COUNTERPARTY_CURRENCY_MISMATCH"],
      }),
    ]));
    expect(prepared.operations).toHaveLength(0);
  });

  // ---- LEDGER_ADJUSTMENT: JournalEntry ----------------------------------

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
    return quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref: targetSessionRef,
      case_id: "case-accrual-001",
      expected_version: 0,
      sources: [{ artifactId: "accrual.md", label: "Month-end accrual schedule", units: [{ unitId: "page-1", expectedFactKinds: ["JOURNAL_ENTRY"] }] }],
      facts: [fact],
    });
  };

  const ledgerAccounts = [
    { Id: "70", Name: "Professional Fees", FullyQualifiedName: "Professional Fees", AccountType: "Expense", Active: true },
    { Id: "71", Name: "Accrued Liabilities", FullyQualifiedName: "Accrued Liabilities", AccountType: "Other Current Liability", Active: true },
  ];

  function journalFixture(options: Parameters<typeof fixture>[0] = {}) {
    const built = fixture({ delegationActions: ["journal_entry.create"], ...options });
    vi.mocked(built.provider.listAccounts).mockResolvedValue(ledgerAccounts);
    return built;
  }

  it("compiles, prepares and posts a balanced journal entry against exactly-named accounts", async () => {
    const { service, executeMutation } = journalFixture();
    const staged = journalCase();
    const prepared = await service.prepare(context, staged);
    expect(prepared).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      completion_claim: { ledger_write_claim: "NOT_WRITTEN" },
      events: [{ route: "JOURNAL_ENTRY", compiled_disposition: "AUTO_EXECUTE" }],
      operations: [{ action_id: "journal_entry.create", entity: "JournalEntry", state: "PENDING" }],
    });
    expect(executeMutation).not.toHaveBeenCalled();

    const executed = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-accrual-1",
    });
    expect(executed).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED", provider_entity_id: "9001", assurance: { all_required_evidence_verified: true } }],
      completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(executeMutation.mock.calls.at(-1)?.[0]).toMatchObject({
      entity: "JournalEntry",
      payload: {
        TxnDate: "2026-07-31",
        CurrencyRef: { value: "SGD" },
        PrivateNote: "Accrue the July audit fee before the month is closed.",
        Line: [
          { Amount: 1200, Description: "July audit fee accrual", DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "70" } } },
          { Amount: 1200, Description: "Accrued audit fee", DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "71" } } },
        ],
      },
    });
    expect(executeMutation.mock.calls.at(-1)?.[0].payload).not.toHaveProperty("ExchangeRate");
  });

  it("refuses a journal line whose account name is absent from the chart of accounts", async () => {
    const { service, executeMutation } = journalFixture();
    const prepared = await service.prepare(context, journalCase((fact) => {
      (fact.lines as Array<Record<string, unknown>>)[0]!.accountName = "Profesional Fees";
    }));
    expect(prepared).toMatchObject({ state: "PLANNED_WITH_EXCEPTIONS", operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_NOT_FOUND"] }),
    ]));
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it("refuses a journal line whose account name matches two active accounts", async () => {
    const { service, provider } = journalFixture();
    vi.mocked(provider.listAccounts).mockResolvedValue([
      ...ledgerAccounts,
      { Id: "72", Name: "Professional Fees", FullyQualifiedName: "Professional Fees", AccountType: "Expense", Active: true },
    ]);
    const prepared = await service.prepare(context, journalCase());
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_AMBIGUOUS"] }),
    ]));
    expect(prepared.operations).toEqual([]);
  });

  it("refuses an AR or AP journal line this release cannot attribute to a counterparty", async () => {
    const { service, provider } = journalFixture();
    vi.mocked(provider.listAccounts).mockResolvedValue([
      ledgerAccounts[0]!,
      { Id: "80", Name: "Accounts Payable", FullyQualifiedName: "Accounts Payable", AccountType: "Accounts Payable", Active: true },
    ]);
    const prepared = await service.prepare(context, journalCase((fact) => {
      (fact.lines as Array<Record<string, unknown>>)[1]!.accountName = "Accounts Payable";
    }));
    expect(prepared).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: "BLOCKED_VALIDATION",
        reason_codes: ["JOURNAL_LINE_ACCOUNT_REQUIRES_COUNTERPARTY"],
      }),
    ]));
  });

  it("holds a journal entry to the same foreign-currency rules as a document", async () => {
    const missingRate = journalFixture();
    const preparedWithoutRate = await missingRate.service.prepare(context, journalCase((fact) => { fact.currency = "USD"; }));
    expect(preparedWithoutRate).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(preparedWithoutRate.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason_codes: ["EXCHANGE_RATE_REQUIRED_FOR_FOREIGN_CURRENCY"] }),
    ]));

    const disabled = journalFixture();
    vi.mocked(disabled.provider.getCompanyContext).mockResolvedValue({
      CompanyName: "Sandbox", HomeCurrency: { value: "SGD" }, MultiCurrencyEnabled: false,
    } as never);
    const preparedWithoutMultiCurrency = await disabled.service.prepare(context, journalCase((fact) => {
      fact.currency = "USD";
      fact.exchangeRate = "1.34";
    }));
    expect(preparedWithoutMultiCurrency.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "REVIEW_REQUIRED", reason_codes: ["COMPANY_MULTICURRENCY_DISABLED"] }),
    ]));

    const homeCurrencyRate = journalFixture();
    const preparedWithSpuriousRate = await homeCurrencyRate.service.prepare(context, journalCase((fact) => { fact.exchangeRate = "1.34"; }));
    expect(preparedWithSpuriousRate.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason_codes: ["EXCHANGE_RATE_NOT_APPLICABLE_TO_HOME_CURRENCY"] }),
    ]));

    const accepted = journalFixture();
    const staged = journalCase((fact) => {
      fact.currency = "USD";
      fact.exchangeRate = "1.34";
    });
    await accepted.service.prepare(context, staged);
    await accepted.service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-accrual-usd",
    });
    expect(accepted.executeMutation.mock.calls.at(-1)?.[0].payload).toMatchObject({
      CurrencyRef: { value: "USD" }, ExchangeRate: 1.34,
    });
  });

  // ---- POSTING_TRANSACTION: Purchase ------------------------------------

  const purchaseCase = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "card-expense-v1", lineageKey: "card-expense", eventKey: "card-expense", sourceUnitIds: ["page-1"],
      origin: "MODEL_EXTRACTED", revision: 1, kind: "NATIVE_DOCUMENT",
      documentType: "PURCHASE", counterpartyName: "Kopi Roasters", documentDate: "2026-07-14",
      currency: "SGD", taxMode: "NO_TAX",
      lines: [{
        lineId: "beans", description: "Office coffee", quantity: "2", unitAmount: "22.50",
        sourceTax: "0.00", codingType: "ACCOUNT", codingName: "Staff Welfare",
      }],
      declaredNet: "45.00", declaredTax: "0.00", declaredGross: "45.00",
      businessReason: "Record the company card purchase already charged to the card.",
      paymentAccountName: "OCBC Business Card",
      paymentType: "CREDIT_CARD",
    };
    mutate(fact);
    return quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref: targetSessionRef,
      case_id: "case-card-expense-001",
      expected_version: 0,
      sources: [{ artifactId: "card-receipt.jpg", label: "Card receipt", units: [{ unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT"] }] }],
      facts: [fact],
    });
  };

  const purchaseAccounts = [
    { Id: "60", Name: "Staff Welfare", FullyQualifiedName: "Staff Welfare", AccountType: "Expense", Active: true },
    { Id: "61", Name: "OCBC Business Card", FullyQualifiedName: "OCBC Business Card", AccountType: "Credit Card", Active: true },
  ];

  function purchaseFixture(options: Parameters<typeof fixture>[0] = {}) {
    const built = fixture({ delegationActions: ["purchase.create"], ...options });
    vi.mocked(built.provider.listAccounts).mockResolvedValue(purchaseAccounts);
    vi.mocked(built.provider.searchVendors).mockResolvedValue({
      records: [{ Id: "44", DisplayName: "Kopi Roasters", Active: true }], searchWindow: {} as never,
    });
    return built;
  }

  it("posts a card purchase with its payee, its money source and how the money left", async () => {
    const { service, executeMutation } = purchaseFixture();
    const staged = purchaseCase();
    const prepared = await service.prepare(context, staged);
    expect(prepared).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      events: [{ route: "PURCHASE", compiled_disposition: "AUTO_EXECUTE" }],
      operations: [{ action_id: "purchase.create", entity: "Purchase", state: "PENDING" }],
    });

    const executed = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-card-1",
    });
    expect(executed).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED", assurance: { all_required_evidence_verified: true } }],
    });
    const payload = executeMutation.mock.calls.at(-1)?.[0].payload;
    expect(payload).toMatchObject({
      EntityRef: { value: "44", type: "Vendor" },
      AccountRef: { value: "61" },
      PaymentType: "CreditCard",
      TxnDate: "2026-07-14",
      CurrencyRef: { value: "SGD" },
      GlobalTaxCalculation: "NotApplicable",
      Line: [{ Amount: 45, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "60" } } }],
    });
    // Purchase carries its payee on EntityRef, never on VendorRef, and never
    // acquires a DueDate.
    expect(payload).not.toHaveProperty("VendorRef");
    expect(payload).not.toHaveProperty("DueDate");
  });

  it("refuses a purchase whose stated money source is not a bank or card account", async () => {
    const { service } = purchaseFixture();
    const prepared = await service.prepare(context, purchaseCase((fact) => {
      fact.paymentAccountName = "Staff Welfare";
    }));
    expect(prepared).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: "BLOCKED_VALIDATION",
        reason_codes: ["PAYMENT_ACCOUNT_IS_NOT_A_MONEY_ACCOUNT"],
      }),
    ]));
  });

  it("refuses a purchase whose money source is absent from the chart of accounts", async () => {
    const { service } = purchaseFixture();
    const prepared = await service.prepare(context, purchaseCase((fact) => {
      fact.paymentAccountName = "OCBC Buisness Card";
    }));
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_NOT_FOUND"] }),
    ]));
    expect(prepared.operations).toEqual([]);
  });

  it("holds a purchase to the one shared foreign-currency policy", async () => {
    const missingRate = purchaseFixture();
    const prepared = await missingRate.service.prepare(context, purchaseCase((fact) => { fact.currency = "USD"; }));
    expect(prepared).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason_codes: ["EXCHANGE_RATE_REQUIRED_FOR_FOREIGN_CURRENCY"] }),
    ]));

    const accepted = purchaseFixture();
    vi.mocked(accepted.provider.searchVendors).mockResolvedValue({
      records: [{ Id: "44", DisplayName: "Kopi Roasters", Active: true, CurrencyRef: { value: "USD" } }],
      searchWindow: {} as never,
    });
    const staged = purchaseCase((fact) => {
      fact.currency = "USD";
      fact.exchangeRate = "1.34";
    });
    await accepted.service.prepare(context, staged);
    await accepted.service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-card-usd",
    });
    expect(accepted.executeMutation.mock.calls.at(-1)?.[0].payload).toMatchObject({
      CurrencyRef: { value: "USD" }, ExchangeRate: 1.34, PaymentType: "CreditCard",
    });
  });

  it("treats an exact purchase number and payee already in QuickBooks as already satisfied", async () => {
    const { service, documents, executeMutation } = purchaseFixture();
    documents.set("Purchase:44:kr-7714", {
      entity: "Purchase", counterpartyId: "44", docNumber: "KR-7714", providerEntityId: "5150",
    });
    const prepared = await service.prepare(context, purchaseCase((fact) => { fact.documentNumber = "KR-7714"; }));
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "EVIDENCE_ONLY", reason_codes: ["DOCUMENT_ALREADY_EXISTS"] }),
    ]));
    expect(prepared.operations).toEqual([]);
    expect(executeMutation).not.toHaveBeenCalled();
  });

  // ---- POSTING_TRANSACTION: SalesReceipt --------------------------------

  const salesReceiptCase = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "counter-sale-v1", lineageKey: "counter-sale", eventKey: "counter-sale", sourceUnitIds: ["page-1"],
      origin: "MODEL_EXTRACTED", revision: 1, kind: "NATIVE_DOCUMENT",
      documentType: "SALES_RECEIPT", counterpartyName: "Harbour Kitchen", documentDate: "2026-08-02",
      documentNumber: "SR-2001", currency: "SGD", taxMode: "NO_TAX",
      lines: [{
        lineId: "workshop", description: "Bookkeeping workshop seat", quantity: "2", unitAmount: "150.00",
        sourceTax: "0.00", codingType: "ITEM", codingName: "Bookkeeping",
      }],
      declaredNet: "300.00", declaredTax: "0.00", declaredGross: "300.00",
      businessReason: "Record the cash sale taken at the counter.",
      paymentAccountName: "Undeposited Funds",
    };
    mutate(fact);
    return quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref: targetSessionRef,
      case_id: "case-counter-sale-001",
      expected_version: 0,
      sources: [{ artifactId: "counter-receipt.pdf", label: "Counter receipt", units: [{ unitId: "page-1", expectedFactKinds: ["NATIVE_DOCUMENT"] }] }],
      facts: [fact],
    });
  };

  const salesReceiptAccounts = [
    { Id: "90", Name: "Undeposited Funds", FullyQualifiedName: "Undeposited Funds", AccountType: "Other Current Asset", AccountSubType: "UndepositedFunds", Active: true },
    { Id: "91", Name: "DBS Current Account", FullyQualifiedName: "DBS Current Account", AccountType: "Bank", Active: true },
    { Id: "92", Name: "Services Income", FullyQualifiedName: "Services Income", AccountType: "Income", Active: true },
  ];

  function salesReceiptFixture(options: Parameters<typeof fixture>[0] = {}) {
    const built = fixture({ delegationActions: ["sales_receipt.create"], ...options });
    vi.mocked(built.provider.listAccounts).mockResolvedValue(salesReceiptAccounts);
    return built;
  }

  it("posts a cash sale to its customer and the account the money landed in", async () => {
    const { service, executeMutation } = salesReceiptFixture();
    const staged = salesReceiptCase();
    const prepared = await service.prepare(context, staged);
    expect(prepared).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      events: [{ route: "SALES_RECEIPT", compiled_disposition: "AUTO_EXECUTE" }],
      operations: [{ action_id: "sales_receipt.create", entity: "SalesReceipt", state: "PENDING" }],
    });

    const executed = await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-counter-sale-1",
    });
    expect(executed).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED", assurance: { all_required_evidence_verified: true } }],
      completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
    });
    const payload = executeMutation.mock.calls.at(-1)?.[0].payload;
    expect(payload).toMatchObject({
      CustomerRef: { value: "12" },
      DepositToAccountRef: { value: "90" },
      DocNumber: "SR-2001",
      TxnDate: "2026-08-02",
      CurrencyRef: { value: "SGD" },
      GlobalTaxCalculation: "NotApplicable",
      Line: [{
        Amount: 300, DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { ItemRef: { value: "21" }, Qty: 2, UnitPrice: 150 },
      }],
    });
    // A cash sale records a completed sale; it never initiates a movement, so
    // it carries neither a payment type nor a due date.
    expect(payload).not.toHaveProperty("PaymentType");
    expect(payload).not.toHaveProperty("DueDate");
    expect(payload).not.toHaveProperty("VendorRef");
  });

  it("accepts a bank account as the deposit target and refuses an account money cannot land in", async () => {
    const toBank = salesReceiptFixture();
    const bankStaged = salesReceiptCase((fact) => { fact.paymentAccountName = "DBS Current Account"; });
    await toBank.service.prepare(context, bankStaged);
    await toBank.service.execute(context, {
      target_session_ref: targetSessionRef, case_id: bankStaged.case_id, case_version: 1, request_id: "execute-counter-sale-bank",
    });
    expect(toBank.executeMutation.mock.calls.at(-1)?.[0].payload).toMatchObject({
      DepositToAccountRef: { value: "91" },
    });

    const toIncome = salesReceiptFixture();
    const prepared = await toIncome.service.prepare(context, salesReceiptCase((fact) => {
      fact.paymentAccountName = "Services Income";
    }));
    expect(prepared).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: "BLOCKED_VALIDATION",
        reason_codes: ["PAYMENT_ACCOUNT_IS_NOT_A_MONEY_ACCOUNT"],
      }),
    ]));
    expect(toIncome.executeMutation).not.toHaveBeenCalled();
  });

  // ---- MASTER_DATA: Account and Item ------------------------------------

  const masterDataCase = (facts: Array<Record<string, unknown>>, expectedFactKinds: string[]) =>
    quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref: targetSessionRef,
      case_id: "case-master-data-001",
      expected_version: 0,
      sources: [{ artifactId: "chart-request.md", label: "Chart of accounts request", units: [{ unitId: "row-1", expectedFactKinds }] }],
      facts,
    });

  const newAccountFact = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "account-v1", lineageKey: "account", eventKey: "account", sourceUnitIds: ["row-1"],
      origin: "AGENT_ASSERTED", revision: 1, kind: "ACCOUNT_CANDIDATE",
      name: "Software Subscriptions", accountType: "Expense",
    };
    mutate(fact);
    return fact;
  };

  const newItemFact = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "item-v1", lineageKey: "item", eventKey: "item", sourceUnitIds: ["row-1"],
      origin: "AGENT_ASSERTED", revision: 1, kind: "ITEM_CANDIDATE",
      name: "Workshop Seat", itemType: "SERVICE", incomeAccountName: "Services Income",
    };
    mutate(fact);
    return fact;
  };

  const chartOfAccounts = [
    { Id: "50", Name: "Operating Expenses", FullyQualifiedName: "Operating Expenses", AccountType: "Expense", Active: true },
    { Id: "51", Name: "Services Income", FullyQualifiedName: "Services Income", AccountType: "Income", Active: true },
    { Id: "52", Name: "Subcontractor Costs", FullyQualifiedName: "Subcontractor Costs", AccountType: "Cost of Goods Sold", Active: true },
  ];

  function masterDataFixture(options: Parameters<typeof fixture>[0] = {}) {
    const built = fixture({ delegationActions: ["account.create", "item.create"], ...options });
    vi.mocked(built.provider.listAccounts).mockResolvedValue(chartOfAccounts);
    return built;
  }

  it("creates a chart-of-accounts entry and a service item mid-close", async () => {
    const { service, executeMutation } = masterDataFixture();
    const staged = masterDataCase([newAccountFact(), newItemFact((fact) => {
      fact.expenseAccountName = "Subcontractor Costs";
    })], ["ACCOUNT_CANDIDATE", "ITEM_CANDIDATE"]);
    const prepared = await service.prepare(context, staged);
    expect(prepared).toMatchObject({ state: "PLANNED_NEEDS_PREFLIGHT" });
    expect(prepared.operations.map((operation) => operation.action_id).sort())
      .toEqual(["account.create", "item.create"]);

    await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-master-data-1",
    });
    const written = new Map(executeMutation.mock.calls.map(([mutation]) => [mutation.entity, mutation.payload]));
    expect(written.get("Account")).toEqual({ Name: "Software Subscriptions", AccountType: "Expense" });
    expect(written.get("Item")).toEqual({
      Name: "Workshop Seat",
      Type: "Service",
      IncomeAccountRef: { value: "51" },
      ExpenseAccountRef: { value: "52" },
    });
  });

  it("hangs a sub-account off its exactly-named parent", async () => {
    const { service, executeMutation } = masterDataFixture();
    const staged = masterDataCase([newAccountFact((fact) => {
      fact.parentAccountName = "Operating Expenses";
    })], ["ACCOUNT_CANDIDATE"]);
    await service.prepare(context, staged);
    await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-sub-account-1",
    });
    expect(executeMutation.mock.calls.at(-1)?.[0].payload).toEqual({
      Name: "Software Subscriptions",
      AccountType: "Expense",
      SubAccount: true,
      ParentRef: { value: "50" },
    });
  });

  it("treats master data that already exists as satisfied, and resolves on the qualified name", async () => {
    const { service, provider, executeMutation } = masterDataFixture();
    // Resolution is on FullyQualifiedName, so a *sub*-account already named
    // Operating Expenses:Software Subscriptions must satisfy the sub-account
    // request while leaving the top-level request of the same leaf name open.
    vi.mocked(provider.listAccounts).mockResolvedValue([
      ...chartOfAccounts,
      {
        Id: "53", Name: "Software Subscriptions",
        FullyQualifiedName: "Operating Expenses:Software Subscriptions",
        AccountType: "Expense", Active: true,
      },
    ]);
    vi.mocked(provider.listItems).mockResolvedValue([
      { Id: "21", Name: "Bookkeeping", Active: true },
      { Id: "22", Name: "Workshop Seat", Active: true },
    ]);
    const prepared = await service.prepare(context, masterDataCase(
      [newAccountFact((fact) => { fact.parentAccountName = "Operating Expenses"; }), newItemFact()],
      ["ACCOUNT_CANDIDATE", "ITEM_CANDIDATE"],
    ));
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "ACCOUNT_CREATE", disposition: "EVIDENCE_ONLY", reason_codes: ["ACCOUNT_ALREADY_EXISTS"] }),
      expect.objectContaining({ route: "ITEM_CREATE", disposition: "EVIDENCE_ONLY", reason_codes: ["ITEM_ALREADY_EXISTS"] }),
    ]));
    expect(prepared.operations).toEqual([]);
    expect(executeMutation).not.toHaveBeenCalled();

    const topLevel = masterDataFixture();
    vi.mocked(topLevel.provider.listAccounts).mockResolvedValue([
      ...chartOfAccounts,
      {
        Id: "53", Name: "Software Subscriptions",
        FullyQualifiedName: "Operating Expenses:Software Subscriptions",
        AccountType: "Expense", Active: true,
      },
    ]);
    const stillOpen = await topLevel.service.prepare(context, masterDataCase([newAccountFact()], ["ACCOUNT_CANDIDATE"]));
    expect(stillOpen.operations).toEqual([{ ...stillOpen.operations[0], action_id: "account.create" }]);
  });

  it("refuses master data whose referenced accounts are absent or ambiguous", async () => {
    const missing = masterDataFixture();
    const preparedMissingParent = await missing.service.prepare(context, masterDataCase([newAccountFact((fact) => {
      fact.parentAccountName = "Operating Expensez";
    })], ["ACCOUNT_CANDIDATE"]));
    expect(preparedMissingParent.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_NOT_FOUND"] }),
    ]));
    expect(preparedMissingParent.operations).toEqual([]);

    const ambiguous = masterDataFixture();
    vi.mocked(ambiguous.provider.listAccounts).mockResolvedValue([
      ...chartOfAccounts,
      { Id: "54", Name: "Services Income", FullyQualifiedName: "Services Income", AccountType: "Income", Active: true },
    ]);
    const preparedAmbiguousIncome = await ambiguous.service.prepare(context,
      masterDataCase([newItemFact()], ["ITEM_CANDIDATE"]));
    expect(preparedAmbiguousIncome.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_AMBIGUOUS"] }),
    ]));
    expect(preparedAmbiguousIncome.operations).toEqual([]);
  });

  // ---- ATTACHMENT: the source document follows the entry -----------------

  const attachmentCase = (mutate: (fact: Record<string, unknown>) => void = () => {}) => {
    const fact: Record<string, unknown> = {
      factId: "attachment-v1", lineageKey: "attachment", eventKey: "attachment", sourceUnitIds: ["page-1"],
      origin: "MODEL_EXTRACTED", revision: 1, kind: "SOURCE_ATTACHMENT",
      documentType: "INVOICE", counterpartyName: "Harbour Kitchen", documentNumber: "INV-1001",
      note: "Original invoice as issued to the client.",
    };
    mutate(fact);
    return quickBooksPrepareAccountingCaseSchema.parse({
      target_session_ref: targetSessionRef,
      case_id: "case-attachment-001",
      expected_version: 0,
      sources: [{
        artifactId: "invoice.pdf",
        label: "Customer invoice",
        units: [{ unitId: "page-1", expectedFactKinds: ["SOURCE_ATTACHMENT"] }],
        sourceRef: "drive://harbour-kitchen/INV-1001.pdf",
        sourceSha256: "b".repeat(64),
        sourceDigestProvenance: "AGENT_SUPPLIED_TEXT_FINGERPRINT",
      }],
      facts: [fact],
    });
  };

  function attachmentFixture(options: Parameters<typeof fixture>[0] = {}) {
    return fixture({ delegationActions: ["attachment.create"], ...options });
  }

  it("waits for the document to post, then hangs the source identity off it as a note", async () => {
    const { service, documents, executeMutation } = attachmentFixture();

    // Stage one: the invoice is not in QuickBooks yet, so there is nothing to
    // attach to. The attachment orders itself behind the document by the same
    // prepare-time reference resolution that orders a document behind its
    // contact -- no compiler sequencing is involved.
    const beforeDocument = await service.prepare(context, attachmentCase());
    expect(beforeDocument).toMatchObject({ state: "PLANNED_WITH_EXCEPTIONS", operations: [] });
    expect(beforeDocument.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: "ATTACHMENT_CREATE", disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_NOT_FOUND"],
      }),
    ]));
    expect(executeMutation).not.toHaveBeenCalled();

    // Stage three: the invoice posted, so the same facts now resolve.
    documents.set("Invoice:12:inv-1001", {
      entity: "Invoice", counterpartyId: "12", docNumber: "INV-1001", providerEntityId: "9001",
    });
    const staged = attachmentCase();
    staged.expected_version = 1;
    const prepared = await service.prepare(context, staged);
    expect(prepared).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      operations: [{ action_id: "attachment.create", entity: "Attachable", state: "PENDING" }],
    });

    await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 2, request_id: "execute-attachment-1",
    });
    const mutation = executeMutation.mock.calls.at(-1)?.[0];
    expect(mutation).toMatchObject({ entity: "Attachable" });
    expect(mutation?.payload).toEqual({
      Note: [
        "Original invoice as issued to the client.",
        "",
        "Source: drive://harbour-kitchen/INV-1001.pdf",
        `SHA-256: ${"b".repeat(64)}`,
        "Digest provenance: AGENT_SUPPLIED_TEXT_FINGERPRINT",
      ].join("\n"),
      AttachableRef: [{ EntityRef: { type: "Invoice", value: "9001" } }],
    });
    // The note form is a plain entity write, never the multipart /upload form
    // that the confirmed-not-written classifier deliberately excludes.
    expect(mutation?.payload).not.toHaveProperty("base64_content");
    expect(mutation?.payload).not.toHaveProperty("FileName");
  });

  it("refuses an attachment whose counterparty or target document is ambiguous", async () => {
    const ambiguousDocument = attachmentFixture();
    vi.mocked(ambiguousDocument.provider.findExistingAccountingDocuments).mockResolvedValue([
      { entity: "Invoice", providerEntityId: "9001", counterpartyId: "12", docNumber: "INV-1001" },
      { entity: "Invoice", providerEntityId: "9002", counterpartyId: "12", docNumber: "INV-1001" },
    ] as never);
    const prepared = await ambiguousDocument.service.prepare(context, attachmentCase());
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "REVIEW_REQUIRED", reason_codes: ["DOCUMENT_NUMBER_AMBIGUOUS"] }),
    ]));
    expect(prepared.operations).toEqual([]);

    const missingCounterparty = attachmentFixture({ customerInitiallyMissing: true });
    const preparedMissing = await missingCounterparty.service.prepare(context, attachmentCase());
    expect(preparedMissing.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "REVIEW_REQUIRED", reason_codes: ["REFERENCE_NOT_FOUND"] }),
    ]));
  });

  it("refuses rather than truncates when the note and its source identity exceed the QuickBooks limit", async () => {
    const { service, documents } = attachmentFixture();
    documents.set("Invoice:12:inv-1001", {
      entity: "Invoice", counterpartyId: "12", docNumber: "INV-1001", providerEntityId: "9001",
    });
    const staged = attachmentCase((fact) => { fact.note = "n".repeat(1_000); });
    const [source] = staged.sources;
    if (!source) throw new Error("test fixture requires one source artifact");
    source.sourceRef = `drive://${"p".repeat(1_100)}`;
    const prepared = await service.prepare(context, staged);
    expect(prepared).toMatchObject({ state: "BLOCKED_VALIDATION", operations: [] });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "BLOCKED_VALIDATION", reason_codes: ["ATTACHMENT_NOTE_TOO_LONG"] }),
    ]));
  });

  it("never attaches twice under one attachment key, and refuses rather than collapsing distinct evidence", async () => {
    // The stable key is target plus note, so these two Cases are one logical
    // attachment -- but they declare different source identities, which the
    // note itself carries. The durable request id is shared while the payload
    // is not, so the second is refused outright. That is the safe answer: no
    // second Attachable is posted, and the distinct evidence is not silently
    // discarded as "already done".
    const mutationRepository = new InMemoryQuickBooksMutationRepository();
    const posted = { entity: "Invoice", counterpartyId: "12", docNumber: "INV-1001", providerEntityId: "9001" };
    const first = attachmentFixture({ mutationRepository });
    first.documents.set("Invoice:12:inv-1001", posted);
    const firstStaged = attachmentCase();
    await first.service.prepare(context, firstStaged);
    await first.service.execute(context, {
      target_session_ref: targetSessionRef, case_id: firstStaged.case_id, case_version: 1, request_id: "execute-attachment-a",
    });
    expect(first.executeMutation).toHaveBeenCalledTimes(1);

    const second = attachmentFixture({ mutationRepository });
    second.documents.set("Invoice:12:inv-1001", posted);
    const secondStaged = attachmentCase();
    secondStaged.case_id = "case-attachment-002";
    const [otherSource] = secondStaged.sources;
    if (!otherSource) throw new Error("test fixture requires one source artifact");
    otherSource.sourceRef = "drive://harbour-kitchen/INV-1001-approval.pdf";
    otherSource.sourceSha256 = "c".repeat(64);
    await second.service.prepare(context, secondStaged);
    await expect(second.service.execute(context, {
      target_session_ref: targetSessionRef, case_id: secondStaged.case_id, case_version: 1, request_id: "execute-attachment-b",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(second.executeMutation).not.toHaveBeenCalled();
  });

  it("falls back to the Case fact fingerprint when the source unit declared no identity", async () => {
    const { service, documents, executeMutation } = attachmentFixture();
    documents.set("Invoice:12:inv-1001", {
      entity: "Invoice", counterpartyId: "12", docNumber: "INV-1001", providerEntityId: "9001",
    });
    const staged = attachmentCase();
    const [source] = staged.sources;
    if (!source) throw new Error("test fixture requires one source artifact");
    delete source.sourceRef;
    delete source.sourceSha256;
    delete source.sourceDigestProvenance;
    await service.prepare(context, staged);
    await service.execute(context, {
      target_session_ref: targetSessionRef, case_id: staged.case_id, case_version: 1, request_id: "execute-attachment-fallback",
    });
    const note = (executeMutation.mock.calls.at(-1)?.[0].payload as { Note: string }).Note;
    // The fallback is labelled for what it is -- a Case fact fingerprint, not a
    // claim about the original file's bytes.
    expect(note).toContain("Source: accounting-case-operation:");
    expect(note).toContain("Digest provenance: AGENT_SUPPLIED_TEXT_FINGERPRINT");
  });
});
