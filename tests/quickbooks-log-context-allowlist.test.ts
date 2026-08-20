import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `redact()` emits "[REDACTED]" for any context key not on `safeContextKeys`,
 * and every test in this repository injects a mock logger that never redacts.
 * So a log line written with an unlisted key is fully green in CI and useless
 * in production — precisely when someone is reading it to understand a failure.
 *
 * That has happened four times: the post-dispatch write outcome, the MCP
 * rejection reason, the QuickBooks company id on token refresh, and the
 * crash-recovery sweep's own counters. Each was found by eye, after the fact.
 *
 * This closes it structurally. It reads the real source rather than exercising
 * the logger, because the point is to catch a key that no test happens to
 * cover — the only kind that has ever caused the bug.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function allowlistedKeys(): Set<string> {
  const source = readFileSync(join(SRC, "logging.ts"), "utf8");
  const block = source.split("const safeContextKeys = new Set([")[1]?.split("]);")[0];
  if (!block) throw new Error("could not find safeContextKeys in logging.ts");
  return new Set([...block.matchAll(/"([A-Za-z0-9_]+)"/gu)].map((match) => match[1] as string));
}

/** Every key passed as logger context, with the file and line that used it. */
function loggedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith(`${"/"}logging.ts`)) continue;
    const source = readFileSync(file, "utf8");
    const calls = source.matchAll(/#?logger\.(?:warn|info|error|debug)\(\s*[^,]+,\s*\{(.*?)\n\s*\}\s*\)/gsu);
    for (const call of calls) {
      const line = source.slice(0, call.index).split("\n").length;
      const where = `${file.slice(SRC.length + 1)}:${line}`;
      for (const key of (call[1] as string).matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gu)) {
        const name = key[1] as string;
        found.set(name, [...(found.get(name) ?? []), where]);
      }
    }
  }
  return found;
}

describe("QuickBooks log context allowlist", () => {
  it("carries every key any logger call actually passes", () => {
    const allowed = allowlistedKeys();
    const used = loggedKeys();
    expect(used.size).toBeGreaterThan(0);

    const unlisted = [...used.entries()]
      .filter(([key]) => !allowed.has(key))
      .map(([key, sites]) => `${key} (${sites.join(", ")})`);

    // Naming the sites matters: the fix is either to allowlist the key or to
    // rename it to one already there, and you cannot choose without seeing
    // what the line is for.
    expect(unlisted, `these keys print as [REDACTED] in production:\n  ${unlisted.join("\n  ")}`)
      .toEqual([]);
  });

  it("keeps the allowlist to keys something actually logs", () => {
    const allowed = allowlistedKeys();
    const used = new Set(loggedKeys().keys());
    // Structured details assembled elsewhere also flow through redact(), so an
    // allowlisted key with no direct logger call is legitimate. This only
    // asserts the list has not drifted into pure fiction.
    expect([...allowed].some((key) => used.has(key))).toBe(true);
  });
});
