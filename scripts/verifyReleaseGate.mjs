import { spawnSync } from "node:child_process";

const hasDatabase = Boolean(process.env.TEST_DATABASE_URL);
const nonDatabaseEnv = { ...process.env };
delete nonDatabaseEnv.TEST_DATABASE_URL;
const steps = [
  { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { name: "secret-scan", command: "npm", args: ["run", "verify:no-secrets"] },
  { name: "build", command: "npm", args: ["run", "build"] },
  // DB suites share migration state and must not race under Vitest's ordinary
  // parallel run. The dedicated required-postgres step runs them serially.
  { name: "tests", command: "npm", args: ["test"], env: nonDatabaseEnv },
  { name: "required-http-edge", command: "npm", args: ["run", "test:http:required"] },
  { name: "deployment-static", command: "sh", args: ["deploy/verify-static.sh"] },
];
if (hasDatabase) steps.push({ name: "required-postgres", command: "npm", args: ["run", "test:postgres:required"] });

for (const step of steps) {
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(), env: step.env ?? process.env, stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.error(JSON.stringify({
      status: "failed",
      gate: "quickbooks-ledger-mcp-0.6.0",
      step: step.name,
      exitCode: result.status,
      errorClass: result.error?.name,
    }));
    process.exit(result.status ?? 1);
  }
}
console.log(JSON.stringify({
  status: "passed",
  gate: "quickbooks-ledger-mcp-0.6.0",
  checks: steps.map((step) => step.name),
  postgresIntegration: hasDatabase ? "passed" : "not_run_no_TEST_DATABASE_URL",
  agent2Uat: "not_run_by_local_gate",
}));
