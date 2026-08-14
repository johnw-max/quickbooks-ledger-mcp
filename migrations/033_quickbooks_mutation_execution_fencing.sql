SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- One immutable mutation may have only one Provider-dispatch attempt. A lease
-- can move between workers only before the durable dispatch marker is written.
-- Once dispatch starts, an absent exact Provider Id is an operator-resolution
-- condition and can never be automatically re-armed into EXECUTING.
ALTER TABLE quickbooks_mutation_preparations
  ADD COLUMN IF NOT EXISTS execution_attempt_id text,
  ADD COLUMN IF NOT EXISTS execution_attempt_state text,
  ADD COLUMN IF NOT EXISTS execution_claim_sequence integer,
  ADD COLUMN IF NOT EXISTS execution_lease_owner text,
  ADD COLUMN IF NOT EXISTS execution_lease_token_hash text,
  ADD COLUMN IF NOT EXISTS execution_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_outcome_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_resolution_receipt jsonb,
  ADD COLUMN IF NOT EXISTS execution_attempt_created_at timestamptz;

ALTER TABLE quickbooks_mutation_preparations
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_preparations_state_check,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_preparations_check2,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_preparations_check3,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_provider_outcome_check,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_terminal_evidence_check,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_execution_actors_check,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_execution_attempt_shape,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_execution_attempt_state_check;

-- An in-flight legacy row cannot prove whether the Provider request was sent.
-- Promotion therefore fails closed to unknown-no-Id instead of silently making
-- the row retryable after deployment.
UPDATE quickbooks_mutation_preparations
SET state = 'WRITE_RESULT_UNKNOWN_NO_ID',
    execution_attempt_id = 'qbea_' || md5(preparation_id || ':migration-033'),
    execution_attempt_state = 'WRITE_RESULT_UNKNOWN_NO_ID',
    execution_claim_sequence = 1,
    execution_lease_owner = 'migration:033',
    execution_lease_token_hash = repeat('0', 64),
    execution_lease_until = updated_at,
    dispatch_started_at = updated_at,
    execution_resolution_receipt = jsonb_build_object(
      'evidenceType', 'QUICKBOOKS_EXECUTION_RESOLUTION',
      'evidenceVersion', '1.0',
      'resolution', 'WRITE_RESULT_UNKNOWN_NO_ID',
      'attemptId', 'qbea_' || md5(preparation_id || ':migration-033'),
      'providerRequestId', provider_request_id,
      'reasonCode', 'LEGACY_EXECUTING_STATE_MIGRATED_FAIL_CLOSED',
      'providerMutationPossible', true,
      'automaticRearmAllowed', false,
      'operatorResolutionRequired', true,
      'recoveryAction', 'OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM',
      'resolvedAt', to_jsonb(updated_at)
    ),
    execution_attempt_created_at = COALESCE(approved_at, updated_at)
WHERE state = 'EXECUTING';

-- A legacy recovery row without both parts of the exact-Id checkpoint is not
-- recoverable by GET. Treat it exactly like an interrupted legacy execution:
-- fail closed, preserve the durable request identity, and require an audited
-- operator resolution instead of manufacturing a Provider outcome timestamp.
UPDATE quickbooks_mutation_preparations
SET state = 'WRITE_RESULT_UNKNOWN_NO_ID',
    execution_attempt_id = 'qbea_' || md5(preparation_id || ':migration-033'),
    execution_attempt_state = 'WRITE_RESULT_UNKNOWN_NO_ID',
    execution_claim_sequence = 1,
    execution_lease_owner = 'migration:033',
    execution_lease_token_hash = repeat('0', 64),
    execution_lease_until = updated_at,
    dispatch_started_at = COALESCE(approved_at, updated_at),
    execution_resolution_receipt = jsonb_build_object(
      'evidenceType', 'QUICKBOOKS_EXECUTION_RESOLUTION',
      'evidenceVersion', '1.0',
      'resolution', 'WRITE_RESULT_UNKNOWN_NO_ID',
      'attemptId', 'qbea_' || md5(preparation_id || ':migration-033'),
      'providerRequestId', provider_request_id,
      'reasonCode', 'LEGACY_RECOVERY_WITHOUT_EXACT_ID_MIGRATED_FAIL_CLOSED',
      'providerMutationPossible', true,
      'automaticRearmAllowed', false,
      'operatorResolutionRequired', true,
      'recoveryAction', 'OPERATOR_RESOLUTION_REQUIRED_NO_AUTOMATIC_REARM',
      'resolvedAt', to_jsonb(updated_at)
    ),
    execution_attempt_created_at = COALESCE(approved_at, updated_at)
WHERE state IN ('WRITE_RESULT_UNKNOWN','READBACK_MISMATCH')
  AND (provider_entity_id IS NULL OR provider_outcome_receipt IS NULL);

-- Backfill already terminal/recoverable rows with deterministic attempt
-- identity. These rows already carry their Provider outcome or no-write result.
UPDATE quickbooks_mutation_preparations
SET execution_attempt_id = COALESCE(
      execution_attempt_id, 'qbea_' || md5(preparation_id || ':migration-033')
    ),
    execution_attempt_state = COALESCE(execution_attempt_state, CASE
      WHEN state = 'POSTED_READBACK_VERIFIED' THEN 'READBACK_VERIFIED'
      WHEN state IN ('PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','READBACK_MISMATCH')
        THEN 'PROVIDER_OUTCOME_RECORDED'
      WHEN state = 'WRITE_RESULT_UNKNOWN_NO_ID' THEN 'WRITE_RESULT_UNKNOWN_NO_ID'
      ELSE 'RESOLVED_NO_WRITE'
    END),
    execution_claim_sequence = COALESCE(execution_claim_sequence, 1),
    execution_lease_owner = COALESCE(execution_lease_owner, 'migration:033'),
    execution_lease_token_hash = COALESCE(execution_lease_token_hash, repeat('0', 64)),
    execution_lease_until = COALESCE(execution_lease_until, updated_at),
    dispatch_started_at = CASE
      WHEN state IN ('PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','WRITE_RESULT_UNKNOWN_NO_ID',
        'POSTED_READBACK_VERIFIED','READBACK_MISMATCH')
        THEN COALESCE(dispatch_started_at, approved_at, updated_at)
      ELSE dispatch_started_at
    END,
    provider_outcome_recorded_at = CASE
      WHEN provider_entity_id IS NOT NULL AND provider_outcome_receipt IS NOT NULL
        THEN COALESCE(provider_outcome_recorded_at, updated_at)
      ELSE provider_outcome_recorded_at
    END,
    execution_resolution_receipt = CASE
      WHEN state = 'BLOCKED_VALIDATION' AND execution_resolution_receipt IS NULL THEN jsonb_build_object(
        'evidenceType', 'QUICKBOOKS_EXECUTION_RESOLUTION',
        'evidenceVersion', '1.0',
        'resolution', 'RESOLVED_NO_WRITE',
        'attemptId', COALESCE(execution_attempt_id, 'qbea_' || md5(preparation_id || ':migration-033')),
        'providerRequestId', provider_request_id,
        'reasonCode', 'LEGACY_BLOCKED_VALIDATION',
        'providerMutationPossible', false,
        'automaticRearmAllowed', false,
        'resolvedAt', to_jsonb(updated_at)
      )
      ELSE execution_resolution_receipt
    END,
    execution_attempt_created_at = COALESCE(execution_attempt_created_at, approved_at, updated_at)
WHERE state NOT IN ('PREPARED','REJECTED');

ALTER TABLE quickbooks_mutation_preparations
  ADD CONSTRAINT quickbooks_mutation_preparations_state_check CHECK (state IN (
    'PREPARED','EXECUTING','PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN',
    'WRITE_RESULT_UNKNOWN_NO_ID','POSTED_READBACK_VERIFIED','READBACK_MISMATCH',
    'BLOCKED_VALIDATION','REJECTED'
  )),
  ADD CONSTRAINT quickbooks_mutation_execution_actors_check CHECK (
    (state = 'PREPARED' AND approved_by IS NULL AND approved_at IS NULL AND rejected_by IS NULL AND rejected_at IS NULL)
    OR (state = 'REJECTED' AND approved_by IS NULL AND approved_at IS NULL
      AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL)
    OR (state IN ('EXECUTING','PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN',
      'WRITE_RESULT_UNKNOWN_NO_ID','POSTED_READBACK_VERIFIED','READBACK_MISMATCH','BLOCKED_VALIDATION')
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND rejected_by IS NULL AND rejected_at IS NULL)
  ),
  ADD CONSTRAINT quickbooks_mutation_provider_outcome_check CHECK (
    (provider_entity_id IS NULL AND provider_outcome_receipt IS NULL AND state <> 'PROVIDER_OUTCOME_RECORDED')
    OR (provider_entity_id IS NOT NULL AND jsonb_typeof(provider_outcome_receipt) = 'object'
      AND state IN ('PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN',
        'POSTED_READBACK_VERIFIED','READBACK_MISMATCH'))
  ),
  ADD CONSTRAINT quickbooks_mutation_terminal_evidence_check CHECK (
    (state = 'POSTED_READBACK_VERIFIED' AND provider_entity_id IS NOT NULL
      AND jsonb_typeof(provider_outcome_receipt) = 'object'
      AND jsonb_typeof(write_receipt) = 'object' AND jsonb_typeof(readback) = 'object')
    OR (state <> 'POSTED_READBACK_VERIFIED' AND write_receipt IS NULL AND readback IS NULL)
  ),
  ADD CONSTRAINT quickbooks_mutation_execution_attempt_state_check CHECK (
    execution_attempt_state IS NULL OR execution_attempt_state IN (
      'CLAIMED','DISPATCH_STARTED','PROVIDER_OUTCOME_RECORDED',
      'WRITE_RESULT_UNKNOWN_NO_ID','RESOLVED_NO_WRITE','READBACK_VERIFIED'
    )
  ),
  ADD CONSTRAINT quickbooks_mutation_execution_attempt_shape CHECK (
    (state IN ('PREPARED','REJECTED')
      AND execution_attempt_id IS NULL AND execution_attempt_state IS NULL
      AND execution_claim_sequence IS NULL AND execution_lease_owner IS NULL
      AND execution_lease_token_hash IS NULL AND execution_lease_until IS NULL
      AND dispatch_started_at IS NULL AND provider_outcome_recorded_at IS NULL
      AND execution_resolution_receipt IS NULL AND execution_attempt_created_at IS NULL)
    OR
    (state NOT IN ('PREPARED','REJECTED')
      AND execution_attempt_id ~ '^qbea_[a-f0-9]{32}$'
      AND execution_claim_sequence >= 1
      AND char_length(execution_lease_owner) > 0
      AND execution_lease_token_hash ~ '^[a-f0-9]{64}$'
      AND execution_lease_until IS NOT NULL
      AND execution_attempt_created_at IS NOT NULL
      AND (
        (state = 'EXECUTING' AND execution_attempt_state IN ('CLAIMED','DISPATCH_STARTED')
          AND execution_resolution_receipt IS NULL
          AND ((execution_attempt_state = 'CLAIMED' AND dispatch_started_at IS NULL)
            OR (execution_attempt_state = 'DISPATCH_STARTED' AND dispatch_started_at IS NOT NULL)))
        OR (state = 'WRITE_RESULT_UNKNOWN_NO_ID'
          AND execution_attempt_state = 'WRITE_RESULT_UNKNOWN_NO_ID'
          AND dispatch_started_at IS NOT NULL AND provider_entity_id IS NULL
          AND jsonb_typeof(execution_resolution_receipt) = 'object'
          AND execution_resolution_receipt->>'automaticRearmAllowed' = 'false'
          AND execution_resolution_receipt->>'operatorResolutionRequired' = 'true')
        OR (state IN ('PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','READBACK_MISMATCH')
          AND execution_attempt_state = 'PROVIDER_OUTCOME_RECORDED'
          AND dispatch_started_at IS NOT NULL AND provider_outcome_recorded_at IS NOT NULL)
        OR (state = 'POSTED_READBACK_VERIFIED'
          AND execution_attempt_state = 'READBACK_VERIFIED'
          AND dispatch_started_at IS NOT NULL AND provider_outcome_recorded_at IS NOT NULL)
        OR (state = 'BLOCKED_VALIDATION'
          AND execution_attempt_state = 'RESOLVED_NO_WRITE'
          AND jsonb_typeof(execution_resolution_receipt) = 'object')
      ))
  );

DROP INDEX IF EXISTS quickbooks_mutation_recovery_idx;
CREATE INDEX quickbooks_mutation_recovery_idx
  ON quickbooks_mutation_preparations (state, execution_lease_until)
  WHERE state IN ('EXECUTING','PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN',
    'WRITE_RESULT_UNKNOWN_NO_ID','READBACK_MISMATCH');

CREATE OR REPLACE FUNCTION quickbooks_mutation_execution_attempt_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.execution_attempt_id IS NOT NULL
    AND NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id THEN
    RAISE EXCEPTION 'QuickBooks execution attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.dispatch_started_at IS NOT NULL
    AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at THEN
    RAISE EXCEPTION 'QuickBooks Provider dispatch marker is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.execution_resolution_receipt IS NOT NULL
    AND NEW.execution_resolution_receipt IS DISTINCT FROM OLD.execution_resolution_receipt THEN
    RAISE EXCEPTION 'QuickBooks execution resolution receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.dispatch_started_at IS NOT NULL AND (
    NEW.execution_claim_sequence IS DISTINCT FROM OLD.execution_claim_sequence
    OR NEW.execution_lease_owner IS DISTINCT FROM OLD.execution_lease_owner
    OR NEW.execution_lease_token_hash IS DISTINCT FROM OLD.execution_lease_token_hash
    OR NEW.execution_lease_until IS DISTINCT FROM OLD.execution_lease_until
  ) THEN
    RAISE EXCEPTION 'QuickBooks execution lease cannot move after Provider dispatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quickbooks_mutation_execution_attempt_immutable
  ON quickbooks_mutation_preparations;
CREATE TRIGGER quickbooks_mutation_execution_attempt_immutable
BEFORE UPDATE OF execution_attempt_id, execution_claim_sequence, execution_lease_owner,
  execution_lease_token_hash, execution_lease_until, dispatch_started_at,
  execution_resolution_receipt
ON quickbooks_mutation_preparations
FOR EACH ROW EXECUTE FUNCTION quickbooks_mutation_execution_attempt_immutable_guard();
