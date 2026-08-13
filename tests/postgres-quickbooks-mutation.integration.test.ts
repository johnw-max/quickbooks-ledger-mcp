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
      now: new Date(now.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });

    const claimed = await repository.claimForExecution({
      preparationId: input.preparationId,
      actorId: input.actorId,
      requestId: `execute.${suffix}`,
      confirmationPhraseHash: confirmationHash,
      approvedBy: input.actorId,
      now: new Date(now.getTime() + 2_000),
    });
    expect(claimed).toMatchObject({ shouldExecute: true, preparation: { state: "EXECUTING" } });

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
      now: new Date(now.getTime() + 4_000),
    });
    expect(terminalReplay).toMatchObject({
      shouldExecute: false,
      preparation: { state: "POSTED_READBACK_VERIFIED", providerEntityId: `customer-${suffix}` },
    });
  });
});
