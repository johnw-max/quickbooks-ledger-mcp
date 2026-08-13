import { describe, expect, it, vi } from "vitest";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";

function fixture(options: {
  writeEnabled?: boolean;
  bindingRevision?: string;
  allowedCapabilities?: string[];
  accountingCaseReleasedCapabilities?: string[];
} = {}) {
  const executeMutation = vi.fn(async (input: { entity: string; operation: string }) => ({
    providerEntityId: "9001",
    receipt: { verified: true, entity: input.entity, operation: input.operation },
    readback: { Id: "9001", DisplayName: "Harbour Kitchen Pte Ltd" },
  }));
  const getMutationTarget = vi.fn(async (_entity: string, targetId: string) => ({
    Id: targetId,
    SyncToken: "3",
    DisplayName: "Old Vendor Name",
    Active: true,
  }));
  const provider = { executeMutation, getMutationTarget } as unknown as QuickBooksProviderCapabilities;
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
  const service = new QuickBooksMutationService(
    new InMemoryQuickBooksMutationRepository(),
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
    },
  );
  return { service, resolver, executeMutation, getMutationTarget };
}

const customerInput = {
  request_id: "qbo.customer.harbour-001",
  entity: "Customer" as const,
  operation: "CREATE" as const,
  payload: { DisplayName: "Harbour Kitchen Pte Ltd" },
  business_reason: "Create the accepted engagement customer after intake approval.",
};

describe("QuickBooks generic mutation service", () => {
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
  });

  it("requires out-of-band review for a posting transaction", async () => {
    const { service, executeMutation } = fixture();
    const prepared = await service.prepare("actor-a", {
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
