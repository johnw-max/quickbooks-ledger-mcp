CREATE TABLE IF NOT EXISTS quickbooks_connections (
  connection_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  realm_id TEXT NOT NULL CHECK (realm_id ~ '^[0-9]{3,32}$'),
  company_name TEXT NOT NULL,
  granted_scopes TEXT[] NOT NULL,
  token_ciphertext TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_version INTEGER NOT NULL DEFAULT 0 CHECK (refresh_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'TOKEN_REFRESH_FAILED', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (actor_id, realm_id)
);

CREATE INDEX IF NOT EXISTS quickbooks_connection_actor_status_idx
ON quickbooks_connections (actor_id, status);
