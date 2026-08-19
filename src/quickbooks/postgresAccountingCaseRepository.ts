import type { Pool, PoolClient } from "pg";
import { AppError } from "../errors.js";
import { hashObject } from "../security/hash.js";
import type { QuickBooksAccountingCaseRecord, QuickBooksCaseBinding, QuickBooksCaseOperationRecord } from "./accountingCase.js";
import {
  initialQuickBooksCaseOperations,
  quickBooksCaseBindingKey,
  type QuickBooksAccountingCaseRepository,
} from "./accountingCaseRepository.js";

const columns = `workspace_id, subject_type, subject_id, agent_id, installation_id, binding_id,
  binding_revision, connection_id, realm_id`;

function bindingValues(binding: QuickBooksCaseBinding): unknown[] {
  return [binding.workspaceId, binding.subjectType, binding.subjectId, binding.agentId, binding.installationId,
    binding.bindingId, binding.bindingRevision, binding.connectionId, binding.realmId];
}

function whereBinding(offset = 1): string {
  return `workspace_id=$${offset} AND subject_type=$${offset + 1} AND subject_id=$${offset + 2}
    AND agent_id=$${offset + 3} AND installation_id=$${offset + 4} AND binding_id=$${offset + 5}
    AND binding_revision=$${offset + 6} AND connection_id=$${offset + 7} AND realm_id=$${offset + 8}`;
}

/**
 * A guard trigger or CHECK constraint refusing a transition is a durable,
 * deterministic refusal by this service's own persistence kernel. Left unmapped
 * it reaches `toSafeError` as an unknown error and is relabelled a *retryable*
 * `PROVIDER_ERROR`, telling the calling Agent that QuickBooks failed and that
 * retrying the write path is safe. Every guard message in `migrations/` is an
 * authored constant carrying no row data, so it is safe to surface verbatim;
 * CHECK violations name their constraint instead.
 */
async function withDurableGuardRefusal<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const sqlState = (error as { code?: unknown }).code;
    if (typeof sqlState !== "string" || !sqlState.startsWith("23")) throw error;
    const constraint = (error as { constraint?: unknown }).constraint;
    const message = (error as { message?: unknown }).message;
    const guard = typeof constraint === "string" && constraint.length > 0 ? constraint
      : typeof message === "string" ? message : undefined;
    throw new AppError("CONFLICT", "A QuickBooks persistence guard refused this Accounting Case transition.", {
      httpStatus: 409,
      retryable: false,
      details: {
        failureLayer: "PERSISTENCE",
        reasonCodes: ["DURABLE_GUARD_REFUSED"],
        sqlState,
        ...(guard ? { guard } : {}),
      },
      cause: error,
    });
  }
}

export class QuickBooksPostgresAccountingCaseRepository implements QuickBooksAccountingCaseRepository {
  constructor(private readonly pool: Pool) {}

  async readiness(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(`SELECT
        to_regclass('public.quickbooks_accounting_cases') IS NOT NULL
        AND to_regclass('public.quickbooks_accounting_case_operations') IS NOT NULL
        AND EXISTS (SELECT 1 FROM schema_migrations WHERE version='029_quickbooks_accounting_case_evidence_linkage.sql')
        AND EXISTS (SELECT 1 FROM schema_migrations WHERE version='031_quickbooks_accounting_case_preparation_identity.sql')
        AND EXISTS (SELECT 1 FROM schema_migrations WHERE version='032_quickbooks_cross_case_authorization_causality.sql')
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='quickbooks_accounting_case_operations'
            AND column_name='preparation_payload_hash' AND data_type='text'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='quickbooks_accounting_case_operations'
            AND column_name='operation_source_evidence_hash' AND data_type='text'
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint constraint_meta
          WHERE constraint_meta.conrelid='public.quickbooks_accounting_case_operations'::regclass
            AND constraint_meta.conname='quickbooks_accounting_case_preparation_fk'
            AND constraint_meta.contype='f' AND constraint_meta.convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger trigger_meta
          WHERE trigger_meta.tgrelid='public.quickbooks_accounting_case_operations'::regclass
            AND trigger_meta.tgname='quickbooks_accounting_case_preparation_link'
            AND NOT trigger_meta.tgisinternal AND trigger_meta.tgenabled <> 'D'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='quickbooks_accounting_case_operations'
            AND column_name='authorization_evidence' AND data_type='jsonb'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='quickbooks_accounting_case_operations'
            AND column_name='reuse_evidence_receipt' AND data_type='jsonb'
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger trigger_meta
          WHERE trigger_meta.tgrelid='public.quickbooks_accounting_case_operations'::regclass
            AND trigger_meta.tgname='quickbooks_accounting_case_mutation_causality'
            AND NOT trigger_meta.tgisinternal AND trigger_meta.tgenabled <> 'D'
        )
        AND EXISTS (
          SELECT 1 FROM pg_class index_class
          JOIN pg_index index_meta ON index_meta.indexrelid=index_class.oid
          WHERE index_class.relname='quickbooks_accounting_case_operation_preparation_idx'
            AND index_meta.indrelid='public.quickbooks_accounting_case_operations'::regclass
            AND NOT index_meta.indisunique AND index_meta.indisvalid AND index_meta.indisready
        )
        AND EXISTS (
          SELECT 1 FROM pg_class index_class
          JOIN pg_index index_meta ON index_meta.indexrelid=index_class.oid
          WHERE index_class.relname='quickbooks_accounting_case_operation_mutation_idx'
            AND index_meta.indrelid='public.quickbooks_accounting_case_operations'::regclass
            AND NOT index_meta.indisunique AND index_meta.indisvalid AND index_meta.indisready
        )
        AND to_regclass('public.quickbooks_accounting_case_operation_preparation_uq') IS NULL
        AND to_regclass('public.quickbooks_accounting_case_operation_mutation_uq') IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM quickbooks_accounting_case_operations
          WHERE state='READBACK_VERIFIED' AND authorization_evidence IS NULL
        )
        AS ready`);
      return result.rows[0]?.ready === true;
    } catch { return false; }
  }

  async createOrAdvance(input: Parameters<QuickBooksAccountingCaseRepository["createOrAdvance"]>[0]) {
    return withDurableGuardRefusal(() => this.#createOrAdvance(input));
  }

  async #createOrAdvance(input: Parameters<QuickBooksAccountingCaseRepository["createOrAdvance"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // SELECT ... FOR UPDATE cannot lock a Case that has no rows yet. A
      // transaction-scoped advisory lock closes that first-version race and
      // makes expected_version a real compare-and-swap boundary.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        // The in-memory repository key deliberately uses NUL separators, but
        // PostgreSQL text values cannot contain NUL bytes. Hash the exact key
        // before passing it to hashtextextended so the advisory-lock identity
        // remains deterministic without emitting an invalid UTF-8 string.
        hashObject({ caseBindingKey: quickBooksCaseBindingKey(input.binding, input.compiled.caseId) }),
      ]);
      const current = await client.query<{ version: number; compiled_plan_hash: string; state: QuickBooksAccountingCaseRecord["state"] }>(
        `SELECT version, compiled_plan_hash, state FROM quickbooks_accounting_cases WHERE ${whereBinding()} AND case_id=$10
         ORDER BY version DESC LIMIT 1 FOR UPDATE`, [...bindingValues(input.binding), input.compiled.caseId]);
      const currentVersion = Number(current.rows[0]?.version ?? 0);
      if (currentVersion === input.compiled.version) {
        if (current.rows[0]?.compiled_plan_hash !== input.compiledPlanHash) throw new AppError("CONFLICT", "Case version plan differs.", { httpStatus: 409 });
        const record = await this.#load(client, input.binding, input.compiled.caseId, input.compiled.version);
        await client.query("COMMIT");
        return { mode: "IDEMPOTENT_REPLAY" as const, record: record as QuickBooksAccountingCaseRecord };
      }
      if (input.compiled.version !== currentVersion + 1) throw new AppError("CONFLICT", "Accounting Case expected_version is stale.", { httpStatus: 409 });
      if (current.rows[0]?.state === "EXECUTING" || current.rows[0]?.state === "RECOVERY_REQUIRED") {
        throw new AppError("CONFLICT", "Accounting Case cannot advance while execution or recovery is active.", { httpStatus: 409 });
      }
      await client.query(`INSERT INTO quickbooks_accounting_cases(
        case_id,version,actor_id,${columns},target_session_hash,compiled_case,compiled_plan_hash,source_revision_hash,state,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$18)`,
        [input.compiled.caseId, input.compiled.version, input.binding.actorId, ...bindingValues(input.binding),
          input.binding.targetSessionHash, JSON.stringify(input.compiled), input.compiledPlanHash,
          input.compiled.sourceRevisionHash, input.compiled.status, input.now]);
      for (const operationRecord of initialQuickBooksCaseOperations(input.compiled)) {
        await client.query(`INSERT INTO quickbooks_accounting_case_operations(
          ${columns},case_id,case_version,operation_id,operation_json,state,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$15)`,
          [...bindingValues(input.binding), input.compiled.caseId, input.compiled.version, operationRecord.operation.operationId,
            JSON.stringify(operationRecord.operation), operationRecord.state, input.now]);
      }
      const record = await this.#load(client, input.binding, input.compiled.caseId, input.compiled.version);
      await client.query("COMMIT");
      return { mode: currentVersion === 0 ? "CREATED" as const : "ADVANCED" as const, record: record as QuickBooksAccountingCaseRecord };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async getBound(input: Parameters<QuickBooksAccountingCaseRepository["getBound"]>[0]) {
    const version = input.version ?? await this.#latestVersion(this.pool, input.binding, input.caseId);
    return version ? this.#load(this.pool, input.binding, input.caseId, version) : undefined;
  }

  async claimExecution(input: Parameters<QuickBooksAccountingCaseRepository["claimExecution"]>[0]) {
    return withDurableGuardRefusal(() => this.#claimExecution(input));
  }

  async #claimExecution(input: Parameters<QuickBooksAccountingCaseRepository["claimExecution"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await client.query<{ state: QuickBooksAccountingCaseRecord["state"]; execution_request_id: string | null; compiled_plan_hash: string }>(
        `SELECT state, execution_request_id, compiled_plan_hash FROM quickbooks_accounting_cases
         WHERE ${whereBinding()} AND case_id=$10 AND version=$11 FOR UPDATE`,
        [...bindingValues(input.binding), input.caseId, input.version]);
      const current = row.rows[0];
      if (!current) throw new AppError("NOT_FOUND", "Accounting Case not found.", { httpStatus: 404 });
      if (current.compiled_plan_hash !== input.expectedPlanHash) throw new AppError("CONFLICT", "Accounting Case plan hash changed.", { httpStatus: 409 });
      let mode: "CLAIMED" | "RESUME" | "ALREADY_TERMINAL" = "CLAIMED";
      if (current.state === "TERMINAL") mode = "ALREADY_TERMINAL";
      else if (current.state === "EXECUTING" || current.state === "RECOVERY_REQUIRED") {
        // Resuming requires the request id that started the execution. Saying only
        // that someone else owns the Case leaves the caller guessing: a real agent
        // read this as lock contention and retried with a fresh request id a dozen
        // times, which can never succeed. Name the owner and the action — it is the
        // caller's own earlier request id, and the binding above already proves the
        // caller owns this Case.
        if (current.execution_request_id !== input.requestId) {
          throw new AppError(
            "CONFLICT",
            "This Accounting Case version is already executing under an earlier request; resume it with that same request id rather than a new one.",
            {
              httpStatus: 409,
              details: {
                failureLayer: "CONCURRENCY_OR_VERSION",
                reasonCodes: ["CASE_OWNED_BY_EARLIER_REQUEST"],
                caseState: current.state,
                owningRequestId: current.execution_request_id,
                recoveryAction: "RETRY_WITH_OWNING_REQUEST_ID",
              },
            },
          );
        }
        mode = "RESUME";
      } else {
        await client.query(`UPDATE quickbooks_accounting_cases SET state='EXECUTING',execution_request_id=$12,updated_at=$13
          WHERE ${whereBinding()} AND case_id=$10 AND version=$11`,
          [...bindingValues(input.binding), input.caseId, input.version, input.requestId, input.now]);
      }
      const record = await this.#load(client, input.binding, input.caseId, input.version);
      await client.query("COMMIT");
      return { mode, record: record as QuickBooksAccountingCaseRecord };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async updateOperation(input: Parameters<QuickBooksAccountingCaseRepository["updateOperation"]>[0]) {
    return withDurableGuardRefusal(() => this.#updateOperation(input));
  }

  async #updateOperation(input: Parameters<QuickBooksAccountingCaseRepository["updateOperation"]>[0]) {
    const result = await this.pool.query(`UPDATE quickbooks_accounting_case_operations SET
      state=$14,preparation_id=COALESCE($15,preparation_id),
      preparation_payload_hash=COALESCE($16,preparation_payload_hash),
      operation_source_evidence_hash=COALESCE($17,operation_source_evidence_hash),
      mutation_request_id=COALESCE($18,mutation_request_id),provider_entity_id=COALESCE($19,provider_entity_id),
      authorization_receipt=COALESCE($20::jsonb,authorization_receipt),
      authorization_evidence=COALESCE($21::jsonb,authorization_evidence),
      reuse_evidence_receipt=COALESCE($22::jsonb,reuse_evidence_receipt),
      write_receipt=COALESCE($23::jsonb,write_receipt),
      readback=COALESCE($24::jsonb,readback),error_receipt=COALESCE($25::jsonb,error_receipt),updated_at=$26
      WHERE ${whereBinding()} AND case_id=$10 AND case_version=$11 AND operation_id=$12 AND state=ANY($13::text[])
      AND EXISTS (SELECT 1 FROM quickbooks_accounting_cases case_head
        WHERE case_head.workspace_id=$1 AND case_head.subject_type=$2 AND case_head.subject_id=$3
          AND case_head.agent_id=$4 AND case_head.installation_id=$5 AND case_head.binding_id=$6
          AND case_head.binding_revision=$7 AND case_head.connection_id=$8 AND case_head.realm_id=$9
          AND case_head.case_id=$10 AND case_head.version=$11 AND case_head.state IN ('EXECUTING','RECOVERY_REQUIRED')
          AND case_head.execution_request_id=$27)
      RETURNING operation_id`, [...bindingValues(input.binding), input.caseId, input.version, input.operationId,
        input.expectedStates, input.state, input.preparationId ?? null, input.preparationPayloadHash ?? null,
        input.operationSourceEvidenceHash ?? null, input.mutationRequestId ?? null, input.providerEntityId ?? null,
        input.authorizationReceipt ? JSON.stringify(input.authorizationReceipt) : null,
        input.authorizationEvidence ? JSON.stringify(input.authorizationEvidence) : null,
        input.reuseEvidenceReceipt ? JSON.stringify(input.reuseEvidenceReceipt) : null,
        input.writeReceipt ? JSON.stringify(input.writeReceipt) : null, input.readback ? JSON.stringify(input.readback) : null,
        input.errorReceipt ? JSON.stringify(input.errorReceipt) : null, input.now, input.requestId]);
    if (result.rowCount !== 1) throw new AppError("CONFLICT", "Accounting Case operation transition failed.", { httpStatus: 409 });
    return (await this.#load(this.pool, input.binding, input.caseId, input.version)) as QuickBooksAccountingCaseRecord;
  }

  async finalize(input: Parameters<QuickBooksAccountingCaseRepository["finalize"]>[0]) {
    return withDurableGuardRefusal(() => this.#finalize(input));
  }

  async #finalize(input: Parameters<QuickBooksAccountingCaseRepository["finalize"]>[0]) {
    const operationGate = input.state === "RECOVERY_REQUIRED"
      ? `AND EXISTS (SELECT 1 FROM quickbooks_accounting_case_operations operation_row
          WHERE operation_row.workspace_id=$1 AND operation_row.subject_type=$2 AND operation_row.subject_id=$3
            AND operation_row.agent_id=$4 AND operation_row.installation_id=$5 AND operation_row.binding_id=$6
            AND operation_row.binding_revision=$7 AND operation_row.connection_id=$8 AND operation_row.realm_id=$9
            AND operation_row.case_id=$10 AND operation_row.case_version=$11
            AND operation_row.state IN ('WRITE_UNCERTAIN','READBACK_MISMATCH'))`
      : `AND NOT EXISTS (SELECT 1 FROM quickbooks_accounting_case_operations operation_row
          WHERE operation_row.workspace_id=$1 AND operation_row.subject_type=$2 AND operation_row.subject_id=$3
            AND operation_row.agent_id=$4 AND operation_row.installation_id=$5 AND operation_row.binding_id=$6
            AND operation_row.binding_revision=$7 AND operation_row.connection_id=$8 AND operation_row.realm_id=$9
            AND operation_row.case_id=$10 AND operation_row.case_version=$11
            AND operation_row.state IN ('PENDING','PREPARED','WRITE_UNCERTAIN','READBACK_MISMATCH'))`;
    const result = await this.pool.query(`UPDATE quickbooks_accounting_cases SET state=$12,terminal_summary=$13::jsonb,updated_at=$14
      WHERE ${whereBinding()} AND case_id=$10 AND version=$11 AND execution_request_id=$15 ${operationGate} RETURNING case_id`,
      [...bindingValues(input.binding), input.caseId, input.version, input.state, JSON.stringify(input.terminalSummary), input.now, input.requestId]);
    if (result.rowCount !== 1) throw new AppError("CONFLICT", "Accounting Case finalize failed.", { httpStatus: 409 });
    return (await this.#load(this.pool, input.binding, input.caseId, input.version)) as QuickBooksAccountingCaseRecord;
  }

  async #latestVersion(queryable: Pick<Pool, "query">, binding: QuickBooksCaseBinding, caseId: string): Promise<number | undefined> {
    const result = await queryable.query<{ version: number }>(`SELECT version FROM quickbooks_accounting_cases
      WHERE ${whereBinding()} AND case_id=$10 ORDER BY version DESC LIMIT 1`, [...bindingValues(binding), caseId]);
    return result.rows[0] ? Number(result.rows[0].version) : undefined;
  }

  async #load(queryable: Pick<Pool | PoolClient, "query">, binding: QuickBooksCaseBinding, caseId: string, version: number) {
    const head = await queryable.query<any>(`SELECT * FROM quickbooks_accounting_cases WHERE ${whereBinding()} AND case_id=$10 AND version=$11`,
      [...bindingValues(binding), caseId, version]);
    const row = head.rows[0];
    if (!row) return undefined;
    const ops = await queryable.query<any>(`SELECT * FROM quickbooks_accounting_case_operations WHERE ${whereBinding()}
      AND case_id=$10 AND case_version=$11 ORDER BY operation_id`, [...bindingValues(binding), caseId, version]);
    const operations: QuickBooksCaseOperationRecord[] = ops.rows.map((entry: any) => ({
      operation: entry.operation_json, state: entry.state,
      ...(entry.preparation_id ? { preparationId: entry.preparation_id } : {}),
      ...(entry.preparation_payload_hash ? { preparationPayloadHash: entry.preparation_payload_hash } : {}),
      ...(entry.operation_source_evidence_hash
        ? { operationSourceEvidenceHash: entry.operation_source_evidence_hash }
        : {}),
      ...(entry.mutation_request_id ? { mutationRequestId: entry.mutation_request_id } : {}),
      ...(entry.provider_entity_id ? { providerEntityId: entry.provider_entity_id } : {}),
      ...(entry.authorization_receipt ? { authorizationReceipt: entry.authorization_receipt } : {}),
      ...(entry.authorization_evidence ? { authorizationEvidence: entry.authorization_evidence } : {}),
      ...(entry.reuse_evidence_receipt ? { reuseEvidenceReceipt: entry.reuse_evidence_receipt } : {}),
      ...(entry.write_receipt ? { writeReceipt: entry.write_receipt } : {}),
      ...(entry.readback ? { readback: entry.readback } : {}),
      ...(entry.error_receipt ? { errorReceipt: entry.error_receipt } : {}),
    }));
    return {
      binding: { ...binding, actorId: row.actor_id, targetSessionHash: row.target_session_hash },
      compiled: row.compiled_case, compiledPlanHash: row.compiled_plan_hash, state: row.state,
      ...(row.execution_request_id ? { executionRequestId: row.execution_request_id } : {}),
      operations, ...(row.terminal_summary ? { terminalSummary: row.terminal_summary } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    } as QuickBooksAccountingCaseRecord;
  }
}
