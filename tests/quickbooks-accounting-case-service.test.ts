import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import type { RequestContext } from "../src/security/requestContext.js";
import { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";
import { quickBooksPrepareAccountingCaseSchema } from "../src/quickbooks/accountingCaseSchemas.js";
import { InMemoryQuickBooksAccountingCaseRepository } from "../src/quickbooks/inMemoryAccountingCaseRepository.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES } from "../src/quickbooks/accountingCase.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";

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
} = {}) {
  let customerExists = !options.customerInitiallyMissing;
  let delegationActions = options.delegationActions ?? ["invoice.create"];
  const documents = new Map<string, { entity: string; counterpartyId: string; docNumber: string; providerEntityId: string }>();
  let crashAfterProviderOutcome = options.crashAfterProviderOutcome ?? false;
  const executeMutation = vi.fn(async (
    mutation: { entity: string; requestId: string },
    _permit: unknown,
    recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
    markProviderDispatch: () => Promise<void>,
  ) => {
    if (options.providerDelayMs) await new Promise((resolve) => setTimeout(resolve, options.providerDelayMs));
    if (options.beforeProviderDispatch) await options.beforeProviderDispatch();
    await markProviderDispatch();
    if (options.afterProviderDispatch) await options.afterProviderDispatch();
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
  const mutations = new QuickBooksMutationService(
    new InMemoryQuickBooksMutationRepository(), resolver,
    {
      writeEnabled: options.writeEnabled ?? true,
      writeTargetMode: "exact_allowlist",
      allowedRealmId: "9341457701636490",
      publicBaseUrl: "https://mcp.test",
      accountingCaseReleasedCapabilities: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
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
    service, repository, executeMutation, recoverMutation, provider, documents,
    setDelegationActions: (actions: string[]) => { delegationActions = [...actions]; },
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

  it("blocks a foreign-currency NativeDocument even when QuickBooks multi-currency is enabled", async () => {
    const { service } = fixture();
    const foreign = structuredClone(input);
    foreign.case_id = "case-foreign-currency-001";
    const [foreignFact] = foreign.facts;
    if (!foreignFact || foreignFact.kind !== "NATIVE_DOCUMENT") throw new Error("test fixture requires a native document");
    foreignFact.currency = "USD";

    const prepared = await service.prepare(context, foreign);
    expect(prepared).toMatchObject({
      state: "BLOCKED_VALIDATION",
      operations: [],
    });
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: "BLOCKED_VALIDATION",
        reason_codes: ["FOREIGN_CURRENCY_EXCHANGE_RATE_POLICY_NOT_RELEASED"],
      }),
    ]));
  });

  it("recomputes OfficeHub 9% GST and blocks 7.21 while accepting 7.20", async () => {
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
});
