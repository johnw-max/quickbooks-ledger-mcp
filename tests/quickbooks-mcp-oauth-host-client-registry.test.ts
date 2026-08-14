import { describe, expect, it } from "vitest";
import { QuickBooksMcpOAuthHostClientRegistry } from "../src/quickbooks/mcpOAuthHostClientRegistry.js";

const agent2 = {
  name: "Agent2",
  clientId: "agent2-quickbooks",
  clientSecret: "a".repeat(48),
  redirectUris: ["https://agent2.zcloak.ai/api/mcp/qbo/oauth/callback"],
  allowedOrigins: ["https://agent2.zcloak.ai"],
};
const work = {
  name: "Work",
  clientId: "work-quickbooks",
  clientSecret: "w".repeat(48),
  redirectUris: ["https://work.zcloak.ai/api/mcp/qbo/oauth/callback"],
  allowedOrigins: ["https://work.zcloak.ai"],
};

describe("QuickBooks MCP OAuth Host client registry", () => {
  it("resolves authentication, redirect ownership and origin ownership without Host-specific branches", () => {
    const registry = new QuickBooksMcpOAuthHostClientRegistry([agent2, work]);
    expect(registry.size).toBe(2);
    expect(registry.authenticate(agent2.clientId, agent2.clientSecret)).toBe(true);
    expect(registry.authenticate(work.clientId, agent2.clientSecret)).toBe(false);
    expect(registry.hasExactRedirect(agent2.clientId, agent2.redirectUris[0]!)).toBe(true);
    expect(registry.hasExactRedirect(work.clientId, agent2.redirectUris[0]!)).toBe(false);
    expect(registry.isOriginAllowed(work.clientId, work.allowedOrigins[0]!)).toBe(true);
    expect(registry.isOriginAllowed(work.clientId, agent2.allowedOrigins[0]!)).toBe(false);
  });

  it("rejects shared secrets and redirect ownership across clients", () => {
    expect(() => new QuickBooksMcpOAuthHostClientRegistry([
      agent2,
      { ...work, clientSecret: agent2.clientSecret },
    ])).toThrow(/secrets must not be shared/);
    expect(() => new QuickBooksMcpOAuthHostClientRegistry([
      agent2,
      { ...work, redirectUris: agent2.redirectUris },
    ])).toThrow(/one exact Host client owner/);
    expect(() => new QuickBooksMcpOAuthHostClientRegistry([
      agent2,
      { ...work, allowedOrigins: agent2.allowedOrigins },
    ])).toThrow(/origins must have one exact Host client owner/);
  });

  it.each([
    "https://WORK.zcloak.ai/api/mcp/qbo/oauth/callback",
    "https://work.zcloak.ai:443/api/mcp/qbo/oauth/callback",
    "https://work.zcloak.ai/api/mcp/qbo/oauth/callback#fragment",
    "https://user@work.zcloak.ai/api/mcp/qbo/oauth/callback",
  ])("rejects non-canonical or ambiguous redirect %s", (redirectUri) => {
    expect(() => new QuickBooksMcpOAuthHostClientRegistry([
      { ...work, redirectUris: [redirectUri] },
    ])).toThrow(/canonical exact HTTPS/);
  });
});
