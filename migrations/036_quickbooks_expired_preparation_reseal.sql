SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A prepared mutation expires after 30 minutes so that authority is re-evaluated
-- rather than assumed. Nothing could act on that expiry: an Accounting Case that
-- resumes a stored preparation reuses it whatever its age, and the operation's
-- request id is a content hash, so ON CONFLICT ... DO NOTHING hands every later
-- attempt — including a brand-new Case version — back the same expired row. A
-- Case that sat overnight was therefore unexecutable forever.
--
-- The fix is to re-authorize, not to extend a clock: clearing the recorded
-- authorization evidence makes the service run a fresh standing-delegation
-- evaluation, which is the check the expiry existed to force. Migration 034
-- makes that evidence immutable, so this relaxes exactly one branch of its
-- guard, and only for a row that provably never reached the Provider.
--
-- Everything 034 protects after dispatch is untouched: no claim, no receipt, no
-- Provider id, no dispatch marker may exist, the row must be and remain PREPARED
-- and unclaimed, and evidence may only be cleared — never rewritten.

CREATE OR REPLACE FUNCTION quickbooks_mutation_autonomous_authorization_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_approved_by text;
  clearing_never_dispatched_evidence boolean;
BEGIN
  clearing_never_dispatched_evidence :=
    NEW.autonomous_authorization_evidence IS NULL
    AND OLD.state = 'PREPARED' AND NEW.state = 'PREPARED'
    AND OLD.approved_by IS NULL AND NEW.approved_by IS NULL
    AND OLD.approved_at IS NULL AND NEW.approved_at IS NULL
    AND OLD.execution_attempt_id IS NULL AND NEW.execution_attempt_id IS NULL
    AND OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NULL
    AND OLD.provider_entity_id IS NULL AND NEW.provider_entity_id IS NULL
    AND OLD.provider_outcome_receipt IS NULL AND NEW.provider_outcome_receipt IS NULL
    AND OLD.write_receipt IS NULL AND NEW.write_receipt IS NULL
    AND OLD.readback IS NULL AND NEW.readback IS NULL
    AND OLD.execution_resolution_receipt IS NULL AND NEW.execution_resolution_receipt IS NULL;

  IF OLD.autonomous_authorization_evidence IS NOT NULL
    AND NEW.autonomous_authorization_evidence IS DISTINCT FROM OLD.autonomous_authorization_evidence
    AND NOT clearing_never_dispatched_evidence THEN
    RAISE EXCEPTION 'QuickBooks autonomous authorization evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.autonomous_authorization_evidence IS NOT NULL AND OLD.approved_at IS NOT NULL
    AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'QuickBooks autonomous authorization claim timestamp is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.approved_by LIKE 'standing:%' AND NEW.state NOT IN ('PREPARED','REJECTED')
    AND NEW.autonomous_authorization_evidence IS NULL THEN
    RAISE EXCEPTION 'QuickBooks autonomous Provider dispatch requires durable prior authorization evidence'
      USING ERRCODE='23514';
  END IF;
  IF NEW.autonomous_authorization_evidence IS NOT NULL
    AND NEW.state NOT IN ('PREPARED','REJECTED') THEN
    expected_approved_by := 'standing:' ||
      (NEW.autonomous_authorization_evidence->'authorizationReceipt'->>'delegationId');
    IF NEW.approved_by IS DISTINCT FROM expected_approved_by THEN
      RAISE EXCEPTION 'QuickBooks autonomous authorization can only be claimed by its original standing delegation'
        USING ERRCODE='23514';
    END IF;
    IF NEW.approved_at IS NULL
      OR NEW.autonomous_authorization_evidence->>'recordedAt' !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      OR (NEW.autonomous_authorization_evidence->>'recordedAt')::timestamptz > NEW.approved_at THEN
      RAISE EXCEPTION 'QuickBooks autonomous authorization evidence must causally precede execution claim'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
