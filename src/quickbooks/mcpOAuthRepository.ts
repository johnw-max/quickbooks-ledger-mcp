import type { Pool, QueryResultRow } from "pg";

export type QuickBooksMcpOAuthFlowStatus =
  | "AUTHORIZING_QUICKBOOKS"
  | "EXCHANGING_QUICKBOOKS"
  | "COMPLETED"
  | "DENIED"
  | "FAILED";

export interface QuickBooksMcpOAuthFlow {
  flowId: string;
  browserSessionHash: string;
  qboStateHash: string;
  clientId: string;
  redirectUri: string;
  outerStateCiphertext: string;
  pkceCodeChallenge?: string;
  requestedScopes: string[];
  actorId: string;
  status: QuickBooksMcpOAuthFlowStatus;
  authorizationCodeHash?: string;
  authorizationCodeExpiresAt?: Date;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuickBooksMcpOAuthToken {
  tokenId: string;
  actorId: string;
  clientId: string;
  grantedScopes: string[];
  accessTokenHash: string;
  accessTokenExpiresAt: Date;
  refreshTokenHash: string;
  refreshTokenExpiresAt: Date;
  refreshVersion: number;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuickBooksMcpOAuthRepository {
  createFlow(flow: QuickBooksMcpOAuthFlow): Promise<void>;
  claimCallback(input: {
    flowId: string;
    browserSessionHash: string;
    qboStateHash: string;
    now: Date;
  }): Promise<QuickBooksMcpOAuthFlow | undefined>;
  completeFlow(input: {
    flowId: string;
    browserSessionHash: string;
    authorizationCodeHash: string;
    authorizationCodeExpiresAt: Date;
    now: Date;
  }): Promise<QuickBooksMcpOAuthFlow | undefined>;
  terminateFlow(input: {
    flowId: string;
    browserSessionHash: string;
    status: "DENIED" | "FAILED";
    now: Date;
  }): Promise<QuickBooksMcpOAuthFlow | undefined>;
  peekAuthorizationCode(input: {
    authorizationCodeHash: string;
    clientId: string;
    redirectUri: string;
    now: Date;
  }): Promise<QuickBooksMcpOAuthFlow | undefined>;
  consumeAuthorizationCode(input: {
    flowId: string;
    authorizationCodeHash: string;
    now: Date;
  }): Promise<boolean>;
  createToken(token: QuickBooksMcpOAuthToken): Promise<void>;
  getAccessToken(accessTokenHash: string, now: Date): Promise<QuickBooksMcpOAuthToken | undefined>;
  actorHasScope(actorId: string, scope: string, now: Date): Promise<boolean>;
  rotateOrCoalesceRefreshToken(input: {
    refreshTokenHash: string;
    clientId: string;
    accessTokenHash: string;
    accessTokenExpiresAt: Date;
    nextRefreshTokenHash: string;
    refreshTokenExpiresAt: Date;
    retryResponseCiphertext: string;
    retryExpiresAt: Date;
    now: Date;
  }): Promise<
    | { kind: "rotated"; token: QuickBooksMcpOAuthToken }
    | {
      kind: "coalesced";
      responseCiphertext: string;
      sourceRefreshTokenHash: string;
      grantedScopes: string[];
    }
    | undefined
  >;
  revokeRefreshFamilyOnReplay(input: {
    refreshTokenHash: string;
    clientId: string;
    now: Date;
  }): Promise<{ actorId: string } | undefined>;
  revokeToken(input: {
    accessTokenHash: string;
    refreshTokenHash: string;
    clientId: string;
    now: Date;
  }): Promise<{ revoked: boolean; actorId?: string }>;
}

function cloneFlow(flow: QuickBooksMcpOAuthFlow): QuickBooksMcpOAuthFlow {
  return structuredClone(flow);
}

function cloneToken(token: QuickBooksMcpOAuthToken): QuickBooksMcpOAuthToken {
  return structuredClone(token);
}

export class InMemoryQuickBooksMcpOAuthRepository implements QuickBooksMcpOAuthRepository {
  readonly #flows = new Map<string, QuickBooksMcpOAuthFlow>();
  readonly #tokens = new Map<string, QuickBooksMcpOAuthToken>();
  readonly #accessHistory = new Map<string, { tokenId: string; expiresAt: Date }>();
  readonly #refreshHistory = new Map<string, {
    tokenId: string;
    clientId: string;
    actorId: string;
    consumedAt: Date;
    successorAccessTokenHash: string;
    successorRefreshTokenHash: string;
    successorRefreshVersion: number;
    retryResponseCiphertext: string | undefined;
    retryExpiresAt: Date;
  }>();

  async createFlow(flow: QuickBooksMcpOAuthFlow): Promise<void> {
    this.#flows.set(flow.flowId, cloneFlow(flow));
  }

  async claimCallback(input: {
    flowId: string;
    browserSessionHash: string;
    qboStateHash: string;
    now: Date;
  }): Promise<QuickBooksMcpOAuthFlow | undefined> {
    const flow = this.#flows.get(input.flowId);
    if (
      !flow ||
      flow.status !== "AUTHORIZING_QUICKBOOKS" ||
      flow.browserSessionHash !== input.browserSessionHash ||
      flow.qboStateHash !== input.qboStateHash ||
      flow.expiresAt <= input.now
    ) return undefined;
    flow.status = "EXCHANGING_QUICKBOOKS";
    flow.updatedAt = input.now;
    return cloneFlow(flow);
  }

  async completeFlow(input: {
    flowId: string;
    browserSessionHash: string;
    authorizationCodeHash: string;
    authorizationCodeExpiresAt: Date;
    now: Date;
  }): Promise<QuickBooksMcpOAuthFlow | undefined> {
    const flow = this.#flows.get(input.flowId);
    if (!flow || flow.status !== "EXCHANGING_QUICKBOOKS" || flow.browserSessionHash !== input.browserSessionHash) {
      return undefined;
    }
    flow.status = "COMPLETED";
    flow.authorizationCodeHash = input.authorizationCodeHash;
    flow.authorizationCodeExpiresAt = input.authorizationCodeExpiresAt;
    flow.updatedAt = input.now;
    return cloneFlow(flow);
  }

  async terminateFlow(input: {
    flowId: string;
    browserSessionHash: string;
    status: "DENIED" | "FAILED";
    now: Date;
  }): Promise<QuickBooksMcpOAuthFlow | undefined> {
    const flow = this.#flows.get(input.flowId);
    if (!flow || flow.browserSessionHash !== input.browserSessionHash || flow.status !== "EXCHANGING_QUICKBOOKS") {
      return undefined;
    }
    flow.status = input.status;
    flow.updatedAt = input.now;
    return cloneFlow(flow);
  }

  async peekAuthorizationCode(input: {
    authorizationCodeHash: string;
    clientId: string;
    redirectUri: string;
    now: Date;
  }): Promise<QuickBooksMcpOAuthFlow | undefined> {
    const flow = [...this.#flows.values()].find((candidate) =>
      candidate.authorizationCodeHash === input.authorizationCodeHash &&
      candidate.clientId === input.clientId &&
      candidate.redirectUri === input.redirectUri &&
      candidate.status === "COMPLETED" &&
      candidate.consumedAt === undefined &&
      candidate.authorizationCodeExpiresAt !== undefined &&
      candidate.authorizationCodeExpiresAt > input.now
    );
    return flow ? cloneFlow(flow) : undefined;
  }

  async consumeAuthorizationCode(input: {
    flowId: string;
    authorizationCodeHash: string;
    now: Date;
  }): Promise<boolean> {
    const flow = this.#flows.get(input.flowId);
    if (
      !flow || flow.status !== "COMPLETED" || flow.consumedAt !== undefined ||
      flow.authorizationCodeHash !== input.authorizationCodeHash ||
      !flow.authorizationCodeExpiresAt || flow.authorizationCodeExpiresAt <= input.now
    ) return false;
    flow.consumedAt = input.now;
    flow.updatedAt = input.now;
    return true;
  }

  async createToken(token: QuickBooksMcpOAuthToken): Promise<void> {
    this.#tokens.set(token.tokenId, cloneToken(token));
  }

  async getAccessToken(accessTokenHash: string, now: Date): Promise<QuickBooksMcpOAuthToken | undefined> {
    const token = [...this.#tokens.values()].find((candidate) =>
      candidate.accessTokenHash === accessTokenHash && !candidate.revokedAt && candidate.accessTokenExpiresAt > now
    );
    if (token) return cloneToken(token);
    const historical = this.#accessHistory.get(accessTokenHash);
    if (!historical || historical.expiresAt <= now) return undefined;
    const family = this.#tokens.get(historical.tokenId);
    return family && !family.revokedAt ? cloneToken(family) : undefined;
  }

  async actorHasScope(actorId: string, scope: string, now: Date): Promise<boolean> {
    return [...this.#tokens.values()].some((token) =>
      token.actorId === actorId && !token.revokedAt && token.refreshTokenExpiresAt > now &&
      token.grantedScopes.includes(scope));
  }

  async rotateOrCoalesceRefreshToken(input: {
    refreshTokenHash: string;
    clientId: string;
    accessTokenHash: string;
    accessTokenExpiresAt: Date;
    nextRefreshTokenHash: string;
    refreshTokenExpiresAt: Date;
    retryResponseCiphertext: string;
    retryExpiresAt: Date;
    now: Date;
  }): Promise<
    | { kind: "rotated"; token: QuickBooksMcpOAuthToken }
    | {
      kind: "coalesced";
      responseCiphertext: string;
      sourceRefreshTokenHash: string;
      grantedScopes: string[];
    }
    | undefined
  > {
    const token = [...this.#tokens.values()].find((candidate) =>
      candidate.clientId === input.clientId && !candidate.revokedAt && candidate.refreshTokenExpiresAt > input.now && (
        candidate.refreshTokenHash === input.refreshTokenHash ||
        [...this.#refreshHistory.entries()].some(([sourceHash, history]) =>
          sourceHash === input.refreshTokenHash && history.tokenId === candidate.tokenId &&
          history.successorAccessTokenHash === candidate.accessTokenHash &&
          history.successorRefreshTokenHash === candidate.refreshTokenHash &&
          history.successorRefreshVersion === candidate.refreshVersion
        )
      )
    );
    if (!token) return undefined;
    const activeRetry = [...this.#refreshHistory.entries()].find(([sourceHash, history]) =>
      history.tokenId === token.tokenId && history.successorAccessTokenHash === token.accessTokenHash &&
      history.successorRefreshTokenHash === token.refreshTokenHash &&
      history.successorRefreshVersion === token.refreshVersion && history.retryExpiresAt > input.now &&
      typeof history.retryResponseCiphertext === "string" && (
        sourceHash === input.refreshTokenHash || token.refreshTokenHash === input.refreshTokenHash
      )
    );
    if (activeRetry) {
      const [sourceRefreshTokenHash, history] = activeRetry;
      return {
        kind: "coalesced",
        responseCiphertext: history.retryResponseCiphertext as string,
        sourceRefreshTokenHash,
        grantedScopes: [...token.grantedScopes],
      };
    }
    if (token.refreshTokenHash !== input.refreshTokenHash) return undefined;
    for (const history of this.#refreshHistory.values()) {
      if (history.tokenId === token.tokenId && history.retryExpiresAt <= input.now) {
        history.retryResponseCiphertext = undefined;
      }
    }
    this.#accessHistory.set(token.accessTokenHash, {
      tokenId: token.tokenId,
      expiresAt: token.accessTokenExpiresAt,
    });
    this.#refreshHistory.set(input.refreshTokenHash, {
      tokenId: token.tokenId,
      clientId: token.clientId,
      actorId: token.actorId,
      consumedAt: input.now,
      successorAccessTokenHash: input.accessTokenHash,
      successorRefreshTokenHash: input.nextRefreshTokenHash,
      successorRefreshVersion: token.refreshVersion + 1,
      retryResponseCiphertext: input.retryResponseCiphertext,
      retryExpiresAt: input.retryExpiresAt,
    });
    token.accessTokenHash = input.accessTokenHash;
    token.accessTokenExpiresAt = input.accessTokenExpiresAt;
    token.refreshTokenHash = input.nextRefreshTokenHash;
    token.refreshTokenExpiresAt = input.refreshTokenExpiresAt;
    token.refreshVersion += 1;
    token.updatedAt = input.now;
    return { kind: "rotated", token: cloneToken(token) };
  }

  async revokeRefreshFamilyOnReplay(input: {
    refreshTokenHash: string;
    clientId: string;
    now: Date;
  }): Promise<{ actorId: string } | undefined> {
    const used = this.#refreshHistory.get(input.refreshTokenHash);
    if (!used || used.clientId !== input.clientId) return undefined;
    const token = this.#tokens.get(used.tokenId);
    if (!token) return undefined;
    token.revokedAt = token.revokedAt ?? input.now;
    token.updatedAt = input.now;
    return { actorId: used.actorId };
  }

  async revokeToken(input: {
    accessTokenHash: string;
    refreshTokenHash: string;
    clientId: string;
    now: Date;
  }): Promise<{ revoked: boolean; actorId?: string }> {
    const token = [...this.#tokens.values()].find((candidate) => candidate.clientId === input.clientId && (
      candidate.accessTokenHash === input.accessTokenHash || candidate.refreshTokenHash === input.refreshTokenHash
    )) ?? (() => {
      const historical = this.#accessHistory.get(input.accessTokenHash);
      if (!historical) return undefined;
      const family = this.#tokens.get(historical.tokenId);
      return family?.clientId === input.clientId ? family : undefined;
    })();
    if (!token) return { revoked: false };
    token.revokedAt = token.revokedAt ?? input.now;
    token.updatedAt = input.now;
    return { revoked: true, actorId: token.actorId };
  }
}

interface FlowRow extends QueryResultRow {
  flow_id: string;
  browser_session_hash: string;
  qbo_state_hash: string;
  oauth_client_id: string;
  redirect_uri: string;
  outer_state_ciphertext: string;
  pkce_code_challenge: string | null;
  requested_scopes: string[];
  actor_id: string;
  flow_status: QuickBooksMcpOAuthFlowStatus;
  authorization_code_hash: string | null;
  authorization_code_expires_at: Date | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface TokenRow extends QueryResultRow {
  token_id: string;
  actor_id: string;
  oauth_client_id: string;
  granted_scopes: string[];
  access_token_hash: string;
  access_token_expires_at: Date;
  refresh_token_hash: string;
  refresh_token_expires_at: Date;
  refresh_version: number;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapFlow(row: FlowRow): QuickBooksMcpOAuthFlow {
  return {
    flowId: row.flow_id,
    browserSessionHash: row.browser_session_hash,
    qboStateHash: row.qbo_state_hash,
    clientId: row.oauth_client_id,
    redirectUri: row.redirect_uri,
    outerStateCiphertext: row.outer_state_ciphertext,
    ...(row.pkce_code_challenge ? { pkceCodeChallenge: row.pkce_code_challenge } : {}),
    requestedScopes: row.requested_scopes,
    actorId: row.actor_id,
    status: row.flow_status,
    ...(row.authorization_code_hash ? { authorizationCodeHash: row.authorization_code_hash } : {}),
    ...(row.authorization_code_expires_at ? { authorizationCodeExpiresAt: row.authorization_code_expires_at } : {}),
    expiresAt: row.expires_at,
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToken(row: TokenRow): QuickBooksMcpOAuthToken {
  return {
    tokenId: row.token_id,
    actorId: row.actor_id,
    clientId: row.oauth_client_id,
    grantedScopes: row.granted_scopes,
    accessTokenHash: row.access_token_hash,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenHash: row.refresh_token_hash,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    refreshVersion: row.refresh_version,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class QuickBooksPostgresMcpOAuthRepository implements QuickBooksMcpOAuthRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createFlow(flow: QuickBooksMcpOAuthFlow): Promise<void> {
    await this.#pool.query(
      `INSERT INTO quickbooks_mcp_oauth_flows (
        flow_id, browser_session_hash, qbo_state_hash, oauth_client_id, redirect_uri,
        outer_state_ciphertext, pkce_code_challenge, requested_scopes, actor_id, flow_status,
        expires_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [flow.flowId, flow.browserSessionHash, flow.qboStateHash, flow.clientId, flow.redirectUri,
        flow.outerStateCiphertext, flow.pkceCodeChallenge ?? null, flow.requestedScopes, flow.actorId,
        flow.status, flow.expiresAt, flow.createdAt, flow.updatedAt],
    );
  }

  async claimCallback(input: { flowId: string; browserSessionHash: string; qboStateHash: string; now: Date }): Promise<QuickBooksMcpOAuthFlow | undefined> {
    const result = await this.#pool.query<FlowRow>(
      `UPDATE quickbooks_mcp_oauth_flows SET flow_status='EXCHANGING_QUICKBOOKS', updated_at=$4
       WHERE flow_id=$1 AND browser_session_hash=$2 AND qbo_state_hash=$3
         AND flow_status='AUTHORIZING_QUICKBOOKS' AND expires_at>$4
       RETURNING *`,
      [input.flowId, input.browserSessionHash, input.qboStateHash, input.now],
    );
    return result.rows[0] ? mapFlow(result.rows[0]) : undefined;
  }

  async completeFlow(input: { flowId: string; browserSessionHash: string; authorizationCodeHash: string; authorizationCodeExpiresAt: Date; now: Date }): Promise<QuickBooksMcpOAuthFlow | undefined> {
    const result = await this.#pool.query<FlowRow>(
      `UPDATE quickbooks_mcp_oauth_flows
       SET flow_status='COMPLETED', authorization_code_hash=$3, authorization_code_expires_at=$4, updated_at=$5
       WHERE flow_id=$1 AND browser_session_hash=$2 AND flow_status='EXCHANGING_QUICKBOOKS'
       RETURNING *`,
      [input.flowId, input.browserSessionHash, input.authorizationCodeHash, input.authorizationCodeExpiresAt, input.now],
    );
    return result.rows[0] ? mapFlow(result.rows[0]) : undefined;
  }

  async terminateFlow(input: { flowId: string; browserSessionHash: string; status: "DENIED" | "FAILED"; now: Date }): Promise<QuickBooksMcpOAuthFlow | undefined> {
    const result = await this.#pool.query<FlowRow>(
      `UPDATE quickbooks_mcp_oauth_flows SET flow_status=$3, updated_at=$4
       WHERE flow_id=$1 AND browser_session_hash=$2 AND flow_status='EXCHANGING_QUICKBOOKS'
       RETURNING *`,
      [input.flowId, input.browserSessionHash, input.status, input.now],
    );
    return result.rows[0] ? mapFlow(result.rows[0]) : undefined;
  }

  async peekAuthorizationCode(input: { authorizationCodeHash: string; clientId: string; redirectUri: string; now: Date }): Promise<QuickBooksMcpOAuthFlow | undefined> {
    const result = await this.#pool.query<FlowRow>(
      `SELECT * FROM quickbooks_mcp_oauth_flows
       WHERE authorization_code_hash=$1 AND oauth_client_id=$2 AND redirect_uri=$3
         AND flow_status='COMPLETED' AND consumed_at IS NULL AND authorization_code_expires_at>$4`,
      [input.authorizationCodeHash, input.clientId, input.redirectUri, input.now],
    );
    return result.rows[0] ? mapFlow(result.rows[0]) : undefined;
  }

  async consumeAuthorizationCode(input: { flowId: string; authorizationCodeHash: string; now: Date }): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE quickbooks_mcp_oauth_flows SET consumed_at=$3, updated_at=$3
       WHERE flow_id=$1 AND authorization_code_hash=$2 AND flow_status='COMPLETED'
         AND consumed_at IS NULL AND authorization_code_expires_at>$3`,
      [input.flowId, input.authorizationCodeHash, input.now],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async createToken(token: QuickBooksMcpOAuthToken): Promise<void> {
    await this.#pool.query(
      `INSERT INTO quickbooks_mcp_oauth_tokens (
        token_id, actor_id, oauth_client_id, granted_scopes, access_token_hash,
        access_token_expires_at, refresh_token_hash, refresh_token_expires_at,
        refresh_version, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [token.tokenId, token.actorId, token.clientId, token.grantedScopes, token.accessTokenHash,
        token.accessTokenExpiresAt, token.refreshTokenHash, token.refreshTokenExpiresAt,
        token.refreshVersion, token.createdAt, token.updatedAt],
    );
  }

  async getAccessToken(accessTokenHash: string, now: Date): Promise<QuickBooksMcpOAuthToken | undefined> {
    const result = await this.#pool.query<TokenRow>(
      `SELECT * FROM quickbooks_mcp_oauth_tokens
       WHERE access_token_hash=$1 AND revoked_at IS NULL AND access_token_expires_at>$2`,
      [accessTokenHash, now],
    );
    if (result.rows[0]) return mapToken(result.rows[0]);
    const historical = await this.#pool.query<TokenRow>(
      `SELECT tokens.*
       FROM quickbooks_mcp_oauth_access_history history
       JOIN quickbooks_mcp_oauth_tokens tokens ON tokens.token_id=history.token_id
       WHERE history.access_token_hash=$1 AND history.expires_at>$2 AND tokens.revoked_at IS NULL`,
      [accessTokenHash, now],
    );
    return historical.rows[0] ? mapToken(historical.rows[0]) : undefined;
  }

  async actorHasScope(actorId: string, scope: string, now: Date): Promise<boolean> {
    const result = await this.#pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM quickbooks_mcp_oauth_tokens
         WHERE actor_id=$1 AND revoked_at IS NULL AND refresh_token_expires_at>$3
           AND $2 = ANY(granted_scopes)
       ) AS allowed`,
      [actorId, scope, now],
    );
    return result.rows[0]?.allowed === true;
  }

  async rotateOrCoalesceRefreshToken(input: {
    refreshTokenHash: string; clientId: string; accessTokenHash: string; accessTokenExpiresAt: Date;
    nextRefreshTokenHash: string; refreshTokenExpiresAt: Date;
    retryResponseCiphertext: string; retryExpiresAt: Date; now: Date;
  }): Promise<
    | { kind: "rotated"; token: QuickBooksMcpOAuthToken }
    | {
      kind: "coalesced";
      responseCiphertext: string;
      sourceRefreshTokenHash: string;
      grantedScopes: string[];
    }
    | undefined
  > {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<TokenRow>(
        `SELECT * FROM quickbooks_mcp_oauth_tokens
         WHERE oauth_client_id=$2 AND revoked_at IS NULL AND refresh_token_expires_at>$3
           AND (
             refresh_token_hash=$1 OR EXISTS (
               SELECT 1 FROM quickbooks_mcp_oauth_refresh_history history
               WHERE history.token_id=quickbooks_mcp_oauth_tokens.token_id
                 AND history.refresh_token_hash=$1
                 AND history.successor_access_token_hash=quickbooks_mcp_oauth_tokens.access_token_hash
                 AND history.successor_refresh_token_hash=quickbooks_mcp_oauth_tokens.refresh_token_hash
                 AND history.successor_refresh_version=quickbooks_mcp_oauth_tokens.refresh_version
             )
           )
         FOR UPDATE`,
        [input.refreshTokenHash, input.clientId, input.now],
      );
      const current = selected.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        `UPDATE quickbooks_mcp_oauth_refresh_history
         SET retry_response_ciphertext=NULL
         WHERE token_id=$2 AND retry_response_ciphertext IS NOT NULL AND retry_expires_at<=$1`,
        [input.now, current.token_id],
      );
      const retry = await client.query<{
        refresh_token_hash: string;
        retry_response_ciphertext: string;
      }>(
        `SELECT history.refresh_token_hash, history.retry_response_ciphertext
         FROM quickbooks_mcp_oauth_refresh_history history
         WHERE history.token_id=$1
           AND history.successor_access_token_hash=$2
           AND history.successor_refresh_token_hash=$3
           AND history.successor_refresh_version=$4
           AND history.retry_expires_at>$5
           AND history.retry_response_ciphertext IS NOT NULL
           AND (history.refresh_token_hash=$6 OR $3=$6)
         ORDER BY history.consumed_at DESC
         LIMIT 1`,
        [current.token_id, current.access_token_hash, current.refresh_token_hash,
          current.refresh_version, input.now, input.refreshTokenHash],
      );
      const retryRow = retry.rows[0];
      if (retryRow) {
        await client.query("COMMIT");
        return {
          kind: "coalesced",
          responseCiphertext: retryRow.retry_response_ciphertext,
          sourceRefreshTokenHash: retryRow.refresh_token_hash,
          grantedScopes: current.granted_scopes,
        };
      }
      if (current.refresh_token_hash !== input.refreshTokenHash) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        `INSERT INTO quickbooks_mcp_oauth_access_history(
           access_token_hash, token_id, expires_at, issued_at, retired_at
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (access_token_hash) DO NOTHING`,
        [current.access_token_hash, current.token_id, current.access_token_expires_at,
          current.updated_at, input.now],
      );
      await client.query(
        `INSERT INTO quickbooks_mcp_oauth_refresh_history(
           refresh_token_hash, token_id, oauth_client_id, actor_id, consumed_at,
           successor_access_token_hash, successor_refresh_token_hash, successor_refresh_version,
           retry_response_ciphertext, retry_expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [input.refreshTokenHash, current.token_id, current.oauth_client_id, current.actor_id, input.now,
          input.accessTokenHash, input.nextRefreshTokenHash, current.refresh_version + 1,
          input.retryResponseCiphertext, input.retryExpiresAt],
      );
      const result = await client.query<TokenRow>(
        `UPDATE quickbooks_mcp_oauth_tokens
         SET access_token_hash=$2, access_token_expires_at=$3, refresh_token_hash=$4,
             refresh_token_expires_at=$5, refresh_version=refresh_version+1, updated_at=$6
         WHERE token_id=$1
         RETURNING *`,
        [current.token_id, input.accessTokenHash, input.accessTokenExpiresAt,
          input.nextRefreshTokenHash, input.refreshTokenExpiresAt, input.now],
      );
      await client.query("COMMIT");
      return result.rows[0] ? { kind: "rotated", token: mapToken(result.rows[0]) } : undefined;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeRefreshFamilyOnReplay(input: {
    refreshTokenHash: string; clientId: string; now: Date;
  }): Promise<{ actorId: string } | undefined> {
    const result = await this.#pool.query<{ actor_id: string }>(
      `UPDATE quickbooks_mcp_oauth_tokens tokens
       SET revoked_at=COALESCE(tokens.revoked_at,$3), updated_at=$3
       FROM quickbooks_mcp_oauth_refresh_history history
       WHERE history.refresh_token_hash=$1 AND history.oauth_client_id=$2
         AND tokens.token_id=history.token_id
       RETURNING tokens.actor_id`,
      [input.refreshTokenHash, input.clientId, input.now],
    );
    return result.rows[0] ? { actorId: result.rows[0].actor_id } : undefined;
  }

  async revokeToken(input: {
    accessTokenHash: string; refreshTokenHash: string; clientId: string; now: Date;
  }): Promise<{ revoked: boolean; actorId?: string }> {
    const result = await this.#pool.query<{ actor_id: string }>(
      `UPDATE quickbooks_mcp_oauth_tokens
       SET revoked_at=COALESCE(revoked_at,$4), updated_at=$4
       WHERE oauth_client_id=$3 AND (
         access_token_hash=$1 OR refresh_token_hash=$2 OR EXISTS (
           SELECT 1 FROM quickbooks_mcp_oauth_access_history history
           WHERE history.token_id=quickbooks_mcp_oauth_tokens.token_id
             AND history.access_token_hash=$1
         )
       )
       RETURNING actor_id`,
      [input.accessTokenHash, input.refreshTokenHash, input.clientId, input.now],
    );
    const row = result.rows[0];
    return row ? { revoked: true, actorId: row.actor_id } : { revoked: false };
  }
}
