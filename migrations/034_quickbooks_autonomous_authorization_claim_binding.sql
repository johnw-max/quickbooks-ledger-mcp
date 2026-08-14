SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Authorization evidence is a causal record of who authorized the first
-- Provider dispatch. It cannot be attached while PREPARED and later claimed by
-- a human reviewer (or by a different standing delegation) without falsifying
-- that history. Refuse to upgrade an already-inconsistent ledger.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM quickbooks_mutation_preparations
    WHERE state NOT IN ('PREPARED','REJECTED')
      AND (
        (approved_by LIKE 'standing:%' AND autonomous_authorization_evidence IS NULL)
        OR (
          autonomous_authorization_evidence IS NOT NULL
          AND (
            approved_by IS DISTINCT FROM
              ('standing:' || (autonomous_authorization_evidence->'authorizationReceipt'->>'delegationId'))
            OR approved_at IS NULL
            OR CASE
              WHEN autonomous_authorization_evidence->>'recordedAt' ~
                '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                THEN (autonomous_authorization_evidence->>'recordedAt')::timestamptz > approved_at
              ELSE true
            END
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'migration 034 blocked: autonomous authorization claim history is inconsistent and requires controlled audit disposition';
  END IF;
END
$$;

ALTER TABLE quickbooks_mutation_preparations
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_autonomous_authorization_shape,
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_autonomous_authorization_claim_binding;

ALTER TABLE quickbooks_mutation_preparations
  ADD CONSTRAINT quickbooks_mutation_autonomous_authorization_shape CHECK (
    autonomous_authorization_evidence IS NULL OR (
      jsonb_typeof(autonomous_authorization_evidence)='object'
      AND autonomous_authorization_evidence->>'evidenceType'='QUICKBOOKS_AUTONOMOUS_WRITE_AUTHORIZATION'
      AND autonomous_authorization_evidence->>'evidenceVersion'='1.0'
      AND autonomous_authorization_evidence->>'preparationId'=preparation_id
      AND autonomous_authorization_evidence->>'providerRequestId'=provider_request_id
      AND autonomous_authorization_evidence->>'preparationPayloadHash'=payload_hash
      AND autonomous_authorization_evidence->>'canonicalPayloadHash' ~ '^[a-f0-9]{64}$'
      AND autonomous_authorization_evidence->>'stableOperationKey' ~ '^[a-f0-9]{64}$'
      AND autonomous_authorization_evidence->>'sourceRevisionHash' ~ '^[a-f0-9]{64}$'
      AND autonomous_authorization_evidence->>'originCaseId' <> ''
      AND jsonb_typeof(autonomous_authorization_evidence->'originCaseVersion')='number'
      AND (autonomous_authorization_evidence->>'originCaseVersion') ~ '^[1-9][0-9]*$'
      AND autonomous_authorization_evidence->>'authorizationIdentityHash' ~ '^[a-f0-9]{64}$'
      AND autonomous_authorization_evidence->>'authorizationReceiptHash' ~ '^[a-f0-9]{64}$'
      AND autonomous_authorization_evidence->>'recordedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND jsonb_typeof(autonomous_authorization_evidence->'authorizationReceipt')='object'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'receiptHash'=
        autonomous_authorization_evidence->>'authorizationReceiptHash'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'receiptType'=
        'LEDGER_AUTONOMOUS_AUTHORIZATION'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'providerId'='quickbooks'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'actorId'=actor_id
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'tenantId'=realm_id
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'delegationId' <> ''
      AND jsonb_typeof(autonomous_authorization_evidence->'authorizationReceipt'->'delegationRevision')='number'
      AND (autonomous_authorization_evidence->'authorizationReceipt'->>'delegationRevision') ~ '^[1-9][0-9]*$'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'actionId'=
        autonomous_authorization_evidence->>'actionId'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'canonicalPayloadHash'=
        autonomous_authorization_evidence->>'canonicalPayloadHash'
      AND jsonb_typeof(autonomous_authorization_evidence->'deterministicValidationReceipt')='object'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'deterministicValidationReceiptHash'=
        autonomous_authorization_evidence->'deterministicValidationReceipt'->>'receiptHash'
    )
  ),
  ADD CONSTRAINT quickbooks_mutation_autonomous_authorization_claim_binding CHECK (
    autonomous_authorization_evidence IS NULL
    OR state IN ('PREPARED','REJECTED')
    OR (
      approved_by = ('standing:' || (autonomous_authorization_evidence->'authorizationReceipt'->>'delegationId'))
      AND approved_at IS NOT NULL
      AND CASE
        WHEN autonomous_authorization_evidence->>'recordedAt' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          THEN (autonomous_authorization_evidence->>'recordedAt')::timestamptz <= approved_at
        ELSE false
      END
    )
  );

CREATE OR REPLACE FUNCTION quickbooks_mutation_autonomous_authorization_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_approved_by text;
BEGIN
  IF OLD.autonomous_authorization_evidence IS NOT NULL
    AND NEW.autonomous_authorization_evidence IS DISTINCT FROM OLD.autonomous_authorization_evidence THEN
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

DROP TRIGGER IF EXISTS quickbooks_mutation_autonomous_authorization_causality
  ON quickbooks_mutation_preparations;
CREATE TRIGGER quickbooks_mutation_autonomous_authorization_causality
BEFORE UPDATE OF autonomous_authorization_evidence, state, approved_by, approved_at
ON quickbooks_mutation_preparations
FOR EACH ROW EXECUTE FUNCTION quickbooks_mutation_autonomous_authorization_guard();
