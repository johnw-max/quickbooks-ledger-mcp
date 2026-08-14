import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import { QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS } from "../src/quickbooks/mutationExecutionAttempt.js";
import type { CreateQuickBooksMutationPreparationInput } from "../src/quickbooks/mutationModels.js";
import { QuickBooksMutationService } from "../src/quickbooks/mutationService.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../src/quickbooks/service.js";
import {
  consumeQuickBooksProviderWritePermit,
  type QuickBooksProviderMutationCommand,
  type QuickBooksProviderWritePermit,
} from "../src/security/quickBooksProviderWritePermit.js";

const targetSessionRef = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
const realmId = "9341457701636490";

function preparationInput(now: Date): CreateQuickBooksMutationPreparationInput {
  return {
    preparationId: `qbm_${randomBytes(16).toString("hex")}`,
    actorId: "actor-fencing",
    realmId,
    connectionRefSafe: "qbc-safe",
    boundTargetRefSafe: "qbt-safe",
    bindingRevision: "qbr-safe",
    entity: "Customer",
    operation: "CREATE",
    risk: "LOW",
    executionMode: "EXPLICIT_CONFIRMATION",
    providerEffect: "MASTER_DATA",
    clientRequestId: `client-${randomBytes(8).toString("hex")}`,
    providerRequestId: `zc.${randomBytes(16).toString("hex")}`,
    payload: { DisplayName: "Execution Fence Customer" },
    payloadHash: randomBytes(32).toString("hex"),
    businessReason: "Exercise the durable execution attempt fence.",
    confirmationPhraseHash: randomBytes(32).toString("hex"),
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    now,
  };
}

function claimInput(
  preparation: CreateQuickBooksMutationPreparationInput,
  now: Date,
  leaseOwner: string,
  leaseTokenHash: string,
) {
  return {
    preparationId: preparation.preparationId,
    actorId: preparation.actorId,
    requestId: preparation.clientRequestId,
    confirmationPhraseHash: preparation.confirmationPhraseHash,
    approvedBy: preparation.actorId,
    leaseOwner,
    leaseTokenHash,
    leaseDurationMs: 1_000,
    now,
  };
}

function mutationRuntime(
  repository: InMemoryQuickBooksMutationRepository,
  executeMutation: QuickBooksProviderCapabilities["executeMutation"],
  recoverMutation: QuickBooksProviderCapabilities["recoverMutation"] = vi.fn(),
) {
  const provider = {
    executeMutation,
    recoverMutation,
    getMutationTarget: vi.fn(),
  } as unknown as QuickBooksProviderCapabilities;
  const resolver: QuickBooksProviderResolver = {
    connectionStatus: vi.fn(),
    resolve: vi.fn(async () => ({
      realmId,
      companyName: "Sandbox Company",
      connectionRefSafe: "qbc-safe",
      boundTargetRefSafe: "qbt-safe",
      bindingRevision: "qbr-safe",
      provider,
    })),
  };
  const service = new QuickBooksMutationService(repository, resolver, {
    writeEnabled: true,
    writeTargetMode: "exact_allowlist",
    allowedRealmId: realmId,
    publicBaseUrl: "https://mcp.test",
  });
  return { service, provider };
}

async function preparedExecution(service: QuickBooksMutationService) {
  const request = {
    target_session_ref: targetSessionRef,
    request_id: `qbo.fencing.${randomBytes(8).toString("hex")}`,
    entity: "Customer" as const,
    operation: "CREATE" as const,
    payload: { DisplayName: "Execution Fence Customer" },
    business_reason: "Exercise crash-safe Provider dispatch.",
  };
  const prepared = await service.prepare("actor-fencing", request);
  return {
    prepared,
    execute: () => service.executeWithConfirmation("actor-fencing", {
      preparation_id: prepared.preparation_id,
      request_id: request.request_id,
      confirmation_phrase: prepared.confirmation_phrase as string,
    }),
  };
}

describe("QuickBooks durable mutation execution fencing", () => {
  it("reclaims only a stale pre-dispatch lease and fences the old worker", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const now = new Date("2026-08-13T00:00:00.000Z");
    const preparation = preparationInput(now);
    await repository.createOrGet(preparation);
    const tokenA = "a".repeat(64);
    const tokenB = "b".repeat(64);
    const first = await repository.claimForExecution(claimInput(
      preparation, new Date(now.getTime() + 100), "worker-a", tokenA,
    ));
    const firstAttempt = first.preparation.executionAttempt;
    expect(firstAttempt).toMatchObject({ claimSequence: 1, state: "CLAIMED", leaseTokenHash: tokenA });

    await expect(repository.claimForExecution(claimInput(
      preparation, new Date(now.getTime() + 500), "worker-b", tokenB,
    ))).rejects.toMatchObject({
      code: "CONFLICT",
      details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_ACTIVE"] },
    });

    const reclaimedAt = new Date(now.getTime() + 1_101);
    const reclaimed = await repository.claimForExecution(claimInput(
      preparation, reclaimedAt, "worker-b", tokenB,
    ));
    expect(reclaimed.preparation.executionAttempt).toMatchObject({
      attemptId: firstAttempt?.attemptId,
      claimSequence: 2,
      state: "CLAIMED",
      leaseOwner: "worker-b",
      leaseTokenHash: tokenB,
    });
    await expect(repository.markDispatchStarted({
      preparationId: preparation.preparationId,
      attemptId: firstAttempt?.attemptId as string,
      leaseTokenHash: tokenA,
      now: reclaimedAt,
    })).rejects.toMatchObject({ code: "CONFLICT", details: { failureLayer: "EXECUTION_FENCING" } });
    await expect(repository.markDispatchStarted({
      preparationId: preparation.preparationId,
      attemptId: firstAttempt?.attemptId as string,
      leaseTokenHash: tokenB,
      now: reclaimedAt,
    })).resolves.toMatchObject({ executionAttempt: { state: "DISPATCH_STARTED" } });
  });

  it("reconciles a stale post-dispatch attempt to unknown-no-Id and never rearms it", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const now = new Date("2026-08-13T00:00:00.000Z");
    const preparation = preparationInput(now);
    const token = "c".repeat(64);
    await repository.createOrGet(preparation);
    const claimed = await repository.claimForExecution(claimInput(
      preparation, new Date(now.getTime() + 100), "worker-a", token,
    ));
    const attemptId = claimed.preparation.executionAttempt?.attemptId as string;
    await repository.markDispatchStarted({
      preparationId: preparation.preparationId,
      attemptId,
      leaseTokenHash: token,
      now: new Date(now.getTime() + 200),
    });

    await expect(repository.reconcileStaleExecutionAttempts(new Date(now.getTime() + 1_101)))
      .resolves.toMatchObject({ stalePreDispatchReclaimable: 0, transitionedToUnknownNoId: 1 });
    await expect(repository.get(preparation.preparationId)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN_NO_ID",
      executionAttempt: {
        state: "WRITE_RESULT_UNKNOWN_NO_ID",
        resolutionReceipt: {
          automaticRearmAllowed: false,
          operatorResolutionRequired: true,
          recoveryAction: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
        },
      },
    });
    await expect(repository.claimForExecution(claimInput(
      preparation, new Date(now.getTime() + 2_000), "worker-b", "d".repeat(64),
    ))).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN_NO_ID",
      retryable: false,
      details: { automaticRearmAllowed: false, operatorResolutionRequired: true },
    });
  });

  it("fails closed after Provider POST but before the outcome callback and never sends a second POST", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      // Represents a successful/unknown POST followed by a process failure
      // before QuickBooks' exact Id reaches the durable callback.
      throw new AppError("WRITE_RESULT_UNKNOWN", "process exited after POST", {
        httpStatus: 503, retryable: false,
      });
    });
    const { service } = mutationRuntime(repository, executeMutation);
    const execution = await preparedExecution(service);

    await expect(execution.execute()).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN_NO_ID",
      retryable: false,
      details: {
        providerMutationPossible: true,
        automaticRearmAllowed: false,
        operatorResolutionRequired: true,
      },
    });
    await expect(execution.execute()).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("accepts a late exact Id only from the original fenced attempt after stale reconciliation", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-13T01:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      const repository = new InMemoryQuickBooksMutationRepository();
      const executeMutation = vi.fn(async (
        input: QuickBooksProviderMutationCommand,
        permit: QuickBooksProviderWritePermit,
        recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
        markProviderDispatch: () => Promise<void>,
      ) => {
        consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
        await markProviderDispatch();
        vi.setSystemTime(new Date(startedAt.getTime() + QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS + 1));
        await expect(repository.reconcileStaleExecutionAttempts(new Date()))
          .resolves.toMatchObject({ transitionedToUnknownNoId: 1 });
        await recordProviderOutcome({ providerEntityId: "late-9001", receipt: { requestId: input.requestId } });
        return {
          providerEntityId: "late-9001",
          receipt: { providerEntityId: "late-9001", verified: true },
          readback: { Id: "late-9001", DisplayName: "Execution Fence Customer" },
        };
      });
      const { service } = mutationRuntime(repository, executeMutation);
      const execution = await preparedExecution(service);

      await expect(execution.execute()).resolves.toMatchObject({
        state: "POSTED_READBACK_VERIFIED",
        providerEntityId: "late-9001",
      });
      await expect(repository.get(execution.prepared.preparation_id)).resolves.toMatchObject({
        state: "POSTED_READBACK_VERIFIED",
        providerEntityId: "late-9001",
        executionAttempt: {
          state: "READBACK_VERIFIED",
          resolutionReceipt: {
            resolution: "WRITE_RESULT_UNKNOWN_NO_ID",
            automaticRearmAllowed: false,
          },
        },
      });
      await expect(execution.execute()).resolves.toMatchObject({
        state: "POSTED_READBACK_VERIFIED",
        idempotentReplay: true,
      });
      expect(executeMutation).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed exact-Id checkpoint, then uses exact GET only", async () => {
    class FailFirstCheckpointRepository extends InMemoryQuickBooksMutationRepository {
      calls = 0;
      override async recordProviderOutcome(input: Parameters<InMemoryQuickBooksMutationRepository["recordProviderOutcome"]>[0]) {
        this.calls += 1;
        if (this.calls === 1) throw new Error("checkpoint connection reset");
        return super.recordProviderOutcome(input);
      }
    }
    const repository = new FailFirstCheckpointRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      await recordProviderOutcome({ providerEntityId: "exact-9001", receipt: { requestId: input.requestId } });
      throw new Error("callback must surface the first checkpoint failure");
    });
    const recoverMutation = vi.fn(async (_input: QuickBooksProviderMutationCommand, providerEntityId: string) => ({
      providerEntityId,
      receipt: { recoveryOnly: true },
      readback: { Id: providerEntityId, DisplayName: "Execution Fence Customer" },
    }));
    const { service } = mutationRuntime(repository, executeMutation, recoverMutation);
    const execution = await preparedExecution(service);

    await expect(execution.execute()).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      details: {
        providerEntityId: "exact-9001",
        recoveryAction: "RECOVER_BY_EXACT_PROVIDER_ID_NO_SECOND_WRITE",
      },
    });
    await expect(repository.get(execution.prepared.preparation_id)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN",
      providerEntityId: "exact-9001",
      executionAttempt: { state: "PROVIDER_OUTCOME_RECORDED" },
    });
    await expect(execution.execute()).resolves.toMatchObject({
      state: "POSTED_READBACK_VERIFIED",
      providerEntityId: "exact-9001",
      idempotentReplay: true,
    });
    expect(repository.calls).toBe(2);
    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(recoverMutation).toHaveBeenCalledTimes(1);
  });

  it("releases a transient pre-dispatch failure and retries the same preparation without a prior POST", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    let first = true;
    const dispatch = vi.fn();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      if (first) {
        first = false;
        throw new AppError("PROVIDER_UNAVAILABLE", "preflight GET timed out", {
          httpStatus: 503, retryable: true,
        });
      }
      await markProviderDispatch();
      dispatch();
      await recordProviderOutcome({ providerEntityId: "retry-9001", receipt: { requestId: input.requestId } });
      return {
        providerEntityId: "retry-9001",
        receipt: { verified: true },
        readback: { Id: "retry-9001", DisplayName: "Execution Fence Customer" },
      };
    });
    const { service } = mutationRuntime(repository, executeMutation);
    const execution = await preparedExecution(service);

    await expect(execution.execute()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      details: {
        failureLayer: "PRE_DISPATCH_TRANSIENT",
        providerMutationPossible: false,
        retrySamePreparation: true,
      },
    });
    await expect(execution.execute()).resolves.toMatchObject({
      state: "POSTED_READBACK_VERIFIED", providerEntityId: "retry-9001",
    });
    expect(executeMutation).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
