import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AppError } from "../errors.js";
import type { QuickBooksBillSnapshot } from "../providers/quickbooksTypes.js";
import { safeEqual } from "../security/hash.js";
import type {
  CreateQuickBooksPostingInput,
  QuickBooksPostClaim,
  QuickBooksPostingRequest,
  QuickBooksPostingState,
} from "./models.js";
import type { QuickBooksPostingRepository } from "./repository.js";

interface PostingRow extends QueryResultRow {
  posting_request_id: string;
  actor_id: string;
  realm_id: string;
  client_request_id: string;
  provider_request_id: string;
  source_ref: string;
  source_sha256: string;
  payload: QuickBooksPostingRequest["payload"];
  payload_hash: string;
  state: QuickBooksPostingState;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  qbo_bill_id: string | null;
  write_receipt: Record<string, unknown> | null;
  readback: QuickBooksBillSnapshot | null;
  created_at: Date;
  updated_at: Date;
}

function mapPosting(row: PostingRow): QuickBooksPostingRequest {
  return {
    postingRequestId: row.posting_request_id,
    actorId: row.actor_id,
    realmId: row.realm_id,
    clientRequestId: row.client_request_id,
    providerRequestId: row.provider_request_id,
    sourceRef: row.source_ref,
    sourceSha256: row.source_sha256,
    payload: row.payload,
    payloadHash: row.payload_hash,
    state: row.state,
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    ...(row.rejected_by ? { rejectedBy: row.rejected_by } : {}),
    ...(row.rejected_at ? { rejectedAt: row.rejected_at } : {}),
    ...(row.qbo_bill_id ? { qboBillId: row.qbo_bill_id } : {}),
    ...(row.write_receipt ? { writeReceipt: row.write_receipt } : {}),
    ...(row.readback ? { readback: row.readback } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function selectForUpdate(client: PoolClient, postingRequestId: string): Promise<PostingRow | undefined> {
  const result = await client.query<PostingRow>(
    "SELECT * FROM quickbooks_posting_requests WHERE posting_request_id = $1 FOR UPDATE",
    [postingRequestId],
  );
  return result.rows[0];
}

export class QuickBooksPostgresPostingRepository implements QuickBooksPostingRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createOrGet(input: CreateQuickBooksPostingInput): Promise<{
    posting: QuickBooksPostingRequest;
    created: boolean;
  }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<PostingRow>(
        `INSERT INTO quickbooks_posting_requests (
          posting_request_id, actor_id, realm_id, client_request_id, provider_request_id,
          source_ref, source_sha256, payload, payload_hash, state, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'PREPARED', $10, $10)
        ON CONFLICT DO NOTHING
        RETURNING *`,
        [
          input.postingRequestId,
          input.actorId,
          input.realmId,
          input.payload.clientRequestId,
          input.providerRequestId,
          input.payload.sourceRef,
          input.payload.sourceSha256,
          JSON.stringify(input.payload),
          input.payloadHash,
          input.now,
        ],
      );
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return { posting: mapPosting(inserted.rows[0]), created: true };
      }
      const existing = await client.query<PostingRow>(
        `SELECT * FROM quickbooks_posting_requests
         WHERE realm_id = $2 AND (
           (actor_id = $1 AND client_request_id = $3) OR (
             state IN ('PREPARED','POSTING','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED') AND (
               source_sha256 = $4 OR (
                 $6::text IS NOT NULL AND payload->>'vendorId' = $5
                 AND lower(btrim(payload->>'docNumber')) = lower(btrim($6::text))
               )
             )
           )
         )
         ORDER BY (client_request_id = $3) DESC, created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [input.actorId, input.realmId, input.payload.clientRequestId, input.payload.sourceSha256,
          input.payload.vendorId, input.payload.docNumber ?? null],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("QuickBooks posting conflict row disappeared");
      await client.query("COMMIT");
      return { posting: mapPosting(row), created: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findActiveDuplicate(input: {
    actorId: string;
    realmId: string;
    sourceSha256: string;
    vendorId: string;
    docNumber?: string;
  }): Promise<QuickBooksPostingRequest | undefined> {
    const result = await this.#pool.query<PostingRow>(
      `SELECT * FROM quickbooks_posting_requests
       WHERE realm_id = $1
         AND state IN ('PREPARED','POSTING','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED')
         AND (
           source_sha256 = $2 OR (
             $4::text IS NOT NULL AND payload->>'vendorId' = $3
             AND lower(btrim(payload->>'docNumber')) = lower(btrim($4::text))
           )
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.realmId, input.sourceSha256, input.vendorId, input.docNumber ?? null],
    );
    return result.rows[0] ? mapPosting(result.rows[0]) : undefined;
  }

  async get(postingRequestId: string): Promise<QuickBooksPostingRequest | undefined> {
    const result = await this.#pool.query<PostingRow>(
      "SELECT * FROM quickbooks_posting_requests WHERE posting_request_id = $1",
      [postingRequestId],
    );
    return result.rows[0] ? mapPosting(result.rows[0]) : undefined;
  }

  async claimForApprovedPost(input: {
    postingRequestId: string;
    actorId: string;
    approvedPayloadHash: string;
    approvedBy: string;
    now: Date;
  }): Promise<QuickBooksPostClaim> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const row = await selectForUpdate(client, input.postingRequestId);
      if (!row) throw new AppError("NOT_FOUND", "QuickBooks posting request was not found.", { httpStatus: 404 });
      if (!safeEqual(row.actor_id, input.actorId)) {
        throw new AppError("FORBIDDEN", "QuickBooks posting belongs to another actor.", { httpStatus: 403 });
      }
      if (!safeEqual(row.payload_hash, input.approvedPayloadHash)) {
        throw new AppError("APPROVAL_INVALID", "Approved QuickBooks payload hash does not match the prepared bill.", {
          httpStatus: 409,
        });
      }
      if (row.state === "POSTED_READBACK_VERIFIED") {
        await client.query("COMMIT");
        return { posting: mapPosting(row), shouldPost: false };
      }
      if (row.state === "POSTING") {
        throw new AppError("CONFLICT", "QuickBooks posting is already in progress.", {
          httpStatus: 409,
          retryable: true,
        });
      }
      if (!["PREPARED", "WRITE_RESULT_UNKNOWN"].includes(row.state)) {
        throw new AppError("APPROVAL_INVALID", `QuickBooks posting cannot be approved from ${row.state}.`, {
          httpStatus: 409,
        });
      }
      const updated = await client.query<PostingRow>(
        `UPDATE quickbooks_posting_requests
         SET state = 'POSTING', approved_by = $2, approved_at = COALESCE(approved_at, $3), updated_at = $3
         WHERE posting_request_id = $1
         RETURNING *`,
        [input.postingRequestId, input.approvedBy, input.now],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error("QuickBooks posting claim update failed");
      await client.query("COMMIT");
      return { posting: mapPosting(updatedRow), shouldPost: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reject(input: {
    postingRequestId: string;
    actorId: string;
    rejectedBy: string;
    now: Date;
  }): Promise<QuickBooksPostingRequest> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const row = await selectForUpdate(client, input.postingRequestId);
      if (!row) throw new AppError("NOT_FOUND", "QuickBooks posting request was not found.", { httpStatus: 404 });
      if (!safeEqual(row.actor_id, input.actorId)) {
        throw new AppError("FORBIDDEN", "QuickBooks posting belongs to another actor.", { httpStatus: 403 });
      }
      if (row.state === "REJECTED") {
        await client.query("COMMIT");
        return mapPosting(row);
      }
      if (row.state !== "PREPARED") {
        throw new AppError("CONFLICT", `QuickBooks posting cannot be rejected from ${row.state}.`, { httpStatus: 409 });
      }
      const updated = await client.query<PostingRow>(
        `UPDATE quickbooks_posting_requests
         SET state = 'REJECTED', rejected_by = $2, rejected_at = $3, updated_at = $3
         WHERE posting_request_id = $1
         RETURNING *`,
        [input.postingRequestId, input.rejectedBy, input.now],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error("QuickBooks posting reject update failed");
      await client.query("COMMIT");
      return mapPosting(updatedRow);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeVerified(input: {
    postingRequestId: string;
    bill: QuickBooksBillSnapshot;
    receipt: Record<string, unknown>;
    now: Date;
  }): Promise<QuickBooksPostingRequest> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const row = await selectForUpdate(client, input.postingRequestId);
      if (!row) throw new AppError("NOT_FOUND", "QuickBooks posting request was not found.", { httpStatus: 404 });
      if (row.state === "POSTED_READBACK_VERIFIED") {
        await client.query("COMMIT");
        return mapPosting(row);
      }
      if (row.state !== "POSTING") {
        throw new AppError("CONFLICT", `QuickBooks posting cannot complete from ${row.state}.`, { httpStatus: 409 });
      }
      const updated = await client.query<PostingRow>(
        `UPDATE quickbooks_posting_requests
         SET state = 'POSTED_READBACK_VERIFIED', qbo_bill_id = $2,
             write_receipt = $3::jsonb, readback = $4::jsonb, updated_at = $5
         WHERE posting_request_id = $1
         RETURNING *`,
        [
          input.postingRequestId,
          input.bill.billId,
          JSON.stringify(input.receipt),
          JSON.stringify(input.bill),
          input.now,
        ],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error("QuickBooks posting completion update failed");
      await client.query("COMMIT");
      return mapPosting(updatedRow);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markFailure(
    postingRequestId: string,
    state: Extract<QuickBooksPostingState, "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION">,
    now: Date,
  ): Promise<void> {
    await this.#pool.query(
      `UPDATE quickbooks_posting_requests
       SET state = $2, updated_at = $3
       WHERE posting_request_id = $1 AND state <> 'POSTED_READBACK_VERIFIED'`,
      [postingRequestId, state, now],
    );
  }
}
