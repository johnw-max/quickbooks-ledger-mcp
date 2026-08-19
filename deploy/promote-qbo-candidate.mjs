import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

const candidateName = "quickbooks-accounting-mcp-0.6-candidate";
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

const serverPattern = /server\s+127\.0\.0\.1:18003;/g;
const serverMatches = upstreamMatches[0].match(serverPattern) ?? [];
if (serverMatches.length !== 1) {
  throw new Error(`Expected exactly one legacy QuickBooks upstream server; found ${serverMatches.length}`);
}

const replacementBlock = upstreamMatches[0].replace(serverPattern, `server ${candidateAddress}:3000;`);
const updated = original.replace(upstreamPattern, replacementBlock);
const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const backup = `${targetConfig}.pre-qbo-0.6-${timestamp}`;
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
  candidateAddress,
  backup,
}));
