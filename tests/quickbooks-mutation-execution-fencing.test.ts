import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { createLogger, type Logger } from "../src/logging.js";
import { InMemoryQuickBooksMutationRepository } from "../src/quickbooks/inMemoryMutationRepository.js";
import {
  quickBooksFaultResponse,
  quickBooksWriteFailure,
} from "./helpers/quickBooksCompletedProviderResponse.js";
import { QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS } from "../src/quickbooks/mutationExecutionAttempt.js";
import type { CreateQuickBooksMutationPreparationInput } from "../src/quickbooks/mutationModels.js";
import {
  quickBooksPreparationBelongsToOperation,
  QuickBooksMutationService,
} from "../src/quickbooks/mutationService.js";
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

const providerWriteFailure = (transport: () => Promise<Response> | never) =>
  quickBooksWriteFailure(transport, realmId);
const faultResponse = quickBooksFaultResponse;

function recordingLogger(): Logger & { warnings: { message: string; context?: Record<string, unknown> }[] } {
  const warnings: { message: string; context?: Record<string, unknown> }[] = [];
  return {
    warnings,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string, context?: Record<string, unknown>) => {
      warnings.push({ message, ...(context ? { context } : {}) });
    },
    error: vi.fn(),
  };
}

function mutationRuntime(
  repository: InMemoryQuickBooksMutationRepository,
  executeMutation: QuickBooksProviderCapabilities["executeMutation"],
  recoverMutation: QuickBooksProviderCapabilities["recoverMutation"] = vi.fn(),
  logger?: Logger,
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
  }, undefined, undefined, undefined, logger);
  return { service, provider };
}

async function preparedExecution(
  service: QuickBooksMutationService,
  overrides: { requestId?: string; payload?: Record<string, unknown> } = {},
) {
  const request = {
    target_session_ref: targetSessionRef,
    request_id: overrides.requestId ?? `qbo.fencing.${randomBytes(8).toString("hex")}`,
    entity: "Customer" as const,
    operation: "CREATE" as const,
    payload: overrides.payload ?? { DisplayName: "Execution Fence Customer" },
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

  it("records a completed Provider refusal after dispatch as a proven non-write, not an unknown outcome", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const logger = recordingLogger();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      // The real production shape: Intuit completed the round trip and refused
      // the Bill because the vendor is a USD vendor. Nothing was created.
      throw await providerWriteFailure(async () => faultResponse(400));
    });
    const { service } = mutationRuntime(repository, executeMutation, vi.fn(), logger);
    const execution = await preparedExecution(service);

    const error: AppError = await execution.execute().then(
      () => { throw new Error("expected the refused write to fail"); },
      (caught: unknown) => caught as AppError,
    );
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.code).not.toBe("WRITE_RESULT_UNKNOWN_NO_ID");
    expect(error.details).toMatchObject({ providerErrors: [{ code: "6000", element: "CurrencyRef" }] });

    const durable = await repository.get(execution.prepared.preparation_id);
    expect(durable).toMatchObject({
      state: "BLOCKED_VALIDATION",
      executionAttempt: {
        state: "RESOLVED_NO_WRITE",
        resolutionReceipt: {
          resolution: "RESOLVED_NO_WRITE",
          providerMutationPossible: false,
          reasonCode: "PROVIDER_CONFIRMED_NOT_WRITTEN_HTTP_400",
        },
      },
    });
    expect(durable?.providerEntityId).toBeUndefined();
    // The dispatch marker is never rewritten: crash safety is unchanged, the
    // row simply leaves EXECUTING so it is no longer treated as in flight.
    expect(durable?.executionAttempt?.dispatchStartedAt).toBeInstanceOf(Date);
    await expect(repository.reconcileStaleExecutionAttempts(new Date(Date.now() + 10 * 60_000)))
      .resolves.toMatchObject({ stalePreDispatchReclaimable: 0, transitionedToUnknownNoId: 0 });

    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.context).toMatchObject({
      preparationId: execution.prepared.preparation_id,
      attemptId: expect.stringMatching(/^qbea_[a-f0-9]{32}$/u),
      providerRequestId: expect.any(String),
      providerWriteOutcome: "CONFIRMED_NOT_WRITTEN",
      errorCode: "VALIDATION_FAILED",
      providerHttpStatus: 400,
      providerFaultCodes: ["6000"],
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["401 expired authorization", 401, "NOT_CONNECTED"],
    ["403 denied company", 403, "FORBIDDEN"],
    ["404 missing record", 404, "NOT_FOUND"],
  ] as const)("treats a completed %s after dispatch as a proven non-write", async (_label, status, code) => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      throw await providerWriteFailure(async () => faultResponse(status));
    });
    const { service } = mutationRuntime(repository, executeMutation);
    const execution = await preparedExecution(service);

    await expect(execution.execute()).rejects.toMatchObject({ code });
    await expect(repository.get(execution.prepared.preparation_id)).resolves.toMatchObject({
      state: "BLOCKED_VALIDATION",
      executionAttempt: { state: "RESOLVED_NO_WRITE" },
    });
  });

  it.each([
    ["409 concurrent change", 409, "CONFLICT"],
    ["429 rate limit", 429, "RATE_LIMITED"],
  ] as const)("keeps a completed %s after dispatch unknown, because a write may have landed", async (_label, status, code) => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      throw await providerWriteFailure(async () => faultResponse(status));
    });
    const { service } = mutationRuntime(repository, executeMutation);
    const execution = await preparedExecution(service);

    expect(code).not.toBe("");
    await expect(execution.execute()).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN_NO_ID",
      details: { providerMutationPossible: true, operatorResolutionRequired: true },
    });
    await expect(repository.get(execution.prepared.preparation_id)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN_NO_ID",
    });
  });

  it("still reports unknown-no-Id when the Provider answered 5xx after dispatch", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const logger = recordingLogger();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      throw await providerWriteFailure(async () => faultResponse(500));
    });
    const { service } = mutationRuntime(repository, executeMutation, vi.fn(), logger);
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
    await expect(repository.get(execution.prepared.preparation_id)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN_NO_ID",
      executionAttempt: { state: "WRITE_RESULT_UNKNOWN_NO_ID" },
    });
    expect(logger.warnings[0]?.context).toMatchObject({
      providerWriteOutcome: "UNKNOWN",
    });
    await expect(execution.execute()).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("puts Intuit's trace id on the post-dispatch log line, and the real logger keeps it", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const logger = recordingLogger();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      throw await providerWriteFailure(async () => faultResponse(500, "6000", "CurrencyRef", "1-64a1-9f2c"));
    });
    const { service } = mutationRuntime(repository, executeMutation, vi.fn(), logger);
    const execution = await preparedExecution(service);

    await expect(execution.execute()).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });

    const context = logger.warnings[0]?.context as Record<string, unknown>;
    expect(context).toMatchObject({ providerWriteOutcome: "UNKNOWN", intuitTid: "1-64a1-9f2c" });

    // The mock logger above never redacts, which is exactly how an unlisted key
    // has twice reached production as "[REDACTED]" with every test green. Drive
    // the same context through the real logger and read the emitted line.
    const emitted: string[] = [];
    const write = vi.spyOn(console, "warn").mockImplementation((line: string) => { emitted.push(line); });
    try {
      createLogger({ logLevel: "warn" }).warn("QuickBooks provider dispatch failed after the durable dispatch marker.", context);
    } finally {
      write.mockRestore();
    }
    const record = JSON.parse(emitted[0] as string) as { context: Record<string, unknown> };
    expect(record.context.intuitTid).toBe("1-64a1-9f2c");
    expect(record.context.providerWriteOutcome).toBe("UNKNOWN");
  });

  it("omits the trace id from the post-dispatch log line when Intuit sent none", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const logger = recordingLogger();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      throw await providerWriteFailure(async () => { throw new Error("connection reset"); });
    });
    const { service } = mutationRuntime(repository, executeMutation, vi.fn(), logger);
    const execution = await preparedExecution(service);

    await expect(execution.execute()).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });
    // No response cycle completed, so there is no Intuit-side request to trace.
    expect(logger.warnings[0]?.context).not.toHaveProperty("intuitTid");
  });

  it("still reports unknown-no-Id when the write died in transport after dispatch", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      throw await providerWriteFailure(() => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });
    });
    const { service } = mutationRuntime(repository, executeMutation);
    const execution = await preparedExecution(service);

    await expect(execution.execute()).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN_NO_ID",
      details: { providerMutationPossible: true, operatorResolutionRequired: true },
    });
    await expect(repository.get(execution.prepared.preparation_id)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN_NO_ID",
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("leaves every other durable mutation untouched by one confirmed non-write", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    let refuse = true;
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      if (refuse) {
        refuse = false;
        throw await providerWriteFailure(async () => faultResponse(400));
      }
      await recordProviderOutcome({ providerEntityId: "next-9001", receipt: { requestId: input.requestId } });
      return {
        providerEntityId: "next-9001",
        receipt: { verified: true },
        readback: { Id: "next-9001", DisplayName: "Next Customer" },
      };
    });
    const { service } = mutationRuntime(repository, executeMutation);
    const refused = await preparedExecution(service, { requestId: "qbo.fencing.currency-mismatch" });
    await expect(refused.execute()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const next = await preparedExecution(service, {
      requestId: "qbo.fencing.next-write",
      payload: { DisplayName: "Next Customer" },
    });
    await expect(next.execute()).resolves.toMatchObject({
      state: "POSTED_READBACK_VERIFIED",
      providerEntityId: "next-9001",
    });
    await expect(repository.get(refused.prepared.preparation_id)).resolves.toMatchObject({
      state: "BLOCKED_VALIDATION",
    });
    expect(executeMutation).toHaveBeenCalledTimes(2);
  });

  it("still refuses to re-prepare a genuinely unknown write", async () => {
    const repository = new InMemoryQuickBooksMutationRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      throw await providerWriteFailure(async () => faultResponse(503));
    });
    const { service } = mutationRuntime(repository, executeMutation);
    const unknown = await preparedExecution(service, { requestId: "qbo.fencing.unknown-write" });
    await expect(unknown.execute()).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID" });

    await expect(preparedExecution(service, { requestId: "qbo.fencing.unknown-write" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The QuickBooks mutation is already in WRITE_RESULT_UNKNOWN_NO_ID.",
    });
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

describe("QuickBooks confirmed non-write supersession", () => {
  // A Case operation's request id is a content hash of the document and is
  // deliberately invariant across corrections, so the remedy for a refused
  // write never changes it. Without a generation the first refusal would make
  // the document permanently unbookable — which is exactly what happened in
  // production to supplier invoice MBC-2026-0820.
  const caseRequestId = "qbocase.3281698c384e7a795a4ae7ba93ca53be653a3570";

  function caseOperationInput(requestId: string) {
    return {
      target_session_ref: targetSessionRef,
      request_id: requestId,
      entity: "Customer" as const,
      operation: "CREATE" as const,
      payload: { DisplayName: "Marina Bay Consulting Pte Ltd" },
      business_reason: "Accounting Case stable source operation.",
    };
  }

  async function refuseOnce(status: number) {
    const repository = new InMemoryQuickBooksMutationRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      _record: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      throw await quickBooksWriteFailure(async () => quickBooksFaultResponse(status));
    });
    const { service } = mutationRuntime(repository, executeMutation);
    const first = await service.prepareCaseOperation("actor-fencing", caseOperationInput(caseRequestId));
    await service.executeWithConfirmation("actor-fencing", {
      preparation_id: first.preparation_id,
      request_id: caseRequestId,
      confirmation_phrase: first.confirmation_phrase as string,
    }).catch(() => undefined);
    return { repository, service, first, executeMutation };
  }

  it("opens a new generation for the same document once the Provider proved it did not write", async () => {
    const { repository, service, first } = await refuseOnce(400);
    const refused = await repository.get(first.preparation_id);
    expect(refused?.state).toBe("BLOCKED_VALIDATION");

    // The accountant fixes the vendor record and the agent restates the very
    // same invoice. The request id is identical by design.
    const second = await service.prepareCaseOperation("actor-fencing", caseOperationInput(caseRequestId));

    expect(second.state).toBe("PREPARED");
    expect(second.preparation_id).not.toBe(first.preparation_id);

    const superseding = await repository.get(second.preparation_id);
    expect(superseding?.clientRequestId).toBe(`${caseRequestId}.g2`);
    // Intuit's idempotency key must move too, or the retry offers the Provider
    // a replay of the write it is meant to re-attempt.
    expect(superseding?.providerRequestId).not.toBe(refused?.providerRequestId);
    // The refused row is retained intact as audit evidence, never rewritten.
    expect(refused?.executionAttempt?.dispatchStartedAt).toBeInstanceOf(Date);
  });

  it("refuses to supersede a genuinely unknown outcome", async () => {
    // A 5xx may have been applied. This is the case the no-rearm rule exists
    // for and it must keep behaving exactly as before.
    const { repository, service, first } = await refuseOnce(500);
    expect((await repository.get(first.preparation_id))?.state).toBe("WRITE_RESULT_UNKNOWN_NO_ID");

    await expect(service.prepareCaseOperation("actor-fencing", caseOperationInput(caseRequestId)))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps the generic prepare path strict", async () => {
    // Outside the Case path the request id is the caller's own, so a fresh one
    // is theirs to choose and the one-preparation-per-id contract stands.
    const { service } = await refuseOnce(400);
    await expect(service.prepare("actor-fencing", caseOperationInput(caseRequestId)))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("QuickBooks replayed terminal success verification", () => {
  const caseRequestId = "qbocase.replay0000000000000000000000000000";

  function caseOperationInput(requestId: string) {
    return {
      target_session_ref: targetSessionRef,
      request_id: requestId,
      entity: "Customer" as const,
      operation: "CREATE" as const,
      payload: { DisplayName: "Marina Bay Consulting Pte Ltd" },
      business_reason: "Accounting Case stable source operation.",
    };
  }

  async function completedCaseOperation() {
    const repository = new InMemoryQuickBooksMutationRepository();
    const executeMutation = vi.fn(async (
      input: QuickBooksProviderMutationCommand,
      permit: QuickBooksProviderWritePermit,
      recordProviderOutcome: (outcome: { providerEntityId: string; receipt: Record<string, unknown> }) => Promise<void>,
      markProviderDispatch: () => Promise<void>,
    ) => {
      consumeQuickBooksProviderWritePermit(permit, { realmId, command: input });
      await markProviderDispatch();
      await recordProviderOutcome({ providerEntityId: "63", receipt: { requestId: input.requestId } });
      return {
        providerEntityId: "63",
        receipt: { requestId: input.requestId },
        readback: { Id: "63", DisplayName: "Marina Bay Consulting Pte Ltd" },
      };
    });
    const { service, provider } = mutationRuntime(repository, executeMutation);
    const first = await service.prepareCaseOperation("actor-fencing", caseOperationInput(caseRequestId));
    await service.executeWithConfirmation("actor-fencing", {
      preparation_id: first.preparation_id,
      request_id: caseRequestId,
      confirmation_phrase: first.confirmation_phrase as string,
    });
    return { repository, service, provider, first };
  }

  it("replays a terminal success only after confirming the object is still in the Company", async () => {
    const { service, provider, first } = await completedCaseOperation();
    vi.mocked(provider.getMutationTarget).mockResolvedValue({ Id: "63", DisplayName: "Renamed By The Accountant" });

    const replayed = await service.prepareCaseOperation("actor-fencing", caseOperationInput(caseRequestId));

    expect(replayed.preparation_id).toBe(first.preparation_id);
    expect(replayed.provider_write_executed).toBe(true);
    expect(provider.getMutationTarget).toHaveBeenCalledWith("Customer", "63");
    // Existence is the whole assertion. A rename is still the object this
    // operation created, so "was created" stays true and this must not
    // supersede.
    expect(replayed.state).toBe("POSTED_READBACK_VERIFIED");
  });

  it("supersedes a terminal success whose object was removed from QuickBooks", async () => {
    // The routine case: a mis-coded Bill is deleted in QuickBooks and the same
    // invoice is re-entered. Before this check the Case reported it as booked
    // while the Company held nothing.
    const { repository, service, provider, first } = await completedCaseOperation();
    vi.mocked(provider.getMutationTarget).mockRejectedValue(
      new AppError("NOT_FOUND", "QuickBooks Customer target was not found.", { httpStatus: 404 }),
    );

    const reissued = await service.prepareCaseOperation("actor-fencing", caseOperationInput(caseRequestId));

    expect(reissued.preparation_id).not.toBe(first.preparation_id);
    expect(reissued.state).toBe("PREPARED");
    expect(reissued.provider_write_executed).toBe(false);
    const superseding = await repository.get(reissued.preparation_id);
    expect(superseding?.clientRequestId).toBe(`${caseRequestId}.g2`);
  });

  it("refuses to conclude anything when the confirming read itself fails", async () => {
    // Not knowing must never be reported as done. Only NOT_FOUND is proof.
    const { repository, service, provider, first } = await completedCaseOperation();
    vi.mocked(provider.getMutationTarget).mockRejectedValue(
      new AppError("PROVIDER_UNAVAILABLE", "QuickBooks is temporarily unavailable.", { httpStatus: 503, retryable: true }),
    );

    await expect(service.prepareCaseOperation("actor-fencing", caseOperationInput(caseRequestId)))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    // The stored outcome is untouched: nothing was superseded on a failed read.
    expect((await repository.get(first.preparation_id))?.state).toBe("POSTED_READBACK_VERIFIED");
  });
});

describe("QuickBooks preparation ownership across generations", () => {
  const base = "qbocase.3281698c384e7a795a4ae7ba93ca53be653a3570";

  it("admits the base id and any generation of it", () => {
    // Without this the generation would only move the deadlock from the
    // mutation row to the Case operation, which is what production hit.
    expect(quickBooksPreparationBelongsToOperation(base, base)).toBe(true);
    expect(quickBooksPreparationBelongsToOperation(`${base}.g2`, base)).toBe(true);
    expect(quickBooksPreparationBelongsToOperation(`${base}.g10`, base)).toBe(true);
  });

  it("refuses anything that is not this operation", () => {
    const other = "qbocase.0000000000000000000000000000000000000000";
    expect(quickBooksPreparationBelongsToOperation(other, base)).toBe(false);
    expect(quickBooksPreparationBelongsToOperation(`${other}.g2`, base)).toBe(false);
    // A generation suffix must not let a prefix stand in for the whole id.
    expect(quickBooksPreparationBelongsToOperation(`${base}extra.g2`, base)).toBe(false);
    expect(quickBooksPreparationBelongsToOperation(`${base}.g1`, base)).toBe(false);
    expect(quickBooksPreparationBelongsToOperation(`${base}.gx`, base)).toBe(false);
    expect(quickBooksPreparationBelongsToOperation(base, `${base}.g2`)).toBe(false);
  });
});
