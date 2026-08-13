CREATE TABLE IF NOT EXISTS quickbooks_mcp_oauth_refresh_history (
  refresh_token_hash text PRIMARY KEY,
  token_id text NOT NULL REFERENCES quickbooks_mcp_oauth_tokens(token_id) ON DELETE CASCADE,
  oauth_client_id text NOT NULL,
  actor_id text NOT NULL,
  consumed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS quickbooks_mcp_oauth_refresh_history_token_idx
  ON quickbooks_mcp_oauth_refresh_history (token_id, consumed_at);
