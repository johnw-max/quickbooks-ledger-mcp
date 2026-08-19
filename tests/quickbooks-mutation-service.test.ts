import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";
import {
  consumeQuickBooksProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../src/security/quickBooksProviderWritePermit.js";

const targetSessionRef = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;

function fixture(options: {
  writeEnabled?: boolean;
  bindingRevision?: string;
  allowedCapabilities?: string[];
  accountingCaseReleasedCapabilities?: string[];
  executeScopeAuthorizer?: (actorId: string, requiredScope: string) => Promise<boolean>;
} = {}) {
  const executeMutation = vi.fn(async (
    input: QuickBooksProviderMutationCommand,
    permit: QuickBooksProviderWritePermit,
    recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
    markProviderDispatch: () => Promise<void>,
  ) => {
    consumeQuickBooksProviderWritePermit(permit, {
      realmId: "9341457701636490",
      command: input,
    });
    await markProviderDispatch();
    const outcome = {
      providerEntityId: "9001",
      receipt: { verified: true, entity: input.entity, operation: input.operation },
      readback: { Id: "9001", DisplayName: "Harbour Kitchen Pte Ltd" },
    };
    await recordProviderOutcome({ providerEntityId: outcome.providerEntityId, receipt: {
      provider: "quickbooks-test", requestId: input.requestId,
    } });
    return outcome;
  });
  const recoverMutation = vi.fn(async (input: QuickBooksProviderMutationCommand, providerEntityId: string) => ({
    providerEntityId,
    receipt: { verified: true, recoveryOnly: true, requestId: input.requestId },
    readback: { Id: providerEntityId, DisplayName: "Harbour Kitchen Pte Ltd" },
  }));
  const getMutationTarget = vi.fn(async (_entity: string, targetId: string) => ({
    Id: targetId,
    SyncToken: "3",
    DisplayName: "Old Vendor Name",
    Active: true,
  }));
  const provider = { executeMutation, recoverMutation, getMutationTarget } as unknown as QuickBooksProviderCapabilities;
  const resolver: QuickBooksProviderResolver = {
    connectionStatus: vi.fn(),
    resolve: vi.fn(async () => ({
      realmId: "9341457701636490",
      companyName: "Sandbox Company",
      connectionRefSafe: "qbc_123",
      boundTargetRefSafe: "qbt_123",
      bindingRevision: options.bindingRevision ?? "qbr_v1",
      provider,
    })),
  };
  const repository = new InMemoryQuickBooksMutationRepository();
  const service = new QuickBooksMutationService(
    repository,
    resolver,
    {
      writeEnabled: options.writeEnabled ?? true,
      writeTargetMode: "exact_allowlist",
      publicBaseUrl: "https://quickbooks-mcp.example.test",
      allowedRealmId: "9341457701636490",
      ...(options.allowedCapabilities ? { allowedCapabilities: options.allowedCapabilities } : {}),
      ...(options.accountingCaseReleasedCapabilities
        ? { accountingCaseReleasedCapabilities: options.accountingCaseReleasedCapabilities }
        : {}),
      ...(options.executeScopeAuthorizer ? { executeScopeAuthorizer: options.executeScopeAuthorizer } : {}),
    },
  );
  return { service, repository, resolver, executeMutation, recoverMutation, getMutationTarget };
}

const customerInput = {
  target_session_ref: targetSessionRef,
  request_id: "qbo.customer.harbour-001",
  entity: "Customer" as const,
  operation: "CREATE" as const,
  payload: { DisplayName: "Harbour Kitchen Pte Ltd" },
  business_reason: "Create the accepted engagement customer after intake approval.",
};

describe("QuickBooks generic mutation service", () => {
  it("uses the generic mutation execute scope for Bill while legacy supplier Bill keeps its separate gate", async () => {
    const observedScopes: string[] = [];
    const { service, repository } = fixture({
      allowedCapabilities: ["CREATE:Bill"],
      executeScopeAuthorizer: async (_actorId, requiredScope) => {
        observedScopes.push(requiredScope);
        return requiredScope === "quickbooks.mutation.execute";
      },
    });
    const prepared = await service.prepare("actor-a", {
      target_session_ref: targetSessionRef,
      request_id: "qbo.bill.scope-001",
      entity: "Bill",
      operation: "CREATE",
      payload: {
        VendorRef: { value: "60" },
        Line: [{
          Amount: 80,
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: { AccountRef: { value: "15" } },
        }],
      },
      business_reason: "Verify Accounting Case and generic Bill use the mutation transport scope.",
    });

    await repository.saveReviewCsrf({
      csrfHash: "csrf-hash",
      sessionHash: "session-hash",
      actorId: "actor-a",
      preparationId: prepared.preparation_id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await service.executeAfterHumanReview({
      actorId: "actor-a",
      preparationId: prepared.preparation_id,
      approvedBy: "reviewer-a",
      sessionHash: "session-hash",
      csrfHash: "csrf-hash",
    });

    expect(observedScopes).toEqual(["quickbooks.mutation.execute"]);
  });

  it("prepares without provider mutation, then executes a low-risk create after exact confirmation", async () => {
    const { service, executeMutation } = fixture();
    const prepared = await service.prepare("actor-a", customerInput);
    expect(prepared).toMatchObject({
      state: "PREPARED",
      entity: "Customer",
      risk: "LOW",
      execution_mode: "EXPLICIT_CONFIRMATION",
      provider_write_executed: false,
      runtime_policy_enabled: true,
      runtime_execution_enabled: true,
      quickbooks_draft_available: false,
    });
    expect(executeMutation).not.toHaveBeenCalled();

    const result = await service.executeWithConfirmation("actor-a", {
      preparation_id: prepared.preparation_id,
      request_id: customerInput.request_id,
      confirmation_phrase: prepared.confirmation_phrase as string,
    });
    expect(result).toMatchObject({
      state: "POSTED_READBACK_VERIFIED",
      entity: "Customer",
      operation: "CREATE",
      providerEntityId: "9001",
      receipt: { verified: true },
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(Object.keys(executeMutation.mock.calls[0]?.[1] as object)).toEqual([]);
  });

  it("durably checkpoints the Provider Id before readback and recovers by exact Id without a second write", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    let first = true;
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId: "9341457701636490", command: input });
      await markProviderDispatch();
      await recordProviderOutcome({ providerEntityId: "recovery-9001", receipt: { requestId: input.requestId } });
      if (first) {
        first = false;
        throw new AppError("WRITE_RESULT_UNKNOWN", "simulated crash after Provider response", { httpStatus: 503, retryable: false });
      }
      throw new Error("provider write must never be retried");
    });
    const recoverMutation = vi.fn(async (input: QuickBooksProviderMutationCommand, providerEntityId: string) => ({
      providerEntityId,
      receipt: { requestId: input.requestId, verification: "RECOVERY_EXACT_ID_READBACK" },
      readback: { Id: providerEntityId, DisplayName: "Harbour Kitchen Pte Ltd" },
    }));
    const provider = { executeMutation, recoverMutation, getMutationTarget: vi.fn() } as unknown as QuickBooksProviderCapabilities;
    const resolver: QuickBooksProviderResolver = {
      connectionStatus: vi.fn(),
      resolve: vi.fn(async () => ({
        realmId: "9341457701636490", companyName: "Sandbox Company", connectionRefSafe: "qbc_123",
        boundTargetRefSafe: "qbt_123", bindingRevision: "qbr_v1", provider,
      })),
    };
    const service = new QuickBooksMutationService(repository, resolver, {
      writeEnabled: true, writeTargetMode: "exact_allowlist", publicBaseUrl: "https://quickbooks-mcp.example.test",
      allowedRealmId: "9341457701636490",
    });
    const prepared = await service.prepare("actor-a", customerInput);
    await expect(service.executeWithConfirmation("actor-a", {
      preparation_id: prepared.preparation_id, request_id: customerInput.request_id,
      confirmation_phrase: prepared.confirmation_phrase as string,
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    await expect(repository.get(prepared.preparation_id)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN", providerEntityId: "recovery-9001",
      providerOutcomeReceipt: { requestId: expect.any(String), canonicalPayloadHash: expect.any(String) },
    });

    const recovered = await service.executeWithConfirmation("actor-a", {
      preparation_id: prepared.preparation_id, request_id: customerInput.request_id,
      confirmation_phrase: prepared.confirmation_phrase as string,
    });
    expect(recovered).toMatchObject({
      state: "POSTED_READBACK_VERIFIED", providerEntityId: "recovery-9001", idempotentReplay: true,
      receipt: { recoveryOnly: true, providerMutationRetried: false },
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(recoverMutation).toHaveBeenCalledTimes(1);
  });

  it("replays durable terminal evidence without a second write when audit completion crashes after commit", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId: "9341457701636490", command: input });
      await markProviderDispatch();
      await recordProviderOutcome({ providerEntityId: "audit-9001", receipt: { requestId: input.requestId } });
      return {
        providerEntityId: "audit-9001", receipt: { verified: true },
        readback: { Id: "audit-9001", DisplayName: "Harbour Kitchen Pte Ltd" },
      };
    });
    const provider = {
      executeMutation, recoverMutation: vi.fn(), getMutationTarget: vi.fn(),
    } as unknown as QuickBooksProviderCapabilities;
    const resolver: QuickBooksProviderResolver = {
      connectionStatus: vi.fn(),
      resolve: vi.fn(async () => ({
        realmId: "9341457701636490", companyName: "Sandbox Company", connectionRefSafe: "qbc_123",
        boundTargetRefSafe: "qbt_123", bindingRevision: "qbr_v1", provider,
      })),
    };
    let completionCount = 0;
    const audit = {
      beginAudit: vi.fn(async () => undefined),
      completeAudit: vi.fn(async () => {
        completionCount += 1;
        if (completionCount === 2) throw new Error("simulated audit completion crash");
      }),
    };
    const service = new QuickBooksMutationService(repository, resolver, {
      writeEnabled: true, writeTargetMode: "exact_allowlist", publicBaseUrl: "https://quickbooks-mcp.example.test",
      allowedRealmId: "9341457701636490",
    }, audit);
    const prepared = await service.prepare("actor-a", customerInput);
    const executeInput = {
      preparation_id: prepared.preparation_id, request_id: customerInput.request_id,
      confirmation_phrase: prepared.confirmation_phrase as string,
    };
    await expect(service.executeWithConfirmation("actor-a", executeInput)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR", details: { auditCompletionStatus: "UNKNOWN" },
    });
    await expect(repository.get(prepared.preparation_id)).resolves.toMatchObject({
      state: "POSTED_READBACK_VERIFIED", providerEntityId: "audit-9001",
    });
    const replay = await service.executeWithConfirmation("actor-a", executeInput);
    expect(replay).toMatchObject({ state: "POSTED_READBACK_VERIFIED", idempotentReplay: true });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("requires out-of-band review for a posting transaction", async () => {
    const { service, executeMutation } = fixture();
    const prepared = await service.prepare("actor-a", {
      target_session_ref: targetSessionRef,
      request_id: "qbo.invoice.001",
      entity: "Invoice",
      operation: "CREATE",
      payload: { CustomerRef: { value: "12" }, Line: [{ Amount: 100 }] },
      business_reason: "Bill the approved monthly bookkeeping engagement.",
    });
    expect(prepared).toMatchObject({
      risk: "HIGH",
      execution_mode: "HUMAN_REVIEW",
      review_required: true,
      confirmation_phrase: undefined,
    });
    await expect(service.executeWithConfirmation("actor-a", {
      preparation_id: prepared.preparation_id,
      request_id: "qbo.invoice.execute-001",
      confirmation_phrase: "CONFIRM QUICKBOOKS CREATE Invoice",
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it("keeps cash actions disabled even after human review unless explicitly allowlisted", async () => {
    const { service, executeMutation } = fixture();
    const prepared = await service.prepare("actor-a", {
      target_session_ref: targetSessionRef,
      request_id: "qbo.payment.001",
      entity: "Payment",
      operation: "CREATE",
      payload: { CustomerRef: { value: "12" }, TotalAmt: 100 },
      business_reason: "Record a received customer payment.",
    });
    await expect(service.executeAfterHumanReview({
      actorId: "actor-a",
      preparationId: prepared.preparation_id,
      approvedBy: "controller-a",
      sessionHash: "session-hash",
      csrfHash: "csrf-hash",
    })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("CREATE:Payment") });
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it("fails closed when write gate is disabled or OAuth binding changes", async () => {
    const disabled = fixture({ writeEnabled: false });
    const prepared = await disabled.service.prepare("actor-a", customerInput);
    expect(prepared.runtime_execution_enabled).toBe(false);
    expect(disabled.service.capabilities({ entity: "Customer", operation: "CREATE" }))
      .toMatchObject({ capabilities: [{ runtimePolicyEnabled: true, runtimeExecutionEnabled: false }] });
    await expect(disabled.service.executeWithConfirmation("actor-a", {
      preparation_id: prepared.preparation_id,
      request_id: customerInput.request_id,
      confirmation_phrase: prepared.confirmation_phrase as string,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const switched = fixture();
    const switchedPrepared = await switched.service.prepare("actor-a", customerInput);
    vi.mocked(switched.resolver.resolve).mockResolvedValueOnce({
      realmId: "9341457701636490",
      companyName: "Sandbox Company",
      connectionRefSafe: "qbc_123",
      boundTargetRefSafe: "qbt_123",
      bindingRevision: "qbr_v2",
      provider: { executeMutation: switched.executeMutation } as unknown as QuickBooksProviderCapabilities,
    });
    await expect(switched.service.executeWithConfirmation("actor-a", {
      preparation_id: switchedPrepared.preparation_id,
      request_id: customerInput.request_id,
      confirmation_phrase: switchedPrepared.confirmation_phrase as string,
    })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("OAuth binding") });
  });

  it("is idempotent and rejects request-id payload substitution", async () => {
    const { service } = fixture();
    const first = await service.prepare("actor-a", customerInput);
    const replay = await service.prepare("actor-a", customerInput);
    expect(replay.preparation_id).toBe(first.preparation_id);
    expect(replay.idempotent_replay).toBe(true);
    await expect(service.prepare("actor-a", {
      ...customerInput,
      payload: { DisplayName: "Different customer" },
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reads and freezes the exact update target during PREPARED", async () => {
    const { service, getMutationTarget } = fixture();
    const prepared = await service.prepare("actor-a", {
      target_session_ref: targetSessionRef,
      request_id: "qbo.vendor.update.001",
      entity: "Vendor",
      operation: "UPDATE",
      target_id: "77",
      sync_token: "3",
      payload: { DisplayName: "New Vendor Name" },
      business_reason: "Correct the accepted vendor display name.",
    });
    expect(getMutationTarget).toHaveBeenCalledWith("Vendor", "77");
    expect(prepared.proposal).toMatchObject({
      target_id: "77",
      sync_token: "3",
      before_image: { Id: "77", SyncToken: "3", DisplayName: "Old Vendor Name" },
    });
  });

  it("separates the official write catalog from the Agent-facing Accounting Case release", () => {
    const { service } = fixture({ accountingCaseReleasedCapabilities: ["CREATE:Invoice"] });

    expect(service.capabilities({ entity: "Invoice", operation: "CREATE" })).toMatchObject({
      runtime: {
        agentFacingMode: "ACCOUNTING_CASE",
        accountingCaseReleasedCapabilities: ["CREATE:Invoice"],
      },
      capabilities: [{
        accountingCaseReleased: true,
        runtimePolicyEnabled: true,
        runtimeExecutionEnabled: true,
      }],
    });
    expect(service.capabilities({ entity: "Customer", operation: "UPDATE" })).toMatchObject({
      capabilities: [{
        accountingCaseReleased: false,
        runtimePolicyEnabled: true,
        runtimeExecutionEnabled: false,
      }],
    });
  });
});
