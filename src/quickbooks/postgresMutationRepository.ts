import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AppError } from "../errors.js";
import { hashObject, safeEqual } from "../security/hash.js";
import type {
  CreateQuickBooksMutationPreparationInput,
  QuickBooksMutationClaim,
  QuickBooksMutationPreparation,
  QuickBooksMutationState,
} from "./mutationModels.js";
import type { QuickBooksMutationRepository } from "./mutationRepository.js";
import { resolvedNoWriteReceipt, unknownNoIdResolutionReceipt } from "./mutationExecutionAttempt.js";
import { resolveQuickBooksAutonomousAuthorizationDelegationIdentity } from "./autonomousAuthorizationEvidence.js";

interface MutationRow extends QueryResultRow {
  preparation_id: string;
  actor_id: string;
  realm_id: string;
  connection_ref_safe: string;
  bound_target_ref_safe: string;
  binding_revision: string;
  entity: QuickBooksMutationPreparation["entity"];
  operation: QuickBooksMutationPreparation["operation"];
  risk: QuickBooksMutationPreparation["risk"];
  execution_mode: QuickBooksMutationPreparation["executionMode"];
  provider_effect: QuickBooksMutationPreparation["providerEffect"];
  client_request_id: string;
  provider_request_id: string;
  target_id: string | null;
  sync_token: string | null;
  before_image: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  business_reason: string;
  source_ref: string | null;
  source_sha256: string | null;
  source_digest_provenance: QuickBooksMutationPreparation["sourceDigestProvenance"] | null;
  source_attestation_digest: string | null;
  approval_ref: string | null;
  confirmation_phrase_hash: string;
  state: QuickBooksMutationState;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  provider_entity_id: string | null;
  autonomous_authorization_evidence: QuickBooksMutationPreparation["autonomousAuthorizationEvidence"] | null;
  execution_attempt_id: string | null;
  execution_attempt_state: QuickBooksMutationPreparation["executionAttempt"] extends infer Attempt
    ? Attempt extends { state: infer State } ? State | null : null : null;
  execution_claim_sequence: number | null;
  execution_lease_owner: string | null;
  execution_lease_token_hash: string | null;
  execution_lease_until: Date | null;
  dispatch_started_at: Date | null;
  provider_outcome_recorded_at: Date | null;
  execution_resolution_receipt: Record<string, unknown> | null;
  execution_attempt_created_at: Date | null;
  provider_outcome_receipt: Record<string, unknown> | null;
  write_receipt: Record<string, unknown> | null;
  readback: Record<string, unknown> | null;
  created_at: Date;
  expires_at: Date;
  updated_at: Date;
}

function map(row: MutationRow): QuickBooksMutationPreparation {
  return {
    preparationId: row.preparation_id,
    actorId: row.actor_id,
    realmId: row.realm_id,
    connectionRefSafe: row.connection_ref_safe,
    boundTargetRefSafe: row.bound_target_ref_safe,
    bindingRevision: row.binding_revision,
    entity: row.entity,
    operation: row.operation,
    risk: row.risk,
    executionMode: row.execution_mode,
    providerEffect: row.provider_effect,
    clientRequestId: row.client_request_id,
    providerRequestId: row.provider_request_id,
    ...(row.target_id ? { targetId: row.target_id } : {}),
    ...(row.sync_token ? { syncToken: row.sync_token } : {}),
    ...(row.before_image ? { beforeImage: row.before_image } : {}),
    payload: row.payload,
    payloadHash: row.payload_hash,
    businessReason: row.business_reason,
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.source_sha256 ? { sourceSha256: row.source_sha256 } : {}),
    ...(row.source_digest_provenance ? { sourceDigestProvenance: row.source_digest_provenance } : {}),
    ...(row.source_attestation_digest ? { sourceAttestationDigest: row.source_attestation_digest } : {}),
    ...(row.approval_ref ? { approvalRef: row.approval_ref } : {}),
    confirmationPhraseHash: row.confirmation_phrase_hash,
    state: row.state,
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    ...(row.rejected_by ? { rejectedBy: row.rejected_by } : {}),
    ...(row.rejected_at ? { rejectedAt: row.rejected_at } : {}),
    ...(row.provider_entity_id ? { providerEntityId: row.provider_entity_id } : {}),
    ...(row.autonomous_authorization_evidence
      ? { autonomousAuthorizationEvidence: row.autonomous_authorization_evidence }
      : {}),
    ...(row.execution_attempt_id && row.execution_attempt_state && row.execution_claim_sequence &&
      row.execution_lease_owner && row.execution_lease_token_hash && row.execution_lease_until &&
      row.execution_attempt_created_at ? {
        executionAttempt: {
          attemptId: row.execution_attempt_id,
          claimSequence: row.execution_claim_sequence,
          state: row.execution_attempt_state,
          leaseOwner: row.execution_lease_owner,
          leaseTokenHash: row.execution_lease_token_hash,
          leaseUntil: row.execution_lease_until,
          ...(row.dispatch_started_at ? { dispatchStartedAt: row.dispatch_started_at } : {}),
          ...(row.provider_outcome_recorded_at ? { providerOutcomeRecordedAt: row.provider_outcome_recorded_at } : {}),
          ...(row.execution_resolution_receipt ? { resolutionReceipt: row.execution_resolution_receipt } : {}),
          createdAt: row.execution_attempt_created_at,
          updatedAt: row.updated_at,
        },
      } : {}),
    ...(row.provider_outcome_receipt ? { providerOutcomeReceipt: row.provider_outcome_receipt } : {}),
    ...(row.write_receipt ? { writeReceipt: row.write_receipt } : {}),
    ...(row.readback ? { readback: row.readback } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

async function locked(client: PoolClient, preparationId: string) {
  const result = await client.query<MutationRow>(
    "SELECT * FROM quickbooks_mutation_preparations WHERE preparation_id = $1 FOR UPDATE",
    [preparationId],
  );
  return result.rows[0];
}

function assertAutonomousAuthorizationClaimBinding(row: MutationRow, approvedBy: string): void {
  const evidence = row.autonomous_authorization_evidence;
  if (!evidence) {
    if (approvedBy.startsWith("standing:")) {
      throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence was not durably recorded before execution.", {
        httpStatus: 503,
        details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_MISSING"] },
      });
    }
    return;
  }
  const identity = resolveQuickBooksAutonomousAuthorizationDelegationIdentity(evidence, {
    preparationId: row.preparation_id,
    providerRequestId: row.provider_request_id,
    actorId: row.actor_id,
    realmId: row.realm_id,
    preparationPayloadHash: row.payload_hash,
  });
  if (!identity) {
    throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence failed integrity verification at execution claim.", {
      httpStatus: 503,
      details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_INVALID"] },
    });
  }
  if (!safeEqual(approvedBy, identity.approvedBy)) {
    throw new AppError("APPROVAL_INVALID", "QuickBooks mutation must be claimed by the standing delegation recorded in its original authorization.", {
      httpStatus: 409,
      details: {
        failureLayer: "AUTHORIZATION_CAUSALITY",
        reasonCodes: ["AUTHORIZATION_CLAIM_ACTOR_MISMATCH"],
        expectedApprovedBy: identity.approvedBy,
      },
    });
  }
}

export class QuickBooksPostgresMutationRepository implements QuickBooksMutationRepository {
  constructor(private readonly pool: Pool) {}

  async readiness(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `SELECT
          to_regclass('public.quickbooks_mutation_preparations') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM schema_migrations
            WHERE version = '025_quickbooks_generic_mutations.sql'
          )
          AND EXISTS (
            SELECT 1 FROM schema_migrations
            WHERE version = '026_quickbooks_source_attestation.sql'
          )
          AND EXISTS (
            SELECT 1 FROM schema_migrations
            WHERE version = '030_quickbooks_mutation_recovery.sql'
          )
          AND EXISTS (
            SELECT 1 FROM schema_migrations
            WHERE version = '032_quickbooks_cross_case_authorization_causality.sql'
          )
          AND EXISTS (
            SELECT 1 FROM schema_migrations
            WHERE version = '033_quickbooks_mutation_execution_fencing.sql'
          )
          AND EXISTS (
            SELECT 1 FROM schema_migrations
            WHERE version = '034_quickbooks_autonomous_authorization_claim_binding.sql'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'quickbooks_mutation_preparations'
              AND column_name = 'autonomous_authorization_evidence'
              AND data_type = 'jsonb'
              AND is_nullable = 'YES'
          )
          AND EXISTS (
            SELECT 1 FROM pg_trigger trigger_meta
            WHERE trigger_meta.tgrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND trigger_meta.tgname = 'quickbooks_mutation_autonomous_authorization_causality'
              AND NOT trigger_meta.tgisinternal AND trigger_meta.tgenabled = 'O'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint constraint_meta
            WHERE constraint_meta.conrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND constraint_meta.conname = 'quickbooks_mutation_autonomous_authorization_claim_binding'
              AND constraint_meta.contype = 'c' AND constraint_meta.convalidated
          )
          AND (
            SELECT count(*) = 10
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'quickbooks_mutation_preparations'
              AND column_name = ANY (ARRAY[
                'execution_attempt_id','execution_attempt_state','execution_claim_sequence',
                'execution_lease_owner','execution_lease_token_hash','execution_lease_until',
                'dispatch_started_at','provider_outcome_recorded_at',
                'execution_resolution_receipt','execution_attempt_created_at'
              ])
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint constraint_meta
            WHERE constraint_meta.conrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND constraint_meta.conname = 'quickbooks_mutation_execution_attempt_shape'
              AND constraint_meta.contype = 'c' AND constraint_meta.convalidated
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint constraint_meta
            WHERE constraint_meta.conrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND constraint_meta.conname = 'quickbooks_mutation_execution_attempt_state_check'
              AND constraint_meta.contype = 'c' AND constraint_meta.convalidated
          )
          AND EXISTS (
            SELECT 1 FROM pg_trigger trigger_meta
            WHERE trigger_meta.tgrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND trigger_meta.tgname = 'quickbooks_mutation_execution_attempt_immutable'
              AND NOT trigger_meta.tgisinternal AND trigger_meta.tgenabled = 'O'
          )
          AND NOT EXISTS (
            SELECT 1 FROM quickbooks_mutation_preparations
            WHERE state NOT IN ('PREPARED','REJECTED')
              AND (
                (approved_by LIKE 'standing:%' AND autonomous_authorization_evidence IS NULL)
                OR (
                  autonomous_authorization_evidence IS NOT NULL
                  AND approved_by IS DISTINCT FROM
                    ('standing:' || (autonomous_authorization_evidence->'authorizationReceipt'->>'delegationId'))
                )
              )
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'quickbooks_mutation_preparations'
              AND column_name = 'provider_outcome_receipt'
              AND data_type = 'jsonb'
              AND is_nullable = 'YES'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint constraint_meta
            WHERE constraint_meta.conrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND constraint_meta.conname = 'quickbooks_mutation_provider_outcome_check'
              AND constraint_meta.contype = 'c' AND constraint_meta.convalidated
          )
          AND EXISTS (
            SELECT 1 FROM pg_trigger trigger_meta
            WHERE trigger_meta.tgrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND trigger_meta.tgname = 'quickbooks_mutation_provider_outcome_immutable'
              AND NOT trigger_meta.tgisinternal AND trigger_meta.tgenabled = 'O'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'quickbooks_mutation_preparations'
              AND column_name = 'source_attestation_digest'
              AND data_type = 'text'
              AND is_nullable = 'YES'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint constraint_meta
            WHERE constraint_meta.conrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND constraint_meta.conname = 'quickbooks_mutation_source_attestation_digest_check'
              AND constraint_meta.contype = 'c'
              AND constraint_meta.convalidated
              AND pg_get_constraintdef(constraint_meta.oid) LIKE '%source_attestation_digest%'
              AND pg_get_constraintdef(constraint_meta.oid) LIKE '%^[a-f0-9]{64}$%'
              AND pg_get_constraintdef(constraint_meta.oid) LIKE '%repeat%'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint constraint_meta
            JOIN pg_index index_meta ON index_meta.indexrelid = constraint_meta.conindid
            WHERE constraint_meta.conrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND constraint_meta.contype = 'u' AND constraint_meta.convalidated
              AND pg_get_constraintdef(constraint_meta.oid) =
                'UNIQUE (actor_id, realm_id, entity, operation, client_request_id)'
              AND index_meta.indisunique AND index_meta.indisvalid AND index_meta.indisready
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint constraint_meta
            JOIN pg_index index_meta ON index_meta.indexrelid = constraint_meta.conindid
            WHERE constraint_meta.conrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND constraint_meta.contype = 'u' AND constraint_meta.convalidated
              AND pg_get_constraintdef(constraint_meta.oid) = 'UNIQUE (realm_id, provider_request_id)'
              AND index_meta.indisunique AND index_meta.indisvalid AND index_meta.indisready
          )
          AND EXISTS (
            SELECT 1 FROM pg_class index_class
            JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
            WHERE index_class.relname = 'quickbooks_mutation_actor_created_idx'
              AND index_meta.indrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND NOT index_meta.indisunique AND index_meta.indpred IS NULL
              AND index_meta.indisvalid AND index_meta.indisready
              AND pg_get_indexdef(index_class.oid) LIKE '%(actor_id, created_at DESC)'
          )
          AND EXISTS (
            SELECT 1 FROM pg_class index_class
            JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
            WHERE index_class.relname = 'quickbooks_mutation_recovery_idx'
              AND index_meta.indrelid = 'public.quickbooks_mutation_preparations'::regclass
              AND NOT index_meta.indisunique AND index_meta.indpred IS NOT NULL
              AND index_meta.indisvalid AND index_meta.indisready
              AND pg_get_indexdef(index_class.oid) LIKE '%(state, execution_lease_until)%'
              AND pg_get_expr(index_meta.indpred, index_meta.indrelid) LIKE '%EXECUTING%'
              AND pg_get_expr(index_meta.indpred, index_meta.indrelid) LIKE '%WRITE_RESULT_UNKNOWN_NO_ID%'
              AND pg_get_expr(index_meta.indpred, index_meta.indrelid) LIKE '%READBACK_MISMATCH%'
          ) AS ready`,
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  async createOrGet(input: CreateQuickBooksMutationPreparationInput) {
    const result = await this.pool.query<MutationRow>(
      `INSERT INTO quickbooks_mutation_preparations (
        preparation_id, actor_id, realm_id, connection_ref_safe, bound_target_ref_safe, binding_revision,
        entity, operation, risk, execution_mode, provider_effect, client_request_id, provider_request_id,
        target_id, sync_token, before_image, payload, payload_hash, business_reason, source_ref, source_sha256,
        source_digest_provenance, source_attestation_digest, approval_ref, confirmation_phrase_hash,
        state, created_at, expires_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,
        'PREPARED',$26,$27,$26
      )
      ON CONFLICT (actor_id, realm_id, entity, operation, client_request_id) DO NOTHING
      RETURNING *`,
      [input.preparationId, input.actorId, input.realmId, input.connectionRefSafe, input.boundTargetRefSafe,
        input.bindingRevision, input.entity, input.operation, input.risk, input.executionMode, input.providerEffect,
        input.clientRequestId, input.providerRequestId, input.targetId ?? null, input.syncToken ?? null,
        input.beforeImage ? JSON.stringify(input.beforeImage) : null, JSON.stringify(input.payload), input.payloadHash,
        input.businessReason, input.sourceRef ?? null, input.sourceSha256 ?? null,
        input.sourceDigestProvenance ?? null, input.sourceAttestationDigest ?? null, input.approvalRef ?? null,
        input.confirmationPhraseHash, input.now, input.expiresAt],
    );
    if (result.rows[0]) return { preparation: map(result.rows[0]), created: true };
    const existing = await this.pool.query<MutationRow>(
      `SELECT * FROM quickbooks_mutation_preparations
       WHERE actor_id=$1 AND realm_id=$2 AND entity=$3 AND operation=$4 AND client_request_id=$5`,
      [input.actorId, input.realmId, input.entity, input.operation, input.clientRequestId],
    );
    if (!existing.rows[0]) throw new Error("QuickBooks mutation conflict row disappeared");
    return { preparation: map(existing.rows[0]), created: false };
  }

  async get(preparationId: string) {
    const result = await this.pool.query<MutationRow>(
      "SELECT * FROM quickbooks_mutation_preparations WHERE preparation_id=$1",
      [preparationId],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }

  async recordAutonomousAuthorizationEvidence(
    input: Parameters<QuickBooksMutationRepository["recordAutonomousAuthorizationEvidence"]>[0],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await locked(client, input.preparationId);
      if (!row) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
      if (!safeEqual(row.actor_id, input.actorId)) {
        throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
      }
      if (row.autonomous_authorization_evidence) {
        await client.query("COMMIT");
        return { preparation: map(row), created: false };
      }
      if (row.state !== "PREPARED") {
        throw new AppError("CONFLICT", "QuickBooks autonomous authorization must be recorded before Provider dispatch.", {
          httpStatus: 409,
          details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_RECORD_TOO_LATE"] },
        });
      }
      if (!resolveQuickBooksAutonomousAuthorizationDelegationIdentity(input.evidence, {
        preparationId: row.preparation_id,
        providerRequestId: row.provider_request_id,
        actorId: row.actor_id,
        realmId: row.realm_id,
        preparationPayloadHash: row.payload_hash,
      })) {
        throw new AppError("CONFIGURATION_ERROR", "QuickBooks autonomous authorization evidence failed integrity verification before persistence.", {
          httpStatus: 503,
          details: { failureLayer: "AUTHORIZATION_CAUSALITY", reasonCodes: ["AUTHORIZATION_EVIDENCE_INVALID"] },
        });
      }
      const updated = await client.query<MutationRow>(
        `UPDATE quickbooks_mutation_preparations
         SET autonomous_authorization_evidence=$3::jsonb,updated_at=$4
         WHERE preparation_id=$1 AND actor_id=$2 AND state='PREPARED'
           AND autonomous_authorization_evidence IS NULL RETURNING *`,
        [input.preparationId, input.actorId, JSON.stringify(input.evidence), input.now],
      );
      if (!updated.rows[0]) throw new AppError("CONFLICT", "QuickBooks autonomous authorization evidence was not recorded.", { httpStatus: 409 });
      await client.query("COMMIT");
      return { preparation: map(updated.rows[0]), created: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async saveReviewCsrf(input: {
    csrfHash: string; sessionHash: string; actorId: string; preparationId: string; expiresAt: Date;
  }) {
    await this.pool.query(
      `INSERT INTO review_csrf_tokens(csrf_hash, session_hash, actor_id, posting_request_id, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.csrfHash, input.sessionHash, input.actorId, input.preparationId, input.expiresAt],
    );
  }

  async resealNeverDispatchedPreparation(
    input: Parameters<QuickBooksMutationRepository["resealNeverDispatchedPreparation"]>[0],
  ): Promise<QuickBooksMutationPreparation | undefined> {
    // The WHERE clause is the proof, not a convenience: every column that could
    // record contact with the Provider must still be NULL. If any is set, the
    // row is not resealable and the caller keeps the expiry error it already
    // gets. Migration 036 relaxes the 034 immutability guard for exactly this
    // shape, so a drift between the two would surface as a 23514 rather than a
    // silent write.
    const result = await this.pool.query<MutationRow>(
      `UPDATE quickbooks_mutation_preparations
         SET autonomous_authorization_evidence=NULL, expires_at=$3, updated_at=$4
       WHERE preparation_id=$1 AND actor_id=$2
         AND state='PREPARED' AND expires_at<=$4
         AND approved_by IS NULL AND approved_at IS NULL
         AND execution_attempt_id IS NULL AND dispatch_started_at IS NULL
         AND provider_entity_id IS NULL AND provider_outcome_receipt IS NULL
         AND write_receipt IS NULL AND readback IS NULL
         AND execution_resolution_receipt IS NULL
       RETURNING *`,
      [input.preparationId, input.actorId, input.expiresAt, input.now],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }

  async claimForExecution(
    input: Parameters<QuickBooksMutationRepository["claimForExecution"]>[0],
  ): Promise<QuickBooksMutationClaim> {
    const { leaseOwner, leaseTokenHash, leaseDurationMs } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await locked(client, input.preparationId);
      if (!row) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
      if (!safeEqual(row.actor_id, input.actorId)) throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
      if (row.state === "POSTED_READBACK_VERIFIED") {
        await client.query("COMMIT");
        return { preparation: map(row), shouldExecute: false, recoveryOnly: false };
      }
      if (row.state === "PROVIDER_OUTCOME_RECORDED" || row.state === "WRITE_RESULT_UNKNOWN" ||
        row.state === "READBACK_MISMATCH") {
        if (!row.provider_entity_id || !row.provider_outcome_receipt) {
          throw new AppError("WRITE_RESULT_UNKNOWN", "QuickBooks mutation has no exact Provider Id for automatic recovery; no second write is allowed.", {
            httpStatus: 503, retryable: false,
          });
        }
        await client.query("COMMIT");
        return { preparation: map(row), shouldExecute: false, recoveryOnly: true };
      }
      if (row.state === "WRITE_RESULT_UNKNOWN_NO_ID") throw unknownNoId(row);
      if (row.state === "EXECUTING" && row.execution_attempt_id && row.execution_lease_until) {
        if (row.dispatch_started_at) {
          if (row.execution_lease_until <= input.now) {
            const receipt = unknownNoIdResolutionReceipt({
              attemptId: row.execution_attempt_id,
              providerRequestId: row.provider_request_id,
              reasonCode: "STALE_AFTER_DISPATCH",
              resolvedAt: input.now,
            });
            const resolved = await client.query<MutationRow>(
              `UPDATE quickbooks_mutation_preparations
               SET state='WRITE_RESULT_UNKNOWN_NO_ID',execution_attempt_state='WRITE_RESULT_UNKNOWN_NO_ID',
                 execution_resolution_receipt=$2::jsonb,updated_at=$3
               WHERE preparation_id=$1 AND state='EXECUTING' AND dispatch_started_at IS NOT NULL
               RETURNING *`,
              [input.preparationId, JSON.stringify(receipt), input.now],
            );
            await client.query("COMMIT");
            throw unknownNoId(resolved.rows[0] as MutationRow);
          }
          throw inFlight(row);
        }
        if (row.execution_lease_until > input.now) throw inFlight(row);
        const reclaimed = await client.query<MutationRow>(
          `UPDATE quickbooks_mutation_preparations SET
             execution_claim_sequence=execution_claim_sequence+1,execution_lease_owner=$2,
             execution_lease_token_hash=$3,execution_lease_until=$4,updated_at=$5
           WHERE preparation_id=$1 AND state='EXECUTING' AND execution_attempt_state='CLAIMED'
             AND dispatch_started_at IS NULL AND execution_lease_until<=$5 RETURNING *`,
          [input.preparationId, leaseOwner, leaseTokenHash,
            new Date(input.now.getTime() + leaseDurationMs), input.now],
        );
        if (!reclaimed.rows[0]) throw inFlight(row);
        await client.query("COMMIT");
        return { preparation: map(reclaimed.rows[0]), shouldExecute: true, recoveryOnly: false };
      }
      if (row.state !== "PREPARED") throw new AppError("CONFLICT", `QuickBooks mutation cannot execute from ${row.state}.`, {
        httpStatus: 409,
        retryable: row.state === "EXECUTING",
        ...(row.state === "EXECUTING" ? {
          details: { failureLayer: "IDEMPOTENCY", reasonCodes: ["SHARED_MUTATION_IN_FLIGHT"] },
        } : {}),
      });
      if (row.expires_at <= input.now) throw new AppError("APPROVAL_INVALID", "QuickBooks mutation preparation has expired.", { httpStatus: 409 });
      if (input.confirmationPhraseHash && !safeEqual(row.confirmation_phrase_hash, input.confirmationPhraseHash)) {
        throw new AppError("APPROVAL_INVALID", "QuickBooks confirmation does not match the prepared mutation.", { httpStatus: 409 });
      }
      assertAutonomousAuthorizationClaimBinding(row, input.approvedBy);
      const updated = await client.query<MutationRow>(
        `UPDATE quickbooks_mutation_preparations SET state='EXECUTING', approved_by=$2,
         approved_at=$3,execution_attempt_id='qbea_' || md5(gen_random_uuid()::text),
         execution_attempt_state='CLAIMED',execution_claim_sequence=1,execution_lease_owner=$4,
         execution_lease_token_hash=$5,execution_lease_until=$6,execution_attempt_created_at=$3,
         updated_at=$3 WHERE preparation_id=$1 RETURNING *`,
        [input.preparationId, input.approvedBy, input.now, leaseOwner, leaseTokenHash,
          new Date(input.now.getTime() + leaseDurationMs)],
      );
      await client.query("COMMIT");
      return { preparation: map(updated.rows[0] as MutationRow), shouldExecute: true, recoveryOnly: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async claimForHumanReview(
    input: Parameters<QuickBooksMutationRepository["claimForHumanReview"]>[0],
  ): Promise<QuickBooksMutationClaim> {
    const { leaseOwner, leaseTokenHash, leaseDurationMs } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await locked(client, input.preparationId);
      if (!row) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
      if (!safeEqual(row.actor_id, input.actorId)) throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
      if (row.state !== "PREPARED" && row.state !== "POSTED_READBACK_VERIFIED") {
        throw new AppError("CONFLICT", `QuickBooks mutation cannot execute from ${row.state}.`, { httpStatus: 409 });
      }
      if (row.state === "PREPARED" && row.expires_at <= input.now) {
        throw new AppError("APPROVAL_INVALID", "QuickBooks mutation preparation has expired.", { httpStatus: 409 });
      }
      if (row.state === "PREPARED") assertAutonomousAuthorizationClaimBinding(row, input.approvedBy);
      const consumed = await client.query(
        `UPDATE review_csrf_tokens SET consumed_at=$5
         WHERE csrf_hash=$1 AND session_hash=$2 AND actor_id=$3 AND posting_request_id=$4
           AND consumed_at IS NULL AND expires_at>$5 RETURNING csrf_hash`,
        [input.csrfHash, input.sessionHash, input.actorId, input.preparationId, input.now],
      );
      if (consumed.rowCount !== 1) {
        throw new AppError("FORBIDDEN", "QuickBooks review CSRF is invalid, expired, or already used.", { httpStatus: 403 });
      }
      if (row.state === "POSTED_READBACK_VERIFIED") {
        await client.query("COMMIT");
        return { preparation: map(row), shouldExecute: false, recoveryOnly: false };
      }
      const updated = await client.query<MutationRow>(
        `UPDATE quickbooks_mutation_preparations SET state='EXECUTING', approved_by=$2,
         approved_at=$3,execution_attempt_id='qbea_' || md5(gen_random_uuid()::text),
         execution_attempt_state='CLAIMED',execution_claim_sequence=1,execution_lease_owner=$4,
         execution_lease_token_hash=$5,execution_lease_until=$6,execution_attempt_created_at=$3,
         updated_at=$3 WHERE preparation_id=$1 RETURNING *`,
        [input.preparationId, input.approvedBy, input.now, leaseOwner, leaseTokenHash,
          new Date(input.now.getTime() + leaseDurationMs)],
      );
      await client.query("COMMIT");
      return { preparation: map(updated.rows[0] as MutationRow), shouldExecute: true, recoveryOnly: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async reject(input: { preparationId: string; actorId: string; rejectedBy: string; now: Date }) {
    const result = await this.pool.query<MutationRow>(
      `UPDATE quickbooks_mutation_preparations SET state='REJECTED', rejected_by=$3,
       rejected_at=$4, updated_at=$4 WHERE preparation_id=$1 AND actor_id=$2 AND state='PREPARED' RETURNING *`,
      [input.preparationId, input.actorId, input.rejectedBy, input.now],
    );
    if (!result.rows[0]) throw new AppError("CONFLICT", "QuickBooks mutation cannot be rejected.", { httpStatus: 409 });
    return map(result.rows[0]);
  }

  async rejectFromHumanReview(input: {
    preparationId: string; actorId: string; sessionHash: string; csrfHash: string; rejectedBy: string; now: Date;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await locked(client, input.preparationId);
      if (!row) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
      if (!safeEqual(row.actor_id, input.actorId) || row.state !== "PREPARED") {
        throw new AppError("CONFLICT", "QuickBooks mutation cannot be rejected.", { httpStatus: 409 });
      }
      const consumed = await client.query(
        `UPDATE review_csrf_tokens SET consumed_at=$5
         WHERE csrf_hash=$1 AND session_hash=$2 AND actor_id=$3 AND posting_request_id=$4
           AND consumed_at IS NULL AND expires_at>$5 RETURNING csrf_hash`,
        [input.csrfHash, input.sessionHash, input.actorId, input.preparationId, input.now],
      );
      if (consumed.rowCount !== 1) throw new AppError("FORBIDDEN", "QuickBooks review CSRF is invalid, expired, or already used.", { httpStatus: 403 });
      const rejected = await client.query<MutationRow>(
        `UPDATE quickbooks_mutation_preparations SET state='REJECTED', rejected_by=$2,
         rejected_at=$3, updated_at=$3 WHERE preparation_id=$1 RETURNING *`,
        [input.preparationId, input.rejectedBy, input.now],
      );
      await client.query("COMMIT");
      return map(rejected.rows[0] as MutationRow);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async completeVerified(input: {
    preparationId: string; providerEntityId: string; receipt: Record<string, unknown>;
    readback: Record<string, unknown>; now: Date;
  }) {
    const result = await this.pool.query<MutationRow>(
      `UPDATE quickbooks_mutation_preparations SET state='POSTED_READBACK_VERIFIED',
       execution_attempt_state='READBACK_VERIFIED',provider_entity_id=$2,
       write_receipt=$3::jsonb, readback=$4::jsonb, updated_at=$5
       WHERE preparation_id=$1 AND state IN ('PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','READBACK_MISMATCH')
         AND provider_entity_id=$2 AND provider_outcome_receipt IS NOT NULL RETURNING *`,
      [input.preparationId, input.providerEntityId, JSON.stringify(input.receipt), JSON.stringify(input.readback), input.now],
    );
    if (result.rows[0]) return map(result.rows[0]);
    const existing = await this.get(input.preparationId);
    if (existing?.state === "POSTED_READBACK_VERIFIED") return existing;
    throw new AppError("CONFLICT", "QuickBooks mutation cannot complete from its current state.", { httpStatus: 409 });
  }

  async recordProviderOutcome(
    input: Parameters<QuickBooksMutationRepository["recordProviderOutcome"]>[0],
  ) {
    const result = await this.pool.query<MutationRow>(
      `UPDATE quickbooks_mutation_preparations SET state='PROVIDER_OUTCOME_RECORDED',
       execution_attempt_state='PROVIDER_OUTCOME_RECORDED',provider_entity_id=$4,
       provider_outcome_receipt=$5::jsonb,provider_outcome_recorded_at=$6,updated_at=$6
       WHERE preparation_id=$1
         AND execution_attempt_id=$2
         AND execution_lease_token_hash=$3
         AND dispatch_started_at IS NOT NULL
         AND (
           (state='EXECUTING' AND execution_attempt_state='DISPATCH_STARTED')
           OR
           (state='WRITE_RESULT_UNKNOWN_NO_ID'
             AND execution_attempt_state='WRITE_RESULT_UNKNOWN_NO_ID'
             AND execution_resolution_receipt IS NOT NULL)
         )
         AND provider_entity_id IS NULL RETURNING *`,
      [input.preparationId, input.attemptId, input.leaseTokenHash, input.providerEntityId,
        JSON.stringify(input.providerOutcomeReceipt), input.now],
    );
    if (result.rows[0]) return map(result.rows[0]);
    const existing = await this.get(input.preparationId);
    if (existing?.providerEntityId && existing.providerOutcomeReceipt &&
      safeEqual(existing.providerEntityId, input.providerEntityId) &&
      safeEqual(hashObject(existing.providerOutcomeReceipt), hashObject(input.providerOutcomeReceipt))) return existing;
    throw new AppError("CONFLICT", "QuickBooks provider outcome cannot be recorded or changed.", { httpStatus: 409 });
  }

  async markDispatchStarted(input: Parameters<QuickBooksMutationRepository["markDispatchStarted"]>[0]) {
    const result = await this.pool.query<MutationRow>(
      `UPDATE quickbooks_mutation_preparations SET
         execution_attempt_state='DISPATCH_STARTED',dispatch_started_at=$4,updated_at=$4
       WHERE preparation_id=$1 AND execution_attempt_id=$2 AND execution_lease_token_hash=$3
         AND state='EXECUTING' AND execution_attempt_state='CLAIMED'
         AND dispatch_started_at IS NULL AND execution_lease_until>$4 RETURNING *`,
      [input.preparationId, input.attemptId, input.leaseTokenHash, input.now],
    );
    if (result.rows[0]) return map(result.rows[0]);
    throw new AppError("CONFLICT", "QuickBooks execution lease cannot start Provider dispatch.", {
      httpStatus: 409,
      details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_INVALID"] },
    });
  }

  async resolveUnknownNoId(input: Parameters<QuickBooksMutationRepository["resolveUnknownNoId"]>[0]) {
    const result = await this.pool.query<MutationRow>(
      `UPDATE quickbooks_mutation_preparations SET
         state='WRITE_RESULT_UNKNOWN_NO_ID',execution_attempt_state='WRITE_RESULT_UNKNOWN_NO_ID',
         execution_resolution_receipt=$4::jsonb,updated_at=$5
       WHERE preparation_id=$1 AND execution_attempt_id=$2 AND execution_lease_token_hash=$3
         AND state='EXECUTING' AND execution_attempt_state='DISPATCH_STARTED'
         AND dispatch_started_at IS NOT NULL AND provider_entity_id IS NULL RETURNING *`,
      [input.preparationId, input.attemptId, input.leaseTokenHash,
        JSON.stringify(input.resolutionReceipt), input.now],
    );
    if (result.rows[0]) return map(result.rows[0]);
    const existing = await this.get(input.preparationId);
    if (existing?.state === "WRITE_RESULT_UNKNOWN_NO_ID") return existing;
    throw new AppError("CONFLICT", "QuickBooks execution attempt cannot be resolved as unknown without an exact Id.", {
      httpStatus: 409, details: { failureLayer: "EXECUTION_FENCING" },
    });
  }

  async releasePreDispatchLease(input: Parameters<QuickBooksMutationRepository["releasePreDispatchLease"]>[0]) {
    const result = await this.pool.query<MutationRow>(
      `UPDATE quickbooks_mutation_preparations SET execution_lease_until=$4,updated_at=$4
       WHERE preparation_id=$1 AND execution_attempt_id=$2 AND execution_lease_token_hash=$3
         AND state='EXECUTING' AND execution_attempt_state='CLAIMED'
         AND dispatch_started_at IS NULL RETURNING *`,
      [input.preparationId, input.attemptId, input.leaseTokenHash, input.now],
    );
    if (result.rows[0]) return map(result.rows[0]);
    throw new AppError("CONFLICT", "QuickBooks pre-dispatch lease cannot be released.", {
      httpStatus: 409, details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_INVALID"] },
    });
  }

  async reconcileStaleExecutionAttempts(now: Date) {
    const stale = await this.pool.query<{ stale_pre_dispatch: string; oldest_stale_at: Date | null }>(
      `SELECT count(*) FILTER (WHERE dispatch_started_at IS NULL)::text AS stale_pre_dispatch,
         min(execution_lease_until) AS oldest_stale_at
       FROM quickbooks_mutation_preparations
       WHERE state='EXECUTING' AND execution_lease_until<=$1`,
      [now],
    );
    const candidates = await this.pool.query<MutationRow>(
      `SELECT * FROM quickbooks_mutation_preparations
       WHERE state='EXECUTING' AND execution_attempt_state='DISPATCH_STARTED'
         AND dispatch_started_at IS NOT NULL AND provider_entity_id IS NULL
         AND execution_lease_until<=$1 FOR UPDATE SKIP LOCKED`,
      [now],
    );
    let transitionedToUnknownNoId = 0;
    for (const row of candidates.rows) {
      const receipt = unknownNoIdResolutionReceipt({
        attemptId: row.execution_attempt_id as string,
        providerRequestId: row.provider_request_id,
        reasonCode: "STALE_AFTER_DISPATCH",
        resolvedAt: now,
      });
      const result = await this.pool.query(
        `UPDATE quickbooks_mutation_preparations SET
           state='WRITE_RESULT_UNKNOWN_NO_ID',execution_attempt_state='WRITE_RESULT_UNKNOWN_NO_ID',
           execution_resolution_receipt=$2::jsonb,updated_at=$3
         WHERE preparation_id=$1 AND state='EXECUTING' AND execution_attempt_state='DISPATCH_STARTED'
           AND provider_entity_id IS NULL RETURNING preparation_id`,
        [row.preparation_id, JSON.stringify(receipt), now],
      );
      transitionedToUnknownNoId += result.rowCount ?? 0;
    }
    const oldestStaleAt = stale.rows[0]?.oldest_stale_at ?? undefined;
    return {
      stalePreDispatchReclaimable: Number(stale.rows[0]?.stale_pre_dispatch ?? 0),
      transitionedToUnknownNoId,
      ...(oldestStaleAt ? { oldestStaleAt } : {}),
    };
  }

  async markFailure(input: Parameters<QuickBooksMutationRepository["markFailure"]>[0]) {
    const result = await this.pool.query(
      `UPDATE quickbooks_mutation_preparations SET state=$2,
         execution_attempt_state=CASE WHEN $2='BLOCKED_VALIDATION' THEN 'RESOLVED_NO_WRITE'
           ELSE 'PROVIDER_OUTCOME_RECORDED' END,
         execution_resolution_receipt=CASE WHEN $2='BLOCKED_VALIDATION' THEN $4::jsonb
           ELSE execution_resolution_receipt END,
         updated_at=$3
       WHERE preparation_id=$1 AND execution_attempt_id=$5 AND execution_lease_token_hash=$6
         AND state <> 'POSTED_READBACK_VERIFIED'
         AND ($2<>'BLOCKED_VALIDATION' OR dispatch_started_at IS NULL OR $7::boolean)
         AND ($7::boolean IS NOT TRUE OR provider_entity_id IS NULL)`,
      [input.preparationId, input.state, input.now,
        JSON.stringify(input.resolutionReceipt ?? resolvedNoWriteReceipt({
          attemptId: input.attemptId,
          providerRequestId: input.providerRequestId,
          reasonCode: "DEFINITIVE_PRE_DISPATCH_FAILURE",
          resolvedAt: input.now,
        })), input.attemptId, input.leaseTokenHash,
        input.providerConfirmedNotWritten === true],
    );
    if (result.rowCount === 1) return;
    const existing = await this.get(input.preparationId);
    if (!existing || existing.state === "POSTED_READBACK_VERIFIED") return;
    throw new AppError("CONFLICT", "QuickBooks execution failure cannot cross the durable attempt fence.", {
      httpStatus: 409,
      details: { failureLayer: "EXECUTION_FENCING", reasonCodes: ["EXECUTION_LEASE_INVALID"] },
    });
  }
}

function inFlight(row: MutationRow): AppError {
  return new AppError("CONFLICT", "QuickBooks mutation is owned by an active execution lease.", {
    httpStatus: 409,
    retryable: true,
    details: {
      failureLayer: "EXECUTION_FENCING",
      reasonCodes: ["EXECUTION_LEASE_ACTIVE"],
      providerMutationPossible: row.dispatch_started_at !== null,
    },
  });
}

function unknownNoId(row: MutationRow): AppError {
  return new AppError(
    "WRITE_RESULT_UNKNOWN_NO_ID",
    "QuickBooks Provider dispatch may have occurred without a durable exact Provider Id; operator resolution is required and automatic re-arm is forbidden.",
    {
      httpStatus: 503,
      retryable: false,
      details: {
        failureLayer: "PROVIDER_OUTCOME",
        attemptId: row.execution_attempt_id,
        providerRequestId: row.provider_request_id,
        providerMutationPossible: true,
        automaticRearmAllowed: false,
        operatorResolutionRequired: true,
        recoveryAction: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
      },
    },
  );
}
