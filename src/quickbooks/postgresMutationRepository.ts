import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AppError } from "../errors.js";
import { safeEqual } from "../security/hash.js";
import type {
  CreateQuickBooksMutationPreparationInput,
  QuickBooksMutationClaim,
  QuickBooksMutationPreparation,
  QuickBooksMutationState,
} from "./mutationModels.js";
import type { QuickBooksMutationRepository } from "./mutationRepository.js";

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
              AND pg_get_indexdef(index_class.oid) LIKE '%(state, updated_at)%'
              AND pg_get_expr(index_meta.indpred, index_meta.indrelid) =
                '(state = ANY (ARRAY[''EXECUTING''::text, ''WRITE_RESULT_UNKNOWN''::text]))'
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

  async saveReviewCsrf(input: {
    csrfHash: string; sessionHash: string; actorId: string; preparationId: string; expiresAt: Date;
  }) {
    await this.pool.query(
      `INSERT INTO review_csrf_tokens(csrf_hash, session_hash, actor_id, posting_request_id, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.csrfHash, input.sessionHash, input.actorId, input.preparationId, input.expiresAt],
    );
  }

  async claimForExecution(input: {
    preparationId: string; actorId: string; requestId: string; confirmationPhraseHash?: string;
    approvedBy: string; now: Date;
  }): Promise<QuickBooksMutationClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await locked(client, input.preparationId);
      if (!row) throw new AppError("NOT_FOUND", "QuickBooks mutation preparation was not found.", { httpStatus: 404 });
      if (!safeEqual(row.actor_id, input.actorId)) throw new AppError("FORBIDDEN", "QuickBooks mutation belongs to another actor.", { httpStatus: 403 });
      if (row.state === "POSTED_READBACK_VERIFIED") {
        await client.query("COMMIT");
        return { preparation: map(row), shouldExecute: false };
      }
      if (row.state !== "PREPARED") throw new AppError("CONFLICT", `QuickBooks mutation cannot execute from ${row.state}.`, { httpStatus: 409 });
      if (row.expires_at <= input.now) throw new AppError("APPROVAL_INVALID", "QuickBooks mutation preparation has expired.", { httpStatus: 409 });
      if (input.confirmationPhraseHash && !safeEqual(row.confirmation_phrase_hash, input.confirmationPhraseHash)) {
        throw new AppError("APPROVAL_INVALID", "QuickBooks confirmation does not match the prepared mutation.", { httpStatus: 409 });
      }
      const updated = await client.query<MutationRow>(
        `UPDATE quickbooks_mutation_preparations SET state='EXECUTING', approved_by=$2,
         approved_at=$3, updated_at=$3 WHERE preparation_id=$1 RETURNING *`,
        [input.preparationId, input.approvedBy, input.now],
      );
      await client.query("COMMIT");
      return { preparation: map(updated.rows[0] as MutationRow), shouldExecute: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async claimForHumanReview(input: {
    preparationId: string; actorId: string; sessionHash: string; csrfHash: string; approvedBy: string; now: Date;
  }): Promise<QuickBooksMutationClaim> {
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
        return { preparation: map(row), shouldExecute: false };
      }
      const updated = await client.query<MutationRow>(
        `UPDATE quickbooks_mutation_preparations SET state='EXECUTING', approved_by=$2,
         approved_at=$3, updated_at=$3 WHERE preparation_id=$1 RETURNING *`,
        [input.preparationId, input.approvedBy, input.now],
      );
      await client.query("COMMIT");
      return { preparation: map(updated.rows[0] as MutationRow), shouldExecute: true };
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
       provider_entity_id=$2, write_receipt=$3::jsonb, readback=$4::jsonb, updated_at=$5
       WHERE preparation_id=$1 AND state='EXECUTING' RETURNING *`,
      [input.preparationId, input.providerEntityId, JSON.stringify(input.receipt), JSON.stringify(input.readback), input.now],
    );
    if (result.rows[0]) return map(result.rows[0]);
    const existing = await this.get(input.preparationId);
    if (existing?.state === "POSTED_READBACK_VERIFIED") return existing;
    throw new AppError("CONFLICT", "QuickBooks mutation cannot complete from its current state.", { httpStatus: 409 });
  }

  async markFailure(
    preparationId: string,
    state: Extract<QuickBooksMutationState, "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION">,
    now: Date,
  ) {
    await this.pool.query(
      `UPDATE quickbooks_mutation_preparations SET state=$2, updated_at=$3
       WHERE preparation_id=$1 AND state <> 'POSTED_READBACK_VERIFIED'`,
      [preparationId, state, now],
    );
  }
}
