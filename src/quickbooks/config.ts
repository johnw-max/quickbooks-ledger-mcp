import { z } from "zod/v4";
import type { QuickBooksEnvironment } from "../providers/quickbooksTypes.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS } from "./accountingCase.js";
import { QUICKBOOKS_WRITE_CAPABILITIES } from "./writePolicy.js";

const csv = z.string().transform((value, context) => {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    context.addIssue({ code: "custom", message: "must contain at least one entry" });
    return z.NEVER;
  }
  return entries;
});

const base64Key = z.string().refine((value) => {
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be a base64-encoded 32-byte key");

const booleanFlag = z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const optionalMinorVersion = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().int().min(1).max(999).optional(),
);

const optionalCsv = z.string().optional().transform((value, context) => {
  if (value === undefined || value.trim() === "") return [];
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    context.addIssue({ code: "custom", message: "must contain at least one entry" });
    return z.NEVER;
  }
  return entries;
});

const exactHttpsRedirectUri = z.string().superRefine((value, context) => {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be an absolute HTTPS URL" });
    return;
  }
  if (
    redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash || redirect.href !== value ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || value.includes("*")
  ) {
    context.addIssue({
      code: "custom",
      message: "must be one canonical exact HTTPS URL without credentials, fragment, wildcard, whitespace, or control characters",
    });
  }
});

const exactHttpsOrigin = z.string().superRefine((value, context) => {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be an absolute HTTPS origin" });
    return;
  }
  if (
    origin.protocol !== "https:" || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash || origin.origin !== value ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || value.includes("*")
  ) {
    context.addIssue({
      code: "custom",
      message: "must be an exact HTTPS origin without path, query, fragment, credentials, wildcard, whitespace, or control characters",
    });
  }
});

const mcpOAuthHostClientSchema = z.object({
  name: z.string().trim().min(1).max(128),
  client_id: z.string().trim().min(8).max(256),
  client_secret: z.string().min(32).max(512).refine((value) =>
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  "must be an exact secret without surrounding whitespace or control characters"),
  redirect_uris: z.array(exactHttpsRedirectUri).min(1),
  allowed_origins: z.array(exactHttpsOrigin).min(1),
}).strict();

const mcpOAuthHostClientsSchema = z.array(mcpOAuthHostClientSchema).min(1).superRefine((clients, context) => {
  const names = new Set<string>();
  const clientIds = new Set<string>();
  const clientSecrets = new Set<string>();
  const redirectOwners = new Map<string, number>();
  const originOwners = new Map<string, number>();
  clients.forEach((client, clientIndex) => {
    const normalizedName = client.name.toLocaleLowerCase("en-US");
    if (names.has(normalizedName)) {
      context.addIssue({ code: "custom", path: [clientIndex, "name"], message: "must be unique" });
    }
    names.add(normalizedName);
    if (clientIds.has(client.client_id)) {
      context.addIssue({ code: "custom", path: [clientIndex, "client_id"], message: "must be unique" });
    }
    clientIds.add(client.client_id);
    if (clientSecrets.has(client.client_secret)) {
      context.addIssue({
        code: "custom",
        path: [clientIndex, "client_secret"],
        message: "must not be shared by multiple Host clients",
      });
    }
    clientSecrets.add(client.client_secret);

    const clientRedirects = new Set<string>();
    client.redirect_uris.forEach((redirectUri, redirectIndex) => {
      if (clientRedirects.has(redirectUri)) {
        context.addIssue({
          code: "custom",
          path: [clientIndex, "redirect_uris", redirectIndex],
          message: "must be unique within a Host client",
        });
      }
      clientRedirects.add(redirectUri);
      const previousOwner = redirectOwners.get(redirectUri);
      if (previousOwner !== undefined && previousOwner !== clientIndex) {
        context.addIssue({
          code: "custom",
          path: [clientIndex, "redirect_uris", redirectIndex],
          message: "must not be registered to more than one Host client",
        });
      }
      redirectOwners.set(redirectUri, clientIndex);
    });

    const origins = new Set<string>();
    client.allowed_origins.forEach((origin, originIndex) => {
      if (origins.has(origin)) {
        context.addIssue({
          code: "custom",
          path: [clientIndex, "allowed_origins", originIndex],
          message: "must be unique within a Host client",
        });
      }
      origins.add(origin);
      const previousOwner = originOwners.get(origin);
      if (previousOwner !== undefined && previousOwner !== clientIndex) {
        context.addIssue({
          code: "custom",
          path: [clientIndex, "allowed_origins", originIndex],
          message: "must not be registered to more than one Host client",
        });
      }
      originOwners.set(origin, clientIndex);
    });
  });
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  QUICKBOOKS_HOST: z.string().min(1).default("127.0.0.1"),
  QUICKBOOKS_PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
  QUICKBOOKS_PUBLIC_BASE_URL: z.string().url().transform((value) => value.replace(/\/$/, "")),
  DATABASE_URL: z.string().min(1),
  QUICKBOOKS_MCP_BEARER_TOKEN: z.string().min(32),
  QUICKBOOKS_MCP_ALLOWED_ORIGINS: csv,
  QUICKBOOKS_MCP_ALLOWED_HOSTS: csv,
  QUICKBOOKS_REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(5_242_880).default(1_048_576),
  QUICKBOOKS_CLIENT_ID: z.string().min(1),
  QUICKBOOKS_CLIENT_SECRET: z.string().min(1),
  QUICKBOOKS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  QUICKBOOKS_MINOR_VERSION: optionalMinorVersion,
  QUICKBOOKS_WRITE_ENABLED: booleanFlag,
  QUICKBOOKS_WRITE_TARGET_MODE: z.enum(["exact_allowlist", "oauth_bound"]).default("exact_allowlist"),
  QUICKBOOKS_ALLOWED_REALM_ID: z.string().regex(/^\d{3,32}$/).optional(),
  QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES: optionalCsv,
  QUICKBOOKS_RESTRICTED_REVIEWER_ACTORS: optionalCsv,
  QUICKBOOKS_STANDING_DELEGATION_ENABLED: booleanFlag,
  QUICKBOOKS_STANDING_DELEGATION_ACTIONS: optionalCsv,
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64: base64Key,
  QUICKBOOKS_DEMO_ACTOR_ID: z.string().min(1).max(128).default("quickbooks-demo-operator"),
  QUICKBOOKS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  QUICKBOOKS_MCP_OAUTH_ENABLED: booleanFlag,
  QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON: z.string().optional(),
  /** @deprecated Single-client compatibility inputs; use HOST_CLIENTS_JSON for new deployments. */
  QUICKBOOKS_MCP_OAUTH_CLIENT_ID: z.string().min(8).max(256).optional(),
  QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET: z.string().min(32).max(512).optional(),
  QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS: optionalCsv,
  QUICKBOOKS_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
  QUICKBOOKS_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3_600).max(31_536_000).default(2_592_000),
  QUICKBOOKS_TARGET_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
});

export interface QuickBooksMcpOAuthHostClientConfig {
  name: string;
  clientId: string;
  clientSecret: string;
  redirectUris: readonly string[];
  allowedOrigins: readonly string[];
}

export interface QuickBooksRuntimeConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  mcpBearerToken: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  requestBodyLimitBytes: number;
  oauth: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    environment: QuickBooksEnvironment;
    minorVersion?: number;
  };
  writeEnabled: boolean;
  writeTargetMode: "exact_allowlist" | "oauth_bound";
  allowedRealmId?: string;
  allowedWriteCapabilities: string[];
  restrictedReviewerActors: string[];
  standingDelegationEnabled: boolean;
  standingDelegationActions: string[];
  targetSessionTtlSeconds: number;
  tokenEncryptionKey: Buffer;
  demoActorId: string;
  logLevel: "debug" | "info" | "warn" | "error";
  mcpOAuth?: {
    resourceUri: string;
    hostClients: readonly QuickBooksMcpOAuthHostClientConfig[];
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  };
}

function invalidMcpOAuthConfiguration(message: string): Error {
  return new Error(`Invalid QuickBooks configuration: ${message}`);
}

function parseMcpOAuthHostClients(value: z.infer<typeof envSchema>): QuickBooksMcpOAuthHostClientConfig[] {
  const registryConfigured = typeof value.QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON === "string" &&
    value.QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON.trim().length > 0;
  const legacyConfigured = Boolean(
    value.QUICKBOOKS_MCP_OAUTH_CLIENT_ID ||
    value.QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET ||
    value.QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS.length,
  );
  if (registryConfigured && legacyConfigured) {
    throw invalidMcpOAuthConfiguration(
      "configure QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON or the deprecated single-client variables, not both",
    );
  }

  let decoded: unknown;
  if (registryConfigured) {
    try {
      decoded = JSON.parse(value.QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON as string) as unknown;
    } catch {
      throw invalidMcpOAuthConfiguration("QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON must be valid JSON");
    }
  } else {
    if (
      !value.QUICKBOOKS_MCP_OAUTH_CLIENT_ID ||
      !value.QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET ||
      value.QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS.length === 0
    ) {
      throw invalidMcpOAuthConfiguration(
        "QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON is required when MCP OAuth is enabled",
      );
    }
    decoded = [{
      name: "Legacy MCP Host",
      client_id: value.QUICKBOOKS_MCP_OAUTH_CLIENT_ID,
      client_secret: value.QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET,
      redirect_uris: value.QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS,
      allowed_origins: [...new Set(value.QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS.map((uri) => {
        try {
          return new URL(uri).origin;
        } catch {
          return uri;
        }
      }))],
    }];
  }

  const parsed = mcpOAuthHostClientsSchema.safeParse(decoded);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) =>
      `QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON.${issue.path.join(".") || "clients"}: ${issue.message}`
    ).join("; ");
    throw invalidMcpOAuthConfiguration(message);
  }
  return parsed.data.map((client) => ({
    name: client.name,
    clientId: client.client_id,
    clientSecret: client.client_secret,
    redirectUris: [...client.redirect_uris],
    allowedOrigins: [...client.allowed_origins],
  }));
}

export function loadQuickBooksConfig(env: NodeJS.ProcessEnv = process.env): QuickBooksRuntimeConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid QuickBooks configuration: ${message}`);
  }
  const value = parsed.data;
  const knownWriteCapabilities = new Set(
    QUICKBOOKS_WRITE_CAPABILITIES.map((capability) => `${capability.operation}:${capability.entity}`),
  );
  const unknownWriteCapabilities = value.QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES
    .filter((capability) => !knownWriteCapabilities.has(capability));
  if (unknownWriteCapabilities.length > 0) {
    throw new Error(`Invalid QuickBooks configuration: unknown write capabilities ${unknownWriteCapabilities.join(", ")}`);
  }
  const releasedCaseActions = new Set<string>(QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS);
  const unknownStandingDelegationActions = value.QUICKBOOKS_STANDING_DELEGATION_ACTIONS
    .filter((action) => !releasedCaseActions.has(action));
  if (unknownStandingDelegationActions.length > 0) {
    throw new Error(
      `Invalid QuickBooks configuration: standing delegation contains unreleased Accounting Case actions ${unknownStandingDelegationActions.join(", ")}`,
    );
  }
  if (value.QUICKBOOKS_STANDING_DELEGATION_ENABLED && value.QUICKBOOKS_STANDING_DELEGATION_ACTIONS.length === 0) {
    throw new Error(
      "Invalid QuickBooks configuration: QUICKBOOKS_STANDING_DELEGATION_ACTIONS is required when standing delegation is enabled",
    );
  }
  const publicUrl = new URL(value.QUICKBOOKS_PUBLIC_BASE_URL);
  if (
    value.NODE_ENV === "production" &&
    (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash ||
      publicUrl.username || publicUrl.password)
  ) {
    throw new Error("Invalid QuickBooks configuration: public base URL must be an HTTPS origin in production");
  }
  if (
    value.QUICKBOOKS_WRITE_ENABLED &&
    value.QUICKBOOKS_WRITE_TARGET_MODE === "exact_allowlist" &&
    !value.QUICKBOOKS_ALLOWED_REALM_ID
  ) {
    throw new Error(
      "Invalid QuickBooks configuration: QUICKBOOKS_ALLOWED_REALM_ID is required when writes are enabled " +
        "and QUICKBOOKS_WRITE_TARGET_MODE is exact_allowlist. Set the realm to pin writes to one company, " +
        "or use oauth_bound to write to whichever company each user authorised.",
    );
  }
  const mcpOAuthHostClients = value.QUICKBOOKS_MCP_OAUTH_ENABLED
    ? parseMcpOAuthHostClients(value)
    : undefined;
  if (mcpOAuthHostClients) {
    const edgeOrigins = new Set(value.QUICKBOOKS_MCP_ALLOWED_ORIGINS);
    const missingOrigins = [...new Set(mcpOAuthHostClients.flatMap((client) => [...client.allowedOrigins]))]
      .filter((origin) => !edgeOrigins.has(origin));
    if (missingOrigins.length > 0) {
      throw invalidMcpOAuthConfiguration(
        `Host client allowed_origins must also be present in QUICKBOOKS_MCP_ALLOWED_ORIGINS: ${missingOrigins.join(", ")}`,
      );
    }
  }
  return {
    nodeEnv: value.NODE_ENV,
    host: value.QUICKBOOKS_HOST,
    port: value.QUICKBOOKS_PORT,
    publicBaseUrl: value.QUICKBOOKS_PUBLIC_BASE_URL,
    databaseUrl: value.DATABASE_URL,
    mcpBearerToken: value.QUICKBOOKS_MCP_BEARER_TOKEN,
    allowedOrigins: value.QUICKBOOKS_MCP_ALLOWED_ORIGINS,
    allowedHosts: value.QUICKBOOKS_MCP_ALLOWED_HOSTS.map((host) => new URL(`http://${host}`).hostname),
    requestBodyLimitBytes: value.QUICKBOOKS_REQUEST_BODY_LIMIT_BYTES,
    oauth: {
      clientId: value.QUICKBOOKS_CLIENT_ID,
      clientSecret: value.QUICKBOOKS_CLIENT_SECRET,
      redirectUri: `${value.QUICKBOOKS_PUBLIC_BASE_URL}/oauth/quickbooks/callback`,
      environment: value.QUICKBOOKS_ENVIRONMENT,
      ...(value.QUICKBOOKS_MINOR_VERSION === undefined ? {} : { minorVersion: value.QUICKBOOKS_MINOR_VERSION }),
    },
    writeEnabled: value.QUICKBOOKS_WRITE_ENABLED,
    writeTargetMode: value.QUICKBOOKS_WRITE_TARGET_MODE,
    ...(value.QUICKBOOKS_ALLOWED_REALM_ID ? { allowedRealmId: value.QUICKBOOKS_ALLOWED_REALM_ID } : {}),
    allowedWriteCapabilities: value.QUICKBOOKS_ALLOWED_WRITE_CAPABILITIES,
    restrictedReviewerActors: value.QUICKBOOKS_RESTRICTED_REVIEWER_ACTORS,
    standingDelegationEnabled: value.QUICKBOOKS_STANDING_DELEGATION_ENABLED,
    standingDelegationActions: value.QUICKBOOKS_STANDING_DELEGATION_ACTIONS,
    targetSessionTtlSeconds: value.QUICKBOOKS_TARGET_SESSION_TTL_SECONDS,
    tokenEncryptionKey: Buffer.from(value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64, "base64"),
    demoActorId: value.QUICKBOOKS_DEMO_ACTOR_ID,
    logLevel: value.QUICKBOOKS_LOG_LEVEL,
    ...(value.QUICKBOOKS_MCP_OAUTH_ENABLED ? {
      mcpOAuth: {
        resourceUri: `${value.QUICKBOOKS_PUBLIC_BASE_URL}/quickbooks/mcp`,
        hostClients: mcpOAuthHostClients as QuickBooksMcpOAuthHostClientConfig[],
        accessTokenTtlSeconds: value.QUICKBOOKS_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenTtlSeconds: value.QUICKBOOKS_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      },
    } : {}),
  };
}
