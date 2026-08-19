SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Re-arming a rejected operation was gated on what the last error receipt said:
-- code FORBIDDEN, failureLayer MCP_SCOPE, denyReasons containing
-- TRANSPORT_SCOPE_MISSING. That receipt is mutable and is overwritten by any
-- later failure on the same operation, so an unrelated second refusal silently
-- destroys the eligibility — the row becomes permanently unresumable while the
-- durable evidence still proves nothing was ever dispatched. That is exactly
-- what happened to the 2026-08-15 supplier bill: a later expiry error replaced
-- its original scope rejection, and it could no longer be re-armed.
--
-- The proxy is dropped. What stays is the proof: the operation must carry no
-- Provider identity, authorization receipt, write receipt or read-back, and its
-- linked preparation must still be PREPARED with no Provider id, no outcome
-- receipt, no execution attempt and no dispatch marker. Those columns are
-- immutable once written, so unlike the receipt they cannot be talked out of.
-- The permitted transition is unchanged and no wider one is opened.

CREATE OR REPLACE FUNCTION quickbooks_accounting_case_operation_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_json IS DISTINCT FROM OLD.operation_json THEN
    RAISE EXCEPTION 'QuickBooks Accounting Case operation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.preparation_id IS NOT NULL AND NEW.preparation_id IS DISTINCT FROM OLD.preparation_id THEN
    RAISE EXCEPTION 'QuickBooks preparation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.preparation_payload_hash IS NOT NULL
    AND NEW.preparation_payload_hash IS DISTINCT FROM OLD.preparation_payload_hash THEN
    RAISE EXCEPTION 'QuickBooks preparation payload evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.operation_source_evidence_hash IS NOT NULL
    AND NEW.operation_source_evidence_hash IS DISTINCT FROM OLD.operation_source_evidence_hash THEN
    RAISE EXCEPTION 'QuickBooks operation source evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_entity_id IS NOT NULL AND NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id THEN
    RAISE EXCEPTION 'QuickBooks provider identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.authorization_receipt IS NOT NULL AND NEW.authorization_receipt IS DISTINCT FROM OLD.authorization_receipt THEN
    RAISE EXCEPTION 'QuickBooks authorization receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.write_receipt IS NOT NULL AND NEW.write_receipt IS DISTINCT FROM OLD.write_receipt THEN
    RAISE EXCEPTION 'QuickBooks write receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.readback IS NOT NULL AND NEW.readback IS DISTINCT FROM OLD.readback THEN
    RAISE EXCEPTION 'QuickBooks readback is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state='PENDING' AND NEW.state IN ('PREPARED','BLOCKED_VALIDATION','PROVIDER_REJECTED'))
    OR (OLD.state='PREPARED' AND NEW.state IN (
      'READBACK_VERIFIED','WRITE_UNCERTAIN','READBACK_MISMATCH','PROVIDER_REJECTED','BLOCKED_VALIDATION'
    ))
    OR (OLD.state IN ('WRITE_UNCERTAIN','READBACK_MISMATCH') AND NEW.state='READBACK_VERIFIED')
    OR (OLD.state='PROVIDER_REJECTED' AND NEW.state='PREPARED'
      AND OLD.provider_entity_id IS NULL AND OLD.authorization_receipt IS NULL
      AND OLD.write_receipt IS NULL AND OLD.readback IS NULL
      AND OLD.preparation_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM quickbooks_mutation_preparations preparation
        WHERE preparation.preparation_id=OLD.preparation_id
          AND preparation.state='PREPARED'
          AND preparation.provider_entity_id IS NULL
          AND preparation.provider_outcome_receipt IS NULL
          AND preparation.execution_attempt_id IS NULL
          AND preparation.dispatch_started_at IS NULL
      ))) THEN
    RAISE EXCEPTION 'invalid QuickBooks Accounting Case operation transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.preparation_id IS NOT NULL AND (
    NEW.preparation_payload_hash IS NULL OR NEW.operation_source_evidence_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'QuickBooks prepared Case operation requires linked payload and source evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state='READBACK_VERIFIED' AND (NEW.preparation_id IS NULL OR NEW.mutation_request_id IS NULL
    OR NEW.provider_entity_id IS NULL OR NEW.authorization_receipt IS NULL OR NEW.write_receipt IS NULL
    OR NEW.readback IS NULL) THEN
    RAISE EXCEPTION 'QuickBooks verified operation requires complete evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('WRITE_UNCERTAIN','READBACK_MISMATCH','PROVIDER_REJECTED','BLOCKED_VALIDATION')
    AND NEW.error_receipt IS NULL THEN
    RAISE EXCEPTION 'QuickBooks failed operation requires error evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
