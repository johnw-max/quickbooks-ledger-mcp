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

function config(): QuickBooksRuntimeConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3010,
    publicBaseUrl: "https://quickbooks-mcp.example.test",
    databaseUrl: "postgres://unused",
    mcpBearerToken: "m".repeat(48),
    allowedOrigins: ["https://agent2.zcloak.ai"],
    allowedHosts: ["127.0.0.1", "quickbooks-mcp.example.test"],
    requestBodyLimitBytes: 1_048_576,
    oauth: {
      clientId: "client-a",
      clientSecret: "secret-a",
      redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
      environment: "sandbox",
    },
    writeEnabled: false,
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
    const mcpOAuth = {
      verifyAccessToken: vi.fn(async (token: string) => token === "oauth-good" ? {
        actorId: "qbo-client-test:user:oauth-user",
        workspaceId: "qbo-client-test",
        subjectId: "oauth-user",
        agentId: "agent2-client",
        installationId: "qbt-token",
        bindingId: "qbob-binding",
        bindingRevision: 1,
        connectionId: "qbc-connection",
        scopes: ["quickbooks.read", "quickbooks.bill.prepare"],
        tokenId: "token-1",
      } : undefined),
      authenticateClient: vi.fn((clientId: string, clientSecret: string) => clientId === "agent2-client" && clientSecret === "agent2-secret"),
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
      toolCount: 16,
      writeEnabled: false,
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
    expect(connectionStatus).toHaveBeenCalledWith("qbo-client-test:user:oauth-user");
  });
});
