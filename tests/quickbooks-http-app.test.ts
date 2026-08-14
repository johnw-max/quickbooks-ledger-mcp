import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logging.js";
import type { QuickBooksConnectionTicketService } from "../src/quickbooks/connectionTicketService.js";
import type { QuickBooksRuntimeConfig } from "../src/quickbooks/config.js";
import { createQuickBooksHttpApp } from "../src/quickbooks/httpApp.js";
import { QUICKBOOKS_TOOL_ALLOWLIST } from "../src/quickbooks/mcp.js";
import type { QuickBooksOAuthService } from "../src/quickbooks/oauthService.js";
import type { QuickBooksMcpOAuthService } from "../src/quickbooks/mcpOAuthService.js";
import type { QuickBooksReviewService } from "../src/quickbooks/reviewService.js";
import type { QuickBooksWorkflowService } from "../src/quickbooks/service.js";
import type { QuickBooksAccountingCaseService } from "../src/quickbooks/accountingCaseService.js";

function config(): QuickBooksRuntimeConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3010,
    publicBaseUrl: "https://quickbooks-mcp.example.test",
    databaseUrl: "postgres://unused",
    mcpBearerToken: "m".repeat(48),
    allowedOrigins: ["https://agent2.zcloak.ai", "https://work.zcloak.ai"],
    allowedHosts: ["127.0.0.1", "quickbooks-mcp.example.test"],
    requestBodyLimitBytes: 1_048_576,
    oauth: {
      clientId: "client-a",
      clientSecret: "secret-a",
      redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
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

async function parseMcp(response: Response) {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    return JSON.parse((data.at(-1) as string).slice(5).trim()) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe("QuickBooks HTTP and MCP edge", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
  });

  it("serves health, enforces bearer/origin, and advertises only the reviewed tools", async () => {
    const appConfig = config();
    const verifiedToken = (clientId: "agent2-client" | "work-client") => ({
      actorId: `qbo-client-test:user:${clientId}`,
      tokenId: `token-${clientId}`,
      clientId,
      resource: "https://quickbooks-mcp.example.test/quickbooks/mcp",
      audience: "https://quickbooks-mcp.example.test/quickbooks/mcp",
      grantedScopes: ["quickbooks.read", "quickbooks.bill.prepare"],
      issuedAt: new Date("2026-08-06T00:00:00.000Z"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      workspaceId: "qbo-client-test",
      subjectType: "USER" as const,
      subjectId: clientId,
      agentId: clientId,
      installationId: `qbt-${clientId}`,
      bindingId: `qbob-${clientId}`,
      bindingRevision: 1,
      connectionId: `qbc-${clientId}`,
      authorizationId: `qboa-${clientId}`,
      policyId: `qbop-${clientId}`,
      tenantId: clientId === "agent2-client" ? "9341457658718743" : "9341457658718744",
      identityAssurance: "INSTALLATION_ONLY" as const,
      allowedOrigins: [clientId === "agent2-client" ? "https://agent2.zcloak.ai" : "https://work.zcloak.ai"],
    });
    const mcpOAuth = {
      registeredHostClientCount: 2,
      verifyAccessToken: vi.fn(async (token: string) => token === "oauth-good"
        ? verifiedToken("agent2-client")
        : token === "oauth-work"
          ? verifiedToken("work-client")
          : undefined),
      authenticateClient: vi.fn((clientId: string, clientSecret: string) => clientId === "agent2-client" && clientSecret === "agent2-secret"),
      isOriginAllowedForClient: vi.fn((clientId: string, origin: string) =>
        (clientId === "agent2-client" && origin === "https://agent2.zcloak.ai") ||
        (clientId === "work-client" && origin === "https://work.zcloak.ai")
      ),
      startAuthorization: vi.fn().mockResolvedValue({
        consentUrl: "https://appcenter.intuit.com/connect/oauth2?state=opaque",
        browserCookie: `qbf_${"a".repeat(36)}.${"b".repeat(43)}`,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }),
      revoke: vi.fn().mockResolvedValue(undefined),
    } as unknown as QuickBooksMcpOAuthService;
    const connectionStatus = vi.fn().mockResolvedValue({ connected: true, company: { name: "Sandbox" } });
    const app = createQuickBooksHttpApp({
      config: appConfig,
      workflow: { connectionStatus } as unknown as QuickBooksWorkflowService,
      oauth: {} as QuickBooksOAuthService,
      mcpOAuth,
      reviews: {} as QuickBooksReviewService,
      tickets: {} as QuickBooksConnectionTicketService,
      readiness: vi.fn().mockResolvedValue(true),
      logger: logger(),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      provider: "quickbooks-online",
      providerEnvironment: "sandbox",
      toolCount: 16,
      writeEnabled: false,
      registeredHostClientCount: 2,
      readiness: {
        ready: true,
        persistence: { status: "READY", source: "UNSTRUCTURED_CALLBACK" },
        migrations: { status: "NOT_ATTESTED" },
      },
      writeControl: {
        enabled: false,
        targetMode: "exact_allowlist",
        exactTargetConfigured: false,
      },
      releasedActions: { count: 6, hash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      releasedCapabilities: { count: 6, hash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      standingDelegation: { enabled: false, status: "DISABLED", revision: null },
      providerAuthorizationModel: {
        requiredOAuthScope: "com.intuit.quickbooks.accounting",
        dynamicProviderRolesAvailable: false,
        roleAuthoritySource: "PLATFORM_POLICY_NOT_INTUIT_ROLE",
      },
      promotionAssertion: {
        status: "NOT_ASSERTED",
        scope: "RUNTIME_CONFIGURATION_AND_PERSISTENCE_ONLY",
        onlineAgentUatRequired: true,
      },
    });

    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "qbo-test", version: "0.1.0" },
      },
    };
    const missingBearer = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://agent2.zcloak.ai" },
      body: JSON.stringify(initialize),
    });
    expect(missingBearer.status).toBe(401);
    expect(missingBearer.headers.get("www-authenticate")).toContain("resource_metadata");

    const standardMetadata = await fetch(`${base}/.well-known/oauth-authorization-server/quickbooks/oauth`);
    expect(standardMetadata.status).toBe(200);
    await expect(standardMetadata.json()).resolves.toMatchObject({
      issuer: "https://quickbooks-mcp.example.test/quickbooks/oauth",
      revocation_endpoint: "https://quickbooks-mcp.example.test/quickbooks/oauth/revoke",
    });

    const revoke = await fetch(`${base}/quickbooks/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "agent2-client", client_secret: "agent2-secret", token: "opaque-token" }),
    });
    expect(revoke.status).toBe(200);
    expect(mcpOAuth.revoke).toHaveBeenCalledWith({
      clientId: "agent2-client",
      clientSecret: "agent2-secret",
      token: "opaque-token",
    });

    const legacyBearer = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${appConfig.mcpBearerToken}`,
        Origin: "https://agent2.zcloak.ai",
      },
      body: JSON.stringify(initialize),
    });
    expect(legacyBearer.status).toBe(401);

    const wrongOrigin = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer oauth-good",
        Origin: "https://evil.invalid",
      },
      body: JSON.stringify(initialize),
    });
    expect(wrongOrigin.status).toBe(403);

    const crossClientOrigin = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer oauth-work",
        Origin: "https://agent2.zcloak.ai",
      },
      body: JSON.stringify(initialize),
    });
    expect(crossClientOrigin.status).toBe(403);

    const confusedAuthorize = await fetch(
      `${base}/quickbooks/oauth/authorize?client_id=agent2-client&redirect_uri=${encodeURIComponent("https://agent2.zcloak.ai/api/mcp/qbo/oauth/callback")}&response_type=code&state=state-a`,
      { headers: { Origin: "https://work.zcloak.ai" }, redirect: "manual" },
    );
    expect(confusedAuthorize.status).toBe(403);
    expect(mcpOAuth.startAuthorization).not.toHaveBeenCalled();

    const allowedAuthorize = await fetch(
      `${base}/quickbooks/oauth/authorize?client_id=agent2-client&redirect_uri=${encodeURIComponent("https://agent2.zcloak.ai/api/mcp/qbo/oauth/callback")}&response_type=code&state=state-a`,
      { headers: { Origin: "https://agent2.zcloak.ai" }, redirect: "manual" },
    );
    expect(allowedAuthorize.status).toBe(302);
    expect(mcpOAuth.startAuthorization).toHaveBeenCalledTimes(1);

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer oauth-good",
      Origin: "https://agent2.zcloak.ai",
      "MCP-Protocol-Version": "2025-06-18",
    };
    const initialized = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(initialize),
    });
    expect(initialized.status).toBe(200);
    const initializedPayload = await parseMcp(initialized) as { result?: { serverInfo?: { name?: string } } };
    expect(initializedPayload.result?.serverInfo?.name).toBe("zcloak-quickbooks-accounting-mcp");

    const toolsResponse = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(toolsResponse.status).toBe(200);
    const toolsPayload = await parseMcp(toolsResponse) as { result?: { tools?: Array<{ name: string }> } };
    expect(toolsPayload.result?.tools?.map((tool) => tool.name).sort())
      .toEqual([...QUICKBOOKS_TOOL_ALLOWLIST].sort());

    const statusResponse = await fetch(`${base}/quickbooks/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "quickbooks_connection_status", arguments: {} },
      }),
    });
    expect(statusResponse.status).toBe(200);
    const statusPayload = await parseMcp(statusResponse);
    expect(statusPayload).toMatchObject({
      result: { content: [{ type: "text" }] },
    });
    expect(connectionStatus).toHaveBeenCalledWith("qbo-client-test:user:agent2-client");
  });

  it("removes the legacy supplier-Bill review writer in Accounting Case runtime", async () => {
    const reviews = { authenticate: vi.fn() } as unknown as QuickBooksReviewService;
    const app = createQuickBooksHttpApp({
      config: config(),
      workflow: {} as QuickBooksWorkflowService,
      accountingCases: {} as QuickBooksAccountingCaseService,
      oauth: {} as QuickBooksOAuthService,
      reviews,
      tickets: {} as QuickBooksConnectionTicketService,
      readiness: vi.fn().mockResolvedValue(true),
      logger: logger(),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const getReview = await fetch(`${base}/quickbooks/review/qbp_legacy`, {
      headers: { Cookie: "qbo_review_session=opaque" },
    });
    expect(getReview.status).toBe(404);

    const approve = await fetch(`${base}/quickbooks/review/qbp_legacy/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://quickbooks-mcp.example.test",
        Cookie: "qbo_review_session=opaque",
      },
      body: "csrf_token=opaque",
    });
    expect(approve.status).toBe(404);

    const getMutationReview = await fetch(`${base}/quickbooks/mutation-review/qbm_legacy`, {
      headers: { Cookie: "qbo_review_session=opaque" },
    });
    expect(getMutationReview.status).toBe(404);

    const approveMutation = await fetch(`${base}/quickbooks/mutation-review/qbm_legacy/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://quickbooks-mcp.example.test",
        Cookie: "qbo_review_session=opaque",
      },
      body: "csrf_token=opaque",
    });
    expect(approveMutation.status).toBe(404);
    expect(reviews.authenticate).not.toHaveBeenCalled();
  });
});
