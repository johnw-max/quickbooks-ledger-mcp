SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A Case operation references a durable mutation; it does not own it. Before
-- this migration, two Cases could not link to the same preparation because the
-- Case table imposed global uniqueness. Worse, the service could create a new
-- authorization receipt after a terminal mutation had already been written.
-- Existing autonomous rows do not contain enough information to invent the
-- missing pre-dispatch evidence hash. Fail closed instead of falsifying history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM quickbooks_mutation_preparations
    WHERE approved_by LIKE 'standing:%'
  ) OR EXISTS (
    SELECT 1 FROM quickbooks_accounting_case_operations
    WHERE authorization_receipt IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'migration 032 blocked: existing QuickBooks autonomous writes require external audit archive and controlled sandbox reset';
  END IF;
END
$$;

ALTER TABLE quickbooks_mutation_preparations
  ADD COLUMN IF NOT EXISTS autonomous_authorization_evidence jsonb;

ALTER TABLE quickbooks_accounting_case_operations
  ADD COLUMN IF NOT EXISTS authorization_evidence jsonb,
  ADD COLUMN IF NOT EXISTS reuse_evidence_receipt jsonb;

ALTER TABLE quickbooks_mutation_preparations
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_autonomous_authorization_shape;
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
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'providerId'='quickbooks'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'actorId'=actor_id
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'tenantId'=realm_id
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'actionId'=
        autonomous_authorization_evidence->>'actionId'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'canonicalPayloadHash'=
        autonomous_authorization_evidence->>'canonicalPayloadHash'
      AND jsonb_typeof(autonomous_authorization_evidence->'deterministicValidationReceipt')='object'
      AND autonomous_authorization_evidence->'authorizationReceipt'->>'deterministicValidationReceiptHash'=
        autonomous_authorization_evidence->'deterministicValidationReceipt'->>'receiptHash'
    )
  );

CREATE OR REPLACE FUNCTION quickbooks_mutation_autonomous_authorization_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.autonomous_authorization_evidence IS NOT NULL
    AND NEW.autonomous_authorization_evidence IS DISTINCT FROM OLD.autonomous_authorization_evidence THEN
    RAISE EXCEPTION 'QuickBooks autonomous authorization evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.approved_by LIKE 'standing:%' AND NEW.state <> 'PREPARED'
    AND NEW.autonomous_authorization_evidence IS NULL THEN
    RAISE EXCEPTION 'QuickBooks autonomous Provider dispatch requires durable prior authorization evidence'
      USING ERRCODE='23514';
  END IF;
  IF NEW.approved_by LIKE 'standing:%' AND NEW.approved_at IS NOT NULL
    AND (NEW.autonomous_authorization_evidence->>'recordedAt')::timestamptz > NEW.approved_at THEN
    RAISE EXCEPTION 'QuickBooks autonomous authorization evidence must causally precede execution claim'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quickbooks_mutation_autonomous_authorization_causality
  ON quickbooks_mutation_preparations;
CREATE TRIGGER quickbooks_mutation_autonomous_authorization_causality
BEFORE UPDATE OF autonomous_authorization_evidence, state, approved_by
ON quickbooks_mutation_preparations
FOR EACH ROW EXECUTE FUNCTION quickbooks_mutation_autonomous_authorization_guard();

-- Shared identity is owned by quickbooks_mutation_preparations. Case rows only
-- need lookup indexes; global uniqueness incorrectly encoded one-to-one
-- ownership and rejected legitimate idempotent reuse.
DROP INDEX IF EXISTS quickbooks_accounting_case_operation_preparation_uq;
DROP INDEX IF EXISTS quickbooks_accounting_case_operation_mutation_uq;
DROP INDEX IF EXISTS quickbooks_accounting_case_operation_preparation_idx;
DROP INDEX IF EXISTS quickbooks_accounting_case_operation_mutation_idx;
CREATE INDEX quickbooks_accounting_case_operation_preparation_idx
  ON quickbooks_accounting_case_operations(preparation_id)
  WHERE preparation_id IS NOT NULL;
CREATE INDEX quickbooks_accounting_case_operation_mutation_idx
  ON quickbooks_accounting_case_operations(mutation_request_id)
  WHERE mutation_request_id IS NOT NULL;

ALTER TABLE quickbooks_accounting_case_operations
  DROP CONSTRAINT IF EXISTS quickbooks_accounting_case_authorization_evidence_shape,
  DROP CONSTRAINT IF EXISTS quickbooks_accounting_case_reuse_evidence_shape;
ALTER TABLE quickbooks_accounting_case_operations
  ADD CONSTRAINT quickbooks_accounting_case_authorization_evidence_shape CHECK (
    authorization_evidence IS NULL OR (
      jsonb_typeof(authorization_evidence)='object'
      AND authorization_evidence->>'evidenceType'='QUICKBOOKS_AUTONOMOUS_WRITE_AUTHORIZATION'
      AND authorization_evidence->>'authorizationIdentityHash' ~ '^[a-f0-9]{64}$'
      AND authorization_evidence->>'authorizationReceiptHash' ~ '^[a-f0-9]{64}$'
    )
  ),
  ADD CONSTRAINT quickbooks_accounting_case_reuse_evidence_shape CHECK (
    reuse_evidence_receipt IS NULL OR (
      jsonb_typeof(reuse_evidence_receipt)='object'
      AND reuse_evidence_receipt->>'evidenceType'='QUICKBOOKS_ACCOUNTING_CASE_MUTATION_REUSE'
      AND reuse_evidence_receipt->>'receiptHash' ~ '^[a-f0-9]{64}$'
      AND reuse_evidence_receipt->>'originalAuthorizationIdentityHash' ~ '^[a-f0-9]{64}$'
      AND reuse_evidence_receipt->>'originalAuthorizationReceiptHash' ~ '^[a-f0-9]{64}$'
    )
  );

CREATE OR REPLACE FUNCTION quickbooks_accounting_case_mutation_causality_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutation quickbooks_mutation_preparations%ROWTYPE;
  reuse_required boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.authorization_evidence IS NOT NULL
      AND NEW.authorization_evidence IS DISTINCT FROM OLD.authorization_evidence THEN
      RAISE EXCEPTION 'QuickBooks Case authorization evidence is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.reuse_evidence_receipt IS NOT NULL
      AND NEW.reuse_evidence_receipt IS DISTINCT FROM OLD.reuse_evidence_receipt THEN
      RAISE EXCEPTION 'QuickBooks Case mutation reuse evidence is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.state <> 'READBACK_VERIFIED' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO mutation FROM quickbooks_mutation_preparations
  WHERE preparation_id=NEW.preparation_id;
  IF NOT FOUND OR mutation.state <> 'POSTED_READBACK_VERIFIED'
    OR mutation.autonomous_authorization_evidence IS NULL THEN
    RAISE EXCEPTION 'QuickBooks verified Case operation requires one verified shared durable mutation and its original authorization'
      USING ERRCODE='23514';
  END IF;
  IF NEW.preparation_payload_hash IS DISTINCT FROM mutation.payload_hash
    OR NEW.mutation_request_id IS DISTINCT FROM mutation.client_request_id
    OR NEW.provider_entity_id IS DISTINCT FROM mutation.provider_entity_id
    OR NEW.authorization_evidence IS DISTINCT FROM mutation.autonomous_authorization_evidence
    OR NEW.authorization_receipt IS DISTINCT FROM mutation.autonomous_authorization_evidence->'authorizationReceipt'
    OR NEW.write_receipt IS DISTINCT FROM mutation.write_receipt
    OR NEW.readback IS DISTINCT FROM mutation.readback
    OR NEW.operation_json->>'stableOperationKey' IS DISTINCT FROM
      mutation.autonomous_authorization_evidence->>'stableOperationKey'
    OR NEW.operation_json->>'actionId' IS DISTINCT FROM
      mutation.autonomous_authorization_evidence->>'actionId'
    OR NEW.operation_json->>'canonicalPayloadHash' IS DISTINCT FROM
      mutation.autonomous_authorization_evidence->>'canonicalPayloadHash' THEN
    RAISE EXCEPTION 'QuickBooks Case terminal evidence does not match its shared durable mutation causal chain'
      USING ERRCODE='23514';
  END IF;
  reuse_required := mutation.autonomous_authorization_evidence->>'originCaseId' <> NEW.case_id
    OR (mutation.autonomous_authorization_evidence->>'originCaseVersion')::bigint <> NEW.case_version
    OR mutation.autonomous_authorization_evidence->>'sourceRevisionHash' <>
      NEW.operation_json->>'sourceRevisionHash';
  IF reuse_required AND NEW.reuse_evidence_receipt IS NULL THEN
    RAISE EXCEPTION 'QuickBooks cross-Case terminal replay requires deterministic reuse evidence'
      USING ERRCODE='23514';
  END IF;
  IF NEW.reuse_evidence_receipt IS NOT NULL AND (
    NEW.reuse_evidence_receipt->>'preparationId' IS DISTINCT FROM NEW.preparation_id
    OR NEW.reuse_evidence_receipt->>'providerRequestId' IS DISTINCT FROM mutation.provider_request_id
    OR NEW.reuse_evidence_receipt->>'providerEntityId' IS DISTINCT FROM NEW.provider_entity_id
    OR NEW.reuse_evidence_receipt->>'stableOperationKey' IS DISTINCT FROM NEW.operation_json->>'stableOperationKey'
    OR NEW.reuse_evidence_receipt->>'actionId' IS DISTINCT FROM NEW.operation_json->>'actionId'
    OR NEW.reuse_evidence_receipt->>'canonicalPayloadHash' IS DISTINCT FROM NEW.operation_json->>'canonicalPayloadHash'
    OR NEW.reuse_evidence_receipt->>'caseId' IS DISTINCT FROM NEW.case_id
    OR (NEW.reuse_evidence_receipt->>'caseVersion')::bigint IS DISTINCT FROM NEW.case_version
    OR NEW.reuse_evidence_receipt->>'sourceRevisionHash' IS DISTINCT FROM NEW.operation_json->>'sourceRevisionHash'
    OR NEW.reuse_evidence_receipt->>'currentDeterministicValidationReceiptHash' IS DISTINCT FROM
      NEW.operation_json->'validationReceipt'->>'receiptHash'
    OR NEW.reuse_evidence_receipt->>'originalAuthorizationIdentityHash' IS DISTINCT FROM
      mutation.autonomous_authorization_evidence->>'authorizationIdentityHash'
    OR NEW.reuse_evidence_receipt->>'originalAuthorizationReceiptHash' IS DISTINCT FROM
      mutation.autonomous_authorization_evidence->>'authorizationReceiptHash'
  ) THEN
    RAISE EXCEPTION 'QuickBooks deterministic reuse evidence does not match the current Case and original authorization'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quickbooks_accounting_case_mutation_causality
  ON quickbooks_accounting_case_operations;
CREATE CONSTRAINT TRIGGER quickbooks_accounting_case_mutation_causality
AFTER INSERT OR UPDATE OF state, preparation_id, preparation_payload_hash, mutation_request_id,
  provider_entity_id, authorization_receipt, authorization_evidence, reuse_evidence_receipt,
  write_receipt, readback
ON quickbooks_accounting_case_operations
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION quickbooks_accounting_case_mutation_causality_guard();
