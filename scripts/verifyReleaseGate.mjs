import { spawnSync } from "node:child_process";

const hasDatabase = Boolean(process.env.TEST_DATABASE_URL);
if (!hasDatabase) {
  console.error(JSON.stringify({
    status: "failed",
    gate: "quickbooks-ledger-mcp-0.6.0",
    step: "required-postgres",
    error: "TEST_DATABASE_URL is required; release verification cannot pass with the persistence kernel untested.",
  }));
  process.exit(1);
}
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
steps.push({ name: "required-postgres", command: "npm", args: ["run", "test:postgres:required"] });
// Real SIGKILL/restart evidence for the four write-lifecycle boundaries. It is slow
// (two boundaries wait out a real 120s execution lease and the harness never rewrites
// that clock) but it is the only check that falsifies the at-most-one-provider-POST
// claim. Left outside the gate it stops being run, and the claim quietly becomes prose.
steps.push({ name: "required-process-crash-restart", command: "npm", args: ["run", "test:crash:postgres"] });

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
  postgresIntegration: "passed",
  processCrashRestart: "passed",
  agent2Uat: "not_run_by_local_gate",
}));
