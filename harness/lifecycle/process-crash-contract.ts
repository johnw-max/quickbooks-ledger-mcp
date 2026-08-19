/**
 * Shared contract for the QuickBooks Online ledger MCP process-crash harness.
 *
 * The four boundary ids below are the reviewed lifecycle milestones of one
 * Accounting Case write, taken from the implementation itself:
 *
 *  1. AFTER_CASE_PREPARED_BEFORE_EXECUTION_CLAIM
 *     `QuickBooksAccountingCaseService.prepare` has committed the compiled plan
 *     through `QuickBooksAccountingCaseRepository.createOrAdvance`, and nothing
 *     has called `claimExecution` or `claimForExecution` yet.
 *  2. AFTER_EXECUTION_CLAIM_BEFORE_DISPATCH_MARKER
 *     `QuickBooksMutationRepository.claimForExecution` has written
 *     `state='EXECUTING'`, `execution_attempt_state='CLAIMED'` and a fenced
 *     lease (migration 033), but `markDispatchStarted` has NOT run, so
 *     `dispatch_started_at IS NULL`. This is the only window in which migration
 *     033's trigger still allows the lease to move to another worker.
 *  3. AFTER_DISPATCH_MARKER_BEFORE_PROVIDER_OUTCOME
 *     `markDispatchStarted` committed `dispatch_started_at`
 *     (`execution_attempt_state='DISPATCH_STARTED'`) and the Provider has
 *     received the create POST, but `recordProviderOutcome` has NOT committed
 *     an exact `provider_entity_id`. Per README this must become
 *     `WRITE_RESULT_UNKNOWN_NO_ID` with operator resolution and no re-arm.
 *  4. AFTER_PROVIDER_OUTCOME_BEFORE_DURABLE_COMPLETION
 *     `recordProviderOutcome` committed the exact Provider Id
 *     (`state='PROVIDER_OUTCOME_RECORDED'`, migration 030 checkpoint), but
 *     `completeVerified` has NOT run. Recovery may only move forward through
 *     `recoverMutation` (exact-Id read-back); it may never POST again.
 */

export const QUICKBOOKS_CRASH_BOUNDARY_IDS = [
  "AFTER_CASE_PREPARED_BEFORE_EXECUTION_CLAIM",
  "AFTER_EXECUTION_CLAIM_BEFORE_DISPATCH_MARKER",
  "AFTER_DISPATCH_MARKER_BEFORE_PROVIDER_OUTCOME",
  "AFTER_PROVIDER_OUTCOME_BEFORE_DURABLE_COMPLETION",
] as const;

export type QuickBooksCrashBoundaryId = typeof QUICKBOOKS_CRASH_BOUNDARY_IDS[number];
export type QuickBooksCrashPhase = "initial" | "restart";

export function isQuickBooksCrashBoundaryId(value: unknown): value is QuickBooksCrashBoundaryId {
  return typeof value === "string" &&
    (QUICKBOOKS_CRASH_BOUNDARY_IDS as readonly string[]).includes(value);
}

/**
 * The single number that decides pass/fail is the create-POST count that the
 * PostgreSQL-backed Provider double recorded for the operation.
 *
 * `provider_create_post_count_at_kill` is what a create POST count must be at
 * the instant the kernel delivered SIGKILL; `provider_create_post_count_final`
 * is what it must still be after a second OS process has loaded the same rows,
 * finished whatever it was allowed to finish, and then been asked to execute
 * the same Case one more time.
 */
export interface QuickBooksCrashBoundaryExpectation {
  readonly provider_create_post_count_at_kill: 0 | 1;
  readonly provider_create_post_count_final: 1;
  readonly restart_may_dispatch: boolean;
  readonly terminal_case_state: "TERMINAL" | "RECOVERY_REQUIRED";
  readonly terminal_case_operation_state: "READBACK_VERIFIED" | "WRITE_UNCERTAIN";
  readonly terminal_mutation_state: "POSTED_READBACK_VERIFIED" | "WRITE_RESULT_UNKNOWN_NO_ID";
  readonly terminal_execution_attempt_state: "READBACK_VERIFIED" | "WRITE_RESULT_UNKNOWN_NO_ID";
  readonly operator_resolution_required: boolean;
  readonly automatic_rearm_allowed: false;
}

export const QUICKBOOKS_CRASH_BOUNDARY_EXPECTATIONS: {
  readonly [Boundary in QuickBooksCrashBoundaryId]: QuickBooksCrashBoundaryExpectation;
} = {
  AFTER_CASE_PREPARED_BEFORE_EXECUTION_CLAIM: {
    provider_create_post_count_at_kill: 0,
    provider_create_post_count_final: 1,
    restart_may_dispatch: true,
    terminal_case_state: "TERMINAL",
    terminal_case_operation_state: "READBACK_VERIFIED",
    terminal_mutation_state: "POSTED_READBACK_VERIFIED",
    terminal_execution_attempt_state: "READBACK_VERIFIED",
    operator_resolution_required: false,
    automatic_rearm_allowed: false,
  },
  AFTER_EXECUTION_CLAIM_BEFORE_DISPATCH_MARKER: {
    provider_create_post_count_at_kill: 0,
    provider_create_post_count_final: 1,
    restart_may_dispatch: true,
    terminal_case_state: "TERMINAL",
    terminal_case_operation_state: "READBACK_VERIFIED",
    terminal_mutation_state: "POSTED_READBACK_VERIFIED",
    terminal_execution_attempt_state: "READBACK_VERIFIED",
    operator_resolution_required: false,
    automatic_rearm_allowed: false,
  },
  AFTER_DISPATCH_MARKER_BEFORE_PROVIDER_OUTCOME: {
    provider_create_post_count_at_kill: 1,
    provider_create_post_count_final: 1,
    restart_may_dispatch: false,
    terminal_case_state: "RECOVERY_REQUIRED",
    terminal_case_operation_state: "WRITE_UNCERTAIN",
    terminal_mutation_state: "WRITE_RESULT_UNKNOWN_NO_ID",
    terminal_execution_attempt_state: "WRITE_RESULT_UNKNOWN_NO_ID",
    operator_resolution_required: true,
    automatic_rearm_allowed: false,
  },
  AFTER_PROVIDER_OUTCOME_BEFORE_DURABLE_COMPLETION: {
    provider_create_post_count_at_kill: 1,
    provider_create_post_count_final: 1,
    restart_may_dispatch: false,
    terminal_case_state: "TERMINAL",
    terminal_case_operation_state: "READBACK_VERIFIED",
    terminal_mutation_state: "POSTED_READBACK_VERIFIED",
    terminal_execution_attempt_state: "READBACK_VERIFIED",
    operator_resolution_required: false,
    automatic_rearm_allowed: false,
  },
};

/** Immutable per-run identity shared by the initial and the restart process. */
export interface QuickBooksCrashRunMetadata {
  schema_version: "1.0";
  run_id: string;
  boundary_id: QuickBooksCrashBoundaryId;
  realm_id: string;
  workspace_id: string;
  subject_id: string;
  agent_id: string;
  installation_id: string;
  binding_id: string;
  binding_revision: string;
  connection_id: string;
  connection_ref_safe: string;
  bound_target_ref_safe: string;
  target_session_id: string;
  target_session_ref: string;
  delegation_id: string;
  case_id: string;
  execution_request_id: string;
  display_name: string;
  provider_entity_id: string;
  anchor_at: string;
  target_expires_at: string;
}

/** Durable PostgreSQL state, read back with plain SQL rather than trusted from a process. */
export interface QuickBooksCrashDurableState {
  observed_by_pid: number;
  case_state: string | null;
  case_operation_states: string[];
  case_operation_provider_entity_ids: Array<string | null>;
  mutation_states: string[];
  mutation_execution_attempt_states: Array<string | null>;
  mutation_dispatch_started: boolean[];
  mutation_provider_entity_ids: Array<string | null>;
  mutation_execution_lease_owners: Array<string | null>;
  mutation_execution_claim_sequences: Array<number | null>;
  mutation_execution_lease_expired: Array<boolean | null>;
  mutation_resolution_receipts: Array<Record<string, unknown> | null>;
  provider_create_post_count: number;
  provider_create_accepted_count: number;
  provider_get_count: number;
  provider_object_ids: string[];
  provider_create_post_pids: number[];
  migration_head: string | null;
  applied_migration_count: number;
}

export interface QuickBooksCrashAttemptRecord {
  attempt: number;
  intent: "CONTINUE_AFTER_RESTART" | "CONTINUE_AFTER_LEASE_EXPIRY" | "REPEAT_EXECUTION_PROBE";
  outcome: "COMPLETED" | "REFUSED";
  waited_for_lease_expiry_ms: number | null;
  case_state: string | null;
  case_operation_states: string[];
  ledger_write_claim: string | null;
  error_code: string | null;
  error_message: string | null;
  error_failure_layer: string | null;
  error_reason_codes: string[] | null;
  provider_mutation_possible: boolean | null;
  provider_mutation_retried: boolean | null;
  second_provider_dispatch_allowed: boolean | null;
  automatic_rearm_allowed: boolean | null;
  operator_resolution_required: boolean | null;
  recovery_action: string | null;
  durable_mutation_state: string | null;
  provider_create_post_count_after_attempt: number;
}

export interface QuickBooksCrashScenarioEvidence {
  schema_version: "1.0";
  boundary_id: QuickBooksCrashBoundaryId;
  run_id: string;
  database_name: string;
  case_id: string;
  execution_request_id: string;
  initial_process_pid: number;
  initial_process_crash_window: Record<string, unknown> | null;
  kill_signal_requested: "SIGKILL";
  kill_signal_delivered: string | null;
  initial_process_exit_code: number | null;
  restart_process_pid: number;
  restart_process_exit_code: number | null;
  restart_pid_differs: boolean;
  durable_state_before_kill: QuickBooksCrashDurableState;
  durable_state_after_restart: QuickBooksCrashDurableState;
  restart_attempts: QuickBooksCrashAttemptRecord[];
  terminal_case_state: string | null;
  terminal_case_operation_states: string[];
  terminal_mutation_states: string[];
  terminal_execution_attempt_states: Array<string | null>;
  provider_create_post_count_at_kill: number;
  provider_create_post_count_final: number;
  provider_create_post_pids: number[];
  expected: QuickBooksCrashBoundaryExpectation;
  checks: Record<string, boolean>;
  status: "PASS" | "FAIL";
}

export interface QuickBooksProcessCrashEvidence {
  schema_version: "1.0";
  status: "PASS" | "FAIL";
  captured_at: string;
  supervisor_pid: number;
  node_version: string;
  worker_path: string;
  scenarios: QuickBooksCrashScenarioEvidence[];
}

/**
 * Recomputes every pass/fail check from the recorded scenario numbers alone, so
 * the evidence file can be re-verified without re-running the crash.
 */
export function evaluateQuickBooksCrashScenario(
  scenario: Omit<QuickBooksCrashScenarioEvidence, "checks" | "status">,
): { checks: Record<string, boolean>; status: "PASS" | "FAIL" } {
  const expected = scenario.expected;
  const attempts = scenario.restart_attempts;
  const durable = scenario.durable_state_after_restart;
  const checks: Record<string, boolean> = {
    initial_process_killed_by_sigkill: scenario.kill_signal_delivered === "SIGKILL" &&
      scenario.initial_process_exit_code === null,
    restart_ran_in_a_different_os_process: scenario.restart_pid_differs &&
      scenario.restart_process_pid !== scenario.initial_process_pid,
    restart_process_exited_cleanly: scenario.restart_process_exit_code === 0,
    provider_create_post_count_at_kill_matches:
      scenario.provider_create_post_count_at_kill === expected.provider_create_post_count_at_kill,
    provider_create_post_count_final_matches:
      scenario.provider_create_post_count_final === expected.provider_create_post_count_final,
    provider_never_received_a_second_create_post: scenario.provider_create_post_count_final <= 1,
    durable_provider_object_count_is_one: durable.provider_object_ids.length === 1,
    terminal_case_state_matches: scenario.terminal_case_state === expected.terminal_case_state,
    terminal_case_operation_state_matches:
      scenario.terminal_case_operation_states.length === 1 &&
      scenario.terminal_case_operation_states[0] === expected.terminal_case_operation_state,
    terminal_mutation_state_matches:
      scenario.terminal_mutation_states.length === 1 &&
      scenario.terminal_mutation_states[0] === expected.terminal_mutation_state,
    terminal_execution_attempt_state_matches:
      scenario.terminal_execution_attempt_states.length === 1 &&
      scenario.terminal_execution_attempt_states[0] === expected.terminal_execution_attempt_state,
    restart_dispatched_only_when_permitted: expected.restart_may_dispatch
      ? scenario.provider_create_post_pids.every((pid) => pid === scenario.restart_process_pid)
      : scenario.provider_create_post_pids.every((pid) => pid === scenario.initial_process_pid),
    repeat_execution_probe_added_no_post: attempts
      .filter((attempt) => attempt.intent === "REPEAT_EXECUTION_PROBE")
      .every((attempt) => attempt.provider_create_post_count_after_attempt ===
        scenario.provider_create_post_count_final),
    automatic_rearm_never_claimed: attempts.every((attempt) => attempt.automatic_rearm_allowed !== true),
  };
  if (expected.operator_resolution_required) {
    checks.operator_resolution_required_surfaced = attempts.some((attempt) =>
      attempt.operator_resolution_required === true &&
      attempt.automatic_rearm_allowed === false &&
      attempt.recovery_action === "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM");
    checks.unknown_no_id_resolution_receipt_is_durable = durable.mutation_resolution_receipts.some((receipt) =>
      receipt?.resolution === "WRITE_RESULT_UNKNOWN_NO_ID" &&
      receipt.automaticRearmAllowed === false &&
      receipt.operatorResolutionRequired === true);
  } else {
    checks.reached_a_completed_attempt = attempts.some((attempt) => attempt.outcome === "COMPLETED");
  }
  if (scenario.boundary_id === "AFTER_EXECUTION_CLAIM_BEFORE_DISPATCH_MARKER") {
    // Migration 033 only permits the lease to move while dispatch_started_at is
    // NULL, and only once the previous lease has actually expired.
    checks.stale_lease_was_reclaimed_not_stolen = durable.mutation_execution_claim_sequences
      .some((sequence) => typeof sequence === "number" && sequence >= 2);
    checks.pre_dispatch_refusal_observed_while_lease_was_live = attempts.some((attempt) =>
      attempt.intent === "CONTINUE_AFTER_RESTART" && attempt.outcome === "REFUSED" &&
      attempt.error_failure_layer === "EXECUTION_FENCING");
  }
  if (scenario.boundary_id === "AFTER_DISPATCH_MARKER_BEFORE_PROVIDER_OUTCOME") {
    checks.post_dispatch_lease_never_moved = durable.mutation_execution_claim_sequences
      .every((sequence) => sequence === 1);
    checks.no_exact_provider_id_was_invented = durable.mutation_provider_entity_ids
      .every((value) => value === null);
    // While the crashed worker's lease was still live the restart must refuse
    // and say so; only once the lease is genuinely stale may the durable row
    // move to WRITE_RESULT_UNKNOWN_NO_ID.
    checks.pre_expiry_refusal_forbade_a_second_dispatch = attempts.some((attempt) =>
      attempt.intent === "CONTINUE_AFTER_RESTART" && attempt.outcome === "REFUSED" &&
      attempt.second_provider_dispatch_allowed === false &&
      attempt.automatic_rearm_allowed === false);
    checks.stale_post_dispatch_attempt_became_unknown_no_id = attempts.some((attempt) =>
      attempt.intent === "CONTINUE_AFTER_LEASE_EXPIRY" &&
      attempt.error_code === "WRITE_RESULT_UNKNOWN_NO_ID");
    checks.repeat_probe_after_resolution_stayed_unknown_no_id = attempts.some((attempt) =>
      attempt.intent === "REPEAT_EXECUTION_PROBE" &&
      attempt.error_code === "WRITE_RESULT_UNKNOWN_NO_ID" &&
      attempt.durable_mutation_state === "WRITE_RESULT_UNKNOWN_NO_ID");
  }
  const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
  return { checks, status };
}
