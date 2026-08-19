#!/usr/bin/env node
// Interactive MCP stdio driver: keeps ONE server alive and executes numbered
// request files as they appear, so a multi-turn session shares server state.
import { spawn } from "node:child_process";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Derived from this file's own location rather than hardcoded: the Xero
// original this was ported from hardcoded an absolute developer-machine path
// here, which breaks the moment the repo is cloned elsewhere or run from a
// worktree. This file lives at harness/agent-under-test/mcp-driver.mjs, so
// the repo root is two levels up.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stepDir = process.env.STEP_DIR;
const auditPath = process.env.LOCAL_AGENT_SERVER_AUDIT_PATH;
if (!stepDir || !auditPath) throw new Error("STEP_DIR and LOCAL_AGENT_SERVER_AUDIT_PATH required");
await mkdir(stepDir, { recursive: true });

const child = spawn("npx", ["tsx", "harness/local-agents/serve-synthetic-quickbooks-mcp.ts"], {
  cwd: repo, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LOCAL_AGENT_SERVER_AUDIT_PATH: auditPath },
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId += 1;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`RPC_TIMEOUT ${method}`)), 60000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "claude-local-acceptance-driver", version: "1.0.0" },
});
notify("notifications/initialized", {});
const tools = await rpc("tools/list", {});
await writeFile(resolve(stepDir, "000-initialize.json"),
  `${JSON.stringify({ init: init.result, tool_names: (tools.result?.tools ?? []).map((t) => t.name) }, null, 2)}\n`);
console.log("READY tools=" + (tools.result?.tools ?? []).length);

const done = new Set(["000-initialize.json"]);
async function poll() {
  const entries = (await readdir(stepDir)).filter((n) => n.endsWith("-request.json")).sort();
  for (const entry of entries) {
    if (done.has(entry)) continue;
    done.add(entry);
    const spec = JSON.parse(await readFile(resolve(stepDir, entry), "utf8"));
    const started = new Date().toISOString();
    let response;
    try { response = await rpc(spec.method ?? "tools/call", spec.params); }
    catch (error) { response = { error: { message: String(error) } }; }
    const out = entry.replace("-request.json", "-response.json");
    await writeFile(resolve(stepDir, out),
      `${JSON.stringify({ started, spec, response }, null, 2)}\n`);
    console.log(`STEP ${entry} -> ${out}`);
  }
  if (!done.has("STOP")) {
    try { await readFile(resolve(stepDir, "STOP")); child.stdin.end(); process.exit(0); } catch {}
  }
  setTimeout(poll, 700);
}
poll();
