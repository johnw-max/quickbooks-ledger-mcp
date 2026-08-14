import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { buildQuickBooksAuthorizationUrl, exchangeQuickBooksAuthorizationCode } from "../providers/quickbooksOAuth.js";
import type { QuickBooksOAuthConfig } from "../providers/quickbooksTypes.js";
import { QUICKBOOKS_ACCOUNTING_SCOPE } from "../providers/quickbooksTypes.js";
import { safeEqual, sha256 } from "../security/hash.js";
import type { TokenCipher } from "../security/tokenCipher.js";
import type { ResolvedMcpAccessToken } from "../security/requestContext.js";
import type { QuickBooksClientManager } from "./clientManager.js";
import type { QuickBooksMcpOAuthHostClientConfig } from "./config.js";
import { QuickBooksMcpOAuthHostClientRegistry } from "./mcpOAuthHostClientRegistry.js";
import type {
  QuickBooksMcpOAuthFlow,
  QuickBooksMcpOAuthRepository,
  QuickBooksMcpOAuthToken,
} from "./mcpOAuthRepository.js";

export const QUICKBOOKS_MCP_OAUTH_SCOPES = [
  "quickbooks.read",
  "quickbooks.bill.prepare",
  "quickbooks.bill.execute",
  "quickbooks.mutation.prepare",
  "quickbooks.mutation.execute",
] as const;
export const QUICKBOOKS_MCP_REFRESH_RETRY_GRACE_MS = 10_000;

export interface QuickBooksMcpOAuthConfig {
  resourceUri: string;
  hostClients: readonly QuickBooksMcpOAuthHostClientConfig[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

export interface QuickBooksMcpTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function secret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function hashSecret(purpose: string, value: string): string {
  return sha256(`quickbooks-mcp-oauth:${purpose}:${value}`);
}

function exactString(value: string | undefined, maxLength = 2_048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function redirectResult(redirectUri: string, state: string, result: { code?: string; error?: string }): string {
  const target = new URL(redirectUri);
  if (result.code) target.searchParams.set("code", result.code);
  if (result.error) target.searchParams.set("error", result.error);
  target.searchParams.set("state", state);
  return target.href;
}

export class QuickBooksMcpOAuthService {
  readonly #repository: QuickBooksMcpOAuthRepository;
  readonly #manager: QuickBooksClientManager;
  readonly #qbo: QuickBooksOAuthConfig & { request?: typeof fetch };
  readonly #config: Omit<QuickBooksMcpOAuthConfig, "hostClients">;
  readonly #hostClients: QuickBooksMcpOAuthHostClientRegistry;
  readonly #cipher: TokenCipher;
  readonly #clock: () => Date;
  readonly #onActorSecurityRevoked: ((actorId: string) => Promise<void>) | undefined;

  constructor(options: {
    repository: QuickBooksMcpOAuthRepository;
    manager: QuickBooksClientManager;
    qbo: QuickBooksOAuthConfig & { request?: typeof fetch };
    config: QuickBooksMcpOAuthConfig;
    cipher: TokenCipher;
    clock?: () => Date;
    onActorSecurityRevoked?: (actorId: string) => Promise<void>;
  }) {
    this.#repository = options.repository;
    this.#manager = options.manager;
    this.#qbo = options.qbo;
    const hostClients = new QuickBooksMcpOAuthHostClientRegistry(options.config.hostClients);
    this.#config = Object.freeze({
      resourceUri: options.config.resourceUri,
      accessTokenTtlSeconds: options.config.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: options.config.refreshTokenTtlSeconds,
    });
    this.#hostClients = hostClients;
    this.#cipher = options.cipher;
    this.#clock = options.clock ?? (() => new Date());
    this.#onActorSecurityRevoked = options.onActorSecurityRevoked;
  }

  get registeredHostClientCount(): number {
    return this.#hostClients.size;
  }

  authenticateClient(clientId: string | undefined, clientSecret: string | undefined): boolean {
    if (!exactString(clientId, 256) || !exactString(clientSecret, 512)) return false;
    return this.#hostClients.authenticate(clientId, clientSecret);
  }

  isOriginAllowedForClient(clientId: string, origin: string): boolean {
    if (!exactString(clientId, 256) || !exactString(origin)) return false;
    return this.#hostClients.isOriginAllowed(clientId, origin);
  }

  async startAuthorization(input: {
    clientId?: string;
    redirectUri?: string;
    responseType?: string;
    state?: string;
    scope?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  }): Promise<{ consentUrl: string; browserCookie: string; expiresAt: Date }> {
    if (!exactString(input.clientId, 256)) {
      throw new AppError("AUTH_REQUIRED", "Unknown MCP OAuth client.", { httpStatus: 401 });
    }
    if (!this.#hostClients.hasClient(input.clientId)) {
      throw new AppError("AUTH_REQUIRED", "Unknown MCP OAuth client.", { httpStatus: 401 });
    }
    if (!exactString(input.redirectUri) || !this.#hostClients.hasExactRedirect(input.clientId, input.redirectUri)) {
      throw new AppError("VALIDATION_FAILED", "MCP OAuth redirect URI is not registered.", { httpStatus: 400 });
    }
    if (input.responseType !== "code" || !exactString(input.state)) {
      throw new AppError("VALIDATION_FAILED", "MCP OAuth requires response_type=code and a bounded state.", { httpStatus: 400 });
    }
    let codeChallenge: string | undefined;
    if (input.codeChallenge !== undefined || input.codeChallengeMethod !== undefined) {
      if (input.codeChallengeMethod !== "S256" || !input.codeChallenge || !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)) {
        throw new AppError("VALIDATION_FAILED", "MCP OAuth PKCE must use a valid S256 challenge.", { httpStatus: 400 });
      }
      codeChallenge = input.codeChallenge;
    }
    const requestedScopes = this.#parseScopes(input.scope);
    const now = this.#clock();
    const flowId = `qbf_${randomUUID()}`;
    // The Broker can prove only this consent/install, not a Host human or
    // workspace identity. Keep the install isolated and label it
    // INSTALLATION_ONLY when the access token is resolved.
    const workspaceId = `qbo-client-${sha256(input.clientId).slice(0, 20)}`;
    const subjectId = randomUUID();
    const actorId = `${workspaceId}:user:${subjectId}`;
    const browserSecret = randomBytes(32).toString("base64url");
    const qboState = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    const flow: QuickBooksMcpOAuthFlow = {
      flowId,
      browserSessionHash: hashSecret("browser", browserSecret),
      qboStateHash: hashSecret("qbo-state", qboState),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      outerStateCiphertext: this.#cipher.encrypt(input.state, flowId),
      ...(codeChallenge ? { pkceCodeChallenge: codeChallenge } : {}),
      requestedScopes,
      actorId,
      status: "AUTHORIZING_QUICKBOOKS",
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.createFlow(flow);
    return {
      consentUrl: buildQuickBooksAuthorizationUrl(this.#qbo, qboState),
      browserCookie: `${flowId}.${browserSecret}`,
      expiresAt,
    };
  }

  async handleQuickBooksCallback(input: {
    browserCookie: string;
    state?: string;
    code?: string;
    realmId?: string;
    error?: string;
  }): Promise<{ redirectUrl: string; actorId?: string; companyName?: string }> {
    const [flowId, browserSecret, ...extra] = input.browserCookie.split(".");
    if (!flowId || !browserSecret || extra.length > 0 || !/^qbf_[0-9a-f-]{36}$/u.test(flowId) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(browserSecret) || !exactString(input.state, 128)) {
      throw new AppError("FORBIDDEN", "MCP OAuth browser binding is invalid.", { httpStatus: 403 });
    }
    const now = this.#clock();
    const flow = await this.#repository.claimCallback({
      flowId,
      browserSessionHash: hashSecret("browser", browserSecret),
      qboStateHash: hashSecret("qbo-state", input.state),
      now,
    });
    if (!flow) {
      throw new AppError("FORBIDDEN", "MCP OAuth flow is invalid, expired, or already used.", { httpStatus: 403 });
    }
    const outerState = this.#cipher.decrypt(flow.outerStateCiphertext, flow.flowId);
    if (input.error) {
      await this.#repository.terminateFlow({
        flowId,
        browserSessionHash: flow.browserSessionHash,
        status: input.error === "access_denied" ? "DENIED" : "FAILED",
        now,
      });
      return { redirectUrl: redirectResult(flow.redirectUri, outerState, { error: input.error === "access_denied" ? "access_denied" : "server_error" }) };
    }
    if (!exactString(input.code, 512) || !input.realmId || !/^\d{3,32}$/u.test(input.realmId)) {
      await this.#repository.terminateFlow({ flowId, browserSessionHash: flow.browserSessionHash, status: "FAILED", now });
      return { redirectUrl: redirectResult(flow.redirectUri, outerState, { error: "server_error" }) };
    }
    try {
      const qboToken = await exchangeQuickBooksAuthorizationCode({
        config: this.#qbo,
        code: input.code,
        ...(this.#qbo.request ? { request: this.#qbo.request } : {}),
        now,
      });
      const connection = await this.#manager.connect({
        actorId: flow.actorId,
        realmId: input.realmId,
        token: qboToken,
        grantedScopes: [QUICKBOOKS_ACCOUNTING_SCOPE],
      });
      const authorizationCode = secret("qbc");
      const completed = await this.#repository.completeFlow({
        flowId,
        browserSessionHash: flow.browserSessionHash,
        authorizationCodeHash: hashSecret("authorization-code", authorizationCode),
        authorizationCodeExpiresAt: new Date(now.getTime() + 5 * 60_000),
        now,
      });
      if (!completed) {
        throw new AppError("CONFLICT", "MCP OAuth flow changed before completion.", { httpStatus: 409 });
      }
      return {
        redirectUrl: redirectResult(flow.redirectUri, outerState, { code: authorizationCode }),
        actorId: flow.actorId,
        companyName: connection.companyName,
      };
    } catch (error) {
      await this.#repository.terminateFlow({ flowId, browserSessionHash: flow.browserSessionHash, status: "FAILED", now });
      throw error;
    }
  }

  async exchangeAuthorizationCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<QuickBooksMcpTokenResponse> {
    this.#requireClient(input.clientId, input.clientSecret);
    if (!exactString(input.code, 256) || !exactString(input.redirectUri)) {
      throw new AppError("AUTH_REQUIRED", "The MCP OAuth authorization code is invalid.", { httpStatus: 401 });
    }
    const now = this.#clock();
    const codeHash = hashSecret("authorization-code", input.code);
    const flow = await this.#repository.peekAuthorizationCode({
      authorizationCodeHash: codeHash,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      now,
    });
    if (!flow || !this.#validPkce(flow.pkceCodeChallenge, input.codeVerifier)) {
      throw new AppError("AUTH_REQUIRED", "The MCP OAuth authorization grant is invalid.", { httpStatus: 401 });
    }
    const consumed = await this.#repository.consumeAuthorizationCode({ flowId: flow.flowId, authorizationCodeHash: codeHash, now });
    if (!consumed) {
      throw new AppError("AUTH_REQUIRED", "The MCP OAuth authorization grant was already used.", { httpStatus: 401 });
    }
    const accessToken = secret("qba");
    const refreshToken = secret("qbr");
    const stored: QuickBooksMcpOAuthToken = {
      tokenId: `qbt_${randomUUID()}`,
      actorId: flow.actorId,
      clientId: flow.clientId,
      grantedScopes: flow.requestedScopes,
      accessTokenHash: hashSecret("access", accessToken),
      accessTokenExpiresAt: new Date(now.getTime() + this.#config.accessTokenTtlSeconds * 1_000),
      refreshTokenHash: hashSecret("refresh", refreshToken),
      refreshTokenExpiresAt: new Date(now.getTime() + this.#config.refreshTokenTtlSeconds * 1_000),
      refreshVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.createToken(stored);
    return this.#tokenResponse(accessToken, refreshToken, stored.grantedScopes);
  }

  async refresh(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<QuickBooksMcpTokenResponse> {
    this.#requireClient(input.clientId, input.clientSecret);
    if (!exactString(input.refreshToken, 256)) {
      throw new AppError("AUTH_REQUIRED", "The MCP OAuth refresh token is invalid.", { httpStatus: 401 });
    }
    const now = this.#clock();
    const accessToken = secret("qba");
    const nextRefreshToken = secret("qbr");
    const refreshTokenHash = hashSecret("refresh", input.refreshToken);
    const retryContext = `quickbooks-mcp-refresh-retry:${refreshTokenHash}`;
    const retryResponseCiphertext = this.#cipher.encrypt(JSON.stringify({ accessToken, nextRefreshToken }), retryContext);
    const result = await this.#repository.rotateOrCoalesceRefreshToken({
      refreshTokenHash,
      clientId: input.clientId,
      accessTokenHash: hashSecret("access", accessToken),
      accessTokenExpiresAt: new Date(now.getTime() + this.#config.accessTokenTtlSeconds * 1_000),
      nextRefreshTokenHash: hashSecret("refresh", nextRefreshToken),
      refreshTokenExpiresAt: new Date(now.getTime() + this.#config.refreshTokenTtlSeconds * 1_000),
      retryResponseCiphertext,
      retryExpiresAt: new Date(now.getTime() + QUICKBOOKS_MCP_REFRESH_RETRY_GRACE_MS),
      now,
    });
    if (result?.kind === "coalesced") {
      try {
        const context = `quickbooks-mcp-refresh-retry:${result.sourceRefreshTokenHash}`;
        const parsed = JSON.parse(this.#cipher.decrypt(result.responseCiphertext, context)) as {
          accessToken?: unknown;
          nextRefreshToken?: unknown;
        };
        if (
          typeof parsed.accessToken === "string" && parsed.accessToken.startsWith("qba_") &&
          exactString(parsed.accessToken, 256) && typeof parsed.nextRefreshToken === "string" &&
          parsed.nextRefreshToken.startsWith("qbr_") && exactString(parsed.nextRefreshToken, 256)
        ) {
          return this.#tokenResponse(parsed.accessToken, parsed.nextRefreshToken, result.grantedScopes);
        }
      } catch {
        // A corrupt retry record must fail closed and continue to family revocation below.
      }
    }
    if (!result || result.kind === "coalesced") {
      const replay = await this.#repository.revokeRefreshFamilyOnReplay({
        refreshTokenHash,
        clientId: input.clientId,
        now,
      });
      if (replay && this.#onActorSecurityRevoked) await this.#onActorSecurityRevoked(replay.actorId);
      throw new AppError("AUTH_REQUIRED", "The MCP OAuth refresh grant is invalid or expired.", { httpStatus: 401 });
    }
    return this.#tokenResponse(accessToken, nextRefreshToken, result.token.grantedScopes);
  }

  async verifyAccessToken(accessToken: string): Promise<(
    ResolvedMcpAccessToken & { actorId: string; allowedOrigins: string[] }
  ) | undefined> {
    if (!exactString(accessToken, 256)) return undefined;
    const token = await this.#repository.getAccessToken(hashSecret("access", accessToken), this.#clock());
    if (!token) return undefined;
    const separator = token.actorId.indexOf(":user:");
    if (separator < 1) return undefined;
    const workspaceId = token.actorId.slice(0, separator);
    const subjectId = token.actorId.slice(separator + ":user:".length);
    if (!workspaceId || !subjectId) return undefined;
    if (!this.#hostClients.hasClient(token.clientId)) return undefined;
    let connection: Awaited<ReturnType<QuickBooksClientManager["resolveSingleConnection"]>>;
    try {
      connection = await this.#manager.resolveSingleConnection(token.actorId);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_CONNECTED") return undefined;
      throw error;
    }
    return {
      tokenId: token.tokenId,
      clientId: token.clientId,
      actorId: token.actorId,
      resource: this.#config.resourceUri,
      audience: this.#config.resourceUri,
      grantedScopes: [...token.grantedScopes],
      issuedAt: token.createdAt,
      expiresAt: token.accessTokenExpiresAt,
      workspaceId,
      subjectType: "USER",
      subjectId,
      agentId: token.clientId,
      installationId: token.tokenId,
      bindingId: `qbob_${sha256(connection.connectionId).slice(0, 32)}`,
      bindingRevision: 1,
      connectionId: connection.connectionId,
      authorizationId: `qboa_${sha256(token.tokenId).slice(0, 32)}`,
      policyId: `qbop_${sha256(token.clientId).slice(0, 32)}`,
      tenantId: connection.realmId,
      allowedOrigins: this.#hostClients.allowedOrigins(token.clientId),
      identityAssurance: "INSTALLATION_ONLY",
    };
  }

  async revoke(input: { clientId: string; clientSecret: string; token: string }): Promise<void> {
    this.#requireClient(input.clientId, input.clientSecret);
    if (!exactString(input.token, 256)) return;
    const revoked = await this.#repository.revokeToken({
      accessTokenHash: hashSecret("access", input.token),
      refreshTokenHash: hashSecret("refresh", input.token),
      clientId: input.clientId,
      now: this.#clock(),
    });
    if (revoked.actorId && this.#onActorSecurityRevoked) await this.#onActorSecurityRevoked(revoked.actorId);
  }

  #parseScopes(scope: string | undefined): string[] {
    if (scope === undefined || scope.trim() === "") return ["quickbooks.read"];
    const requested = scope.split(/\s+/u).filter(Boolean);
    const allowed = new Set<string>(QUICKBOOKS_MCP_OAUTH_SCOPES);
    if (requested.length === 0 || new Set(requested).size !== requested.length || requested.some((value) => !allowed.has(value))) {
      throw new AppError("FORBIDDEN", "MCP OAuth requested an unsupported scope.", { httpStatus: 403 });
    }
    return requested;
  }

  #requireClient(clientId: string, clientSecret: string): void {
    if (!this.authenticateClient(clientId, clientSecret)) {
      throw new AppError("AUTH_REQUIRED", "MCP OAuth client authentication failed.", { httpStatus: 401 });
    }
  }

  #validPkce(expected: string | undefined, verifier: string | undefined): boolean {
    if (!expected) return verifier === undefined || verifier === "";
    return !!verifier && /^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) && safeEqual(pkceChallenge(verifier), expected);
  }

  #tokenResponse(accessToken: string, refreshToken: string, scopes: string[]): QuickBooksMcpTokenResponse {
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.#config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}
