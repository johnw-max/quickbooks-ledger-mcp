import { beforeAll, describe, expect, it } from "vitest";
import {
  evaluateQuickBooksCrashScenario,
  QUICKBOOKS_CRASH_BOUNDARY_EXPECTATIONS,
  QUICKBOOKS_CRASH_BOUNDARY_IDS,
  type QuickBooksCrashBoundaryId,
  type QuickBooksCrashScenarioEvidence,
  type QuickBooksProcessCrashEvidence,
} from "../harness/lifecycle/process-crash-contract.js";
import { runQuickBooksProcessCrashRestart } from "../harness/lifecycle/run-process-crash-restart.js";

/**
 * Real process-crash evidence for the write completion standard in README.md.
 *
 * Every scenario starts a worker process, lets it reach one reviewed lifecycle
 * boundary, SIGKILLs it for real, and then starts a second OS process against
 * the same PostgreSQL rows. The QuickBooks provider double keeps its object
 * ledger and its create-POST call log in PostgreSQL, so the create-POST count
 * is durable evidence rather than an in-process counter.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("QuickBooks process crash and restart integration", () => {
  let evidence: QuickBooksProcessCrashEvidence | undefined;

  const scenarioFor = (boundary: QuickBooksCrashBoundaryId): QuickBooksCrashScenarioEvidence => {
    const scenario = evidence?.scenarios.find((candidate) => candidate.boundary_id === boundary);
    if (!scenario) throw new Error(`missing crash evidence for ${boundary}`);
    return scenario;
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    evidence = await runQuickBooksProcessCrashRestart({ databaseUrl });
  }, 900_000);

  it("kills a real OS process at every reviewed lifecycle boundary and restarts in a different one", () => {
    expect(evidence?.scenarios.map((scenario) => scenario.boundary_id))
      .toEqual([...QUICKBOOKS_CRASH_BOUNDARY_IDS]);
    for (const scenario of evidence?.scenarios ?? []) {
      expect(scenario.kill_signal_requested).toBe("SIGKILL");
      // A kernel-reported signal exit, not a cooperative shutdown.
      expect(scenario.kill_signal_delivered).toBe("SIGKILL");
      expect(scenario.initial_process_exit_code).toBeNull();
      expect(scenario.initial_process_pid).toBeGreaterThan(0);
      expect(scenario.restart_process_pid).toBeGreaterThan(0);
      expect(scenario.restart_pid_differs).toBe(true);
      expect(scenario.restart_process_pid).not.toBe(scenario.initial_process_pid);
      expect(scenario.restart_process_exit_code).toBe(0);
      expect(scenario.initial_process_crash_window).toMatchObject({ boundary_id: scenario.boundary_id });
      // The restart really did reload durable PostgreSQL state.
      expect(scenario.durable_state_after_restart.observed_by_pid).toBeGreaterThan(0);
      expect(scenario.durable_state_after_restart.migration_head)
        .toBe("035_quickbooks_mcp_scope_predispatch_rearm.sql");
    }
  });

  it("never lets the provider receive a second create POST for one operation", () => {
    for (const scenario of evidence?.scenarios ?? []) {
      expect(scenario.provider_create_post_count_final).toBeLessThanOrEqual(1);
      expect(scenario.durable_state_after_restart.provider_object_ids).toHaveLength(1);
      expect(scenario.durable_state_after_restart.provider_create_accepted_count).toBe(1);
      expect(scenario.provider_create_post_pids).toHaveLength(1);
      for (const attempt of scenario.restart_attempts) {
        expect(attempt.provider_create_post_count_after_attempt).toBeLessThanOrEqual(1);
        // Nothing anywhere may claim an automatic re-arm is permitted.
        expect(attempt.automatic_rearm_allowed).not.toBe(true);
      }
    }
    expect(evidence?.status).toBe("PASS");
  });

  it("dispatches no create POST before the dispatch marker and exactly one after it", () => {
    // "0 where it was not dispatched": at the instant of SIGKILL.
    expect(scenarioFor("AFTER_CASE_PREPARED_BEFORE_EXECUTION_CLAIM").provider_create_post_count_at_kill).toBe(0);
    expect(scenarioFor("AFTER_EXECUTION_CLAIM_BEFORE_DISPATCH_MARKER").provider_create_post_count_at_kill).toBe(0);
    expect(scenarioFor("AFTER_DISPATCH_MARKER_BEFORE_PROVIDER_OUTCOME").provider_create_post_count_at_kill).toBe(1);
    expect(scenarioFor("AFTER_PROVIDER_OUTCOME_BEFORE_DURABLE_COMPLETION").provider_create_post_count_at_kill).toBe(1);
    // "exactly 1 where a write was dispatched": after the restart is finished.
    for (const boundary of QUICKBOOKS_CRASH_BOUNDARY_IDS) {
      expect(scenarioFor(boundary).provider_create_post_count_final).toBe(1);
    }
  });

  it("AFTER_CASE_PREPARED_BEFORE_EXECUTION_CLAIM completes the one pending write on restart", () => {
    const scenario = scenarioFor("AFTER_CASE_PREPARED_BEFORE_EXECUTION_CLAIM");
    expect(scenario.durable_state_before_kill.case_state).toBe("PLANNED_NEEDS_PREFLIGHT");
    expect(scenario.durable_state_before_kill.mutation_states).toEqual([]);
    expect(scenario.terminal_case_state).toBe("TERMINAL");
    expect(scenario.terminal_case_operation_states).toEqual(["READBACK_VERIFIED"]);
    expect(scenario.terminal_mutation_states).toEqual(["POSTED_READBACK_VERIFIED"]);
    expect(scenario.terminal_execution_attempt_states).toEqual(["READBACK_VERIFIED"]);
    // The only create POST came from the restart process, not the dead one.
    expect(scenario.provider_create_post_pids).toEqual([scenario.restart_process_pid]);
  });

  it("AFTER_EXECUTION_CLAIM_BEFORE_DISPATCH_MARKER reclaims a stale pre-dispatch lease and still writes once", () => {
    const scenario = scenarioFor("AFTER_EXECUTION_CLAIM_BEFORE_DISPATCH_MARKER");
    expect(scenario.durable_state_before_kill.mutation_states).toEqual(["EXECUTING"]);
    expect(scenario.durable_state_before_kill.mutation_execution_attempt_states).toEqual(["CLAIMED"]);
    expect(scenario.durable_state_before_kill.mutation_dispatch_started).toEqual([false]);
    expect(scenario.durable_state_before_kill.provider_create_post_count).toBe(0);

    const [immediate, afterExpiry] = scenario.restart_attempts;
    // While the dead worker's lease was still live the restart must be fenced out.
    expect(immediate).toMatchObject({
      intent: "CONTINUE_AFTER_RESTART",
      outcome: "REFUSED",
      error_code: "CONFLICT",
      error_failure_layer: "EXECUTION_FENCING",
      provider_create_post_count_after_attempt: 0,
    });
    // Only after the lease genuinely went stale may it move, and only because
    // the dispatch marker was still absent.
    expect(afterExpiry).toMatchObject({
      intent: "CONTINUE_AFTER_LEASE_EXPIRY",
      outcome: "COMPLETED",
      case_state: "TERMINAL",
      provider_create_post_count_after_attempt: 1,
    });
    expect(afterExpiry?.waited_for_lease_expiry_ms ?? 0).toBeGreaterThan(0);
    expect(scenario.durable_state_after_restart.mutation_execution_claim_sequences).toEqual([2]);
    expect(scenario.terminal_case_state).toBe("TERMINAL");
    expect(scenario.terminal_mutation_states).toEqual(["POSTED_READBACK_VERIFIED"]);
    expect(scenario.provider_create_post_pids).toEqual([scenario.restart_process_pid]);
  });

  it("AFTER_DISPATCH_MARKER_BEFORE_PROVIDER_OUTCOME ends in WRITE_RESULT_UNKNOWN_NO_ID with no re-arm", () => {
    const scenario = scenarioFor("AFTER_DISPATCH_MARKER_BEFORE_PROVIDER_OUTCOME");
    expect(scenario.durable_state_before_kill.mutation_execution_attempt_states).toEqual(["DISPATCH_STARTED"]);
    expect(scenario.durable_state_before_kill.mutation_dispatch_started).toEqual([true]);
    expect(scenario.durable_state_before_kill.mutation_provider_entity_ids).toEqual([null]);
    expect(scenario.durable_state_before_kill.provider_create_post_count).toBe(1);

    const [immediate, afterExpiry, repeatProbe] = scenario.restart_attempts;
    // A post-dispatch lease that is still live: refuse and say a second
    // Provider dispatch is not allowed.
    expect(immediate).toMatchObject({
      intent: "CONTINUE_AFTER_RESTART",
      outcome: "REFUSED",
      error_code: "WRITE_RESULT_UNKNOWN",
      error_failure_layer: "PROVIDER_OUTCOME",
      second_provider_dispatch_allowed: false,
      automatic_rearm_allowed: false,
      recovery_action: "WAIT_FOR_ACTIVE_ATTEMPT_OR_STALE_RECONCILIATION",
    });
    // Once stale, the durable row must become WRITE_RESULT_UNKNOWN_NO_ID.
    expect(afterExpiry).toMatchObject({
      intent: "CONTINUE_AFTER_LEASE_EXPIRY",
      outcome: "REFUSED",
      error_code: "WRITE_RESULT_UNKNOWN_NO_ID",
      automatic_rearm_allowed: false,
      operator_resolution_required: true,
      recovery_action: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
      durable_mutation_state: "WRITE_RESULT_UNKNOWN_NO_ID",
    });
    // Asking again is not an automatic re-arm; it stays refused.
    expect(repeatProbe).toMatchObject({
      intent: "REPEAT_EXECUTION_PROBE",
      outcome: "REFUSED",
      error_code: "WRITE_RESULT_UNKNOWN_NO_ID",
      automatic_rearm_allowed: false,
      operator_resolution_required: true,
    });
    expect(scenario.terminal_case_state).toBe("RECOVERY_REQUIRED");
    expect(scenario.terminal_case_operation_states).toEqual(["WRITE_UNCERTAIN"]);
    expect(scenario.terminal_mutation_states).toEqual(["WRITE_RESULT_UNKNOWN_NO_ID"]);
    expect(scenario.terminal_execution_attempt_states).toEqual(["WRITE_RESULT_UNKNOWN_NO_ID"]);
    // No exact Provider Id may be invented for a write whose outcome is unknown.
    expect(scenario.durable_state_after_restart.mutation_provider_entity_ids).toEqual([null]);
    // The post-dispatch lease never moved to another worker.
    expect(scenario.durable_state_after_restart.mutation_execution_claim_sequences).toEqual([1]);
    expect(scenario.durable_state_after_restart.mutation_resolution_receipts[0]).toMatchObject({
      resolution: "WRITE_RESULT_UNKNOWN_NO_ID",
      reasonCode: "STALE_AFTER_DISPATCH",
      providerMutationPossible: true,
      automaticRearmAllowed: false,
      operatorResolutionRequired: true,
      recoveryAction: "OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM",
    });
    // The dead process is the only one that ever POSTed.
    expect(scenario.provider_create_post_pids).toEqual([scenario.initial_process_pid]);
  });

  it("AFTER_PROVIDER_OUTCOME_BEFORE_DURABLE_COMPLETION recovers forward by exact-Id read-back only", () => {
    const scenario = scenarioFor("AFTER_PROVIDER_OUTCOME_BEFORE_DURABLE_COMPLETION");
    expect(scenario.durable_state_before_kill.mutation_states).toEqual(["PROVIDER_OUTCOME_RECORDED"]);
    expect(scenario.durable_state_before_kill.mutation_execution_attempt_states)
      .toEqual(["PROVIDER_OUTCOME_RECORDED"]);
    expect(scenario.durable_state_before_kill.provider_create_post_count).toBe(1);
    const exactId = scenario.durable_state_before_kill.mutation_provider_entity_ids[0];
    expect(typeof exactId).toBe("string");

    expect(scenario.restart_attempts[0]).toMatchObject({
      intent: "CONTINUE_AFTER_RESTART",
      outcome: "COMPLETED",
      case_state: "TERMINAL",
      ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED",
      provider_create_post_count_after_attempt: 1,
    });
    expect(scenario.terminal_case_state).toBe("TERMINAL");
    expect(scenario.terminal_mutation_states).toEqual(["POSTED_READBACK_VERIFIED"]);
    expect(scenario.durable_state_after_restart.mutation_provider_entity_ids).toEqual([exactId]);
    expect(scenario.durable_state_after_restart.case_operation_provider_entity_ids).toEqual([exactId]);
    // Recovery was a GET, so the only create POST is still the dead process's.
    expect(scenario.provider_create_post_pids).toEqual([scenario.initial_process_pid]);
    expect(scenario.durable_state_after_restart.provider_get_count).toBeGreaterThan(0);
  });

  it("recomputes every recorded check from the evidence numbers alone", () => {
    for (const boundary of QUICKBOOKS_CRASH_BOUNDARY_IDS) {
      const scenario = scenarioFor(boundary);
      expect(scenario.expected).toEqual(QUICKBOOKS_CRASH_BOUNDARY_EXPECTATIONS[boundary]);
      const { checks, status } = evaluateQuickBooksCrashScenario(scenario);
      expect(checks).toEqual(scenario.checks);
      expect(status).toBe("PASS");
      expect(Object.entries(checks).filter(([, passed]) => !passed)).toEqual([]);
      expect(scenario.status).toBe("PASS");
    }
  });
});
