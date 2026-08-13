import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { QuickBooksPostgresPostingRepository } from "../src/quickbooks/postgresRepository.js";

describe("QuickBooks PostgreSQL posting repository", () => {
  it("uses a contiguous, fully typed parameter list for cross-actor same-realm duplicate lookup", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new QuickBooksPostgresPostingRepository({ query } as unknown as Pool);

    await expect(repository.findActiveDuplicate({
      actorId: "actor-a",
      realmId: "9341457658718743",
      sourceSha256: "a".repeat(64),
      vendorId: "41",
      docNumber: "HH-0806-0210-FINAL",
    })).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("realm_id = $1");
    expect(sql).toContain("source_sha256 = $2");
    expect(sql).toContain("payload->>'vendorId' = $3");
    expect(sql).toContain("$4::text IS NOT NULL");
    expect(sql).not.toMatch(/\$5/);
    expect(parameters).toEqual([
      "9341457658718743",
      "a".repeat(64),
      "41",
      "HH-0806-0210-FINAL",
    ]);
  });
});
