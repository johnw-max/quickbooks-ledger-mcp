import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQuickBooksMigrations } from "../src/quickbooks/migrate.js";
import { QuickBooksPostgresAccountingCaseRepository } from "../src/quickbooks/postgresAccountingCaseRepository.js";
import { QuickBooksPostgresControlRepository } from "../src/quickbooks/postgresControlRepository.js";
import { QuickBooksPostgresMutationRepository } from "../src/quickbooks/postgresMutationRepository.js";
import { inspectQuickBooksRuntimeReadiness } from "../src/quickbooks/runtimeReadiness.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("QuickBooks structured runtime readiness", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
  const migrationsDirectory = resolve(process.cwd(), "migrations");

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runQuickBooksMigrations(databaseUrl, migrationsDirectory);
  });
  afterAll(async () => { await pool?.end(); });

  it("attests the exact migration set, repositories, and absence of legacy compiler rows", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const control = new QuickBooksPostgresControlRepository(pool);
    const mutations = new QuickBooksPostgresMutationRepository(pool);
    const cases = new QuickBooksPostgresAccountingCaseRepository(pool);

    const result = await inspectQuickBooksRuntimeReadiness({
      pool,
      migrationsDirectory,
      controlRepositoryReady: () => control.readiness(),
      mutationRepositoryReady: () => mutations.readiness(),
      accountingCaseRepositoryReady: () => cases.readiness(),
    });

    expect(result).toMatchObject({
      ready: true,
      persistence: {
        status: "READY",
        checks: {
          database: true,
          controlRepository: true,
          mutationRepository: true,
          accountingCaseRepository: true,
        },
      },
      migrations: {
        status: "READY",
        latestExpected: "038_quickbooks_operator_unknown_write_resolution.sql",
        missingCount: 0,
        unexpectedCount: 0,
        checksumMismatchCount: 0,
        legacyCompilerRowCount: 0,
      },
    });
    expect(result.migrations.migrationSetHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
