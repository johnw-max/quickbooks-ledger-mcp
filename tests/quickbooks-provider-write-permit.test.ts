import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { QuickBooksClientManager } from "../src/quickbooks/clientManager.js";
import { ServerBoundQuickBooksProviderResolver } from "../src/quickbooks/providerResolver.js";
import type { QuickBooksProviderMutationCommand } from "../src/security/quickBooksProviderWritePermit.js";
import {
  consumeQuickBooksProviderWritePermit,
  issueQuickBooksProviderWritePermit,
  type QuickBooksProviderWritePermit,
} from "../src/security/quickBooksProviderWritePermit.js";
import type { QuickBooksApiClient } from "../src/providers/quickbooksClient.js";
import { QuickBooksAccountingProvider } from "../src/providers/quickbooksProvider.js";
import {
  claimedQuickBooksMutationPreparationFixture,
  issueQuickBooksProviderWriteTestPermit,
} from "./helpers/quickBooksProviderWritePermit.js";

const command: QuickBooksProviderMutationCommand = {
  entity: "Vendor",
  operation: "UPDATE",
  payload: { DisplayName: "OfficeHub Pte Ltd" },
  targetId: "77",
  syncToken: "3",
  requestId: "zc.vendor.update.permit-001",
};

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("QuickBooks provider-write permit architecture", () => {
  it("allows only the claimed mutation service to import the production issuer", () => {
    const sourceRoot = resolve(import.meta.dirname, "../src");
    const permitModule = resolve(sourceRoot, "security/quickBooksProviderWritePermit.ts");
    const importers = sourceFiles(sourceRoot)
      .filter((path) => path !== permitModule)
      .filter((path) => /issueQuickBooksProviderWritePermit/u.test(readFileSync(path, "utf8")))
      .sort();

    expect(importers).toEqual([resolve(sourceRoot, "quickbooks/mutationService.ts")]);
  });

  it("is opaque, process-local and not forgeable by copy or serialisation", () => {
    const permit = issueQuickBooksProviderWriteTestPermit(command);
    expect(Object.keys(permit)).toEqual([]);
    expect(JSON.stringify(permit)).toBe("{}");

    const forged = Object.freeze(Object.create(null)) as QuickBooksProviderWritePermit;
    expect(() => consumeQuickBooksProviderWritePermit(forged, {
      realmId: "934145",
      command,
    })).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "INVALID", providerMutationPossible: false }),
    }));

    const deserialised = JSON.parse(JSON.stringify(permit)) as QuickBooksProviderWritePermit;
    expect(() => consumeQuickBooksProviderWritePermit(deserialised, {
      realmId: "934145",
      command,
    })).toThrow(expect.objectContaining({
      details: expect.objectContaining({ permitReason: "INVALID" }),
    }));
  });

  it("cannot be issued before the durable mutation claim enters EXECUTING", () => {
    const unclaimed = {
      ...claimedQuickBooksMutationPreparationFixture(command),
      state: "PREPARED" as const,
    };
    expect(() => issueQuickBooksProviderWritePermit({ claimedPreparation: unclaimed }))
      .toThrow(expect.objectContaining({
        code: "APPROVAL_INVALID",
        details: expect.objectContaining({ permitReason: "CLAIM_NOT_EXECUTING", providerMutationPossible: false }),
      }));
  });

  it("keeps every credentialed provider write egress behind the single permit gate", () => {
    const providerSource = readFileSync(
      resolve(import.meta.dirname, "../src/providers/quickbooksProvider.ts"),
      "utf8",
    );
    // Both egresses (the mutation POST and its Invoice void fallback) sit inside
    // executeMutation, downstream of the one consumer. A second write lifecycle
    // would show up here as a third isWrite egress with no permit ahead of it.
    expect(providerSource.match(/isWrite:\s*true/gu)).toHaveLength(2);
    expect(providerSource.match(/consumeQuickBooksProviderWritePermit\(permit/gu)).toHaveLength(1);

    const genericConsumer = providerSource.indexOf("consumeQuickBooksProviderWritePermit(permit");
    expect(genericConsumer).toBeGreaterThan(-1);
    for (const egress of [...providerSource.matchAll(/isWrite:\s*true/gu)]) {
      expect(egress.index).toBeGreaterThan(genericConsumer);
    }
  });
});

describe("QuickBooks provider-write permit one-shot claims", () => {
  it("consumes exactly once for the exact provider request and mutation arguments", () => {
    const permit = issueQuickBooksProviderWriteTestPermit(command);
    expect(consumeQuickBooksProviderWritePermit(permit, {
      realmId: "934145",
      command,
    })).toMatchObject({
      providerId: "quickbooks",
      realmId: "934145",
      providerRequestId: command.requestId,
      entity: "Vendor",
      operation: "UPDATE",
    });
    expect(() => consumeQuickBooksProviderWritePermit(permit, {
      realmId: "934145",
      command,
    })).toThrow(expect.objectContaining({
      details: expect.objectContaining({ permitReason: "CONSUMED" }),
    }));
  });

  it.each([
    ["realm", { realmId: "wrong-realm" }, "REALM_MISMATCH"],
    ["provider request", { command: { ...command, requestId: "zc.wrong" } }, "PROVIDER_REQUEST_MISMATCH"],
    ["entity", { command: { ...command, entity: "Customer" as const } }, "ENTITY_MISMATCH"],
    ["operation", { command: { ...command, operation: "DELETE" as const } }, "OPERATION_MISMATCH"],
    ["payload", { command: { ...command, payload: { DisplayName: "Substituted" } } }, "PAYLOAD_MISMATCH"],
    ["target", { command: { ...command, targetId: "78" } }, "TARGET_MISMATCH"],
    ["sync token", { command: { ...command, syncToken: "4" } }, "SYNC_TOKEN_MISMATCH"],
  ] as const)("poisons the permit after a mismatched %s", (_label, override, reason) => {
    const permit = issueQuickBooksProviderWriteTestPermit(command);
    const presented = {
      realmId: "934145",
      command,
      ...override,
    } as { realmId: string; command: QuickBooksProviderMutationCommand };
    expect(() => consumeQuickBooksProviderWritePermit(permit, presented)).toThrow(expect.objectContaining({
      details: expect.objectContaining({ permitReason: reason, providerMutationPossible: false }),
    }));
    expect(() => consumeQuickBooksProviderWritePermit(permit, {
      realmId: "934145",
      command,
    })).toThrow(expect.objectContaining({
      details: expect.objectContaining({ permitReason: "CONSUMED" }),
    }));
  });
});

describe("QuickBooks raw and bound provider write boundaries", () => {
  it("blocks a direct raw-provider bypass before any QuickBooks request", async () => {
    const request = vi.fn();
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.executeMutation(command, undefined as never, async () => undefined,
      async () => undefined)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { permitReason: "INVALID", providerMutationPossible: false },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks a substituted raw-provider payload and poisons that permit", async () => {
    const request = vi.fn();
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    const permit = issueQuickBooksProviderWriteTestPermit(command);
    const substituted = { ...command, payload: { DisplayName: "Substituted" } };

    await expect(provider.executeMutation(substituted, permit, async () => undefined,
      async () => undefined)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { permitReason: "PAYLOAD_MISMATCH", providerMutationPossible: false },
    });
    await expect(provider.executeMutation(command, permit, async () => undefined,
      async () => undefined)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { permitReason: "CONSUMED", providerMutationPossible: false },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks a BoundQuickBooksProvider bypass and never reaches provider I/O", async () => {
    const request = vi.fn();
    const raw = new QuickBooksAccountingProvider(
      { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient,
    );
    const connection = {
      connectionId: "qbc-permit-test",
      realmId: "934145",
      companyName: "Sandbox Company",
      grantedScopes: ["com.intuit.quickbooks.accounting"],
    };
    const manager = {
      resolveSingleConnection: vi.fn(async () => connection),
      withBoundProvider: vi.fn(async (
        _actorId: string,
        _connectionId: string,
        _realmId: string,
        action: (provider: QuickBooksAccountingProvider, selected: typeof connection) => Promise<unknown>,
      ) => action(raw, connection)),
    } as unknown as QuickBooksClientManager;
    const resolver = new ServerBoundQuickBooksProviderResolver({ manager });
    const resolved = await resolver.resolve("actor-a");

    await expect(resolved.provider.executeMutation(command, undefined as never, async () => undefined,
      async () => undefined)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { permitReason: "INVALID", providerMutationPossible: false },
    });
    expect(request).not.toHaveBeenCalled();
  });
});
