import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

// The promoted candidate keeps running and serving traffic under its own name,
// so a redeploy must bring up a differently named candidate beside it. Passing
// the name in is what makes a second promotion possible at all.
const candidateName = process.argv[2] ?? "quickbooks-accounting-mcp-0.6-candidate";
const enabledConfig = "/etc/nginx/sites-enabled/mcp.jiayuanwang.xyz";
const upstreamName = "quickbooks_accounting_mcp_demo";

function dockerInspect(name) {
  return JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
}

const candidate = dockerInspect(candidateName);
const health = candidate?.State?.Health?.Status;
if (candidate?.State?.Running !== true || health !== "healthy") {
  throw new Error(`QuickBooks candidate is not promotable: running=${candidate?.State?.Running === true}, health=${health ?? "missing"}`);
}

const networks = candidate.NetworkSettings?.Networks ?? {};
const networkNames = Object.keys(networks);
if (networkNames.length < 2) {
  throw new Error(`QuickBooks candidate must have separate data and egress networks; found ${networkNames.length}`);
}

const primaryNetwork = candidate.HostConfig?.NetworkMode;
const primaryAttachment = typeof primaryNetwork === "string" ? networks[primaryNetwork] : undefined;
const candidateAddress = primaryAttachment?.IPAddress;
if (typeof candidateAddress !== "string" || candidateAddress.length === 0) {
  throw new Error(`QuickBooks candidate primary network ${primaryNetwork ?? "missing"} has no Docker IPv4 address`);
}

const oauthProbe = [
  "const endpoint='https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';",
  "fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=authorization_code&code=promotion-egress-probe'})",
  ".then(r=>{if(r.status<400||r.status>=500)process.exit(1)})",
  ".catch(()=>process.exit(1))",
].join("");
execFileSync("docker", ["exec", candidateName, "node", "-e", oauthProbe], { stdio: "inherit" });

const targetConfig = realpathSync(enabledConfig);
const original = readFileSync(targetConfig, "utf8");
const upstreamPattern = new RegExp(`upstream\\s+${upstreamName}\\s*\\{[\\s\\S]*?\\}`, "g");
const upstreamMatches = original.match(upstreamPattern) ?? [];
if (upstreamMatches.length !== 1) {
  throw new Error(`Expected exactly one ${upstreamName} upstream; found ${upstreamMatches.length}`);
}

// The first promotion replaced the loopback port; every later one replaces the
// previously promoted container address. Matching only the loopback form made
// this script single-use — it threw "found 0" on the second deploy, exactly
// when a fix most needs to reach production.
const serverPattern = /server\s+[0-9.]+:\d+;/g;
const serverMatches = upstreamMatches[0].match(serverPattern) ?? [];
if (serverMatches.length !== 1) {
  throw new Error(`Expected exactly one QuickBooks upstream server; found ${serverMatches.length}`);
}
if (serverMatches[0] === `server ${candidateAddress}:3000;`) {
  throw new Error(`Upstream already points at ${candidateAddress}:3000; nothing to promote`);
}

const replacementBlock = upstreamMatches[0].replace(serverPattern, `server ${candidateAddress}:3000;`);
const updated = original.replace(upstreamPattern, replacementBlock);
const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
// Never write the backup beside the live config: nginx loads *every* file in
// sites-enabled, so a backup left there is parsed as a second server config and
// `nginx -t` fails with a duplicate log_format before the new upstream is ever
// tested. That turned a routine promotion into a rollback, twice.
const backupDirectory = "/var/backups/quickbooks-mcp-nginx";
mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
const backup = resolve(backupDirectory, `${basename(targetConfig)}.pre-qbo-0.6-${timestamp}`);
const mode = lstatSync(targetConfig).mode;
copyFileSync(targetConfig, backup);

try {
  writeFileSync(targetConfig, updated, { mode });
  execFileSync("nginx", ["-t"], { stdio: "inherit" });
  execFileSync("systemctl", ["reload", "nginx"], { stdio: "inherit" });
} catch (error) {
  copyFileSync(backup, targetConfig);
  try {
    execFileSync("nginx", ["-t"], { stdio: "inherit" });
    execFileSync("systemctl", ["reload", "nginx"], { stdio: "inherit" });
  } catch {}
  throw error;
}

console.log(JSON.stringify({
  status: "QBO_CANDIDATE_PROMOTED",
  candidateId: candidate.Id,
  candidateName,
  candidateAddress,
  previousUpstream: serverMatches[0],
  backup,
}));
