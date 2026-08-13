import type { Pool } from "pg";
import { AppError } from "../errors.js";
import type {
  QuickBooksAuditCompletion,
  QuickBooksAuditIntent,
  QuickBooksControlRepository,
} from "./controlRepository.js";

export class QuickBooksPostgresControlRepository implements QuickBooksControlRepository {
  constructor(private readonly pool: Pool) {}

  async readiness(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(`SELECT
        to_regclass('public.quickbooks_oauth_states') IS NOT NULL
        AND to_regclass('public.quickbooks_connect_tickets') IS NOT NULL
        AND to_regclass('public.quickbooks_operator_sessions') IS NOT NULL
        AND to_regclass('public.quickbooks_review_csrf_tokens') IS NOT NULL
        AND to_regclass('public.quickbooks_tool_audit_logs') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE version='028_quickbooks_control_plane.sql'
        ) AS ready`);
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  async saveOAuthState(stateHash: string, browserSessionHash: string, actorId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO quickbooks_oauth_states(state_hash,browser_session_hash,actor_id,expires_at)
       VALUES($1,$2,$3,$4) ON CONFLICT(state_hash) DO NOTHING`,
      [stateHash, browserSessionHash, actorId, expiresAt],
    );
  }

  async consumeOAuthState(stateHash: string, browserSessionHash: string, now: Date) {
    const result = await this.pool.query<{ actor_id: string }>(
      `UPDATE quickbooks_oauth_states SET consumed_at=$3
       WHERE state_hash=$1 AND browser_session_hash=$2 AND consumed_at IS NULL AND expires_at>$3
       RETURNING actor_id`,
      [stateHash, browserSessionHash, now],
    );
    return result.rows[0] ? { actorId: result.rows[0].actor_id } : undefined;
  }

  async saveConnectTicket(ticketHash: string, actorId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO quickbooks_connect_tickets(ticket_hash,actor_id,expires_at)
       VALUES($1,$2,$3) ON CONFLICT(ticket_hash) DO NOTHING`,
      [ticketHash, actorId, expiresAt],
    );
  }

  async consumeConnectTicket(ticketHash: string, now: Date) {
    const result = await this.pool.query<{ actor_id: string }>(
      `UPDATE quickbooks_connect_tickets SET consumed_at=$2
       WHERE ticket_hash=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING actor_id`,
      [ticketHash, now],
    );
    return result.rows[0] ? { actorId: result.rows[0].actor_id } : undefined;
  }

  async saveOperatorSession(sessionHash: string, actorId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO quickbooks_operator_sessions(session_hash,actor_id,expires_at)
       VALUES($1,$2,$3) ON CONFLICT(session_hash) DO NOTHING`,
      [sessionHash, actorId, expiresAt],
    );
  }

  async getOperatorSession(sessionHash: string, now: Date) {
    const result = await this.pool.query<{ actor_id: string }>(
      `SELECT actor_id FROM quickbooks_operator_sessions WHERE session_hash=$1 AND expires_at>$2`,
      [sessionHash, now],
    );
    return result.rows[0] ? { actorId: result.rows[0].actor_id } : undefined;
  }

  async revokeOperatorSessions(actorId: string): Promise<number> {
    const result = await this.pool.query("DELETE FROM quickbooks_operator_sessions WHERE actor_id=$1", [actorId]);
    return result.rowCount ?? 0;
  }

  async saveReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO quickbooks_review_csrf_tokens(
        csrf_hash,session_hash,actor_id,posting_request_id,expires_at
      ) VALUES($1,$2,$3,$4,$5)`,
      [csrfHash, sessionHash, actorId, postingRequestId, expiresAt],
    );
  }

  async consumeReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE quickbooks_review_csrf_tokens SET consumed_at=$5
       WHERE csrf_hash=$1 AND session_hash=$2 AND actor_id=$3 AND posting_request_id=$4
         AND consumed_at IS NULL AND expires_at>$5 RETURNING csrf_hash`,
      [csrfHash, sessionHash, actorId, postingRequestId, now],
    );
    return result.rowCount === 1;
  }

  async beginAudit(intent: QuickBooksAuditIntent): Promise<void> {
    await this.pool.query(
      `INSERT INTO quickbooks_tool_audit_logs(
        call_id,actor_id,tenant_id,tool_name,request_hash,result_status,started_at,finished_at
      ) VALUES($1,$2,$3,$4,$5,'IN_PROGRESS',$6,NULL)`,
      [intent.callId, intent.actorId, intent.tenantId ?? null, intent.toolName, intent.requestHash, intent.startedAt],
    );
  }

  async completeAudit(callId: string, completion: QuickBooksAuditCompletion): Promise<void> {
    const result = await this.pool.query(
      `UPDATE quickbooks_tool_audit_logs SET
        result_status=$2,provider_request_id=$3,record_id=$4,error_class=$5,finished_at=$6
       WHERE call_id=$1 AND result_status='IN_PROGRESS' RETURNING call_id`,
      [callId, completion.resultStatus, completion.providerRequestId ?? null, completion.recordId ?? null,
        completion.errorClass ?? null, completion.finishedAt],
    );
    if (result.rowCount === 1) return;
    const existing = await this.pool.query("SELECT result_status FROM quickbooks_tool_audit_logs WHERE call_id=$1", [callId]);
    if (existing.rowCount === 0) throw new AppError("NOT_FOUND", "QuickBooks audit intent was not found.", { httpStatus: 404 });
    throw new AppError("CONFLICT", "QuickBooks audit intent is already complete.", { httpStatus: 409 });
  }
}
