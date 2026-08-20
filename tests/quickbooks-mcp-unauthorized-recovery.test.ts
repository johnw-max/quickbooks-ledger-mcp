import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import type { Logger } from "../src/logging.js";
import type { QuickBooksClientManager } from "../src/quickbooks/clientManager.js";
import type { QuickBooksRuntimeConfig } from "../src/quickbooks/config.js";
import type { QuickBooksConnectionTicketService } from "../src/quickbooks/connectionTicketService.js";
import { createQuickBooksHttpApp } from "../src/quickbooks/httpApp.js";
import { InMemoryQuickBooksMcpOAuthRepository } from "../src/quickbooks/mcpOAuthRepository.js";
import { QuickBooksMcpOAuthService } from "../src/quickbooks/mcpOAuthService.js";
import type { QuickBooksOAuthService } from "../src/quickbooks/oauthService.js";
import { ServerBoundQuickBooksProviderResolver } from "../src/quickbooks/providerResolver.js";
import type { QuickBooksReviewService } from "../src/quickbooks/reviewService.js";
import type { QuickBooksWorkflowService } from "../src/quickbooks/service.js";
import type { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";
import { intuitOAuthTransport, intuitTokenResponse } from "./helpers/intuitOAuthTransport.js";

const PUBLIC_BASE_URL = "https://quickbooks-mcp.example.test";
const HOST_CLIENT_ID = "agent2-quickbooks";
const HOST_SECRET = "a".repeat(48);
const HOST_ORIGIN = "https://agent2.zcloak.ai";
const HOST_REDIRECT = `${HOST_ORIGIN}/api/mcp/quickbooks-accounting-mcp/oauth/callback`;
const RESOURCE_METADATA_URL = `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/quickbooks/mcp`;

function config(): QuickBooksRuntimeConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3011,
    publicBaseUrl: PUBLIC_BASE_URL,
    databaseUrl: "postgres://unused",
    mcpBearerToken: "m".repeat(48),
    allowedOrigins: [HOST_ORIGIN],
    allowedHosts: ["127.0.0.1", "quickbooks-mcp.example.test"],
    requestBodyLimitBytes: 1_048_576,
    oauth: {
      clientId: "intuit-client",
      clientSecret: "intuit-secret",
      redirectUri: `${PUBLIC_BASE_URL}/oauth/quickbooks/callback`,
      environment: "sandbox",
    },
    writeEnabled: false,
    writeTargetMode: "exact_allowlist",
    allowedWriteCapabilities: [],
    restrictedReviewerActors: [],
    standingDelegationEnabled: false,
    standingDelegationActions: [],
    targetSessionTtlSeconds: 900,
    tokenEncryptionKey: Buffer.alloc(32, 2),
    demoActorId: "trusted-qbo-actor",
    logLevel: "error",
  };
}

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Reproduces the production shape: consent completed and the grant is live, but
 * resolving the single active QuickBooks company fails with NOT_CONNECTED.
 */
function disconnectedManager(): QuickBooksClientManager {
  return {
    connect: vi.fn(async (input: { actorId: string; realmId: string }) => ({
      connectionId: "qbc-unconnected",
      actorId: input.actorId,
      realmId: input.realmId,
      companyName: "Sandbox Company A",
      grantedScopes: ["com.intuit.quickbooks.accounting"],
    })),
    resolveSingleConnection: vi.fn(async () => {
      throw new AppError("NOT_CONNECTED", "No active QuickBooks company is connected.", { httpStatus: 409 });
    }),
  } as unknown as QuickBooksClientManager;
}

async function issueAccessToken(manager: QuickBooksClientManager): Promise<{
  broker: QuickBooksMcpOAuthService;
  accessToken: string;
  actorId: string;
}> {
  const broker = new QuickBooksMcpOAuthService({
    repository: new InMemoryQuickBooksMcpOAuthRepository(),
    manager,
    qbo: {
      clientId: "intuit-client",
      clientSecret: "intuit-secret",
      redirectUri: `${PUBLIC_BASE_URL}/oauth/quickbooks/callback`,
      environment: "sandbox",
      request: intuitOAuthTransport({
        token: () => intuitTokenResponse({
          access_token: "intuit-access-a",
          refresh_token: "intuit-refresh-a",
        }),
      }),
    },
    config: {
      resourceUri: `${PUBLIC_BASE_URL}/quickbooks/mcp`,
      hostClients: [{
        name: "Agent2",
        clientId: HOST_CLIENT_ID,
        clientSecret: HOST_SECRET,
        redirectUris: [HOST_REDIRECT],
        allowedOrigins: [HOST_ORIGIN],
      }],
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 86_400,
    },
    cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 4)),
  });
  const started = await broker.startAuthorization({
    clientId: HOST_CLIENT_ID,
    redirectUri: HOST_REDIRECT,
    responseType: "code",
    state: "host-state-a",
    scope: "quickbooks.read",
  });
  const consent = new URL(started.consentUrl);
  const callback = await broker.handleQuickBooksCallback({
    browserCookie: started.browserCookie,
    state: consent.searchParams.get("state") as string,
    code: "intuit-code-a",
    realmId: "9341457658718743",
  });
  const issued = await broker.exchangeAuthorizationCode({
    clientId: HOST_CLIENT_ID,
    clientSecret: HOST_SECRET,
    code: new URL(callback.redirectUrl).searchParams.get("code") as string,
    redirectUri: HOST_REDIRECT,
  });
  return { broker, accessToken: issued.access_token, actorId: callback.actorId as string };
}

async function parseMcp(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    return JSON.parse((data.at(-1) as string).slice(5).trim()) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe("QuickBooks MCP unauthorized-and-unconnected recovery", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
  });

  async function listen(app: ReturnType<typeof createQuickBooksHttpApp>): Promise<string> {
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("challenges an invalid access token with WWW-Authenticate instead of a bare 401", async () => {
    const { broker } = await issueAccessToken(disconnectedManager());
    const appLogger = logger();
    const base = await listen(createQuickBooksHttpApp({
      config: config(),
      workflow: {} as QuickBooksWorkflowService,
      accountingCases: {} as QuickBooksAccountingCaseService,
      oauth: {} as QuickBooksOAuthService,
      connections: { disconnectActiveConnection: vi.fn() },
      mcpOAuth: broker,
      reviews: {} as QuickBooksReviewService,
      tickets: {} as QuickBooksConnectionTicketService,
      readiness: vi.fn().mockResolvedValue(true),
      logger: appLogger,
    }));

    const rejected = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer qba_${"z".repeat(43)}`,
        Origin: HOST_ORIGIN,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(rejected.status).toBe(401);
    // Without this the Host reads the 401 as "refresh and retry" and loops on a
    // refresh token that is still perfectly valid.
    const challenge = rejected.headers.get("www-authenticate") as string;
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);

    // The wire response stays opaque: no token-validity oracle.
    await expect(rejected.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });

    // The internal reason is logged server-side only.
    expect(appLogger.warn).toHaveBeenCalledWith("QuickBooks MCP access token rejected.", expect.objectContaining({
      path: "/quickbooks/mcp",
      errorCode: "AUTH_REQUIRED",
      rejectionReason: "TOKEN_NOT_FOUND",
      tokenIdHash: expect.stringMatching(/^[a-f0-9]{16}$/u),
    }));
  });

  it("keeps the missing-bearer challenge free of an invalid_token error code", async () => {
    const { broker } = await issueAccessToken(disconnectedManager());
    const base = await listen(createQuickBooksHttpApp({
      config: config(),
      workflow: {} as QuickBooksWorkflowService,
      accountingCases: {} as QuickBooksAccountingCaseService,
      oauth: {} as QuickBooksOAuthService,
      connections: { disconnectActiveConnection: vi.fn() },
      mcpOAuth: broker,
      reviews: {} as QuickBooksReviewService,
      tickets: {} as QuickBooksConnectionTicketService,
      readiness: vi.fn().mockResolvedValue(true),
      logger: logger(),
    }));

    const missing = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: HOST_ORIGIN },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(missing.status).toBe(401);
    const challenge = missing.headers.get("www-authenticate") as string;
    expect(challenge).toBe(`Bearer resource_metadata="${RESOURCE_METADATA_URL}"`);
    expect(challenge).not.toContain("error=");
  });

  it("verifies a token whose actor has no connected company instead of folding it into a 401", async () => {
    const manager = disconnectedManager();
    const { broker, accessToken, actorId } = await issueAccessToken(manager);
    const onRejected = vi.fn();

    const verified = await broker.verifyAccessToken(accessToken, onRejected);

    expect(onRejected).not.toHaveBeenCalled();
    expect(verified).toBeDefined();
    expect(verified?.actorId).toBe(actorId);
    expect(verified?.grantedScopes).toEqual(["quickbooks.read"]);
    // The absence is explicit rather than faked.
    expect(verified?.connectionId).toBeUndefined();
    expect(verified?.tenantId).toBeUndefined();
    expect(verified?.bindingId).toBeUndefined();
    expect(verified?.bindingRevision).toBeUndefined();
  });

  it("dispatches quickbooks_connection_status when the token is valid but no company is connected", async () => {
    const manager = disconnectedManager();
    const { broker, actorId, accessToken } = await issueAccessToken(manager);
    const connectUrl = vi.fn().mockResolvedValue({
      url: `${PUBLIC_BASE_URL}/connect/quickbooks?ticket=one-time`,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const resolver = new ServerBoundQuickBooksProviderResolver({ manager, connectUrl });
    const base = await listen(createQuickBooksHttpApp({
      config: config(),
      workflow: {
        connectionStatus: (actor: string) => resolver.connectionStatus(actor),
      } as unknown as QuickBooksWorkflowService,
      accountingCases: {} as QuickBooksAccountingCaseService,
      oauth: {} as QuickBooksOAuthService,
      connections: { disconnectActiveConnection: vi.fn() },
      mcpOAuth: broker,
      reviews: {} as QuickBooksReviewService,
      tickets: {} as QuickBooksConnectionTicketService,
      readiness: vi.fn().mockResolvedValue(true),
      logger: logger(),
    }));

    const status = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        Origin: HOST_ORIGIN,
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "quickbooks_connection_status", arguments: {} },
      }),
    });

    // The transport no longer hides the recovery affordance behind the very
    // condition that affordance exists to fix.
    expect(status.status).toBe(200);
    expect(status.headers.get("www-authenticate")).toBeNull();
    const payload = await parseMcp(status) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    expect(payload.result?.isError).not.toBe(true);
    expect(payload.result?.structuredContent).toMatchObject({
      connection_state: "disconnected",
      result: {
        connected: false,
        connectAction: "CONNECT_COMPANY",
        connectUrl: `${PUBLIC_BASE_URL}/connect/quickbooks?ticket=one-time`,
      },
    });
    expect(connectUrl).toHaveBeenCalledWith(actorId);
  });
});
