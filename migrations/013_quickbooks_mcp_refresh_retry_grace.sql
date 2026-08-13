ALTER TABLE quickbooks_mcp_oauth_refresh_history
  ADD COLUMN IF NOT EXISTS retry_response_ciphertext text,
  ADD COLUMN IF NOT EXISTS retry_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS successor_access_token_hash text,
  ADD COLUMN IF NOT EXISTS successor_refresh_token_hash text,
  ADD COLUMN IF NOT EXISTS successor_refresh_version integer;

CREATE INDEX IF NOT EXISTS quickbooks_mcp_oauth_refresh_history_retry_idx
  ON quickbooks_mcp_oauth_refresh_history (oauth_client_id, retry_expires_at);

CREATE TABLE IF NOT EXISTS quickbooks_mcp_oauth_access_history (
  access_token_hash text PRIMARY KEY,
  token_id text NOT NULL REFERENCES quickbooks_mcp_oauth_tokens(token_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL,
  retired_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS quickbooks_mcp_oauth_access_history_token_idx
  ON quickbooks_mcp_oauth_access_history (token_id, expires_at);
