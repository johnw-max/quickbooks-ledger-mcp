/**
 * Supervisor for the QuickBooks Online ledger MCP process-crash / restart
 * harness.
 *
 * For every reviewed lifecycle boundary it:
 *   1. creates a fresh PostgreSQL database and runs the project's own migrations
 *      inside the worker,
 *   2. starts a worker process that drives the real Accounting Case ->
 *      QuickBooksMutationService -> Provider stack until that boundary,
 *   3. reads the durable PostgreSQL state itself,
 *   4. sends a real SIGKILL and waits for the kernel-reported signal exit,
 *   5. starts a second, different OS process against the same rows and records
 *      exactly what that process was allowed to do,
 *   6. re-reads PostgreSQL and recomputes every check from those numbers.
 *
 * The number that decides pass/fail is the create-POST count recorded by the
 * PostgreSQL-backed Provider double.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sha256 } from "../../src/security/hash.js";
import {
  evaluateQuickBooksCrashScenario,
  QUICKBOOKS_CRASH_BOUNDARY_EXPECTATIONS,
  QUICKBOOKS_CRASH_BOUNDARY_IDS,
  type QuickBooksCrashAttemptRecord,
  type QuickBooksCrashBoundaryId,
  type QuickBooksCrashDurableState,
  type QuickBooksCrashRunMetadata,
  type QuickBooksCrashScenarioEvidence,
  type QuickBooksProcessCrashEvidence,
} from "./process-crash-contract.js";
import { readQuickBooksCrashDurableState } from "./process-crash-durable-state.js";

const { Pool } = pg;
const supervisorPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(supervisorPath), "..", "..");
const workerPath = resolve(repositoryRoot, "harness/lifecycle/process-crash-worker.ts");
const DEFAULT_EVIDENCE_PATH = resolve(repositoryRoot, "tmp/lifecycle/process-crash-restart.json");
const INITIAL_MILESTONE_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 420_000;

export interface RunProcessCrashRestartOptions {
  /** Any database URL on the target cluster; only its credentials/host are used. */
  databaseUrl?: string;
  boundaries?: readonly QuickBooksCrashBoundaryId[];
  evidencePath?: string;
  keepDatabases?: boolean;
  concurrent?: boolean;
}

interface WorkerEvent extends Record<string, unknown> {
  event?: string;
  pid?: number;
}

function adminConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function scenarioConnectionString(databaseUrl: string, databaseName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error(`CRASH_HARNESS_DATABASE_NAME_INVALID:${value}`);
  return `"${value}"`;
}

function parseJsonLines(text: string, label: string): WorkerEvent[] {
  const events: WorkerEvent[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as WorkerEvent);
    } catch {
      throw new Error(`${label}_JSONL_INVALID_AT_LINE_${index + 1}`);
    }
  }
  return events;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolvePromise, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createMetadata(boundary: QuickBooksCrashBoundaryId, token: string): QuickBooksCrashRunMetadata {
  const anchor = new Date();
  const runId = `${boundary.toLowerCase().replaceAll("_", "-")}-${token}`;
  const short = sha256(runId).slice(0, 32);
  return {
    schema_version: "1.0",
    run_id: runId,
    boundary_id: boundary,
    // A syntactically valid Intuit Realm id; the durable schema enforces the shape.
    realm_id: "9341457701636490",
    workspace_id: `workspace-${token}`,
    subject_id: `user-${token}`,
    agent_id: `agent-${token}`,
    installation_id: `installation-${token}`,
    binding_id: `binding-${token}`,
    binding_revision: `quickbooks-binding-revision:${short}`,
    connection_id: `connection-${token}`,
    connection_ref_safe: `qbc-${token}`,
    bound_target_ref_safe: `qbt-${token}`,
    target_session_id: `target-${token}`,
    target_session_ref: `qbts_v1.${short.slice(0, 16)}.${short.slice(0, 22).padEnd(22, "x")}.${sha256(`${runId}:target`)}`,
    delegation_id: `delegation-${token}`,
    case_id: `crash-case-${token}`,
    execution_request_id: `execute-${token}`,
    display_name: `Crash Harness Customer ${token}`,
    provider_entity_id: `customer-${token}`,
    anchor_at: anchor.toISOString(),
    target_expires_at: new Date(anchor.getTime() + 4 * 60 * 60_000).toISOString(),
  };
}

function workerArguments(boundary: QuickBooksCrashBoundaryId, phase: "initial" | "restart", metadataPath: string) {
  return ["--import", "tsx", workerPath, "--boundary", boundary, "--phase", phase, "--metadata", metadataPath];
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function startInitialWorker(input: {
  boundary: QuickBooksCrashBoundaryId;
  metadataPath: string;
  databaseUrl: string;
}) {
  const child = spawn(process.execPath, workerArguments(input.boundary, "initial", input.metadataPath), {
    cwd: repositoryRoot,
    shell: false,
    env: { ...process.env, TEST_DATABASE_URL: input.databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  const events: WorkerEvent[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  let buffer = "";
  const milestone = new Promise<WorkerEvent>((resolvePromise, rejectPromise) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let event: WorkerEvent;
        try {
          event = JSON.parse(line) as WorkerEvent;
        } catch (error) {
          rejectPromise(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        events.push(event);
        if (event.event === "CRASH_WINDOW_REACHED" && event.boundary_id === input.boundary) resolvePromise(event);
        if (event.event === "PROCESS_ERROR") {
          rejectPromise(new Error(`INITIAL_WORKER_ERROR:${String(event.error_message)}`));
        }
      }
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      rejectPromise(new Error(
        `INITIAL_WORKER_EXITED_BEFORE_SIGKILL:${code ?? "null"}:${signal ?? "none"}:` +
        Buffer.concat(stderr).toString("utf8").trim().slice(0, 800),
      ));
    });
  });
  try {
    const crashWindow = await withTimeout(
      milestone,
      INITIAL_MILESTONE_TIMEOUT_MS,
      `INITIAL_WORKER_MILESTONE_TIMEOUT:${input.boundary}`,
    );
    return { child, crashWindow, events };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function runRestartWorker(input: {
  boundary: QuickBooksCrashBoundaryId;
  metadataPath: string;
  databaseUrl: string;
}) {
  const child = spawn(process.execPath, workerArguments(input.boundary, "restart", input.metadataPath), {
    cwd: repositoryRoot,
    shell: false,
    env: { ...process.env, TEST_DATABASE_URL: input.databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  let exit: { code: number | null; signal: string | null };
  try {
    exit = await withTimeout(waitForExit(child), RESTART_TIMEOUT_MS, `RESTART_WORKER_TIMEOUT:${input.boundary}`);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const events = parseJsonLines(Buffer.concat(stdout).toString("utf8"), "RESTART_WORKER");
  const result = events.find((event) => event.event === "PROCESS_RESULT");
  if (exit.code !== 0 || exit.signal !== null || !result) {
    const failure = events.find((event) => event.event === "PROCESS_ERROR");
    const diagnostic = typeof failure?.error_message === "string"
      ? failure.error_message
      : Buffer.concat(stderr).toString("utf8").trim().slice(0, 800);
    throw new Error(`RESTART_WORKER_FAILED:${exit.code ?? "null"}:${exit.signal ?? "none"}:${diagnostic}`);
  }
  return { pid: child.pid ?? -1, exit, result, events };
}

async function runBoundary(input: {
  boundary: QuickBooksCrashBoundaryId;
  databaseName: string;
  databaseUrl: string;
  scratchDirectory: string;
  token: string;
}): Promise<QuickBooksCrashScenarioEvidence> {
  const metadata = createMetadata(input.boundary, input.token);
  const metadataPath = resolve(input.scratchDirectory, `${input.boundary}.metadata.json`);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  const supervisorPool = new Pool({ connectionString: input.databaseUrl, max: 2 });
  try {
    const initial = await startInitialWorker({
      boundary: input.boundary,
      metadataPath,
      databaseUrl: input.databaseUrl,
    });
    const initialPid = initial.child.pid ?? -1;
    const durableBeforeKill = await readQuickBooksCrashDurableState(supervisorPool, {
      runId: metadata.run_id,
      caseId: metadata.case_id,
      observedByPid: process.pid,
    });
    const exitPromise = waitForExit(initial.child);
    const killDelivered = initial.child.kill("SIGKILL");
    const initialExit = await withTimeout(exitPromise, 30_000, `INITIAL_WORKER_KILL_TIMEOUT:${input.boundary}`);
    if (!killDelivered || initialExit.signal !== "SIGKILL" || initialExit.code !== null) {
      throw new Error(`${input.boundary}_REAL_SIGKILL_FAILED:${initialExit.code ?? "null"}:${initialExit.signal ?? "none"}`);
    }

    const restart = await runRestartWorker({
      boundary: input.boundary,
      metadataPath,
      databaseUrl: input.databaseUrl,
    });
    const durableAfterRestart = await readQuickBooksCrashDurableState(supervisorPool, {
      runId: metadata.run_id,
      caseId: metadata.case_id,
      observedByPid: process.pid,
    });
    const restartAttempts = (restart.result.attempts ?? []) as QuickBooksCrashAttemptRecord[];
    const workerDurableState = restart.result.durable_state as QuickBooksCrashDurableState | undefined;
    if (!workerDurableState ||
      workerDurableState.provider_create_post_count !== durableAfterRestart.provider_create_post_count) {
      throw new Error(`CRASH_HARNESS_DURABLE_STATE_DISAGREEMENT:${input.boundary}`);
    }
    const scenario: Omit<QuickBooksCrashScenarioEvidence, "checks" | "status"> = {
      schema_version: "1.0",
      boundary_id: input.boundary,
      run_id: metadata.run_id,
      database_name: input.databaseName,
      case_id: metadata.case_id,
      execution_request_id: metadata.execution_request_id,
      initial_process_pid: initialPid,
      initial_process_crash_window: initial.crashWindow,
      kill_signal_requested: "SIGKILL",
      kill_signal_delivered: initialExit.signal,
      initial_process_exit_code: initialExit.code,
      restart_process_pid: restart.pid,
      restart_process_exit_code: restart.exit.code,
      restart_pid_differs: restart.pid !== initialPid,
      durable_state_before_kill: durableBeforeKill,
      durable_state_after_restart: durableAfterRestart,
      restart_attempts: restartAttempts,
      terminal_case_state: durableAfterRestart.case_state,
      terminal_case_operation_states: durableAfterRestart.case_operation_states,
      terminal_mutation_states: durableAfterRestart.mutation_states,
      terminal_execution_attempt_states: durableAfterRestart.mutation_execution_attempt_states,
      provider_create_post_count_at_kill: durableBeforeKill.provider_create_post_count,
      provider_create_post_count_final: durableAfterRestart.provider_create_post_count,
      provider_create_post_pids: durableAfterRestart.provider_create_post_pids,
      expected: QUICKBOOKS_CRASH_BOUNDARY_EXPECTATIONS[input.boundary],
    };
    return { ...scenario, ...evaluateQuickBooksCrashScenario(scenario) };
  } finally {
    await supervisorPool.end();
    await rm(metadataPath, { force: true });
  }
}

export async function runQuickBooksProcessCrashRestart(
  options: RunProcessCrashRestartOptions = {},
): Promise<QuickBooksProcessCrashEvidence> {
  const databaseUrl = options.databaseUrl ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const boundaries = options.boundaries ?? QUICKBOOKS_CRASH_BOUNDARY_IDS;
  const evidencePath = options.evidencePath ?? DEFAULT_EVIDENCE_PATH;
  const token = randomBytes(5).toString("hex");
  const scratchDirectory = resolve(repositoryRoot, "tmp/lifecycle", `run-${token}`);
  await mkdir(scratchDirectory, { recursive: true });
  const admin = new Pool({ connectionString: adminConnectionString(databaseUrl), max: 2 });
  const created: string[] = [];
  try {
    const plans = await Promise.all(boundaries.map(async (boundary, index) => {
      const databaseName = `qbo_crash_${token}_${index + 1}`;
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      created.push(databaseName);
      return {
        boundary,
        databaseName,
        databaseUrl: scenarioConnectionString(databaseUrl, databaseName),
        scratchDirectory,
        token: `${token}${index + 1}`,
      };
    }));
    const scenarios: QuickBooksCrashScenarioEvidence[] = [];
    if (options.concurrent === false) {
      for (const plan of plans) scenarios.push(await runBoundary(plan));
    } else {
      scenarios.push(...await Promise.all(plans.map((plan) => runBoundary(plan))));
    }
    const evidence: QuickBooksProcessCrashEvidence = {
      schema_version: "1.0",
      status: scenarios.every((scenario) => scenario.status === "PASS") ? "PASS" : "FAIL",
      captured_at: new Date().toISOString(),
      supervisor_pid: process.pid,
      node_version: process.version,
      worker_path: "harness/lifecycle/process-crash-worker.ts",
      scenarios,
    };
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return evidence;
  } finally {
    if (!options.keepDatabases) {
      // Only databases this run created are ever dropped.
      for (const databaseName of created) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`)
          .catch(() => undefined);
      }
    }
    await admin.end();
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === supervisorPath) {
  const keepDatabases = process.argv.includes("--keep-databases");
  const evidenceIndex = process.argv.indexOf("--evidence");
  const evidencePath = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
  runQuickBooksProcessCrashRestart({
    keepDatabases,
    ...(evidencePath ? { evidencePath: resolve(evidencePath) } : {}),
    concurrent: !process.argv.includes("--sequential"),
  }).then((evidence) => {
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      scenarios: evidence.scenarios.map((scenario) => ({
        boundary_id: scenario.boundary_id,
        initial_process_pid: scenario.initial_process_pid,
        kill_signal_delivered: scenario.kill_signal_delivered,
        restart_process_pid: scenario.restart_process_pid,
        restart_pid_differs: scenario.restart_pid_differs,
        terminal_case_state: scenario.terminal_case_state,
        terminal_mutation_states: scenario.terminal_mutation_states,
        provider_create_post_count_at_kill: scenario.provider_create_post_count_at_kill,
        provider_create_post_count_final: scenario.provider_create_post_count_final,
        status: scenario.status,
        failed_checks: Object.entries(scenario.checks)
          .filter(([, passed]) => !passed).map(([name]) => name),
      })),
    }, null, 2)}\n`);
    process.exitCode = evidence.status === "PASS" ? 0 : 1;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
