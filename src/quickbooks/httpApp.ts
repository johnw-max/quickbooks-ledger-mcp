import { randomBytes, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AppError, toSafeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { hashObject, safeEqual } from "../security/hash.js";
import {
  actorIdForResolvedBinding,
  createLegacySharedBearerRequestContext,
  createOAuthRequestContext,
  type RequestContext,
} from "../security/requestContext.js";
import type { QuickBooksConnectionTicketService } from "./connectionTicketService.js";
import type { QuickBooksRuntimeConfig } from "./config.js";
import {
  createQuickBooksMcpServer,
  QUICKBOOKS_ACCOUNTING_CASE_TOOL_ALLOWLIST,
  QUICKBOOKS_CAPABILITY_TOOL_ALLOWLIST,
  QUICKBOOKS_READ_TOOL_ALLOWLIST,
  QUICKBOOKS_RELEASE_VERSION,
} from "./mcp.js";
import type { QuickBooksOAuthService } from "./oauthService.js";
import {
  QUICKBOOKS_MCP_OAUTH_SCOPES,
  type QuickBooksMcpOAuthService,
  type QuickBooksMcpUnboundPrincipal,
} from "./mcpOAuthService.js";
import type { QuickBooksReviewService } from "./reviewService.js";
import type { QuickBooksWorkflowService } from "./service.js";
import type { QuickBooksMutationService } from "./mutationService.js";
import type { QuickBooksAccountingCaseService } from "./accountingCaseService.js";
import { QUICKBOOKS_CASE_ATTESTATION } from "./accountingCaseService.js";
import {
  QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS,
  QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
} from "./accountingCase.js";
import type { QuickBooksRuntimeReadiness } from "./runtimeReadiness.js";
import { LEDGER_CONTROL_KERNEL_VERSION } from "../ledger-control/ledgerControlKernel.js";
import { LEDGER_DETERMINISTIC_VALIDATOR_VERSION } from "../ledger-control/deterministicValidation.js";

const OAUTH_COOKIE = "zc_quickbooks_oauth_session";
const MCP_OAUTH_COOKIE = "zc_quickbooks_mcp_oauth_session";
const REVIEW_COOKIE = "zc_quickbooks_review_session";

function parseCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function bearerFrom(request: Request): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

/**
 * Builds the request principal for a verified token whose actor has no attached
 * QuickBooks company. It mirrors createOAuthRequestContext's identity claims but
 * deliberately omits bindingId/connectionId/bindingRevision, so every binding
 * gate (requireOAuthBoundRequestContext, assertInternalQuickBooksCaller) still
 * fails closed while read-only diagnostics stay dispatchable.
 */
function createUnboundOAuthRequestContext(options: {
  issuer: string;
  principal: QuickBooksMcpUnboundPrincipal;
}): RequestContext {
  const principal = options.principal;
  return Object.freeze({
    requestId: randomUUID(),
    actorId: actorIdForResolvedBinding(principal),
    workspaceId: principal.workspaceId,
    subjectType: principal.subjectType,
    subjectId: principal.subjectId,
    ...(principal.subjectType === "USER" ? { userId: principal.subjectId } : {}),
    agentId: principal.agentId,
    oauthInstallationId: principal.installationId,
    scopes: Object.freeze([...principal.grantedScopes]),
    roles: Object.freeze([] as string[]),
    identityAssurance: principal.identityAssurance,
    authn: Object.freeze({
      issuer: options.issuer,
      subject: `${principal.subjectType.toLowerCase()}:${principal.subjectId}`,
      audience: principal.audience,
      tokenId: principal.tokenId,
    }),
    legacyDemo: false,
  });
}

function jsonRpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
}

function oauthClientCredentials(request: Request): { clientId?: string; clientSecret?: string } {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
      }
      return {};
    } catch {
      return {};
    }
  }
  return {
    ...(typeof request.body?.client_id === "string" ? { clientId: request.body.client_id } : {}),
    ...(typeof request.body?.client_secret === "string" ? { clientSecret: request.body.client_secret } : {}),
  };
}

function sendOAuthError(response: Response, status: number, error: string, description: string): void {
  response.status(status).json({ error, error_description: description });
}

function setPrivateHeaders(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function renderConnected(companyName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuickBooks connected</title></head><body><main><h1>QuickBooks connected</h1><p>Connected to <strong>${escapeHtml(companyName)}</strong>. Return to the Agent and continue.</p></main></body></html>`;
}

export function createQuickBooksHttpApp(options: {
  config: QuickBooksRuntimeConfig;
  workflow: QuickBooksWorkflowService;
  mutations?: QuickBooksMutationService;
  accountingCases: QuickBooksAccountingCaseService;
  oauth: QuickBooksOAuthService;
  mcpOAuth?: QuickBooksMcpOAuthService;
  reviews: QuickBooksReviewService;
  tickets: QuickBooksConnectionTicketService;
  readiness: () => Promise<boolean | QuickBooksRuntimeReadiness>;
  logger: Logger;
}) {
  const { config, workflow, mutations, accountingCases, oauth, mcpOAuth, reviews, tickets, readiness, logger } = options;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(hostHeaderValidation([...new Set([...config.allowedHosts, "127.0.0.1", "localhost"])]));
  app.use((_, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  app.use(express.json({ limit: config.requestBodyLimitBytes }));
  app.use(express.urlencoded({ extended: false, limit: config.requestBodyLimitBytes }));

  const readinessState = async (): Promise<{ ready: boolean; attestation: QuickBooksRuntimeReadiness | null }> => {
    try {
      const result = await readiness();
      return typeof result === "boolean"
        ? { ready: result, attestation: null }
        : { ready: result.ready, attestation: result };
    } catch {
      return { ready: false, attestation: null };
    }
  };

  app.get("/healthz", async (_, response) => {
    const toolset = [
      ...QUICKBOOKS_READ_TOOL_ALLOWLIST,
      ...(mutations ? QUICKBOOKS_CAPABILITY_TOOL_ALLOWLIST : []),
      ...QUICKBOOKS_ACCOUNTING_CASE_TOOL_ALLOWLIST,
    ];
    const runtime = await readinessState();
    const promotionReasons = [
      ...(runtime.ready ? [] : ["RUNTIME_NOT_READY"]),
      ...(mcpOAuth ? [] : ["PER_USER_MCP_OAUTH_DISABLED"]),
      ...(config.writeEnabled ? [] : ["WRITE_KILL_SWITCH_DISABLED"]),
      ...(config.standingDelegationEnabled ? [] : ["STANDING_DELEGATION_DISABLED"]),
      "ONLINE_AGENT_UAT_REQUIRED",
    ];
    response.json({
      status: runtime.ready ? "ok" : "degraded",
      provider: "quickbooks-online",
      providerEnvironment: config.oauth.environment,
      version: QUICKBOOKS_RELEASE_VERSION,
      toolCount: toolset.length,
      toolsetHash: hashObject(toolset),
      writeEnabled: config.writeEnabled,
      perUserOAuthEnabled: Boolean(mcpOAuth),
      registeredHostClientCount: mcpOAuth?.registeredHostClientCount ?? 0,
      kernelVersion: LEDGER_CONTROL_KERNEL_VERSION,
      validatorVersion: LEDGER_DETERMINISTIC_VALIDATOR_VERSION,
      compilerVersion: QUICKBOOKS_CASE_ATTESTATION.compilerVersion,
      policyVersion: QUICKBOOKS_CASE_ATTESTATION.policyVersion,
      accountingCaseEnabled: true,
      readiness: runtime.attestation ?? {
        ready: runtime.ready,
        persistence: { status: runtime.ready ? "READY" : "NOT_READY", source: "UNSTRUCTURED_CALLBACK" },
        migrations: { status: "NOT_ATTESTED" },
      },
      writeControl: {
        enabled: config.writeEnabled,
        targetMode: config.writeTargetMode,
        exactTargetConfigured: Boolean(config.allowedRealmId),
        ...(config.allowedRealmId ? {
          exactTargetHash: hashObject({ provider: "quickbooks", realmId: config.allowedRealmId }),
        } : {}),
      },
      releasedActions: {
        count: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS.length,
        hash: hashObject(QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS),
      },
      releasedCapabilities: {
        count: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES.length,
        hash: hashObject(QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES),
      },
      standingDelegation: {
        enabled: config.standingDelegationEnabled,
        status: !config.standingDelegationEnabled
          ? "DISABLED"
          : config.writeEnabled
            ? "ACTIVE"
            : "INACTIVE_WRITE_DISABLED",
        revision: config.standingDelegationEnabled ? 1 : null,
        configuredActionHash: hashObject([...config.standingDelegationActions].sort()),
      },
      providerAuthorizationModel: {
        requiredOAuthScope: "com.intuit.quickbooks.accounting",
        dynamicProviderRolesAvailable: false,
        roleAuthoritySource: "PLATFORM_POLICY_NOT_INTUIT_ROLE",
      },
      promotionAssertion: {
        status: promotionReasons.length === 1 ? "RUNTIME_PREREQUISITES_ATTESTED" : "NOT_ASSERTED",
        scope: "RUNTIME_CONFIGURATION_AND_PERSISTENCE_ONLY",
        reasonCodes: promotionReasons,
        onlineAgentUatRequired: true,
      },
    });
  });
  app.get("/readyz", async (_, response) => {
    const runtime = await readinessState();
    response.status(runtime.ready ? 200 : 503).json({
      status: runtime.ready ? "ready" : "not_ready",
      version: QUICKBOOKS_RELEASE_VERSION,
    });
  });

  const resourceMetadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource/quickbooks/mcp`;
  /**
   * RFC 9728 / MCP authorization: without this challenge a Host reads a bare 401
   * as "refresh and retry", and a still-valid refresh token turns that into an
   * unbounded token -> 401 -> refresh loop. Both the missing-bearer and the
   * invalid-token branch must advertise it. It discloses nothing an
   * unauthenticated caller cannot already read from the metadata document.
   */
  const setBearerChallenge = (response: Response, invalidToken: boolean): void => {
    response.setHeader(
      "WWW-Authenticate",
      invalidToken
        ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
        : `Bearer resource_metadata="${resourceMetadataUrl}"`,
    );
  };

  app.all("/quickbooks/mcp", async (request, response, next) => {
    const supplied = bearerFrom(request);
    if (!supplied) {
      if (mcpOAuth) setBearerChallenge(response, false);
      jsonRpcError(response, 401, "Unauthorized");
      return;
    }
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      jsonRpcError(response, 403, "Forbidden Origin");
      return;
    }
    if (!mcpOAuth && safeEqual(supplied, config.mcpBearerToken)) {
      response.locals.requestContext = createLegacySharedBearerRequestContext({
        actorId: config.demoActorId,
        audience: `${config.publicBaseUrl}/quickbooks/mcp`,
        scopes: [...QUICKBOOKS_MCP_OAUTH_SCOPES],
        issuer: "urn:quickbooks-accounting-mcp:legacy-test",
        subjectPrefix: "quickbooks-test",
        tokenId: "quickbooks-test-shared-bearer",
      });
    } else {
      // The internal reason is logged server-side only; the wire response stays
      // opaque so an unauthenticated caller gets no token-validity oracle.
      // Both keys are on logging.ts's allowlist, so they survive redaction —
      // borrowing an unrelated safe key would read as the wrong thing in a log.
      const verified = mcpOAuth
        ? await mcpOAuth.verifyAccessToken(supplied, (rejection) => {
          logger.warn("QuickBooks MCP access token rejected.", {
            method: request.method,
            path: "/quickbooks/mcp",
            errorCode: "AUTH_REQUIRED",
            rejectionReason: rejection.reason,
            tokenIdHash: rejection.tokenIdHash,
          });
        })
        : undefined;
      if (!verified) {
        if (mcpOAuth) setBearerChallenge(response, true);
        jsonRpcError(response, 401, "Unauthorized");
        return;
      }
      if (origin && !verified.allowedOrigins.includes(origin)) {
        jsonRpcError(response, 403, "Forbidden Origin");
        return;
      }
      const issuer = `${config.publicBaseUrl}/quickbooks/oauth`;
      if (verified.connectionId === undefined) {
        logger.debug("QuickBooks MCP request has no connected company.", {
          method: request.method,
          path: "/quickbooks/mcp",
          rejectionReason: "NO_CONNECTION",
          actorId: verified.actorId,
        });
        response.locals.requestContext = createUnboundOAuthRequestContext({ issuer, principal: verified });
      } else {
        response.locals.requestContext = createOAuthRequestContext({ issuer, resolvedToken: verified });
      }
    }
    next();
  });

  if (mcpOAuth) {
    app.get("/.well-known/oauth-protected-resource/quickbooks/mcp", (_, response) => {
      response.json({
        resource: `${config.publicBaseUrl}/quickbooks/mcp`,
        authorization_servers: [`${config.publicBaseUrl}/quickbooks/oauth`],
        bearer_methods_supported: ["header"],
        scopes_supported: [...QUICKBOOKS_MCP_OAUTH_SCOPES],
        resource_name: "zCloak QuickBooks Accounting MCP",
      });
    });
    app.get("/.well-known/oauth-authorization-server/quickbooks", (_, response) => {
      response.json({
        issuer: `${config.publicBaseUrl}/quickbooks/oauth`,
        authorization_endpoint: `${config.publicBaseUrl}/quickbooks/oauth/authorize`,
        token_endpoint: `${config.publicBaseUrl}/quickbooks/oauth/token`,
        revocation_endpoint: `${config.publicBaseUrl}/quickbooks/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [...QUICKBOOKS_MCP_OAUTH_SCOPES],
      });
    });
    app.get("/.well-known/oauth-authorization-server/quickbooks/oauth", (_, response) => {
      response.json({
        issuer: `${config.publicBaseUrl}/quickbooks/oauth`,
        authorization_endpoint: `${config.publicBaseUrl}/quickbooks/oauth/authorize`,
        token_endpoint: `${config.publicBaseUrl}/quickbooks/oauth/token`,
        revocation_endpoint: `${config.publicBaseUrl}/quickbooks/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [...QUICKBOOKS_MCP_OAUTH_SCOPES],
      });
    });
    app.get("/quickbooks/oauth/authorize", async (request, response) => {
      const clientId = typeof request.query.client_id === "string" ? request.query.client_id : undefined;
      const origin = request.headers.origin;
      if (origin && (!clientId || !config.allowedOrigins.includes(origin) || !mcpOAuth.isOriginAllowedForClient(clientId, origin))) {
        sendOAuthError(response, 403, "invalid_request", "OAuth authorization Origin is not registered for this Host client.");
        return;
      }
      const started = await mcpOAuth.startAuthorization({
        ...(clientId ? { clientId } : {}),
        ...(typeof request.query.redirect_uri === "string" ? { redirectUri: request.query.redirect_uri } : {}),
        ...(typeof request.query.response_type === "string" ? { responseType: request.query.response_type } : {}),
        ...(typeof request.query.state === "string" ? { state: request.query.state } : {}),
        ...(typeof request.query.scope === "string" ? { scope: request.query.scope } : {}),
        ...(typeof request.query.code_challenge === "string" ? { codeChallenge: request.query.code_challenge } : {}),
        ...(typeof request.query.code_challenge_method === "string" ? { codeChallengeMethod: request.query.code_challenge_method } : {}),
      });
      response.cookie(MCP_OAUTH_COOKIE, started.browserCookie, {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        path: "/oauth/quickbooks",
        expires: started.expiresAt,
      });
      response.setHeader("Cache-Control", "no-store");
      response.redirect(302, started.consentUrl);
    });
    app.post("/quickbooks/oauth/token", async (request, response) => {
      if (request.headers.origin) {
        sendOAuthError(response, 403, "invalid_request", "Token exchange must be server-to-server.");
        return;
      }
      const credentials = oauthClientCredentials(request);
      if (!credentials.clientId || !credentials.clientSecret) {
        sendOAuthError(response, 401, "invalid_client", "Client authentication is required.");
        return;
      }
      try {
        if (request.body?.grant_type === "authorization_code") {
          const token = await mcpOAuth.exchangeAuthorizationCode({
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            code: typeof request.body.code === "string" ? request.body.code : "",
            redirectUri: typeof request.body.redirect_uri === "string" ? request.body.redirect_uri : "",
            ...(typeof request.body.code_verifier === "string" ? { codeVerifier: request.body.code_verifier } : {}),
          });
          response.setHeader("Cache-Control", "no-store");
          response.json(token);
          return;
        }
        if (request.body?.grant_type === "refresh_token") {
          const token = await mcpOAuth.refresh({
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            refreshToken: typeof request.body.refresh_token === "string" ? request.body.refresh_token : "",
          });
          response.setHeader("Cache-Control", "no-store");
          response.json(token);
          return;
        }
        sendOAuthError(response, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
      } catch (error) {
        const safe = toSafeError(error);
        const invalidClient = safe.message.includes("client authentication");
        sendOAuthError(response, invalidClient ? 401 : 400, invalidClient ? "invalid_client" : "invalid_grant", safe.message);
      }
    });
    app.post("/quickbooks/oauth/revoke", async (request, response) => {
      if (request.headers.origin) {
        sendOAuthError(response, 403, "invalid_request", "Token revocation must be server-to-server.");
        return;
      }
      const credentials = oauthClientCredentials(request);
      if (!credentials.clientId || !credentials.clientSecret || !mcpOAuth.authenticateClient(credentials.clientId, credentials.clientSecret)) {
        sendOAuthError(response, 401, "invalid_client", "Client authentication is required.");
        return;
      }
      await mcpOAuth.revoke({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        token: typeof request.body?.token === "string" ? request.body.token : "",
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(200).end();
    });
  }
  app.post("/quickbooks/mcp", async (request, response) => {
    const server = createQuickBooksMcpServer(
      workflow,
      response.locals.requestContext as RequestContext,
      accountingCases,
      mutations,
    );
    const transport = new StreamableHTTPServerTransport();
    try {
      await server.connect(transport as unknown as Transport);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error("QuickBooks MCP request handling failed.", {
        method: request.method,
        path: "/quickbooks/mcp",
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      if (!response.headersSent) jsonRpcError(response, 500, "Internal server error");
    }
  });
  app.get("/quickbooks/mcp", (_, response) => jsonRpcError(response, 405, "Method not allowed"));
  app.delete("/quickbooks/mcp", (_, response) => jsonRpcError(response, 405, "Method not allowed"));

  app.get("/connect/quickbooks", async (request, response) => {
    const ticket = request.query.ticket;
    if (typeof ticket !== "string") {
      throw new AppError("VALIDATION_FAILED", "QuickBooks connect ticket is invalid.", { httpStatus: 400 });
    }
    const consumed = await tickets.consume(ticket);
    const browserSession = randomBytes(32).toString("base64url");
    const consentUrl = await oauth.start(consumed.actorId, browserSession);
    response.cookie(OAUTH_COOKIE, browserSession, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/oauth/quickbooks",
      maxAge: 10 * 60_000,
    });
    response.setHeader("Cache-Control", "no-store");
    response.redirect(302, consentUrl);
  });

  app.get("/oauth/quickbooks/callback", async (request, response) => {
    const mcpBrowserSession = parseCookie(request, MCP_OAUTH_COOKIE);
    if (mcpOAuth && mcpBrowserSession) {
      const connected = await mcpOAuth.handleQuickBooksCallback({
        browserCookie: mcpBrowserSession,
        ...(typeof request.query.state === "string" ? { state: request.query.state } : {}),
        ...(typeof request.query.code === "string" ? { code: request.query.code } : {}),
        ...(typeof request.query.realmId === "string" ? { realmId: request.query.realmId } : {}),
        ...(typeof request.query.error === "string" ? { error: request.query.error } : {}),
      });
      response.clearCookie(MCP_OAUTH_COOKIE, { path: "/oauth/quickbooks" });
      if (connected.actorId) {
        const reviewSession = await reviews.createOperatorSession(connected.actorId);
        response.cookie(REVIEW_COOKIE, reviewSession.session, {
          httpOnly: true,
          secure: config.nodeEnv === "production",
          sameSite: "lax",
          path: "/",
          expires: reviewSession.expiresAt,
        });
      }
      response.setHeader("Cache-Control", "no-store");
      response.redirect(302, connected.redirectUrl);
      return;
    }
    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    const browserSession = parseCookie(request, OAUTH_COOKIE);
    if (!state || !browserSession) {
      throw new AppError("FORBIDDEN", "QuickBooks OAuth callback is missing state or browser session.", {
        httpStatus: 403,
      });
    }
    const connected = await oauth.callback({
      state,
      browserSession,
      ...(typeof request.query.code === "string" ? { code: request.query.code } : {}),
      ...(typeof request.query.realmId === "string" ? { realmId: request.query.realmId } : {}),
      ...(typeof request.query.error === "string" ? { error: request.query.error } : {}),
    });
    const reviewSession = await reviews.createOperatorSession(connected.actorId);
    response.clearCookie(OAUTH_COOKIE, { path: "/oauth/quickbooks" });
    response.cookie(REVIEW_COOKIE, reviewSession.session, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/",
      expires: reviewSession.expiresAt,
    });
    setPrivateHeaders(response);
    if (request.accepts(["html", "json"]) === "json") {
      response.json({
        status: "connected",
        company: { realmId: connected.realmId, name: connected.companyName },
        scopes: connected.scopes,
      });
      return;
    }
    response.type("html").send(renderConnected(connected.companyName));
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const safe = toSafeError(error);
    logger.warn("QuickBooks HTTP request rejected.", {
      method: request.method,
      path: request.path.startsWith("/connect/quickbooks") ? "/connect/quickbooks" : request.path,
      errorCode: safe.code,
    });
    if (!response.headersSent) {
      response.status(safe.httpStatus).json({ error: { code: safe.code, message: safe.message } });
    }
  });

  return app;
}
