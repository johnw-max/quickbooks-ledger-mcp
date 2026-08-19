import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQuickBooksMigrations } from "../src/quickbooks/migrate.js";
import { QuickBooksPostgresMutationRepository } from "../src/quickbooks/postgresMutationRepository.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres QuickBooks governed mutation integration", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 4 }) : undefined;
  const repository = pool ? new QuickBooksPostgresMutationRepository(pool) : undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runQuickBooksMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("atomically prepares, claims, verifies and idempotently replays one exact mutation", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    await expect(repository.readiness()).resolves.toBe(true);
    const suffix = randomUUID();
    const now = new Date();
    const confirmationHash = randomBytes(32).toString("hex");
    const leaseTokenHash = randomBytes(32).toString("hex");
    const lease = { leaseOwner: `test-worker-${suffix}`, leaseTokenHash, leaseDurationMs: 120_000 };
    const input = {
      preparationId: `qbm_${randomBytes(16).toString("hex")}`,
      actorId: `actor-${suffix}`,
      realmId: "9341457701636490",
      connectionRefSafe: `qbc-${suffix}`,
      boundTargetRefSafe: `qbt-${suffix}`,
      bindingRevision: `qbr-${suffix}`,
      entity: "Customer" as const,
      operation: "CREATE" as const,
      risk: "LOW" as const,
      executionMode: "EXPLICIT_CONFIRMATION" as const,
      providerEffect: "MASTER_DATA" as const,
      clientRequestId: `qbo.customer.${suffix}`,
      providerRequestId: `zc.${randomBytes(16).toString("hex")}`,
      payload: { DisplayName: `Postgres Customer ${suffix}` },
      payloadHash: randomBytes(32).toString("hex"),
      businessReason: "Create the accepted synthetic customer.",
      confirmationPhraseHash: confirmationHash,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    };

    const created = await repository.createOrGet(input);
    expect(created).toMatchObject({ created: true, preparation: { state: "PREPARED" } });
    const replayedPreparation = await repository.createOrGet(input);
    expect(replayedPreparation).toMatchObject({
      created: false,
      preparation: { preparationId: input.preparationId, payloadHash: input.payloadHash },
    });

    await expect(repository.claimForExecution({
      preparationId: input.preparationId,
      actorId: input.actorId,
      requestId: `execute.${suffix}`,
      confirmationPhraseHash: randomBytes(32).toString("hex"),
      approvedBy: input.actorId,
      ...lease,
      now: new Date(now.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });

    const claimed = await repository.claimForExecution({
      preparationId: input.preparationId,
      actorId: input.actorId,
      requestId: `execute.${suffix}`,
      confirmationPhraseHash: confirmationHash,
      approvedBy: input.actorId,
      ...lease,
      now: new Date(now.getTime() + 2_000),
    });
    expect(claimed).toMatchObject({ shouldExecute: true, preparation: { state: "EXECUTING" } });
    const attemptId = claimed.preparation.executionAttempt?.attemptId;
    if (!attemptId) throw new Error("execution attempt is required");
    await repository.markDispatchStarted({
      preparationId: input.preparationId, attemptId, leaseTokenHash,
      now: new Date(now.getTime() + 2_250),
    });

    await repository.recordProviderOutcome({
      preparationId: input.preparationId,
      attemptId,
      leaseTokenHash,
      providerEntityId: `customer-${suffix}`,
      providerOutcomeReceipt: {
        provider: "quickbooks-online", requestId: input.providerRequestId,
        canonicalPayloadHash: input.payloadHash,
      },
      now: new Date(now.getTime() + 2_500),
    });
    const completed = await repository.completeVerified({
      preparationId: input.preparationId,
      providerEntityId: `customer-${suffix}`,
      receipt: { provider: "quickbooks-online", verified: true },
      readback: { Id: `customer-${suffix}`, DisplayName: input.payload.DisplayName },
      now: new Date(now.getTime() + 3_000),
    });
    expect(completed).toMatchObject({
      state: "POSTED_READBACK_VERIFIED",
      providerEntityId: `customer-${suffix}`,
      writeReceipt: { verified: true },
      readback: { Id: `customer-${suffix}` },
    });

    const terminalReplay = await repository.claimForExecution({
      preparationId: input.preparationId,
      actorId: input.actorId,
      requestId: `execute-replay.${suffix}`,
      confirmationPhraseHash: confirmationHash,
      approvedBy: input.actorId,
      ...lease,
      now: new Date(now.getTime() + 4_000),
    });
    expect(terminalReplay).toMatchObject({
      shouldExecute: false,
      preparation: { state: "POSTED_READBACK_VERIFIED", providerEntityId: `customer-${suffix}` },
    });
  });

  it("reseals a preparation that expired without dispatching, and refuses one that reached the Provider", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const now = new Date();
    const base = {
      actorId: `actor-${suffix}`,
      realmId: "9341457701636490",
      connectionRefSafe: `qbc-${suffix}`,
      boundTargetRefSafe: `qbt-${suffix}`,
      bindingRevision: `qbr-${suffix}`,
      entity: "Customer" as const,
      operation: "CREATE" as const,
      risk: "LOW" as const,
      executionMode: "EXPLICIT_CONFIRMATION" as const,
      providerEffect: "MASTER_DATA" as const,
      businessReason: "Reseal coverage.",
      confirmationPhraseHash: randomBytes(32).toString("hex"),
      // Written two hours ago with a one-hour window, so it is expired now.
      // This is what an Accounting Case resumed the next day actually finds;
      // the row cannot simply be inserted pre-expired because a CHECK requires
      // expires_at > created_at.
      expiresAt: new Date(now.getTime() - 60 * 60_000),
      now: new Date(now.getTime() - 120 * 60_000),
    };
    const expired = {
      ...base,
      preparationId: `qbm_${randomBytes(16).toString("hex")}`,
      clientRequestId: `qbo.reseal.${suffix}`,
      providerRequestId: `zc.${randomBytes(16).toString("hex")}`,
      payload: { DisplayName: `Reseal ${suffix}` },
      payloadHash: randomBytes(32).toString("hex"),
    };
    await repository.createOrGet(expired);

    // Claiming it is exactly the deadlock this fixes.
    await expect(repository.claimForExecution({
      preparationId: expired.preparationId, actorId: expired.actorId,
      requestId: expired.clientRequestId, approvedBy: `actor-${suffix}`,
      leaseOwner: `w-${suffix}`, leaseTokenHash: randomBytes(32).toString("hex"),
      leaseDurationMs: 120_000, now: new Date(),
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });

    const resealed = await repository.resealNeverDispatchedPreparation({
      preparationId: expired.preparationId, actorId: expired.actorId,
      expiresAt: new Date(Date.now() + 30 * 60_000), now: new Date(),
    });
    expect(resealed).toMatchObject({ state: "PREPARED" });
    // Clearing the recorded authorization is what forces re-authorization; the
    // relaxation that permits it is asserted against migration 036 directly.
    expect(resealed?.autonomousAuthorizationEvidence).toBeUndefined();
    // Re-authorization is the point of the reseal, so the claim must work now.
    await expect(repository.claimForExecution({
      preparationId: expired.preparationId, actorId: expired.actorId,
      requestId: expired.clientRequestId, approvedBy: `actor-${suffix}`,
      leaseOwner: `w-${suffix}`, leaseTokenHash: randomBytes(32).toString("hex"),
      leaseDurationMs: 120_000, now: new Date(),
    })).resolves.toMatchObject({ shouldExecute: true });

    // A row that reached the Provider must keep failing: it is no longer
    // PREPARED, so the reseal predicate cannot match it.
    const dispatched = {
      ...base,
      preparationId: `qbm_${randomBytes(16).toString("hex")}`,
      clientRequestId: `qbo.reseal.dispatched.${suffix}`,
      providerRequestId: `zc.${randomBytes(16).toString("hex")}`,
      payload: { DisplayName: `Dispatched ${suffix}` },
      payloadHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    };
    await repository.createOrGet(dispatched);
    const claim = await repository.claimForExecution({
      preparationId: dispatched.preparationId, actorId: dispatched.actorId,
      requestId: dispatched.clientRequestId, approvedBy: `actor-${suffix}`,
      leaseOwner: `w-${suffix}`, leaseTokenHash: randomBytes(32).toString("hex"),
      leaseDurationMs: 120_000, now: new Date(),
    });
    expect(claim.shouldExecute).toBe(true);
    await expect(repository.resealNeverDispatchedPreparation({
      preparationId: dispatched.preparationId, actorId: dispatched.actorId,
      expiresAt: new Date(Date.now() + 30 * 60_000), now: new Date(),
    })).resolves.toBeUndefined();
  });

  it("persists a Provider outcome checkpoint and exact-Id recovery completes without a new execution claim", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const now = new Date();
    const leaseTokenHash = randomBytes(32).toString("hex");
    const lease = { leaseOwner: `test-recovery-${suffix}`, leaseTokenHash, leaseDurationMs: 120_000 };
    const input = {
      preparationId: `qbm_${randomBytes(16).toString("hex")}`,
      actorId: `actor-recovery-${suffix}`,
      realmId: "9341457701636490",
      connectionRefSafe: `qbc-${suffix}`,
      boundTargetRefSafe: `qbt-${suffix}`,
      bindingRevision: `qbr-${suffix}`,
      entity: "Customer" as const,
      operation: "CREATE" as const,
      risk: "LOW" as const,
      executionMode: "EXPLICIT_CONFIRMATION" as const,
      providerEffect: "MASTER_DATA" as const,
      clientRequestId: `qbo.recovery.${suffix}`,
      providerRequestId: `zc.${randomBytes(16).toString("hex")}`,
      payload: { DisplayName: `Recovery Customer ${suffix}` },
      payloadHash: randomBytes(32).toString("hex"),
      businessReason: "Crash-recovery integration test.",
      confirmationPhraseHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    };
    await repository.createOrGet(input);
    const claimed = await repository.claimForExecution({
      preparationId: input.preparationId, actorId: input.actorId, requestId: input.clientRequestId,
      confirmationPhraseHash: input.confirmationPhraseHash, approvedBy: input.actorId,
      ...lease,
      now: new Date(now.getTime() + 1_000),
    });
    const attemptId = claimed.preparation.executionAttempt?.attemptId;
    if (!attemptId) throw new Error("execution attempt is required");
    await repository.markDispatchStarted({
      preparationId: input.preparationId, attemptId, leaseTokenHash,
      now: new Date(now.getTime() + 1_500),
    });
    const providerEntityId = `customer-${suffix}`;
    await repository.recordProviderOutcome({
      preparationId: input.preparationId, attemptId, leaseTokenHash, providerEntityId,
      providerOutcomeReceipt: { requestId: input.providerRequestId, canonicalPayloadHash: input.payloadHash },
      now: new Date(now.getTime() + 2_000),
    });
    await repository.markFailure({
      preparationId: input.preparationId, attemptId, leaseTokenHash,
      providerRequestId: input.providerRequestId, state: "WRITE_RESULT_UNKNOWN",
      now: new Date(now.getTime() + 3_000),
    });
    const recoveryClaim = await repository.claimForExecution({
      preparationId: input.preparationId, actorId: input.actorId, requestId: input.clientRequestId,
      confirmationPhraseHash: input.confirmationPhraseHash, approvedBy: input.actorId,
      ...lease,
      now: new Date(now.getTime() + 4_000),
    });
    expect(recoveryClaim).toMatchObject({
      shouldExecute: false, recoveryOnly: true,
      preparation: { state: "WRITE_RESULT_UNKNOWN", providerEntityId },
    });
    const completed = await repository.completeVerified({
      preparationId: input.preparationId, providerEntityId,
      receipt: { verified: true, recoveryOnly: true, providerMutationRetried: false },
      readback: { Id: providerEntityId, DisplayName: input.payload.DisplayName },
      now: new Date(now.getTime() + 5_000),
    });
    expect(completed).toMatchObject({
      state: "POSTED_READBACK_VERIFIED", providerEntityId,
      providerOutcomeReceipt: { canonicalPayloadHash: input.payloadHash },
      writeReceipt: { recoveryOnly: true, providerMutationRetried: false },
    });
    await expect(pool?.query(
      `UPDATE quickbooks_mutation_preparations
       SET provider_outcome_receipt='{"substituted":true}'::jsonb WHERE preparation_id=$1`,
      [input.preparationId],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("atomically fences concurrent leases, reclaims only pre-dispatch, and reconciles stale post-dispatch", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const now = new Date();
    const input = {
      preparationId: `qbm_${randomBytes(16).toString("hex")}`,
      actorId: `actor-fence-${suffix}`,
      realmId: "9341457701636490",
      connectionRefSafe: `qbc-${suffix}`,
      boundTargetRefSafe: `qbt-${suffix}`,
      bindingRevision: `qbr-${suffix}`,
      entity: "Customer" as const,
      operation: "CREATE" as const,
      risk: "LOW" as const,
      executionMode: "EXPLICIT_CONFIRMATION" as const,
      providerEffect: "MASTER_DATA" as const,
      clientRequestId: `qbo.fence.${suffix}`,
      providerRequestId: `zc.${randomBytes(16).toString("hex")}`,
      payload: { DisplayName: `Fence Customer ${suffix}` },
      payloadHash: randomBytes(32).toString("hex"),
      businessReason: "Exercise PostgreSQL execution fencing.",
      confirmationPhraseHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    };
    const tokenA = "a".repeat(64);
    const tokenB = "b".repeat(64);
    await repository.createOrGet(input);
    const first = await repository.claimForExecution({
      preparationId: input.preparationId, actorId: input.actorId, requestId: input.clientRequestId,
      confirmationPhraseHash: input.confirmationPhraseHash, approvedBy: input.actorId,
      leaseOwner: "pg-worker-a", leaseTokenHash: tokenA, leaseDurationMs: 1_000,
      now: new Date(now.getTime() + 100),
    });
    const attemptId = first.preparation.executionAttempt?.attemptId;
    if (!attemptId) throw new Error("execution attempt is required");
    await expect(repository.claimForExecution({
      preparationId: input.preparationId, actorId: input.actorId, requestId: input.clientRequestId,
      confirmationPhraseHash: input.confirmationPhraseHash, approvedBy: input.actorId,
      leaseOwner: "pg-worker-b", leaseTokenHash: tokenB, leaseDurationMs: 1_000,
      now: new Date(now.getTime() + 500),
    })).rejects.toMatchObject({
      code: "CONFLICT", details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_ACTIVE"] },
    });
    const reclaimed = await repository.claimForExecution({
      preparationId: input.preparationId, actorId: input.actorId, requestId: input.clientRequestId,
      confirmationPhraseHash: input.confirmationPhraseHash, approvedBy: input.actorId,
      leaseOwner: "pg-worker-b", leaseTokenHash: tokenB, leaseDurationMs: 1_000,
      now: new Date(now.getTime() + 1_101),
    });
    expect(reclaimed.preparation.executionAttempt).toMatchObject({
      attemptId, claimSequence: 2, leaseOwner: "pg-worker-b", leaseTokenHash: tokenB,
    });
    await expect(repository.markDispatchStarted({
      preparationId: input.preparationId, attemptId, leaseTokenHash: tokenA,
      now: new Date(now.getTime() + 1_200),
    })).rejects.toMatchObject({ code: "CONFLICT", details: { failureLayer: "EXECUTION_FENCING" } });
    await repository.markDispatchStarted({
      preparationId: input.preparationId, attemptId, leaseTokenHash: tokenB,
      now: new Date(now.getTime() + 1_200),
    });
    await expect(repository.reconcileStaleExecutionAttempts(new Date(now.getTime() + 2_102)))
      .resolves.toMatchObject({ transitionedToUnknownNoId: 1 });
    await expect(repository.get(input.preparationId)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN_NO_ID",
      executionAttempt: {
        state: "WRITE_RESULT_UNKNOWN_NO_ID",
        resolutionReceipt: { automaticRearmAllowed: false, operatorResolutionRequired: true },
      },
    });
    await expect(repository.claimForExecution({
      preparationId: input.preparationId, actorId: input.actorId, requestId: input.clientRequestId,
      confirmationPhraseHash: input.confirmationPhraseHash, approvedBy: input.actorId,
      leaseOwner: "pg-worker-c", leaseTokenHash: "c".repeat(64), leaseDurationMs: 1_000,
      now: new Date(now.getTime() + 3_000),
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN_NO_ID", retryable: false });

    const lateOutcomeReceipt = {
      requestId: input.providerRequestId,
      canonicalPayloadHash: input.payloadHash,
      callback: "LATE_EXACT_ID_SAME_ATTEMPT",
    };
    await expect(repository.recordProviderOutcome({
      preparationId: input.preparationId,
      attemptId,
      leaseTokenHash: tokenA,
      providerEntityId: `late-customer-${suffix}`,
      providerOutcomeReceipt: lateOutcomeReceipt,
      now: new Date(now.getTime() + 3_100),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.recordProviderOutcome({
      preparationId: input.preparationId,
      attemptId,
      leaseTokenHash: tokenB,
      providerEntityId: `late-customer-${suffix}`,
      providerOutcomeReceipt: lateOutcomeReceipt,
      now: new Date(now.getTime() + 3_200),
    })).resolves.toMatchObject({
      state: "PROVIDER_OUTCOME_RECORDED",
      providerEntityId: `late-customer-${suffix}`,
      executionAttempt: {
        state: "PROVIDER_OUTCOME_RECORDED",
        resolutionReceipt: { resolution: "WRITE_RESULT_UNKNOWN_NO_ID" },
      },
    });
    await expect(repository.claimForExecution({
      preparationId: input.preparationId, actorId: input.actorId, requestId: input.clientRequestId,
      confirmationPhraseHash: input.confirmationPhraseHash, approvedBy: input.actorId,
      leaseOwner: "pg-worker-c", leaseTokenHash: "c".repeat(64), leaseDurationMs: 1_000,
      now: new Date(now.getTime() + 3_300),
    })).resolves.toMatchObject({
      shouldExecute: false,
      recoveryOnly: true,
      preparation: { providerEntityId: `late-customer-${suffix}` },
    });
  });

  it("durably records CONFIRMED_NOT_WRITTEN after dispatch, and refuses it without that proof", async () => {
    if (!repository || !pool) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const now = new Date();
    const confirmationPhraseHash = randomBytes(32).toString("hex");
    const leaseTokenHash = randomBytes(32).toString("hex");
    const input = {
      preparationId: `qbm_${randomBytes(16).toString("hex")}`,
      actorId: `actor-${suffix}`,
      realmId: "9341457701636490",
      connectionRefSafe: `qbc-${suffix}`,
      boundTargetRefSafe: `qbt-${suffix}`,
      bindingRevision: `qbr-${suffix}`,
      entity: "Bill" as const,
      operation: "CREATE" as const,
      risk: "HIGH" as const,
      executionMode: "EXPLICIT_CONFIRMATION" as const,
      providerEffect: "POSTING_TRANSACTION" as const,
      clientRequestId: `qbo.bill.${suffix}`,
      providerRequestId: `zc.${randomBytes(16).toString("hex")}`,
      payload: { VendorRef: { value: "63" }, CurrencyRef: { value: "SGD" } },
      payloadHash: randomBytes(32).toString("hex"),
      businessReason: "Post the SGD bill that Intuit refuses for a USD vendor.",
      confirmationPhraseHash,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    };
    await repository.createOrGet(input);
    const claimed = await repository.claimForExecution({
      preparationId: input.preparationId, actorId: input.actorId, requestId: input.clientRequestId,
      confirmationPhraseHash, approvedBy: input.actorId,
      leaseOwner: `pg-worker-${suffix}`, leaseTokenHash, leaseDurationMs: 120_000,
      now: new Date(now.getTime() + 1_000),
    });
    const attemptId = claimed.preparation.executionAttempt?.attemptId as string;
    await repository.markDispatchStarted({
      preparationId: input.preparationId, attemptId, leaseTokenHash,
      now: new Date(now.getTime() + 2_000),
    });

    // Without the proof, a post-dispatch non-write claim stays refused.
    await expect(repository.markFailure({
      preparationId: input.preparationId, attemptId, leaseTokenHash,
      providerRequestId: input.providerRequestId, state: "BLOCKED_VALIDATION",
      now: new Date(now.getTime() + 3_000),
    })).rejects.toMatchObject({
      code: "CONFLICT", details: { failureLayer: "EXECUTION_FENCING" },
    });

    // With it, the durable row records what QuickBooks' ledger actually holds.
    // Migration 033's shape CHECK already permits this row: BLOCKED_VALIDATION
    // with RESOLVED_NO_WRITE and a resolution receipt carries no
    // dispatch_started_at IS NULL requirement.
    await repository.markFailure({
      preparationId: input.preparationId, attemptId, leaseTokenHash,
      providerRequestId: input.providerRequestId, state: "BLOCKED_VALIDATION",
      providerConfirmedNotWritten: true,
      resolutionReceipt: {
        evidenceType: "QUICKBOOKS_EXECUTION_RESOLUTION", evidenceVersion: "1.0",
        resolution: "RESOLVED_NO_WRITE", attemptId, providerRequestId: input.providerRequestId,
        reasonCode: "PROVIDER_CONFIRMED_NOT_WRITTEN_HTTP_400",
        providerMutationPossible: false, automaticRearmAllowed: false,
        resolvedAt: new Date(now.getTime() + 4_000).toISOString(),
      },
      now: new Date(now.getTime() + 4_000),
    });
    const durable = await repository.get(input.preparationId);
    expect(durable).toMatchObject({
      state: "BLOCKED_VALIDATION",
      executionAttempt: {
        state: "RESOLVED_NO_WRITE",
        resolutionReceipt: { providerMutationPossible: false },
      },
    });
    expect(durable?.providerEntityId).toBeUndefined();
    // The dispatch marker is untouched: crash safety is unchanged.
    expect(durable?.executionAttempt?.dispatchStartedAt).toBeInstanceOf(Date);
    // And the row is out of EXECUTING, so no sweep can turn it back into a
    // possible write.
    await expect(repository.reconcileStaleExecutionAttempts(new Date(now.getTime() + 20 * 60_000)))
      .resolves.toMatchObject({ transitionedToUnknownNoId: 0 });

    // The two structural limits, pinned so they are not rediscovered by
    // surprise. A dispatched preparation cannot be re-armed for a second POST:
    // migration 033's shape CHECK forbids PREPARED with attempt columns set,
    // and its immutability trigger forbids clearing dispatch_started_at or
    // moving the lease. Re-issuing the identical content therefore needs a new
    // preparation row, which UNIQUE(actor_id, realm_id, entity, operation,
    // client_request_id) does not allow either.
    await expect(pool.query(
      `UPDATE quickbooks_mutation_preparations
         SET state='PREPARED', execution_attempt_id=NULL, execution_attempt_state=NULL,
             execution_claim_sequence=NULL, execution_lease_owner=NULL,
             execution_lease_token_hash=NULL, execution_lease_until=NULL,
             dispatch_started_at=NULL, execution_resolution_receipt=NULL,
             execution_attempt_created_at=NULL, approved_by=NULL, approved_at=NULL
       WHERE preparation_id=$1`,
      [input.preparationId],
    )).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("is immutable"),
    });
    await expect(pool.query(
      "UPDATE quickbooks_mutation_preparations SET execution_lease_until=$2 WHERE preparation_id=$1",
      [input.preparationId, new Date(now.getTime() + 30 * 60_000)],
    )).rejects.toMatchObject({
      message: expect.stringContaining("execution lease cannot move after Provider dispatch"),
    });
  });
});
