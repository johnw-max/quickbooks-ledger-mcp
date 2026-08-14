import { safeEqual } from "../security/hash.js";
import type { QuickBooksMcpOAuthHostClientConfig } from "./config.js";

function exactString(value: string, minLength: number, maxLength: number): boolean {
  return value.length >= minLength && value.length <= maxLength && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactHttpsRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      !value.includes("*") && url.href === value;
  } catch {
    return false;
  }
}

function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" &&
      !url.search && !url.hash && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * Immutable deployment-owned Host registry. It is the single runtime authority
 * for client authentication, exact redirect ownership, and browser origin
 * ownership; Host names never appear in conditional authorization logic.
 */
export class QuickBooksMcpOAuthHostClientRegistry {
  readonly #clients = new Map<string, Readonly<QuickBooksMcpOAuthHostClientConfig>>();

  constructor(hostClients: readonly QuickBooksMcpOAuthHostClientConfig[]) {
    const secrets = new Set<string>();
    const redirectOwners = new Set<string>();
    const originOwners = new Set<string>();
    for (const candidate of hostClients) {
      if (!exactString(candidate.name, 1, 128)) throw new Error("MCP OAuth Host client names must be bounded exact strings.");
      if (!exactString(candidate.clientId, 8, 256)) throw new Error("MCP OAuth Host client IDs must be bounded exact strings.");
      if (!exactString(candidate.clientSecret, 32, 512)) throw new Error("MCP OAuth Host client secrets must be distinct bounded strings.");
      if (this.#clients.has(candidate.clientId)) throw new Error("MCP OAuth Host client IDs must be unique.");
      if (secrets.has(candidate.clientSecret)) throw new Error("MCP OAuth Host client secrets must not be shared.");
      if (candidate.redirectUris.length === 0 || candidate.allowedOrigins.length === 0) {
        throw new Error("MCP OAuth Host clients require redirect and origin allowlists.");
      }
      const redirects = new Set<string>();
      for (const redirectUri of candidate.redirectUris) {
        if (!exactHttpsRedirectUri(redirectUri)) throw new Error("MCP OAuth redirect URIs must be canonical exact HTTPS URLs.");
        if (redirects.has(redirectUri) || redirectOwners.has(redirectUri)) {
          throw new Error("MCP OAuth redirect URIs must have one exact Host client owner.");
        }
        redirects.add(redirectUri);
        redirectOwners.add(redirectUri);
      }
      const origins = new Set<string>();
      for (const origin of candidate.allowedOrigins) {
        if (!exactHttpsOrigin(origin)) throw new Error("MCP OAuth Host origins must be canonical exact HTTPS origins.");
        if (origins.has(origin)) throw new Error("MCP OAuth Host origins must be unique within a client.");
        if (originOwners.has(origin)) throw new Error("MCP OAuth Host origins must have one exact Host client owner.");
        origins.add(origin);
        originOwners.add(origin);
      }
      secrets.add(candidate.clientSecret);
      this.#clients.set(candidate.clientId, Object.freeze({
        ...candidate,
        redirectUris: Object.freeze([...redirects]),
        allowedOrigins: Object.freeze([...origins]),
      }));
    }
    if (this.#clients.size === 0) throw new Error("At least one MCP OAuth Host client is required.");
  }

  get size(): number {
    return this.#clients.size;
  }

  authenticate(clientId: string, clientSecret: string): boolean {
    const client = this.#clients.get(clientId);
    return Boolean(client && safeEqual(clientSecret, client.clientSecret));
  }

  hasClient(clientId: string): boolean {
    return this.#clients.has(clientId);
  }

  hasExactRedirect(clientId: string, redirectUri: string): boolean {
    return Boolean(this.#clients.get(clientId)?.redirectUris.some((allowed) => safeEqual(allowed, redirectUri)));
  }

  isOriginAllowed(clientId: string, origin: string): boolean {
    return Boolean(this.#clients.get(clientId)?.allowedOrigins.some((allowed) => safeEqual(allowed, origin)));
  }

  allowedOrigins(clientId: string): string[] {
    return [...(this.#clients.get(clientId)?.allowedOrigins ?? [])];
  }

}
