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
  issueQuickBooksSupplierBillProviderWriteTestPermit,
} from "./helpers/quickBooksProviderWritePermit.js";
import type { QuickBooksSupplierBillInput } from "../src/providers/quickbooksTypes.js";

const command: QuickBooksProviderMutationCommand = {
  entity: "Vendor",
  operation: "UPDATE",
  payload: { DisplayName: "OfficeHub Pte Ltd" },
  targetId: "77",
  syncToken: "3",
  requestId: "zc.vendor.update.permit-001",
};

const supplierBillInput: QuickBooksSupplierBillInput = {
  requestId: "zc.bill.legacy-permit-001",
  sourceRef: "synthetic-invoice.pdf",
  sourceSha256: "a".repeat(64),
  vendorId: "56",
  txnDate: "2026-08-13",
  docNumber: "SYN-001",
  currencyCode: "SGD",
  globalTaxCalculation: "NotApplicable",
  invoiceTotal: "100.00",
  taxTotal: "0.00",
  lines: [{ accountId: "7", amount: "100.00" }],
};

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("QuickBooks provider-write permit architecture", () => {
  it("allows only the two claimed workflow services to import their production issuers", () => {
    const sourceRoot = resolve(import.meta.dirname, "../src");
    const permitModule = resolve(sourceRoot, "security/quickBooksProviderWritePermit.ts");
    const importers = sourceFiles(sourceRoot)
      .filter((path) => path !== permitModule)
      .filter((path) => /issueQuickBooks(?:SupplierBill)?ProviderWritePermit/u.test(readFileSync(path, "utf8")))
      .sort();

    expect(importers).toEqual([
      resolve(sourceRoot, "quickbooks/mutationService.ts"),
      resolve(sourceRoot, "quickbooks/service.ts"),
    ].sort());
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

  it("keeps the two credentialed provider write egresses permit-gated", () => {
    const providerSource = readFileSync(
      resolve(import.meta.dirname, "../src/providers/quickbooksProvider.ts"),
      "utf8",
    );
    expect(providerSource.match(/isWrite:\s*true/gu)).toHaveLength(3);
    expect(providerSource.match(/consumeQuickBooksSupplierBillProviderWritePermit\(permit/gu)).toHaveLength(1);
    expect(providerSource.match(/consumeQuickBooksProviderWritePermit\(permit/gu)).toHaveLength(1);

    const supplierConsumer = providerSource.indexOf("consumeQuickBooksSupplierBillProviderWritePermit(permit");
    const supplierPost = providerSource.indexOf('this.#client.request<BillResponse>("/bill"');
    expect(supplierConsumer).toBeGreaterThan(-1);
    expect(supplierPost).toBeGreaterThan(supplierConsumer);

    const genericConsumer = providerSource.indexOf("consumeQuickBooksProviderWritePermit(permit");
    const genericPost = providerSource.indexOf("method: \"POST\"", genericConsumer);
    expect(genericConsumer).toBeGreaterThan(-1);
    expect(genericPost).toBeGreaterThan(genericConsumer);
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

  it("blocks the legacy supplier-Bill raw writer without its claimed one-shot permit", async () => {
    const request = vi.fn();
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.createApprovedSupplierBill(supplierBillInput, undefined as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { permitReason: "INVALID", providerMutationPossible: false },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("poisons a legacy supplier-Bill permit on payload substitution before validation or provider I/O", async () => {
    const request = vi.fn();
    const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);
    const permit = issueQuickBooksSupplierBillProviderWriteTestPermit(supplierBillInput);
    const substituted = { ...supplierBillInput, docNumber: "SUBSTITUTED" };

    await expect(provider.createApprovedSupplierBill(substituted, permit)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { permitReason: "PAYLOAD_MISMATCH", providerMutationPossible: false },
    });
    await expect(provider.createApprovedSupplierBill(supplierBillInput, permit)).rejects.toMatchObject({
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
