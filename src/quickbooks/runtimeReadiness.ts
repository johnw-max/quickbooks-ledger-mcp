import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { hashObject, sha256 } from "../security/hash.js";
import { QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION } from "./accountingCase.js";

export interface QuickBooksRuntimeReadiness {
  readonly ready: boolean;
  readonly persistence: {
    readonly status: "READY" | "NOT_READY";
    readonly checks: {
      readonly database: boolean;
      readonly controlRepository: boolean;
      readonly mutationRepository: boolean;
      readonly accountingCaseRepository: boolean;
    };
  };
  readonly migrations: {
    readonly status: "READY" | "NOT_READY";
    readonly latestExpected: string | null;
    readonly migrationSetHash: string;
    readonly missingCount: number;
    readonly unexpectedCount: number;
    readonly checksumMismatchCount: number;
    readonly historyIntegrity: "CHECKSUM_VERIFIED" | "LEGACY_UNCHECKSUMMED";
    readonly legacyCompilerRowCount: number;
  };
}

interface MigrationRow {
  version: string;
  checksum_sha256: string | null;
}

export async function inspectQuickBooksRuntimeReadiness(options: {
  pool: Pool;
  migrationsDirectory: string;
  controlRepositoryReady: () => Promise<boolean>;
  mutationRepositoryReady: () => Promise<boolean>;
  accountingCaseRepositoryReady: () => Promise<boolean>;
}): Promise<QuickBooksRuntimeReadiness> {
  const files = (await readdir(options.migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const expected = await Promise.all(files.map(async (version) => ({
    version,
    checksum: sha256(await readFile(resolve(options.migrationsDirectory, version), "utf8")),
  })));

  let database = false;
  let rows: MigrationRow[] = [];
  let legacyCompilerRowCount = Number.MAX_SAFE_INTEGER;
  try {
    await options.pool.query("SELECT 1");
    database = true;
    const result = await options.pool.query<MigrationRow>(
      "SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version",
    );
    rows = result.rows;
    const caseTable = await options.pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.quickbooks_accounting_cases') IS NOT NULL AS present",
    );
    if (caseTable.rows[0]?.present) {
      const legacy = await options.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM quickbooks_accounting_cases
         WHERE COALESCE(compiled_case->>'compilerVersion','') <> $1`,
        [QUICKBOOKS_ACCOUNTING_CASE_COMPILER_VERSION],
      );
      legacyCompilerRowCount = Number(legacy.rows[0]?.count ?? Number.MAX_SAFE_INTEGER);
    }
  } catch {
    database = false;
  }

  const recorded = new Map(rows.map((row) => [row.version, row.checksum_sha256]));
  const expectedVersions = new Set(expected.map(({ version }) => version));
  const missingCount = expected.filter(({ version }) => !recorded.has(version)).length;
  const unexpectedCount = rows.filter(({ version }) =>
    version.toLowerCase().includes("quickbooks") && !expectedVersions.has(version)).length;
  const checksumMismatchCount = expected.filter(({ version, checksum }) => {
    const value = recorded.get(version);
    return value !== undefined && value !== null && value !== checksum;
  }).length;
  const legacyUnchecksummed = expected.some(({ version }) => recorded.get(version) === null);
  const [controlRepository, mutationRepository, accountingCaseRepository] = await Promise.all([
    options.controlRepositoryReady(),
    options.mutationRepositoryReady(),
    options.accountingCaseRepositoryReady(),
  ]);
  const persistenceReady = database && controlRepository && mutationRepository && accountingCaseRepository;
  const migrationsReady = database && missingCount === 0 && unexpectedCount === 0 && checksumMismatchCount === 0 &&
    legacyCompilerRowCount === 0;
  return Object.freeze({
    ready: persistenceReady && migrationsReady,
    persistence: Object.freeze({
      status: persistenceReady ? "READY" : "NOT_READY",
      checks: Object.freeze({ database, controlRepository, mutationRepository, accountingCaseRepository }),
    }),
    migrations: Object.freeze({
      status: migrationsReady ? "READY" : "NOT_READY",
      latestExpected: files.at(-1) ?? null,
      migrationSetHash: hashObject(expected),
      missingCount,
      unexpectedCount,
      checksumMismatchCount,
      historyIntegrity: legacyUnchecksummed ? "LEGACY_UNCHECKSUMMED" : "CHECKSUM_VERIFIED",
      legacyCompilerRowCount,
    }),
  });
}
