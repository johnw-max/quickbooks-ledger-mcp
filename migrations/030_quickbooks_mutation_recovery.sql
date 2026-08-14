SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A Provider outcome is a write-ahead recovery checkpoint. Once QuickBooks
-- returns an exact entity Id, persist it and the request receipt before doing
-- network readback. Recovery may then GET only that Id; it must never POST the
-- immutable mutation again.
ALTER TABLE quickbooks_mutation_preparations
  ADD COLUMN IF NOT EXISTS provider_outcome_receipt jsonb;

-- Verified legacy rows already contain the exact Provider Id, immutable
-- request identity, write receipt, and exact readback. Preserve that evidence
-- as the recovery checkpoint instead of invalidating an already verified row.
UPDATE quickbooks_mutation_preparations
SET provider_outcome_receipt = jsonb_build_object(
  'evidenceType', 'MIGRATED_FROM_VERIFIED_TERMINAL_EVIDENCE',
  'realmId', realm_id,
  'bindingRevision', binding_revision,
  'entity', entity,
  'operation', operation,
  'providerEntityId', provider_entity_id,
  'providerRequestId', provider_request_id,
  'canonicalPayloadHash', payload_hash,
  'originalWriteReceipt', write_receipt
)
WHERE state = 'POSTED_READBACK_VERIFIED'
  AND provider_entity_id IS NOT NULL
  AND write_receipt IS NOT NULL
  AND readback IS NOT NULL
  AND provider_outcome_receipt IS NULL;

ALTER TABLE quickbooks_mutation_preparations
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_preparations_state_check,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_preparations_check2,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_preparations_check3,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_provider_outcome_check,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_terminal_evidence_check,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_execution_actors_check;

ALTER TABLE quickbooks_mutation_preparations
  ADD CONSTRAINT quickbooks_mutation_preparations_state_check CHECK (state IN (
    'PREPARED','EXECUTING','PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED',
    'READBACK_MISMATCH','BLOCKED_VALIDATION','REJECTED'
  )),
  ADD CONSTRAINT quickbooks_mutation_execution_actors_check CHECK (
    (state = 'PREPARED' AND approved_by IS NULL AND approved_at IS NULL AND rejected_by IS NULL AND rejected_at IS NULL)
    OR (state = 'REJECTED' AND approved_by IS NULL AND approved_at IS NULL
      AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL)
    OR (state IN ('EXECUTING','PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED',
      'READBACK_MISMATCH','BLOCKED_VALIDATION') AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND rejected_by IS NULL AND rejected_at IS NULL)
  ),
  ADD CONSTRAINT quickbooks_mutation_provider_outcome_check CHECK (
    (provider_entity_id IS NULL AND provider_outcome_receipt IS NULL AND state <> 'PROVIDER_OUTCOME_RECORDED')
    OR (provider_entity_id IS NOT NULL AND jsonb_typeof(provider_outcome_receipt) = 'object'
      AND state IN ('PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED','READBACK_MISMATCH'))
  ),
  ADD CONSTRAINT quickbooks_mutation_terminal_evidence_check CHECK (
    (state = 'POSTED_READBACK_VERIFIED' AND provider_entity_id IS NOT NULL
      AND jsonb_typeof(provider_outcome_receipt) = 'object'
      AND jsonb_typeof(write_receipt) = 'object' AND jsonb_typeof(readback) = 'object')
    OR (state <> 'POSTED_READBACK_VERIFIED' AND write_receipt IS NULL AND readback IS NULL)
  );

DROP INDEX IF EXISTS quickbooks_mutation_recovery_idx;
CREATE INDEX quickbooks_mutation_recovery_idx
  ON quickbooks_mutation_preparations (state, updated_at)
  WHERE state IN ('EXECUTING','PROVIDER_OUTCOME_RECORDED','WRITE_RESULT_UNKNOWN','READBACK_MISMATCH');

CREATE OR REPLACE FUNCTION quickbooks_mutation_provider_outcome_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_entity_id IS NOT NULL AND NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id THEN
    RAISE EXCEPTION 'QuickBooks Provider outcome identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_outcome_receipt IS NOT NULL
    AND NEW.provider_outcome_receipt IS DISTINCT FROM OLD.provider_outcome_receipt THEN
    RAISE EXCEPTION 'QuickBooks Provider outcome receipt is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quickbooks_mutation_provider_outcome_immutable
  ON quickbooks_mutation_preparations;
CREATE TRIGGER quickbooks_mutation_provider_outcome_immutable
BEFORE UPDATE OF provider_entity_id, provider_outcome_receipt
ON quickbooks_mutation_preparations
FOR EACH ROW EXECUTE FUNCTION quickbooks_mutation_provider_outcome_immutable_guard();
