CREATE TABLE IF NOT EXISTS quickbooks_posting_requests (
  posting_request_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  realm_id TEXT NOT NULL CHECK (realm_id ~ '^[0-9]{3,32}$'),
  client_request_id TEXT NOT NULL,
  provider_request_id TEXT NOT NULL CHECK (char_length(provider_request_id) BETWEEN 1 AND 50),
  source_ref TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN (
    'PREPARED',
    'POSTING',
    'WRITE_RESULT_UNKNOWN',
    'POSTED_READBACK_VERIFIED',
    'READBACK_MISMATCH',
    'BLOCKED_VALIDATION',
    'REJECTED'
  )),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejected_by TEXT,
  rejected_at TIMESTAMPTZ,
  qbo_bill_id TEXT,
  write_receipt JSONB,
  readback JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (actor_id, realm_id, client_request_id),
  UNIQUE (realm_id, provider_request_id)
);

CREATE INDEX IF NOT EXISTS quickbooks_posting_actor_created_idx
  ON quickbooks_posting_requests (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quickbooks_posting_recovery_idx
  ON quickbooks_posting_requests (state, updated_at)
  WHERE state IN ('POSTING', 'WRITE_RESULT_UNKNOWN');
