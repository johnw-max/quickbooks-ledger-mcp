import { randomBytes, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AppError, toSafeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { hashObject, safeEqual } from "../security/hash.js";
import { createLegacySharedBearerRequestContext, type RequestContext } from "../security/requestContext.js";
import type { QuickBooksConnectionTicketService } from "./connectionTicketService.js";
import type { QuickBooksRuntimeConfig } from "./config.js";
import {
  createQuickBooksMcpServer,
  QUICKBOOKS_RELEASE_VERSION,
  QUICKBOOKS_RUNTIME_TOOL_ALLOWLIST,
  QUICKBOOKS_TOOL_ALLOWLIST,
  QUICKBOOKS_MUTATION_TOOL_ALLOWLIST,
} from "./mcp.js";
import type { QuickBooksOAuthService } from "./oauthService.js";
import { QUICKBOOKS_MCP_OAUTH_SCOPES, type QuickBooksMcpOAuthService } from "./mcpOAuthService.js";
import type { QuickBooksReviewService } from "./reviewService.js";
import type { QuickBooksWorkflowService } from "./service.js";
import type { QuickBooksMutationService } from "./mutationService.js";
import type { QuickBooksAccountingCaseService } from "./accountingCaseService.js";
import { QUICKBOOKS_CASE_ATTESTATION } from "./accountingCaseService.js";
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

function jsonRpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
}

function oauthBearerRequestContext(options: {
  actorId: string;
  workspaceId: string;
  subjectId: string;
  agentId: string;
  installationId: string;
  bindingId: string;
  bindingRevision: number;
  connectionId: string;
  audience: string;
  scopes: string[];
  tokenId: string;
}): RequestContext {
  return Object.freeze({
    requestId: randomUUID(),
    actorId: options.actorId,
    workspaceId: options.workspaceId,
    subjectType: "USER" as const,
    subjectId: options.subjectId,
    userId: options.subjectId,
    agentId: options.agentId,
    oauthInstallationId: options.installationId,
    bindingId: options.bindingId,
    bindingRevision: options.bindingRevision,
    connectionId: options.connectionId,
    scopes: Object.freeze([...options.scopes]),
    roles: Object.freeze([] as string[]),
    authn: Object.freeze({
      issuer: "urn:quickbooks-accounting-mcp:oauth",
      subject: `quickbooks-installation:${options.actorId}`,
      audience: options.audience,
      tokenId: options.tokenId,
    }),
    legacyDemo: false,
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

function renderReview(options: {
  posting: Awaited<ReturnType<QuickBooksReviewService["getReview"]>>["posting"];
  csrfToken?: string;
}): string {
  const posting = options.posting;
  const rows = posting.payload.lines.map((line) => `<tr><td>${escapeHtml(line.description ?? "-")}</td><td>${escapeHtml(line.amount)}</td><td>${escapeHtml(line.accountId)}</td><td>${escapeHtml(line.taxCodeId ?? "-")}</td></tr>`).join("");
  const actionBase = `/quickbooks/review/${encodeURIComponent(posting.postingRequestId)}`;
  const actions = options.csrfToken && ["PREPARED", "WRITE_RESULT_UNKNOWN"].includes(posting.state)
    ? `<form method="post" action="${actionBase}/approve"><input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}"><button type="submit">Approve and post to QuickBooks</button></form>${posting.state === "PREPARED" ? `<form method="post" action="${actionBase}/reject"><input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}"><button type="submit">Reject</button></form>` : ""}`
    : "<p>No review action is available.</p>";
  const evidence = {
    postingRequestId: posting.postingRequestId,
    payloadHash: posting.payloadHash,
    sourceRef: posting.sourceRef,
    sourceSha256: posting.sourceSha256,
    sourceDigestProvenance: posting.payload.sourceDigestProvenance ?? "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256",
    approvalRef: posting.payload.approvalRef,
    supportingEvidence: posting.payload.supportingEvidence,
    providerRequestId: posting.providerRequestId,
    qboBillId: posting.qboBillId,
  };
  const sourceDigestProvenance = posting.payload.sourceDigestProvenance ?? "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256";
  const sourceWarning = sourceDigestProvenance === "HOST_PROVIDED_ORIGINAL_FILE_SHA256"
    ? ""
    : '<p class="warning"><strong>Evidence limitation:</strong> the source digest is not a host-verified hash of the original uploaded file. For AGENT_SUPPLIED_TEXT_FINGERPRINT it covers only text supplied by the Agent. Compare the displayed accounting fields with the original document before approving.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review QuickBooks supplier bill</title><style>body{font-family:system-ui;max-width:900px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.5rem;text-align:left}form{display:inline-block;margin:1rem 1rem 1rem 0}button{padding:.65rem 1rem}.warning{background:#fff4ce;padding:.75rem}</style></head><body><main><h1>Review QuickBooks supplier bill</h1><p><strong>Status: ${escapeHtml(posting.state)}</strong>. QuickBooks has not been written unless the status is POSTED_READBACK_VERIFIED.</p>${posting.payload.approvalRef ? "" : '<p class="warning">No separate business approval reference was supplied. Apply the workspace approval policy before posting.</p>'}${sourceWarning}<dl><dt>Company realm</dt><dd>${escapeHtml(posting.realmId)}</dd><dt>Vendor ID</dt><dd>${escapeHtml(posting.payload.vendorId)}</dd><dt>Supplier document</dt><dd>${escapeHtml(posting.payload.docNumber ?? `Missing: ${posting.payload.missingDocNumberReason ?? "no reason"}`)}</dd><dt>Transaction date</dt><dd>${escapeHtml(posting.payload.txnDate)}</dd><dt>Due date</dt><dd>${escapeHtml(posting.payload.dueDate ?? "-")}</dd><dt>Currency</dt><dd>${escapeHtml(posting.payload.currencyCode ?? "Company default")}</dd><dt>Tax treatment</dt><dd>${escapeHtml(posting.payload.globalTaxCalculation ?? "-")}</dd><dt>Invoice total</dt><dd>${escapeHtml(posting.payload.invoiceTotal ?? "-")}</dd><dt>Tax total</dt><dd>${escapeHtml(posting.payload.taxTotal ?? "-")}</dd><dt>Source</dt><dd>${escapeHtml(posting.sourceRef)}</dd><dt>Source digest provenance</dt><dd>${escapeHtml(sourceDigestProvenance)}</dd></dl><table><thead><tr><th>Description</th><th>Amount</th><th>Account ID</th><th>Tax code ID</th></tr></thead><tbody>${rows}</tbody></table>${actions}<details><summary>Evidence</summary><pre>${escapeHtml(JSON.stringify(evidence, null, 2))}</pre></details></main></body></html>`;
}

function renderResult(options: {
  title: string;
  message: string;
  postingRequestId: string;
  state: string;
  billId?: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)}</title></head><body><main><h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p><dl><dt>Status</dt><dd>${escapeHtml(options.state)}</dd><dt>Posting request</dt><dd>${escapeHtml(options.postingRequestId)}</dd>${options.billId ? `<dt>QuickBooks Bill ID</dt><dd>${escapeHtml(options.billId)}</dd>` : ""}</dl></main></body></html>`;
}

function renderMutationReview(options: {
  preparation: Awaited<ReturnType<QuickBooksReviewService["getMutationReview"]>>["preparation"];
  csrfToken?: string;
}): string {
  const preparation = options.preparation;
  const actionBase = `/quickbooks/mutation-review/${encodeURIComponent(preparation.preparationId)}`;
  const actions = options.csrfToken && preparation.state === "PREPARED"
    ? `<form method="post" action="${actionBase}/approve"><input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}"><button type="submit">Approve and execute once</button></form><form method="post" action="${actionBase}/reject"><input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}"><button type="submit">Reject</button></form>`
    : "<p>No review action is available.</p>";
  const destructiveWarning = preparation.operation === "DELETE"
    ? preparation.entity === "Invoice"
      ? '<p class="critical"><strong>Destructive action:</strong> QuickBooks may delete this Invoice or fall back to voiding it. Either outcome changes receivables and requires a restricted reviewer.</p>'
      : '<p class="critical"><strong>Destructive action:</strong> QuickBooks transaction deletion cannot be undone. Master-data deletion may deactivate the record.</p>'
    : "";
  const beforeImage = preparation.beforeImage
    ? `<details open><summary>Provider target read at preparation time</summary><pre>${escapeHtml(JSON.stringify(preparation.beforeImage, null, 2))}</pre></details>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review QuickBooks mutation</title><style>body{font-family:system-ui;max-width:900px;margin:2rem auto;padding:0 1rem}form{display:inline-block;margin:1rem 1rem 1rem 0}button{padding:.65rem 1rem}.warning{background:#fff4ce;padding:.75rem}.critical{background:#ffd9d9;padding:.75rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><main><h1>Review QuickBooks ${escapeHtml(preparation.operation)} ${escapeHtml(preparation.entity)}</h1><p><strong>Status: ${escapeHtml(preparation.state)}</strong>. No QuickBooks provider write has occurred unless the status is POSTED_READBACK_VERIFIED.</p><p class="warning"><strong>${escapeHtml(preparation.risk)} risk / ${escapeHtml(preparation.providerEffect)}</strong>. QuickBooks does not provide a universal draft state; this page is zCloak's immutable review proposal.</p>${destructiveWarning}<dl><dt>Company binding</dt><dd>${escapeHtml(preparation.boundTargetRefSafe)}</dd><dt>Target ID</dt><dd>${escapeHtml(preparation.targetId ?? "New object")}</dd><dt>Sync token</dt><dd>${escapeHtml(preparation.syncToken ?? "Not applicable")}</dd><dt>Business reason</dt><dd>${escapeHtml(preparation.businessReason)}</dd><dt>Payload hash</dt><dd>${escapeHtml(preparation.payloadHash)}</dd><dt>Expires</dt><dd>${escapeHtml(preparation.expiresAt.toISOString())}</dd></dl>${beforeImage}<details open><summary>Approved payload</summary><pre>${escapeHtml(JSON.stringify(preparation.payload, null, 2))}</pre></details>${actions}</main></body></html>`;
}

export function createQuickBooksHttpApp(options: {
  config: QuickBooksRuntimeConfig;
  workflow: QuickBooksWorkflowService;
  mutations?: QuickBooksMutationService;
  accountingCases?: QuickBooksAccountingCaseService;
  oauth: QuickBooksOAuthService;
  mcpOAuth?: QuickBooksMcpOAuthService;
  reviews: QuickBooksReviewService;
  tickets: QuickBooksConnectionTicketService;
  readiness: () => Promise<boolean>;
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

  app.get("/healthz", (_, response) => {
    const toolset = accountingCases
      ? QUICKBOOKS_RUNTIME_TOOL_ALLOWLIST
      : mutations
        ? [...QUICKBOOKS_TOOL_ALLOWLIST, ...QUICKBOOKS_MUTATION_TOOL_ALLOWLIST]
        : QUICKBOOKS_TOOL_ALLOWLIST;
    response.json({
      status: "ok",
      provider: "quickbooks-online",
      version: QUICKBOOKS_RELEASE_VERSION,
      toolCount: toolset.length,
      toolsetHash: hashObject(toolset),
      writeEnabled: config.writeEnabled,
      perUserOAuthEnabled: Boolean(mcpOAuth),
      kernelVersion: LEDGER_CONTROL_KERNEL_VERSION,
      validatorVersion: LEDGER_DETERMINISTIC_VALIDATOR_VERSION,
      compilerVersion: QUICKBOOKS_CASE_ATTESTATION.compilerVersion,
      policyVersion: QUICKBOOKS_CASE_ATTESTATION.policyVersion,
      accountingCaseEnabled: Boolean(accountingCases),
    });
  });
  app.get("/readyz", async (_, response) => {
    const ready = await readiness();
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", version: QUICKBOOKS_RELEASE_VERSION });
  });

  app.all("/quickbooks/mcp", async (request, response, next) => {
    const supplied = bearerFrom(request);
    if (!supplied) {
      if (mcpOAuth) {
        response.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource/quickbooks/mcp"`,
        );
      }
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
      const verified = mcpOAuth ? await mcpOAuth.verifyAccessToken(supplied) : undefined;
      if (!verified) {
        jsonRpcError(response, 401, "Unauthorized");
        return;
      }
      response.locals.requestContext = oauthBearerRequestContext({
        actorId: verified.actorId,
        workspaceId: verified.workspaceId,
        subjectId: verified.subjectId,
        agentId: verified.agentId,
        installationId: verified.installationId,
        bindingId: verified.bindingId,
        bindingRevision: verified.bindingRevision,
        connectionId: verified.connectionId,
        audience: `${config.publicBaseUrl}/quickbooks/mcp`,
        scopes: verified.scopes,
        tokenId: verified.tokenId,
      });
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
      const started = await mcpOAuth.startAuthorization({
        ...(typeof request.query.client_id === "string" ? { clientId: request.query.client_id } : {}),
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
      mutations,
      accountingCases,
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

  app.get("/quickbooks/review/:postingRequestId", async (request, response) => {
    const postingRequestId = request.params.postingRequestId;
    const rawSession = parseCookie(request, REVIEW_COOKIE);
    if (typeof postingRequestId !== "string" || !rawSession) {
      throw new AppError("AUTH_REQUIRED", "QuickBooks operator review session is required.", { httpStatus: 401 });
    }
    const session = await reviews.authenticate(rawSession);
    const review = await reviews.getReview(postingRequestId, session.actorId, session.sessionHash);
    const csrfToken = "csrfToken" in review && typeof review.csrfToken === "string" ? review.csrfToken : undefined;
    setPrivateHeaders(response);
    if (request.accepts(["html", "json"]) === "json") {
      response.json({ review: review.posting, ...(csrfToken ? { csrfToken } : {}) });
      return;
    }
    response.type("html").send(renderReview({ posting: review.posting, ...(csrfToken ? { csrfToken } : {}) }));
  });

  const sameOrigin = (request: Request, response: Response, next: NextFunction) => {
    if (request.headers.origin !== config.publicBaseUrl) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "Review POST must be same-origin." } });
      return;
    }
    next();
  };

  app.post("/quickbooks/review/:postingRequestId/approve", sameOrigin, async (request, response) => {
    const postingRequestId = request.params.postingRequestId;
    const rawSession = parseCookie(request, REVIEW_COOKIE);
    const csrfToken = typeof request.body?.csrf_token === "string" ? request.body.csrf_token : undefined;
    if (typeof postingRequestId !== "string" || !rawSession || !csrfToken) {
      throw new AppError("AUTH_REQUIRED", "QuickBooks review session and CSRF are required.", { httpStatus: 401 });
    }
    const session = await reviews.authenticate(rawSession);
    const result = await reviews.approve({
      postingRequestId,
      actorId: session.actorId,
      sessionHash: session.sessionHash,
      csrfToken,
      approvedBy: session.actorId,
      service: workflow,
    });
    setPrivateHeaders(response);
    const payload = {
      status: result.state,
      postingRequestId: result.postingRequestId,
      billId: result.bill.billId,
      realmId: result.bill.realmId,
      verified: result.receipt.verified === true,
    };
    if (request.accepts(["html", "json"]) === "json") {
      response.json(payload);
      return;
    }
    response.type("html").send(renderResult({
      title: "Posted to QuickBooks",
      message: "The approved supplier Bill was written once and exact readback was verified.",
      postingRequestId: result.postingRequestId,
      state: result.state,
      billId: result.bill.billId,
    }));
  });

  app.post("/quickbooks/review/:postingRequestId/reject", sameOrigin, async (request, response) => {
    const postingRequestId = request.params.postingRequestId;
    const rawSession = parseCookie(request, REVIEW_COOKIE);
    const csrfToken = typeof request.body?.csrf_token === "string" ? request.body.csrf_token : undefined;
    if (typeof postingRequestId !== "string" || !rawSession || !csrfToken) {
      throw new AppError("AUTH_REQUIRED", "QuickBooks review session and CSRF are required.", { httpStatus: 401 });
    }
    const session = await reviews.authenticate(rawSession);
    const result = await reviews.reject({
      postingRequestId,
      actorId: session.actorId,
      sessionHash: session.sessionHash,
      csrfToken,
      rejectedBy: session.actorId,
      service: workflow,
    });
    setPrivateHeaders(response);
    if (request.accepts(["html", "json"]) === "json") {
      response.json({ postingRequestId: result.postingRequestId, state: result.state });
      return;
    }
    response.type("html").send(renderResult({
      title: "QuickBooks Bill rejected",
      message: "Nothing was posted to QuickBooks.",
      postingRequestId: result.postingRequestId,
      state: result.state,
    }));
  });

  app.get("/quickbooks/mutation-review/:preparationId", async (request, response) => {
    if (!mutations) throw new AppError("CONFIGURATION_ERROR", "QuickBooks mutation runtime is not configured.", { httpStatus: 503 });
    const preparationId = request.params.preparationId;
    const rawSession = parseCookie(request, REVIEW_COOKIE);
    if (typeof preparationId !== "string" || !rawSession) {
      throw new AppError("AUTH_REQUIRED", "QuickBooks operator review session is required.", { httpStatus: 401 });
    }
    const session = await reviews.authenticate(rawSession);
    const review = await reviews.getMutationReview(preparationId, session.actorId, session.sessionHash);
    const csrfToken = "csrfToken" in review && typeof review.csrfToken === "string" ? review.csrfToken : undefined;
    setPrivateHeaders(response);
    if (request.accepts(["html", "json"]) === "json") {
      response.json({ review: review.preparation, ...(csrfToken ? { csrfToken } : {}) });
      return;
    }
    response.type("html").send(renderMutationReview({ preparation: review.preparation, ...(csrfToken ? { csrfToken } : {}) }));
  });

  app.post("/quickbooks/mutation-review/:preparationId/approve", sameOrigin, async (request, response) => {
    if (!mutations) throw new AppError("CONFIGURATION_ERROR", "QuickBooks mutation runtime is not configured.", { httpStatus: 503 });
    const preparationId = request.params.preparationId;
    const rawSession = parseCookie(request, REVIEW_COOKIE);
    const csrfToken = typeof request.body?.csrf_token === "string" ? request.body.csrf_token : undefined;
    if (typeof preparationId !== "string" || !rawSession || !csrfToken) {
      throw new AppError("AUTH_REQUIRED", "QuickBooks review session and CSRF are required.", { httpStatus: 401 });
    }
    const session = await reviews.authenticate(rawSession);
    const result = await reviews.approveMutation({
      preparationId,
      actorId: session.actorId,
      sessionHash: session.sessionHash,
      csrfToken,
      approvedBy: session.actorId,
      service: mutations,
    });
    setPrivateHeaders(response);
    const payload = {
      status: result.state,
      preparationId: result.preparationId,
      entity: result.entity,
      operation: result.operation,
      providerEntityId: result.providerEntityId,
      verified: result.receipt.verified === true,
    };
    if (request.accepts(["html", "json"]) === "json") {
      response.json(payload);
      return;
    }
    response.type("html").send(renderResult({
      title: "QuickBooks mutation verified",
      message: `${result.operation} ${result.entity} was executed once and provider evidence was verified.`,
      postingRequestId: result.preparationId,
      state: result.state,
      billId: result.providerEntityId,
    }));
  });

  app.post("/quickbooks/mutation-review/:preparationId/reject", sameOrigin, async (request, response) => {
    if (!mutations) throw new AppError("CONFIGURATION_ERROR", "QuickBooks mutation runtime is not configured.", { httpStatus: 503 });
    const preparationId = request.params.preparationId;
    const rawSession = parseCookie(request, REVIEW_COOKIE);
    const csrfToken = typeof request.body?.csrf_token === "string" ? request.body.csrf_token : undefined;
    if (typeof preparationId !== "string" || !rawSession || !csrfToken) {
      throw new AppError("AUTH_REQUIRED", "QuickBooks review session and CSRF are required.", { httpStatus: 401 });
    }
    const session = await reviews.authenticate(rawSession);
    const result = await reviews.rejectMutation({
      preparationId,
      actorId: session.actorId,
      sessionHash: session.sessionHash,
      csrfToken,
      rejectedBy: session.actorId,
      service: mutations,
    });
    setPrivateHeaders(response);
    if (request.accepts(["html", "json"]) === "json") {
      response.json({ preparationId: result.preparationId, state: result.state });
      return;
    }
    response.type("html").send(renderResult({
      title: "QuickBooks mutation rejected",
      message: "Nothing was written to QuickBooks.",
      postingRequestId: result.preparationId,
      state: result.state,
    }));
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
