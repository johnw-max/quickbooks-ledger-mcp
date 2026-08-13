import type { Pool, QueryResultRow } from "pg";

export type QuickBooksConnectionState = "ACTIVE" | "TOKEN_REFRESH_FAILED" | "REVOKED";

export interface QuickBooksConnection {
  connectionId: string;
  actorId: string;
  realmId: string;
  companyName: string;
  grantedScopes: string[];
  tokenCiphertext: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  refreshVersion: number;
  status: QuickBooksConnectionState;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuickBooksConnectionRepository {
  listActive(actorId: string): Promise<QuickBooksConnection[]>;
  get(actorId: string, realmId: string): Promise<QuickBooksConnection | undefined>;
  replaceActive(connection: QuickBooksConnection): Promise<QuickBooksConnection>;
  updateRotatedToken(input: {
    connectionId: string;
    expectedRefreshVersion: number;
    tokenCiphertext: string;
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt: Date;
    now: Date;
  }): Promise<QuickBooksConnection | undefined>;
  markStatusIfVersion(input: {
    connectionId: string;
    expectedRefreshVersion: number;
    status: QuickBooksConnectionState;
    now: Date;
  }): Promise<boolean>;
}

export class InMemoryQuickBooksConnectionRepository implements QuickBooksConnectionRepository {
  readonly #connections = new Map<string, QuickBooksConnection>();

  async listActive(actorId: string): Promise<QuickBooksConnection[]> {
    return [...this.#connections.values()]
      .filter((connection) => connection.actorId === actorId && connection.status === "ACTIVE")
      .map((connection) => structuredClone(connection));
  }

  async get(actorId: string, realmId: string): Promise<QuickBooksConnection | undefined> {
    const connection = [...this.#connections.values()]
      .find((candidate) => candidate.actorId === actorId && candidate.realmId === realmId);
    return connection ? structuredClone(connection) : undefined;
  }

  async replaceActive(connection: QuickBooksConnection): Promise<QuickBooksConnection> {
    const existing = await this.get(connection.actorId, connection.realmId);
    const saved = {
      ...structuredClone(connection),
      ...(existing ? { connectionId: existing.connectionId, createdAt: existing.createdAt } : {}),
    };
    this.#connections.set(saved.connectionId, saved);
    for (const candidate of this.#connections.values()) {
      if (
        candidate.actorId === saved.actorId &&
        candidate.connectionId !== saved.connectionId &&
        candidate.status === "ACTIVE"
      ) {
        candidate.status = "REVOKED";
        candidate.updatedAt = saved.updatedAt;
      }
    }
    return structuredClone(saved);
  }

  async updateRotatedToken(input: {
    connectionId: string;
    expectedRefreshVersion: number;
    tokenCiphertext: string;
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt: Date;
    now: Date;
  }): Promise<QuickBooksConnection | undefined> {
    const connection = this.#connections.get(input.connectionId);
    if (!connection || connection.status !== "ACTIVE" || connection.refreshVersion !== input.expectedRefreshVersion) {
      return undefined;
    }
    connection.tokenCiphertext = input.tokenCiphertext;
    connection.accessTokenExpiresAt = input.accessTokenExpiresAt;
    connection.refreshTokenExpiresAt = input.refreshTokenExpiresAt;
    connection.refreshVersion += 1;
    connection.updatedAt = input.now;
    return structuredClone(connection);
  }

  async markStatusIfVersion(input: {
    connectionId: string;
    expectedRefreshVersion: number;
    status: QuickBooksConnectionState;
    now: Date;
  }): Promise<boolean> {
    const connection = this.#connections.get(input.connectionId);
    if (!connection || connection.refreshVersion !== input.expectedRefreshVersion) return false;
    connection.status = input.status;
    connection.updatedAt = input.now;
    return true;
  }
}

interface ConnectionRow extends QueryResultRow {
  connection_id: string;
  actor_id: string;
  realm_id: string;
  company_name: string;
  granted_scopes: string[];
  token_ciphertext: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
  refresh_version: number;
  status: QuickBooksConnectionState;
  created_at: Date;
  updated_at: Date;
}

function mapConnection(row: ConnectionRow): QuickBooksConnection {
  return {
    connectionId: row.connection_id,
    actorId: row.actor_id,
    realmId: row.realm_id,
    companyName: row.company_name,
    grantedScopes: row.granted_scopes,
    tokenCiphertext: row.token_ciphertext,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    refreshVersion: row.refresh_version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class QuickBooksPostgresConnectionRepository implements QuickBooksConnectionRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async listActive(actorId: string): Promise<QuickBooksConnection[]> {
    const result = await this.#pool.query<ConnectionRow>(
      "SELECT * FROM quickbooks_connections WHERE actor_id = $1 AND status = 'ACTIVE' ORDER BY created_at",
      [actorId],
    );
    return result.rows.map(mapConnection);
  }

  async get(actorId: string, realmId: string): Promise<QuickBooksConnection | undefined> {
    const result = await this.#pool.query<ConnectionRow>(
      "SELECT * FROM quickbooks_connections WHERE actor_id = $1 AND realm_id = $2",
      [actorId, realmId],
    );
    return result.rows[0] ? mapConnection(result.rows[0]) : undefined;
  }

  async replaceActive(connection: QuickBooksConnection): Promise<QuickBooksConnection> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [connection.actorId]);
      const result = await client.query<ConnectionRow>(
        `INSERT INTO quickbooks_connections (
          connection_id, actor_id, realm_id, company_name, granted_scopes, token_ciphertext,
          access_token_expires_at, refresh_token_expires_at, refresh_version, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (actor_id, realm_id) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          granted_scopes = EXCLUDED.granted_scopes,
          token_ciphertext = EXCLUDED.token_ciphertext,
          access_token_expires_at = EXCLUDED.access_token_expires_at,
          refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
          refresh_version = quickbooks_connections.refresh_version + 1,
          status = 'ACTIVE',
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
        [
          connection.connectionId,
          connection.actorId,
          connection.realmId,
          connection.companyName,
          connection.grantedScopes,
          connection.tokenCiphertext,
          connection.accessTokenExpiresAt,
          connection.refreshTokenExpiresAt,
          connection.refreshVersion,
          connection.status,
          connection.createdAt,
          connection.updatedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("QuickBooks connection replacement returned no row");
      await client.query(
        `UPDATE quickbooks_connections
         SET status = 'REVOKED', updated_at = $3
         WHERE actor_id = $1 AND connection_id <> $2 AND status = 'ACTIVE'`,
        [row.actor_id, row.connection_id, connection.updatedAt],
      );
      await client.query("COMMIT");
      return mapConnection(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateRotatedToken(input: {
    connectionId: string;
    expectedRefreshVersion: number;
    tokenCiphertext: string;
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt: Date;
    now: Date;
  }): Promise<QuickBooksConnection | undefined> {
    const result = await this.#pool.query<ConnectionRow>(
      `UPDATE quickbooks_connections
       SET token_ciphertext = $3, access_token_expires_at = $4, refresh_token_expires_at = $5,
           refresh_version = refresh_version + 1, updated_at = $6
       WHERE connection_id = $1 AND refresh_version = $2 AND status = 'ACTIVE'
       RETURNING *`,
      [
        input.connectionId,
        input.expectedRefreshVersion,
        input.tokenCiphertext,
        input.accessTokenExpiresAt,
        input.refreshTokenExpiresAt,
        input.now,
      ],
    );
    return result.rows[0] ? mapConnection(result.rows[0]) : undefined;
  }

  async markStatusIfVersion(input: {
    connectionId: string;
    expectedRefreshVersion: number;
    status: QuickBooksConnectionState;
    now: Date;
  }): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE quickbooks_connections SET status = $3, updated_at = $4
       WHERE connection_id = $1 AND refresh_version = $2`,
      [input.connectionId, input.expectedRefreshVersion, input.status, input.now],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
