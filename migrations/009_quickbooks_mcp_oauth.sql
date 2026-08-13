-- Per-installation OAuth facade for MCP hosts such as Agent2. Intuit OAuth
-- credentials stay in quickbooks_connections; opaque MCP tokens only select
-- the server-side actor binding and never expose Intuit tokens to the host.

CREATE TABLE IF NOT EXISTS quickbooks_mcp_oauth_flows (
  flow_id text PRIMARY KEY,
  browser_session_hash text NOT NULL,
  qbo_state_hash text NOT NULL UNIQUE,
  oauth_client_id text NOT NULL,
  redirect_uri text NOT NULL,
  outer_state_ciphertext text NOT NULL,
  pkce_code_challenge text,
  requested_scopes text[] NOT NULL DEFAULT '{}',
  actor_id text NOT NULL UNIQUE,
  flow_status text NOT NULL CHECK (
    flow_status IN ('AUTHORIZING_QUICKBOOKS', 'EXCHANGING_QUICKBOOKS', 'COMPLETED', 'DENIED', 'FAILED')
  ),
  authorization_code_hash text UNIQUE,
  authorization_code_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (
    (flow_status = 'COMPLETED' AND authorization_code_hash IS NOT NULL AND authorization_code_expires_at IS NOT NULL)
    OR flow_status <> 'COMPLETED'
  )
);

CREATE INDEX IF NOT EXISTS quickbooks_mcp_oauth_flows_status_expiry_idx
  ON quickbooks_mcp_oauth_flows (flow_status, expires_at);

CREATE TABLE IF NOT EXISTS quickbooks_mcp_oauth_tokens (
  token_id text PRIMARY KEY,
  actor_id text NOT NULL,
  oauth_client_id text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  access_token_hash text NOT NULL UNIQUE,
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_hash text NOT NULL UNIQUE,
  refresh_token_expires_at timestamptz NOT NULL,
  refresh_version integer NOT NULL DEFAULT 0 CHECK (refresh_version >= 0),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quickbooks_mcp_oauth_tokens_actor_idx
ON quickbooks_mcp_oauth_tokens (actor_id, revoked_at);
