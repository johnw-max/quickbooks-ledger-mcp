/**
 * Child process for the real PostgreSQL QuickBooks Accounting Case
 * crash/restart harness.
 *
 * The supervisor deliberately SIGKILLs this process at one reviewed lifecycle
 * boundary (see `process-crash-contract.ts`). A second OS process then loads the
 * same PostgreSQL rows and tries to continue the same Accounting Case with the
 * same immutable execution request id. The only fake is the QuickBooks provider
 * SDK boundary, and its object ledger plus its create-POST call log are
 * PostgreSQL tables, so Provider acceptance survives process death. A Provider
 * double whose call log lived in memory would prove nothing about a crash.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { toSafeError } from "../../src/errors.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES } from "../../src/quickbooks/accountingCase.js";
import type { QuickBooksAccountingCaseRepository } from "../../src/quickbooks/accountingCaseRepository.js";
import { quickBooksPrepareAccountingCaseSchema } from "../../src/quickbooks/accountingCaseSchemas.js";
import { QuickBooksAccountingCaseService } from "../../src/quickbooks/accountingCaseService.js";
import { runQuickBooksMigrations } from "../../src/quickbooks/migrate.js";
import { QuickBooksMutationService } from "../../src/quickbooks/mutationService.js";
import { QuickBooksPostgresAccountingCaseRepository } from "../../src/quickbooks/postgresAccountingCaseRepository.js";
import { QuickBooksPostgresMutationRepository } from "../../src/quickbooks/postgresMutationRepository.js";
import type { QuickBooksProviderCapabilities, QuickBooksProviderResolver } from "../../src/quickbooks/service.js";
import type { RequestContext } from "../../src/security/requestContext.js";
import {
  isQuickBooksCrashBoundaryId,
  type QuickBooksCrashAttemptRecord,
  type QuickBooksCrashBoundaryId,
  type QuickBooksCrashPhase,
  type QuickBooksCrashRunMetadata,
} from "./process-crash-contract.js";
import {
  CRASH_HARNESS_PROVIDER_CALLS_TABLE,
  CRASH_HARNESS_PROVIDER_OBJECTS_TABLE,
  ensureCrashHarnessProviderTables,
  readExecutionLeaseRemainingMs,
  readQuickBooksCrashDurableState,
  waitForExecutionLeaseExpiry,
} from "./process-crash-durable-state.js";

const { Pool } = pg;
const workerPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(workerPath), "..", "..");
const migrationsDirectory = resolve(repositoryRoot, "migrations");
const LEASE_EXPIRY_WAIT_TIMEOUT_MS = 300_000;

interface WorkerArguments {
  boundary: QuickBooksCrashBoundaryId;
  phase: QuickBooksCrashPhase;
  metadataPath: string;
}

function parseArguments(argv: readonly string[]): WorkerArguments {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const boundary = value("--boundary");
  const phase = value("--phase");
  const metadataPath = value("--metadata");
  if (!isQuickBooksCrashBoundaryId(boundary)) throw new Error("CRASH_BOUNDARY_INVALID");
  if (phase !== "initial" && phase !== "restart") throw new Error("CRASH_PHASE_INVALID");
  if (!metadataPath) throw new Error("CRASH_METADATA_REQUIRED");
  return { boundary, phase, metadataPath };
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    schema_version: "1.0",
    captured_at: new Date().toISOString(),
    pid: process.pid,
    ...event,
  })}\n`);
}

/**
 * The supervisor must prove an external SIGKILL. Self-exiting or throwing here
 * would not be acceptable evidence, so the process deliberately stays alive.
 */
function crashWindow(boundary: QuickBooksCrashBoundaryId, details: Record<string, unknown>): Promise<never> {
  emit({ event: "CRASH_WINDOW_REACHED", boundary_id: boundary, ...details });
  return new Promise<never>(() => undefined);
}

function assertMetadata(value: unknown, expected: QuickBooksCrashBoundaryId): QuickBooksCrashRunMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CRASH_METADATA_INVALID");
  const metadata = value as QuickBooksCrashRunMetadata;
  if (metadata.schema_version !== "1.0" || metadata.boundary_id !== expected) {
    throw new Error("CRASH_METADATA_INVALID");
  }
  return metadata;
}

function requestContext(metadata: QuickBooksCrashRunMetadata): RequestContext {
  return {
    requestId: `request-${metadata.run_id}`,
    actorId: `${metadata.workspace_id}:user:${metadata.subject_id}`,
    workspaceId: metadata.workspace_id,
    subjectType: "USER",
    subjectId: metadata.subject_id,
    userId: metadata.subject_id,
    agentId: metadata.agent_id,
    oauthInstallationId: metadata.installation_id,
    bindingId: metadata.binding_id,
    connectionId: metadata.connection_id,
    bindingRevision: 1,
    scopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
    roles: [],
    authn: {
      issuer: "https://quickbooks-mcp.process-crash.invalid",
      subject: `user:${metadata.subject_id}`,
      audience: "https://quickbooks-mcp.process-crash.invalid/mcp",
      tokenId: `token-${metadata.run_id}`,
    },
    legacyDemo: false,
  };
}

function prepareInput(metadata: QuickBooksCrashRunMetadata) {
  return quickBooksPrepareAccountingCaseSchema.parse({
    target_session_ref: metadata.target_session_ref,
    case_id: metadata.case_id,
    expected_version: 0,
    sources: [{
      artifactId: `crash-source-${metadata.run_id}`,
      label: "New customer intake",
      units: [{ unitId: `crash-unit-${metadata.run_id}`, expectedFactKinds: ["CONTACT_CANDIDATE"] }],
    }],
    facts: [{
      factId: `crash-fact-${metadata.run_id}`,
      lineageKey: `crash-contact-${metadata.run_id}`,
      eventKey: `crash-event-${metadata.run_id}`,
      sourceUnitIds: [`crash-unit-${metadata.run_id}`],
      origin: "AGENT_ASSERTED",
      revision: 1,
      kind: "CONTACT_CANDIDATE",
      role: "CUSTOMER",
      displayName: metadata.display_name,
    }],
  });
}

/**
 * PostgreSQL-backed QuickBooks provider double. Only the SDK boundary is faked:
 * the created object and every create POST are durable rows, so a second OS
 * process reads exactly what the first one made the Provider accept.
 */
class DurableCrashHarnessQuickBooksProvider {
  constructor(
    private readonly pool: pg.Pool,
    private readonly metadata: QuickBooksCrashRunMetadata,
    private readonly boundary: QuickBooksCrashBoundaryId,
    private readonly phase: QuickBooksCrashPhase,
  ) {}

  readonly getCompanyContext = async (): Promise<Record<string, unknown>> => ({
    CompanyName: "Crash Harness Company",
    HomeCurrency: { value: "SGD" },
  });

  readonly getCompany = async (): Promise<Record<string, unknown>> => ({
    Id: this.metadata.realm_id,
    CompanyName: "Crash Harness Company",
  });

  /** The Case only creates a contact when no exact active match already exists. */
  readonly searchCustomers = async (): Promise<Record<string, unknown>> => ({ records: [], searchWindow: {} });
  readonly searchVendors = async (): Promise<Record<string, unknown>> => ({ records: [], searchWindow: {} });

  readonly executeMutation = async (
    command: { entity: string; operation: string; payload: Record<string, unknown>; requestId: string },
    _permit: unknown,
    recordProviderOutcome: (outcome: {
      providerEntityId: string;
      receipt: Record<string, unknown>;
    }) => Promise<void>,
    markProviderDispatch: () => Promise<void>,
  ): Promise<{
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  }> => {
    if (this.phase === "initial" && this.boundary === "AFTER_EXECUTION_CLAIM_BEFORE_DISPATCH_MARKER") {
      await crashWindow(this.boundary, {
        ...(await this.#mutationFencingSnapshot()),
        provider_create_post_attempted: false,
      });
    }

    // Written immediately before the first Provider POST, by the production
    // markDispatchStarted CAS on the fenced lease.
    await markProviderDispatch();
    const receipt = await this.#createPost(command);

    if (this.phase === "initial" && this.boundary === "AFTER_DISPATCH_MARKER_BEFORE_PROVIDER_OUTCOME") {
      await crashWindow(this.boundary, {
        ...(await this.#mutationFencingSnapshot()),
        provider_create_post_attempted: true,
        provider_entity_id_checkpointed: false,
      });
    }

    await recordProviderOutcome({ providerEntityId: this.metadata.provider_entity_id, receipt });

    if (this.phase === "initial" && this.boundary === "AFTER_PROVIDER_OUTCOME_BEFORE_DURABLE_COMPLETION") {
      await crashWindow(this.boundary, {
        ...(await this.#mutationFencingSnapshot()),
        provider_create_post_attempted: true,
        provider_entity_id_checkpointed: true,
      });
    }

    const readback = await this.#exactIdReadback(this.metadata.provider_entity_id);
    return { providerEntityId: this.metadata.provider_entity_id, receipt, readback };
  };

  /** Recovery is an exact-Id GET. It must never reach the create path. */
  readonly recoverMutation = async (
    _command: unknown,
    providerEntityId: string,
  ): Promise<{
    providerEntityId: string;
    receipt: Record<string, unknown>;
    readback: Record<string, unknown>;
  }> => {
    const readback = await this.#exactIdReadback(providerEntityId);
    const stored = await this.pool.query<{ receipt: Record<string, unknown> }>(
      `SELECT receipt FROM ${CRASH_HARNESS_PROVIDER_OBJECTS_TABLE}
        WHERE run_id = $1 AND provider_entity_id = $2`,
      [this.metadata.run_id, providerEntityId],
    );
    const receipt = stored.rows[0]?.receipt;
    if (!receipt) throw new Error("CRASH_HARNESS_PROVIDER_RECEIPT_NOT_FOUND");
    return { providerEntityId, receipt, readback };
  };

  async #createPost(command: {
    entity: string;
    operation: string;
    payload: Record<string, unknown>;
    requestId: string;
  }): Promise<Record<string, unknown>> {
    const providerEntityId = this.metadata.provider_entity_id;
    // Logged BEFORE the ledger insert: a second POST is counted even if the
    // Provider then refuses it as a duplicate.
    await this.pool.query(
      `INSERT INTO ${CRASH_HARNESS_PROVIDER_CALLS_TABLE}
         (run_id, process_pid, phase, operation, provider_request_id, provider_entity_id, details)
       VALUES ($1,$2,$3,'CREATE_POST_SENT',$4,$5,$6::jsonb)`,
      [this.metadata.run_id, process.pid, this.phase, command.requestId, providerEntityId,
        JSON.stringify({ entity: command.entity, operation: command.operation, boundary: this.boundary })],
    );
    const document = {
      Id: providerEntityId,
      ...command.payload,
      Active: true,
      domain: "QBO",
      sparse: false,
      SyncToken: "0",
    };
    const receipt = {
      providerRequestId: command.requestId,
      providerEntityId,
      entity: command.entity,
      operation: command.operation,
      realmId: this.metadata.realm_id,
      verified: true,
    };
    const inserted = await this.pool.query(
      `INSERT INTO ${CRASH_HARNESS_PROVIDER_OBJECTS_TABLE}
         (run_id, provider_request_id, entity, provider_entity_id, document, receipt, accepted_by_pid)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
       ON CONFLICT (run_id, provider_request_id) DO NOTHING
       RETURNING provider_entity_id`,
      [this.metadata.run_id, command.requestId, command.entity, providerEntityId,
        JSON.stringify(document), JSON.stringify(receipt), process.pid],
    );
    if (inserted.rowCount !== 1) {
      // The Provider already holds an object for this immutable request. Reaching
      // here at all means a second create POST was dispatched for one operation.
      throw new Error("CRASH_HARNESS_PROVIDER_DOUBLE_CREATE_POST_DETECTED");
    }
    await this.pool.query(
      `INSERT INTO ${CRASH_HARNESS_PROVIDER_CALLS_TABLE}
         (run_id, process_pid, phase, operation, provider_request_id, provider_entity_id, details)
       VALUES ($1,$2,$3,'CREATE_ACCEPTED',$4,$5,$6::jsonb)`,
      [this.metadata.run_id, process.pid, this.phase, command.requestId, providerEntityId,
        JSON.stringify({ boundary: this.boundary })],
    );
    return receipt;
  }

  async #exactIdReadback(providerEntityId: string): Promise<Record<string, unknown>> {
    await this.pool.query(
      `INSERT INTO ${CRASH_HARNESS_PROVIDER_CALLS_TABLE}
         (run_id, process_pid, phase, operation, provider_request_id, provider_entity_id, details)
       VALUES ($1,$2,$3,'GET',NULL,$4,$5::jsonb)`,
      [this.metadata.run_id, process.pid, this.phase, providerEntityId,
        JSON.stringify({ boundary: this.boundary })],
    );
    const found = await this.pool.query<{ document: Record<string, unknown> }>(
      `SELECT document FROM ${CRASH_HARNESS_PROVIDER_OBJECTS_TABLE}
        WHERE run_id = $1 AND provider_entity_id = $2`,
      [this.metadata.run_id, providerEntityId],
    );
    const document = found.rows[0]?.document;
    if (!document) throw new Error("CRASH_HARNESS_PROVIDER_OBJECT_NOT_FOUND");
    return document;
  }

  async #mutationFencingSnapshot(): Promise<Record<string, unknown>> {
    const row = await this.pool.query<{
      preparation_id: string;
      state: string;
      execution_attempt_id: string | null;
      execution_attempt_state: string | null;
      execution_claim_sequence: number | null;
      dispatch_started: boolean;
      provider_entity_id: string | null;
    }>(
      `SELECT preparation_id, state, execution_attempt_id, execution_attempt_state,
              execution_claim_sequence, dispatch_started_at IS NOT NULL AS dispatch_started,
              provider_entity_id
         FROM quickbooks_mutation_preparations ORDER BY created_at LIMIT 1`,
    );
    const found = row.rows[0];
    return {
      mutation_preparation_id: found?.preparation_id ?? null,
      mutation_state: found?.state ?? null,
      execution_attempt_id: found?.execution_attempt_id ?? null,
      execution_attempt_state: found?.execution_attempt_state ?? null,
      execution_claim_sequence: found?.execution_claim_sequence ?? null,
      dispatch_marker_written: found?.dispatch_started ?? null,
      durable_provider_entity_id: found?.provider_entity_id ?? null,
    };
  }
}

function instrumentCaseRepository(
  repository: QuickBooksPostgresAccountingCaseRepository,
  boundary: QuickBooksCrashBoundaryId,
  phase: QuickBooksCrashPhase,
): QuickBooksAccountingCaseRepository {
  const durable = repository as unknown as QuickBooksAccountingCaseRepository;
  return new Proxy(durable, {
    get(target, property, receiver) {
      if (property === "createOrAdvance" && phase === "initial" &&
        boundary === "AFTER_CASE_PREPARED_BEFORE_EXECUTION_CLAIM") {
        return async (...args: Parameters<QuickBooksAccountingCaseRepository["createOrAdvance"]>) => {
          const persisted = await durable.createOrAdvance(...args);
          return crashWindow(boundary, {
            persistence_mode: persisted.mode,
            case_state: persisted.record.state,
            compiled_plan_hash: persisted.record.compiledPlanHash,
            case_operation_states: persisted.record.operations.map((operation) => operation.state),
            execution_claimed: false,
          });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(durable) : value;
    },
  });
}

function buildServices(pool: pg.Pool, metadata: QuickBooksCrashRunMetadata, args: WorkerArguments) {
  const durableCaseRepository = new QuickBooksPostgresAccountingCaseRepository(pool);
  const caseRepository = instrumentCaseRepository(durableCaseRepository, args.boundary, args.phase);
  const provider = new DurableCrashHarnessQuickBooksProvider(pool, metadata, args.boundary, args.phase);
  const resolver: QuickBooksProviderResolver = {
    connectionStatus: async () => ({
      connected: true,
      company: { realmId: metadata.realm_id, name: "Crash Harness Company" },
      scopes: ["com.intuit.quickbooks.accounting"],
      connectionRefSafe: metadata.connection_ref_safe,
      boundTargetRefSafe: metadata.bound_target_ref_safe,
      bindingRevision: metadata.binding_revision,
    }),
    resolve: async () => ({
      realmId: metadata.realm_id,
      companyName: "Crash Harness Company",
      connectionRefSafe: metadata.connection_ref_safe,
      boundTargetRefSafe: metadata.bound_target_ref_safe,
      bindingRevision: metadata.binding_revision,
      targetSessionId: metadata.target_session_id,
      targetSessionExpiresAt: new Date(metadata.target_expires_at),
      provider: provider as unknown as QuickBooksProviderCapabilities,
    }),
  };
  const mutations = new QuickBooksMutationService(
    new QuickBooksPostgresMutationRepository(pool),
    resolver,
    {
      writeEnabled: true,
      writeTargetMode: "exact_allowlist",
      allowedRealmId: metadata.realm_id,
      publicBaseUrl: "https://quickbooks-mcp.process-crash.invalid",
      accountingCaseReleasedCapabilities: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
      standingDelegationProvider: async () => [{
        delegationId: metadata.delegation_id,
        revision: 1,
        status: "ACTIVE",
        providerId: "quickbooks",
        workspaceId: metadata.workspace_id,
        agentId: metadata.agent_id,
        installationId: metadata.installation_id,
        tenantIds: [metadata.realm_id],
        actionIds: ["customer.create_basic"],
      }],
    },
  );
  return { caseService: new QuickBooksAccountingCaseService(caseRepository, resolver, mutations) };
}

function attemptFromError(
  attempt: number,
  intent: QuickBooksCrashAttemptRecord["intent"],
  waitedMs: number | null,
  error: unknown,
  providerCreatePostCount: number,
  durableMutationState: string | null,
): QuickBooksCrashAttemptRecord {
  const safe = toSafeError(error);
  const details = safe.details ?? {};
  const reasonCodes = Array.isArray(details.reasonCodes)
    ? details.reasonCodes.filter((code): code is string => typeof code === "string")
    : Array.isArray(details.denyReasons)
      ? details.denyReasons.filter((code): code is string => typeof code === "string")
      : null;
  return {
    attempt,
    intent,
    outcome: "REFUSED",
    waited_for_lease_expiry_ms: waitedMs,
    case_state: null,
    case_operation_states: [],
    ledger_write_claim: null,
    error_code: safe.code,
    error_message: safe.message,
    error_failure_layer: typeof details.failureLayer === "string" ? details.failureLayer : null,
    error_reason_codes: reasonCodes,
    provider_mutation_possible: typeof details.providerMutationPossible === "boolean"
      ? details.providerMutationPossible : null,
    provider_mutation_retried: typeof details.providerMutationRetried === "boolean"
      ? details.providerMutationRetried : null,
    second_provider_dispatch_allowed: typeof details.secondProviderDispatchAllowed === "boolean"
      ? details.secondProviderDispatchAllowed : null,
    automatic_rearm_allowed: typeof details.automaticRearmAllowed === "boolean"
      ? details.automaticRearmAllowed : null,
    operator_resolution_required: typeof details.operatorResolutionRequired === "boolean"
      ? details.operatorResolutionRequired : null,
    recovery_action: typeof details.recoveryAction === "string" ? details.recoveryAction : null,
    durable_mutation_state: durableMutationState,
    provider_create_post_count_after_attempt: providerCreatePostCount,
  };
}

async function durableMutationState(pool: pg.Pool): Promise<string | null> {
  const row = await pool.query<{ state: string }>(
    "SELECT state FROM quickbooks_mutation_preparations ORDER BY created_at LIMIT 1",
  );
  return row.rows[0]?.state ?? null;
}

async function providerCreatePostCount(pool: pg.Pool, runId: string): Promise<number> {
  const counted = await pool.query<{ create_post_count: string }>(
    `SELECT count(*)::text AS create_post_count FROM ${CRASH_HARNESS_PROVIDER_CALLS_TABLE}
      WHERE run_id = $1 AND operation = 'CREATE_POST_SENT'`,
    [runId],
  );
  return Number(counted.rows[0]?.create_post_count ?? "0");
}

async function runAttempt(
  options: {
    pool: pg.Pool;
    caseService: QuickBooksAccountingCaseService;
    context: RequestContext;
    metadata: QuickBooksCrashRunMetadata;
    attempt: number;
    intent: QuickBooksCrashAttemptRecord["intent"];
    waitedMs: number | null;
  },
): Promise<QuickBooksCrashAttemptRecord> {
  const { pool, metadata } = options;
  try {
    const summary = await options.caseService.execute(options.context, {
      target_session_ref: metadata.target_session_ref,
      case_id: metadata.case_id,
      case_version: 1,
      request_id: metadata.execution_request_id,
    });
    return {
      attempt: options.attempt,
      intent: options.intent,
      outcome: "COMPLETED",
      waited_for_lease_expiry_ms: options.waitedMs,
      case_state: summary.state,
      case_operation_states: summary.operations.map((operation) => operation.state),
      ledger_write_claim: summary.completion_claim.ledger_write_claim,
      error_code: null,
      error_message: null,
      error_failure_layer: null,
      error_reason_codes: null,
      provider_mutation_possible: null,
      provider_mutation_retried: null,
      second_provider_dispatch_allowed: null,
      automatic_rearm_allowed: null,
      operator_resolution_required: null,
      recovery_action: null,
      durable_mutation_state: await durableMutationState(pool),
      provider_create_post_count_after_attempt: await providerCreatePostCount(pool, metadata.run_id),
    };
  } catch (error) {
    return attemptFromError(
      options.attempt,
      options.intent,
      options.waitedMs,
      error,
      await providerCreatePostCount(pool, metadata.run_id),
      await durableMutationState(pool),
    );
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const metadata = assertMetadata(JSON.parse(await readFile(args.metadataPath, "utf8")), args.boundary);
  if (args.phase === "initial") await runQuickBooksMigrations(databaseUrl, migrationsDirectory);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    if (args.phase === "initial") await ensureCrashHarnessProviderTables(pool);
    const context = requestContext(metadata);
    const { caseService } = buildServices(pool, metadata, args);

    emit({
      event: "PROCESS_READY",
      boundary_id: args.boundary,
      phase: args.phase,
      repository_root: repositoryRoot,
      durable_state: await readQuickBooksCrashDurableState(pool, {
        runId: metadata.run_id,
        caseId: metadata.case_id,
        observedByPid: process.pid,
      }),
    });

    if (args.phase === "initial") {
      const prepared = await caseService.prepare(context, prepareInput(metadata));
      emit({
        event: "CASE_PREPARED",
        boundary_id: args.boundary,
        case_state: prepared.state,
        case_version: prepared.case_version,
        persistence_mode: prepared.persistence_mode,
      });
      const executed = await caseService.execute(context, {
        target_session_ref: metadata.target_session_ref,
        case_id: metadata.case_id,
        case_version: 1,
        request_id: metadata.execution_request_id,
      });
      // The initial process is supposed to die inside one of the crash windows.
      // Reaching here means the boundary was never hit, which is a harness bug
      // rather than evidence about the implementation.
      throw new Error(`CRASH_HARNESS_INITIAL_PHASE_COMPLETED_WITHOUT_CRASH:${executed.state}`);
    }

    const attempts: QuickBooksCrashAttemptRecord[] = [];
    attempts.push(await runAttempt({
      pool, caseService, context, metadata, attempt: 1, intent: "CONTINUE_AFTER_RESTART", waitedMs: null,
    }));
    // The decision to wait is taken from durable state, not from the shape of
    // the error: the dead process may still own a live fenced lease. Nothing in
    // this harness rewrites execution_lease_until; the lease has to go stale on
    // PostgreSQL's own clock, and only then does the production claim path get
    // to decide what a stale pre- or post-dispatch attempt is allowed to do.
    if (await readExecutionLeaseRemainingMs(pool) > 0) {
      const waitedMs = await waitForExecutionLeaseExpiry(pool, { timeoutMs: LEASE_EXPIRY_WAIT_TIMEOUT_MS });
      emit({ event: "EXECUTION_LEASE_EXPIRED", boundary_id: args.boundary, waited_ms: waitedMs });
      attempts.push(await runAttempt({
        pool, caseService, context, metadata, attempt: 2, intent: "CONTINUE_AFTER_LEASE_EXPIRY", waitedMs,
      }));
    }
    attempts.push(await runAttempt({
      pool, caseService, context, metadata,
      attempt: attempts.length + 1, intent: "REPEAT_EXECUTION_PROBE", waitedMs: null,
    }));

    emit({
      event: "PROCESS_RESULT",
      boundary_id: args.boundary,
      phase: args.phase,
      attempts,
      durable_state: await readQuickBooksCrashDurableState(pool, {
        runId: metadata.run_id,
        caseId: metadata.case_id,
        observedByPid: process.pid,
      }),
    });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  emit({
    event: "PROCESS_ERROR",
    error_class: error instanceof Error ? error.name : "UnknownError",
    error_message: error instanceof Error ? error.message : String(error),
    error_stack: error instanceof Error ? error.stack ?? null : null,
  });
  process.exitCode = 1;
});
