import { describe, expect, it } from "vitest";
import { loadQuickBooksConfig } from "../src/quickbooks/config.js";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    QUICKBOOKS_PUBLIC_BASE_URL: "https://quickbooks-mcp.example.test",
    DATABASE_URL: "postgres://unused",
    QUICKBOOKS_MCP_BEARER_TOKEN: "m".repeat(48),
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 7).toString("base64"),
    QUICKBOOKS_MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
    QUICKBOOKS_MCP_ALLOWED_HOSTS: "quickbooks-mcp.example.test",
    QUICKBOOKS_CLIENT_ID: "client-a",
    QUICKBOOKS_CLIENT_SECRET: "secret-a",
    ...overrides,
  };
}

describe("QuickBooks runtime configuration", () => {
  it("defaults to Sandbox with writes closed and exact Agent2 origin", () => {
    const config = loadQuickBooksConfig(env());

    expect(config).toMatchObject({
      publicBaseUrl: "https://quickbooks-mcp.example.test",
      allowedOrigins: ["https://agent2.zcloak.ai"],
      writeEnabled: false,
      targetSessionTtlSeconds: 900,
      oauth: {
        environment: "sandbox",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
      },
    });
    expect(config).not.toHaveProperty("allowedRealmId");
  });

  it("bounds exact-target sessions to a short operational window", () => {
    expect(loadQuickBooksConfig(env({ QUICKBOOKS_TARGET_SESSION_TTL_SECONDS: "300" })))
      .toMatchObject({ targetSessionTtlSeconds: 300 });
    expect(() => loadQuickBooksConfig(env({ QUICKBOOKS_TARGET_SESSION_TTL_SECONDS: "3601" })))
      .toThrow(/QUICKBOOKS_TARGET_SESSION_TTL_SECONDS/);
  });

  it("treats a blank optional minor version as absent", () => {
    const blank = loadQuickBooksConfig(env({ QUICKBOOKS_MINOR_VERSION: "" }));
    const configured = loadQuickBooksConfig(env({ QUICKBOOKS_MINOR_VERSION: "75" }));

    expect(blank.oauth).not.toHaveProperty("minorVersion");
    expect(configured.oauth).toMatchObject({ minorVersion: 75 });
  });

  it("requires an exact realm when writes are enabled", () => {
    expect(() => loadQuickBooksConfig(env({ QUICKBOOKS_WRITE_ENABLED: "true" })))
      .toThrow(/QUICKBOOKS_ALLOWED_REALM_ID/);

    expect(loadQuickBooksConfig(env({
      QUICKBOOKS_WRITE_ENABLED: "true",
      QUICKBOOKS_ALLOWED_REALM_ID: "934145",
      QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES: "CREATE:Customer,CREATE:Invoice",
    }))).toMatchObject({
      writeEnabled: true,
      allowedRealmId: "934145",
      allowedWriteCapabilities: ["CREATE:Customer", "CREATE:Invoice"],
    });

    expect(() => loadQuickBooksConfig(env({
      QUICKBOOKS_WRITE_ENABLED: "true",
      QUICKBOOKS_ALLOWED_REALM_ID: "934145",
      QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES: "POST:Anything",
    }))).toThrow(/unknown write capabilities/);

    expect(loadQuickBooksConfig(env({
      QUICKBOOKS_WRITE_ENABLED: "true",
      QUICKBOOKS_WRITE_TARGET_MODE: "oauth_bound",
    }))).toMatchObject({ writeEnabled: true, writeTargetMode: "oauth_bound" });
  });

  it("requires standing delegation to name only released Accounting Case actions", () => {
    expect(() => loadQuickBooksConfig(env({
      QUICKBOOKS_STANDING_DELEGATION_ENABLED: "true",
    }))).toThrow(/QUICKBOOKS_STANDING_DELEGATION_ACTIONS/);

    expect(() => loadQuickBooksConfig(env({
      QUICKBOOKS_STANDING_DELEGATION_ENABLED: "true",
      QUICKBOOKS_STANDING_DELEGATION_ACTIONS: "payment.create",
    }))).toThrow(/unreleased Accounting Case actions/);

    expect(loadQuickBooksConfig(env({
      QUICKBOOKS_STANDING_DELEGATION_ENABLED: "true",
      QUICKBOOKS_STANDING_DELEGATION_ACTIONS: "invoice.create,bill.create",
    }))).toMatchObject({
      standingDelegationEnabled: true,
      standingDelegationActions: ["invoice.create", "bill.create"],
    });
  });

  it("requires an HTTPS origin in production", () => {
    expect(() => loadQuickBooksConfig(env({
      NODE_ENV: "production",
      QUICKBOOKS_PUBLIC_BASE_URL: "http://quickbooks-mcp.example.test/path",
    }))).toThrow(/HTTPS origin/);
  });

  it("loads isolated Agent2 and Work Host clients without changing the one Intuit redirect", () => {
    const config = loadQuickBooksConfig(env({
      NODE_ENV: "production",
      QUICKBOOKS_MCP_OAUTH_ENABLED: "true",
      QUICKBOOKS_MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai,https://work.zcloak.ai",
      QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON: JSON.stringify([
        {
          name: "Agent2",
          client_id: "agent2-quickbooks",
          client_secret: "a".repeat(48),
          redirect_uris: ["https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
          allowed_origins: ["https://agent2.zcloak.ai"],
        },
        {
          name: "Work",
          client_id: "work-quickbooks",
          client_secret: "w".repeat(48),
          redirect_uris: ["https://work.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
          allowed_origins: ["https://work.zcloak.ai"],
        },
      ]),
    }));

    expect(config.oauth.redirectUri).toBe("https://quickbooks-mcp.example.test/oauth/quickbooks/callback");
    expect(config.mcpOAuth).toMatchObject({
      resourceUri: "https://quickbooks-mcp.example.test/quickbooks/mcp",
      accessTokenTtlSeconds: 3_600,
      hostClients: [
        {
          clientId: "agent2-quickbooks",
          redirectUris: ["https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
          allowedOrigins: ["https://agent2.zcloak.ai"],
        },
        {
          clientId: "work-quickbooks",
          redirectUris: ["https://work.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
          allowedOrigins: ["https://work.zcloak.ai"],
        },
      ],
    });
  });

  it("keeps the deprecated Agent2 single-client environment compatible", () => {
    const config = loadQuickBooksConfig(env({
      NODE_ENV: "production",
      QUICKBOOKS_MCP_OAUTH_ENABLED: "true",
      QUICKBOOKS_MCP_OAUTH_CLIENT_ID: "agent2-quickbooks",
      QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET: "a".repeat(48),
      QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
    }));
    expect(config.mcpOAuth?.hostClients).toMatchObject([{
      name: "Legacy MCP Host",
      clientId: "agent2-quickbooks",
      allowedOrigins: ["https://agent2.zcloak.ai"],
    }]);
    expect(() => loadQuickBooksConfig(env({
      QUICKBOOKS_MCP_OAUTH_ENABLED: "true",
      QUICKBOOKS_MCP_OAUTH_CLIENT_ID: "agent2-quickbooks",
      QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET: "a".repeat(48),
      QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS: "not-a-url",
    }))).toThrow(/HOST_CLIENTS_JSON/);
  });

  it.each([
    ["redirect ownership", {
      clients: [
        { name: "Agent2", client_id: "agent2-client", client_secret: "a".repeat(48) },
        { name: "Work", client_id: "work-client", client_secret: "w".repeat(48) },
      ],
      mutate: (clients: Array<Record<string, unknown>>) => {
        clients[1]!.redirect_uris = clients[0]!.redirect_uris;
      },
      expected: /must not be registered to more than one Host client/,
    }],
    ["secret ownership", {
      clients: [
        { name: "Agent2", client_id: "agent2-client", client_secret: "a".repeat(48) },
        { name: "Work", client_id: "work-client", client_secret: "a".repeat(48) },
      ],
      mutate: () => undefined,
      expected: /must not be shared/,
    }],
    ["origin ownership", {
      clients: [
        { name: "Agent2", client_id: "agent2-client", client_secret: "a".repeat(48) },
        { name: "Work", client_id: "work-client", client_secret: "w".repeat(48) },
      ],
      mutate: (clients: Array<Record<string, unknown>>) => {
        clients[1]!.allowed_origins = clients[0]!.allowed_origins;
      },
      expected: /must not be registered to more than one Host client/,
    }],
  ] as const)("rejects cross-client %s confusion", (_, testCase) => {
    const clients = testCase.clients.map((client, index) => ({
      ...client,
      redirect_uris: [index === 0
        ? "https://agent2.zcloak.ai/api/mcp/qbo/oauth/callback"
        : "https://work.zcloak.ai/api/mcp/qbo/oauth/callback"],
      allowed_origins: [index === 0 ? "https://agent2.zcloak.ai" : "https://work.zcloak.ai"],
    }));
    testCase.mutate(clients);
    expect(() => loadQuickBooksConfig(env({
      QUICKBOOKS_MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai,https://work.zcloak.ai",
      QUICKBOOKS_MCP_OAUTH_ENABLED: "true",
      QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON: JSON.stringify(clients),
    }))).toThrow(testCase.expected);
  });

  it("rejects redirect normalization tricks and Host origins missing from the edge allowlist", () => {
    const host = (redirect: string, origin = "https://work.zcloak.ai") => JSON.stringify([{
      name: "Work",
      client_id: "work-client",
      client_secret: "w".repeat(48),
      redirect_uris: [redirect],
      allowed_origins: [origin],
    }]);
    for (const redirect of [
      "https://work.zcloak.ai/api/mcp/qbo/oauth/callback#fragment",
      "https://work.zcloak.ai/api/mcp/*/oauth/callback",
      "https://user@work.zcloak.ai/api/mcp/qbo/oauth/callback",
      "https://work.zcloak.ai:443/api/mcp/qbo/oauth/callback",
      "https://WORK.zcloak.ai/api/mcp/qbo/oauth/callback",
    ]) {
      expect(() => loadQuickBooksConfig(env({
        QUICKBOOKS_MCP_OAUTH_ENABLED: "true",
        QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON: host(redirect),
      }))).toThrow(/HOST_CLIENTS_JSON/);
    }
    expect(() => loadQuickBooksConfig(env({
      QUICKBOOKS_MCP_OAUTH_ENABLED: "true",
      QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON: host("https://work.zcloak.ai/api/mcp/qbo/oauth/callback"),
    }))).toThrow(/must also be present in QUICKBOOKS_MCP_ALLOWED_ORIGINS/);
  });
});
