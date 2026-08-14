import { describe, expect, it, vi } from "vitest";
import { issueDeterministicValidationReceipt } from "../src/ledger-control/deterministicValidation.js";
import type { LedgerStandingDelegation } from "../src/ledger-control/ledgerControlKernel.js";
import { hashObject } from "../src/security/hash.js";
import type { RequestContext } from "../src/security/requestContext.js";
import {
  consumeQuickBooksProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../src/security/quickBooksProviderWritePermit.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES } from "../src/quickbooks/accountingCase.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";

const targetSessionRef = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
const realmId = "9341457701636490";
const sourceRevisionHash = "d".repeat(64);
const stableOperationKey = "e".repeat(64);
const payload = { DisplayName: "Harbour Kitchen Pte Ltd" };
const canonicalPayloadHash = hashObject(payload);
const context: RequestContext = {
  requestId: "causal-request-1",
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

function delegation(delegationId: string, revision: number, expiresAt?: Date): LedgerStandingDelegation {
  return {
    delegationId,
    revision,
    status: "ACTIVE",
    providerId: "quickbooks",
    workspaceId: "ws-1",
    agentId: "agent-1",
    installationId: "inst-1",
    tenantIds: [realmId],
    actionIds: ["customer.create_basic"],
    ...(expiresAt ? { expiresAt } : {}),
  };
}

class CrashOnceAfterAuthorizationRepository extends InMemoryQuickBooksMutationRepository {
  #crash = true;

  override async recordAutonomousAuthorizationEvidence(
    input: Parameters<InMemoryQuickBooksMutationRepository["recordAutonomousAuthorizationEvidence"]>[0],
  ) {
    const recorded = await super.recordAutonomousAuthorizationEvidence(input);
    if (this.#crash) {
      this.#crash = false;
      throw new Error("simulated crash after durable authorization and before execution claim");
    }
    return recorded;
  }
}

function fixture(options: {
  repository?: InMemoryQuickBooksMutationRepository;
  now?: Date;
  targetSessionExpiresAt?: Date;
  standingDelegation?: LedgerStandingDelegation;
} = {}) {
  let currentTime = options.now ?? new Date("2026-08-13T08:00:00.000Z");
  let currentDelegation = options.standingDelegation ?? delegation("delegation-a", 1);
  const executeMutation = vi.fn(async (
    command: QuickBooksProviderMutationCommand,
    permit: QuickBooksProviderWritePermit,
    recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
    markProviderDispatch: () => Promise<void>,
  ) => {
    consumeQuickBooksProviderWritePermit(permit, { realmId, command });
    await markProviderDispatch();
    await recordProviderOutcome({ providerEntityId: "9001", receipt: { requestId: command.requestId } });
    return {
      providerEntityId: "9001",
      receipt: { requestId: command.requestId, verified: true },
      readback: { Id: "9001", DisplayName: payload.DisplayName },
    };
  });
  const provider = {
    executeMutation,
    recoverMutation: vi.fn(),
    getMutationTarget: vi.fn(),
  } as unknown as QuickBooksProviderCapabilities;
  const resolver: QuickBooksProviderResolver = {
    connectionStatus: vi.fn(),
    resolve: vi.fn(async () => ({
      realmId,
      companyName: "Sandbox Company",
      connectionRefSafe: "qbc-safe",
      boundTargetRefSafe: "qbt-safe",
      bindingRevision: "quickbooks-binding-revision:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetSessionId: "target-session-1",
      targetSessionExpiresAt: options.targetSessionExpiresAt ?? new Date("2099-01-01T00:00:00.000Z"),
      provider,
    })),
  };
  const repository = options.repository ?? new InMemoryQuickBooksMutationRepository();
  const service = new QuickBooksMutationService(repository, resolver, {
    writeEnabled: true,
    writeTargetMode: "exact_allowlist",
    allowedRealmId: realmId,
    publicBaseUrl: "https://mcp.test",
    accountingCaseReleasedCapabilities: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
    standingDelegationProvider: async () => [currentDelegation],
  }, undefined, undefined, () => currentTime);
  return {
    service,
    repository,
    executeMutation,
    setNow: (now: Date) => { currentTime = now; },
    setDelegation: (next: LedgerStandingDelegation) => { currentDelegation = next; },
  };
}

async function prepare(service: QuickBooksMutationService, requestId: string) {
  return service.prepareCaseOperation(context.actorId, {
    target_session_ref: targetSessionRef,
    request_id: requestId,
    entity: "Customer",
    operation: "CREATE",
    payload,
    business_reason: "Create the accepted engagement customer.",
  });
}

function validation(caseId: string, caseVersion: number, issuedAt: Date) {
  return issueDeterministicValidationReceipt({
    actionId: "customer.create_basic",
    canonicalPayloadHash,
    sourceRevisionHash,
    caseId,
    caseVersion,
    policyVersion: "policy-v1",
    compilerVersion: "compiler-v1",
    checks: [{ code: "CONTACT_ACCEPTED", evidence: { accepted: true } }],
    now: issuedAt,
  });
}

function autonomousInput(
  preparationId: string,
  requestId: string,
  caseId: string,
  receipt: ReturnType<typeof validation>,
) {
  return {
    preparationId,
    requestId,
    targetSessionRef,
    actionId: "customer.create_basic",
    caseId,
    caseVersion: 1,
    sourceRevisionHash,
    stableOperationKey,
    validationReceipt: receipt,
  };
}

describe("QuickBooks autonomous authorization claim causality", () => {
  it("does not let a human or a replacement delegation borrow pre-dispatch authorization evidence", async () => {
    const repository = new CrashOnceAfterAuthorizationRepository();
    const { service, executeMutation, setDelegation } = fixture({ repository });
    const prepared = await prepare(service, "causal-pre-dispatch-1");
    const receipt = validation("case-a", 1, new Date("2026-08-13T08:00:00.000Z"));
    const execution = autonomousInput(prepared.preparation_id, "causal-pre-dispatch-1", "case-a", receipt);

    await expect(service.executeAutonomously(context, execution))
      .rejects.toThrow("simulated crash after durable authorization");
    await expect(repository.get(prepared.preparation_id)).resolves.toMatchObject({
      state: "PREPARED",
      autonomousAuthorizationEvidence: {
        authorizationReceipt: { delegationId: "delegation-a", delegationRevision: 1 },
      },
    });
    await expect(service.executeWithConfirmation(context.actorId, {
      preparation_id: prepared.preparation_id,
      request_id: "causal-pre-dispatch-1",
      confirmation_phrase: prepared.confirmation_phrase as string,
    })).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
      details: {
        failureLayer: "AUTHORIZATION_CAUSALITY",
        reasonCodes: ["AUTHORIZATION_CLAIM_ACTOR_MISMATCH"],
      },
    });

    setDelegation(delegation("delegation-b", 2));
    await expect(service.executeAutonomously(context, execution)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: {
        failureLayer: "AUTHORIZATION_CAUSALITY",
        reasonCodes: ["ORIGINAL_AUTHORIZATION_DELEGATION_CHANGED_BEFORE_FIRST_DISPATCH"],
      },
    });
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it("allows a current delegation to reference a terminal write while preserving the original authorization", async () => {
    const { service, executeMutation, setDelegation } = fixture();
    const prepared = await prepare(service, "causal-terminal-reuse-1");
    const first = await service.executeAutonomously(context, autonomousInput(
      prepared.preparation_id,
      "causal-terminal-reuse-1",
      "case-a",
      validation("case-a", 1, new Date("2026-08-13T08:00:00.000Z")),
    ));
    expect(first.authorizationReceipt).toMatchObject({ delegationId: "delegation-a", delegationRevision: 1 });

    setDelegation(delegation("delegation-b", 2));
    const reused = await service.executeAutonomously(context, autonomousInput(
      prepared.preparation_id,
      "causal-terminal-reuse-1",
      "case-b",
      validation("case-b", 1, new Date("2026-08-13T08:02:00.000Z")),
    ));
    expect(reused).toMatchObject({
      idempotentReplay: true,
      authorizationReceipt: { delegationId: "delegation-a", delegationRevision: 1 },
      reuseEvidenceReceipt: {
        currentDelegationId: "delegation-b",
        currentDelegationRevision: 2,
        originalAuthorizationReceiptHash: first.authorizationEvidence.authorizationReceiptHash,
      },
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("evaluates target and delegation expiry at real execution time, not validation issuedAt", async () => {
    const issuedAt = new Date("2026-08-13T08:00:00.000Z");
    const expiresAt = new Date("2026-08-13T08:01:00.000Z");
    const executedAt = new Date("2026-08-13T08:02:00.000Z");
    const { service, executeMutation, setNow } = fixture({
      now: issuedAt,
      targetSessionExpiresAt: expiresAt,
      standingDelegation: delegation("delegation-a", 1, expiresAt),
    });
    const prepared = await prepare(service, "causal-expiry-1");
    setNow(executedAt);

    await expect(service.executeAutonomously(context, autonomousInput(
      prepared.preparation_id,
      "causal-expiry-1",
      "case-expired",
      validation("case-expired", 1, issuedAt),
    ))).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: {
        denyReasons: expect.arrayContaining(["TARGET_SESSION_EXPIRED", "STANDING_DELEGATION_EXPIRED"]),
      },
    });
    expect(executeMutation).not.toHaveBeenCalled();
  });
});
