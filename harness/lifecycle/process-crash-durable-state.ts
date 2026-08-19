/**
 * Durable-state reader for the QuickBooks process-crash harness.
 *
 * Everything here is plain SQL against the same PostgreSQL database the MCP
 * writes to. Nothing is taken from a live process, so the numbers survive a
 * SIGKILL and can be re-read by the supervisor and by the restarted worker
 * independently of each other.
 */
import type { Pool } from "pg";
import type { QuickBooksCrashDurableState } from "./process-crash-contract.js";

export const CRASH_HARNESS_PROVIDER_OBJECTS_TABLE = "crash_harness_provider_objects";
export const CRASH_HARNESS_PROVIDER_CALLS_TABLE = "crash_harness_provider_calls";

/**
 * The Provider double's object ledger and call log live in PostgreSQL on
 * purpose: an in-memory call log would prove nothing about a process crash.
 */
export async function ensureCrashHarnessProviderTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CRASH_HARNESS_PROVIDER_OBJECTS_TABLE} (
      run_id text NOT NULL,
      provider_request_id text NOT NULL,
      entity text NOT NULL,
      provider_entity_id text NOT NULL,
      document jsonb NOT NULL,
      receipt jsonb NOT NULL,
      accepted_by_pid integer NOT NULL,
      accepted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, provider_request_id),
      UNIQUE (run_id, provider_entity_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CRASH_HARNESS_PROVIDER_CALLS_TABLE} (
      sequence_id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      process_pid integer NOT NULL,
      phase text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('CREATE_POST_SENT','CREATE_ACCEPTED','GET')),
      provider_request_id text,
      provider_entity_id text,
      details jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

interface CaseRow {
  state: string;
  operation_states: string[] | null;
  operation_provider_entity_ids: Array<string | null> | null;
}

interface MutationRow {
  state: string;
  execution_attempt_state: string | null;
  dispatch_started: boolean;
  provider_entity_id: string | null;
  execution_lease_owner: string | null;
  execution_claim_sequence: number | null;
  execution_lease_expired: boolean | null;
  execution_resolution_receipt: Record<string, unknown> | null;
}

interface ProviderCountsRow {
  create_post_count: string;
  create_accepted_count: string;
  get_count: string;
}

export async function readQuickBooksCrashDurableState(
  pool: Pool,
  input: { runId: string; caseId: string; observedByPid: number },
): Promise<QuickBooksCrashDurableState> {
  const [cases, mutations, counts, objects, postPids, migrations] = await Promise.all([
    pool.query<CaseRow>(
      `SELECT head.state,
              array_remove(array_agg(operation.state ORDER BY operation.operation_id), NULL)
                AS operation_states,
              array_agg(operation.provider_entity_id ORDER BY operation.operation_id)
                FILTER (WHERE operation.operation_id IS NOT NULL)
                AS operation_provider_entity_ids
         FROM quickbooks_accounting_cases head
         LEFT JOIN quickbooks_accounting_case_operations operation
           ON operation.case_id = head.case_id AND operation.case_version = head.version
            AND operation.workspace_id = head.workspace_id
        WHERE head.case_id = $1
        GROUP BY head.state`,
      [input.caseId],
    ),
    pool.query<MutationRow>(
      `SELECT state, execution_attempt_state,
              dispatch_started_at IS NOT NULL AS dispatch_started,
              provider_entity_id, execution_lease_owner, execution_claim_sequence,
              CASE WHEN execution_lease_until IS NULL THEN NULL
                   ELSE execution_lease_until <= now() END AS execution_lease_expired,
              execution_resolution_receipt
         FROM quickbooks_mutation_preparations
        ORDER BY created_at, preparation_id`,
    ),
    pool.query<ProviderCountsRow>(
      `SELECT count(*) FILTER (WHERE operation = 'CREATE_POST_SENT')::text AS create_post_count,
              count(*) FILTER (WHERE operation = 'CREATE_ACCEPTED')::text AS create_accepted_count,
              count(*) FILTER (WHERE operation = 'GET')::text AS get_count
         FROM ${CRASH_HARNESS_PROVIDER_CALLS_TABLE} WHERE run_id = $1`,
      [input.runId],
    ),
    pool.query<{ provider_entity_id: string }>(
      `SELECT provider_entity_id FROM ${CRASH_HARNESS_PROVIDER_OBJECTS_TABLE}
        WHERE run_id = $1 ORDER BY accepted_at`,
      [input.runId],
    ),
    pool.query<{ process_pid: number }>(
      `SELECT process_pid FROM ${CRASH_HARNESS_PROVIDER_CALLS_TABLE}
        WHERE run_id = $1 AND operation = 'CREATE_POST_SENT' ORDER BY sequence_id`,
      [input.runId],
    ),
    pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version"),
  ]);
  const caseRow = cases.rows[0];
  const operationStates = (caseRow?.operation_states ?? []).filter((state): state is string => state !== null);
  const providerCounts = counts.rows[0];
  return {
    observed_by_pid: input.observedByPid,
    case_state: caseRow?.state ?? null,
    case_operation_states: operationStates,
    case_operation_provider_entity_ids: caseRow?.operation_provider_entity_ids ?? [],
    mutation_states: mutations.rows.map((row) => row.state),
    mutation_execution_attempt_states: mutations.rows.map((row) => row.execution_attempt_state),
    mutation_dispatch_started: mutations.rows.map((row) => row.dispatch_started),
    mutation_provider_entity_ids: mutations.rows.map((row) => row.provider_entity_id),
    mutation_execution_lease_owners: mutations.rows.map((row) => row.execution_lease_owner),
    mutation_execution_claim_sequences: mutations.rows.map((row) => row.execution_claim_sequence),
    mutation_execution_lease_expired: mutations.rows.map((row) => row.execution_lease_expired),
    mutation_resolution_receipts: mutations.rows.map((row) => row.execution_resolution_receipt),
    provider_create_post_count: Number(providerCounts?.create_post_count ?? "0"),
    provider_create_accepted_count: Number(providerCounts?.create_accepted_count ?? "0"),
    provider_get_count: Number(providerCounts?.get_count ?? "0"),
    provider_object_ids: objects.rows.map((row) => row.provider_entity_id),
    provider_create_post_pids: postPids.rows.map((row) => row.process_pid),
    migration_head: migrations.rows.at(-1)?.version ?? null,
    applied_migration_count: migrations.rowCount ?? 0,
  };
}

/**
 * Milliseconds until the newest still-EXECUTING lease expires, measured with
 * PostgreSQL's own clock. Zero means no worker currently holds a live lease.
 */
export async function readExecutionLeaseRemainingMs(pool: Pool): Promise<number> {
  const remaining = await pool.query<{ remaining_ms: string }>(
    `SELECT COALESCE(
              GREATEST(0, ceil(EXTRACT(EPOCH FROM (max(execution_lease_until) - now())) * 1000)), 0
            )::bigint::text AS remaining_ms
       FROM quickbooks_mutation_preparations WHERE state = 'EXECUTING'`,
  );
  const remainingMs = Number(remaining.rows[0]?.remaining_ms ?? "0");
  return Number.isFinite(remainingMs) && remainingMs > 0 ? remainingMs : 0;
}

/**
 * Waits, in real wall-clock time, until every EXECUTING lease in this database
 * has actually expired according to PostgreSQL's own clock. The harness never
 * rewrites `execution_lease_until`; a stale lease has to become stale on its
 * own, exactly as it would in production.
 */
export async function waitForExecutionLeaseExpiry(
  pool: Pool,
  options: { timeoutMs: number },
): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    const remainingMs = await readExecutionLeaseRemainingMs(pool);
    if (remainingMs <= 0) return Date.now() - startedAt;
    if (Date.now() - startedAt > options.timeoutMs) {
      throw new Error("CRASH_HARNESS_EXECUTION_LEASE_EXPIRY_WAIT_TIMEOUT");
    }
    await new Promise((resolveSleep) => {
      setTimeout(resolveSleep, Math.max(250, Math.min(remainingMs + 250, 2_000)));
    });
  }
}
