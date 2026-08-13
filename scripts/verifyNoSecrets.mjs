import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const excludedDirectories = new Set([".git", "node_modules", "dist", "coverage", "output", "test-results"]);
const findings = [];

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    if (excludedDirectories.has(name)) return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const tokenRules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/u],
];
const secretAssignment = /^\s*(QUICKBOOKS_CLIENT_ID|QUICKBOOKS_CLIENT_SECRET|QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET|QUICKBOOKS_MCP_BEARER_TOKEN|QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64|DATABASE_URL)\s*=\s*(.*)\s*$/u;

for (const path of files(root)) {
  let content;
  try { content = readFileSync(path, "utf8"); } catch { continue; }
  for (const [rule, pattern] of tokenRules) if (pattern.test(content)) findings.push({ file: relative(root, path), rule });
  for (const line of content.split(/\r?\n/u)) {
    const match = secretAssignment.exec(line);
    if (!match) continue;
    const value = match[2]?.trim() ?? "";
    const safeExample = value === "" || value.includes("REPLACE") || /^replace-/u.test(value) ||
      value === "postgres://postgres:postgres@127.0.0.1:5432/accounting_mcp";
    if (!safeExample) findings.push({ file: relative(root, path), rule: `real-${match[1]?.toLowerCase()}` });
  }
}

if (findings.length > 0) {
  console.error(JSON.stringify({ status: "failed", findings }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "passed", check: "repository-secret-scan" }));
