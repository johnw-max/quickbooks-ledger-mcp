CREATE TABLE IF NOT EXISTS quickbooks_oauth_states (
  state_hash text PRIMARY KEY,
  browser_session_hash text NOT NULL,
  actor_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quickbooks_oauth_states_expiry_idx ON quickbooks_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS quickbooks_connect_tickets (
  ticket_hash text PRIMARY KEY,
  actor_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quickbooks_connect_tickets_expiry_idx ON quickbooks_connect_tickets(expires_at);

CREATE TABLE IF NOT EXISTS quickbooks_operator_sessions (
  session_hash text PRIMARY KEY,
  actor_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quickbooks_operator_sessions_expiry_idx ON quickbooks_operator_sessions(expires_at);

CREATE TABLE IF NOT EXISTS quickbooks_review_csrf_tokens (
  csrf_hash text PRIMARY KEY,
  session_hash text NOT NULL REFERENCES quickbooks_operator_sessions(session_hash) ON DELETE CASCADE,
  actor_id text NOT NULL,
  posting_request_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quickbooks_review_csrf_expiry_idx ON quickbooks_review_csrf_tokens(expires_at);

CREATE TABLE IF NOT EXISTS quickbooks_tool_audit_logs (
  call_id text PRIMARY KEY,
  actor_id text NOT NULL,
  tenant_id text,
  tool_name text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_status text NOT NULL CHECK (result_status IN ('IN_PROGRESS','SUCCEEDED','REJECTED','FAILED')),
  provider_request_id text,
  record_id text,
  error_class text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK (
    (result_status='IN_PROGRESS' AND finished_at IS NULL)
    OR (result_status<>'IN_PROGRESS' AND finished_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS quickbooks_tool_audit_actor_time_idx ON quickbooks_tool_audit_logs(actor_id,started_at DESC);
CREATE INDEX IF NOT EXISTS quickbooks_tool_audit_record_idx ON quickbooks_tool_audit_logs(record_id,started_at DESC);

CREATE OR REPLACE FUNCTION quickbooks_reject_audit_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.result_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'terminal QuickBooks audit rows are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quickbooks_tool_audit_terminal_immutable ON quickbooks_tool_audit_logs;
CREATE TRIGGER quickbooks_tool_audit_terminal_immutable
BEFORE UPDATE ON quickbooks_tool_audit_logs
FOR EACH ROW EXECUTE FUNCTION quickbooks_reject_audit_rewrite();
