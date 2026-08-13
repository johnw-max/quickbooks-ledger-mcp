import { describe, expect, it } from "vitest";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";
import { QuickBooksTargetSessionService } from "../src/quickbooks/targetSession.js";

const bindingRevision = `quickbooks-binding-revision:${"c".repeat(32)}`;

describe("QuickBooks exact-target sessions", () => {
  it("issues an opaque actor-bound target and verifies its exact binding", () => {
    const now = new Date("2026-08-12T12:00:00.000Z");
    const sessions = new QuickBooksTargetSessionService({
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 7)),
      ttlSeconds: 900,
      now: () => now,
    });
    const issued = sessions.issue({
      actorId: "installation-a",
      connectionId: "qbc_connection_a",
      realmId: "9341457701636490",
      bindingRevision,
    });

    expect(issued.targetSessionRef).toMatch(/^qbts_v1\./);
    expect(issued.targetSessionRef).not.toContain("installation-a");
    expect(issued.targetSessionRef).not.toContain("9341457701636490");
    expect(sessions.verify(issued.targetSessionRef, "installation-a")).toMatchObject({
      actorId: "installation-a",
      connectionId: "qbc_connection_a",
      realmId: "9341457701636490",
      bindingRevision,
    });
  });

  it("fails closed for cross-installation reuse, tampering, and expiry", () => {
    let now = new Date("2026-08-12T12:00:00.000Z");
    const sessions = new QuickBooksTargetSessionService({
      cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 8)),
      ttlSeconds: 60,
      now: () => now,
    });
    const issued = sessions.issue({
      actorId: "installation-a",
      connectionId: "qbc_connection_a",
      realmId: "9341457701636490",
      bindingRevision,
    });

    expect(() => sessions.verify(issued.targetSessionRef, "installation-b")).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const tampered = `${issued.targetSessionRef.slice(0, -1)}${issued.targetSessionRef.endsWith("A") ? "B" : "A"}`;
    expect(() => sessions.verify(tampered, "installation-a")).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
    now = new Date("2026-08-12T12:01:00.000Z");
    expect(() => sessions.verify(issued.targetSessionRef, "installation-a")).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED", retryable: true }),
    );
  });
});
