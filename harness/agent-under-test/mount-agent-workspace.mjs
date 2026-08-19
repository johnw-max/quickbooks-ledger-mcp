#!/usr/bin/env node
/**
 * Assemble an ephemeral, deployment-equivalent workspace for an agent under
 * test, and start one MCP server it can drive.
 *
 * The agent under test must see exactly what the deployed product agent sees:
 * the mounted instructions and Skills, and the MCP tool surface. It must NOT
 * see the repository, because the real agent cannot. Mounting a copy under a
 * temporary root is what makes that separation checkable rather than merely
 * promised -- any repo path in its transcript is a protocol violation.
 */
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vendoredPackageRoot = resolve(repoRoot, "agent-skills/accounting-double-entry-skills-2026-08-10");
const skillsRoot = resolve(vendoredPackageRoot, "accounting-agent/skills");
const configRoot = resolve(vendoredPackageRoot, "agent-config");

/** Only the Skills a QuickBooks accounting-entry conversation is expected to load. */
const MOUNTED_SKILLS = [
  "prepare-balanced-accounting-entry",
  "execute-approved-accounting-entry",
  "singapore-gst-ledger-mapping",
];

const MOUNTED_CONFIG = [
  "accounting-agent-instructions.md",
  "capability-contract.md",
  "connector-profiles/quickbooks.md",
];

async function assertMountSourceExists(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(
      `Cannot mount ${label}: expected path does not exist:\n  ${path}\n` +
      "The vendored accounting-double-entry-skills package is missing (or was " +
      "checked in at a different path). Nothing was mounted and no server was started.",
    );
  }
}

// Fail loudly and before any side effect if the vendored package this script
// depends on is not in the tree yet -- silently mounting an empty workspace
// would let an agent run "successfully" against no instructions at all.
await assertMountSourceExists(vendoredPackageRoot, "the vendored accounting-double-entry-skills package");
for (const skill of MOUNTED_SKILLS) {
  await assertMountSourceExists(resolve(skillsRoot, skill), `Skill "${skill}"`);
}
for (const file of MOUNTED_CONFIG) {
  await assertMountSourceExists(resolve(configRoot, file), `agent-config file "${file}"`);
}

const workspace = await mkdtemp(resolve(tmpdir(), "quickbooks-agent-under-test-"));
const skillsTarget = resolve(workspace, "skills");
const configTarget = resolve(workspace, "agent-config");
await mkdir(resolve(configTarget, "connector-profiles"), { recursive: true });

for (const skill of MOUNTED_SKILLS) {
  await cp(resolve(skillsRoot, skill), resolve(skillsTarget, skill), { recursive: true });
}
for (const file of MOUNTED_CONFIG) {
  await cp(resolve(configRoot, file), resolve(configTarget, file));
}

const stepDir = resolve(workspace, "steps");
const auditPath = resolve(workspace, "server-audit.json");
await mkdir(stepDir, { recursive: true });

const driver = spawn(
  process.execPath,
  [resolve(repoRoot, "harness/agent-under-test/mcp-driver.mjs")],
  {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, STEP_DIR: stepDir, LOCAL_AGENT_SERVER_AUDIT_PATH: auditPath },
    detached: true,
  },
);
driver.unref();

const manifest = {
  workspace,
  skills: skillsTarget,
  agent_config: configTarget,
  step_dir: stepDir,
  server_audit: auditPath,
  mounted_skills: MOUNTED_SKILLS,
  mounted_config: MOUNTED_CONFIG,
  driver_pid: driver.pid,
};
await writeFile(resolve(workspace, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
