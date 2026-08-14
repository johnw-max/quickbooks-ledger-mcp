SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Link each durable Case operation to the immutable generic-mutation
-- preparation that actually owns the Provider request, without confusing a
-- Case fact fingerprint with proof of the original uploaded file bytes.
ALTER TABLE quickbooks_accounting_case_operations
  ADD COLUMN IF NOT EXISTS preparation_payload_hash text,
  ADD COLUMN IF NOT EXISTS operation_source_evidence_hash text;

-- Compiler 0.2 changes the durable Case operation contract and the plan-hash
-- identity. There is no sound mechanical way to invent its source fact,
-- evidence and amount-bridge hashes for an already executing 0.1 Case. Abort
-- the deployment before changing anything when such a row exists. This
-- release intentionally blocks every legacy row: the 0.2 verifier cannot
-- honestly validate a 0.1 plan hash or source-evidence contract, even when the
-- old row is terminal. Preserve the pre-upgrade database backup as the audit
-- archive; do not rewrite immutable legacy plans in-place.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM quickbooks_accounting_cases
    WHERE COALESCE(compiled_case ->> 'compilerVersion', '') <> '0.2.0'
  ) THEN
    RAISE EXCEPTION 'migration 029 blocked: legacy QuickBooks Accounting Case requires external audit archive and controlled disposition';
  END IF;
END
$$;

UPDATE quickbooks_accounting_case_operations operation_row
SET preparation_payload_hash = preparation.payload_hash
FROM quickbooks_mutation_preparations preparation
WHERE operation_row.preparation_id = preparation.preparation_id
  AND operation_row.preparation_payload_hash IS NULL;

UPDATE quickbooks_accounting_case_operations operation_row
SET operation_source_evidence_hash = COALESCE(
  NULLIF(operation_row.operation_json ->> 'sourceEvidenceHash', ''),
  case_row.source_revision_hash
)
FROM quickbooks_accounting_cases case_row
WHERE operation_row.workspace_id = case_row.workspace_id
  AND operation_row.subject_type = case_row.subject_type
  AND operation_row.subject_id = case_row.subject_id
  AND operation_row.agent_id = case_row.agent_id
  AND operation_row.installation_id = case_row.installation_id
  AND operation_row.binding_id = case_row.binding_id
  AND operation_row.binding_revision = case_row.binding_revision
  AND operation_row.connection_id = case_row.connection_id
  AND operation_row.realm_id = case_row.realm_id
  AND operation_row.case_id = case_row.case_id
  AND operation_row.case_version = case_row.version
  AND operation_row.preparation_id IS NOT NULL
  AND operation_row.operation_source_evidence_hash IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM quickbooks_accounting_case_operations
    WHERE preparation_id IS NOT NULL
      AND (preparation_payload_hash IS NULL OR operation_source_evidence_hash IS NULL)
  ) THEN
    RAISE EXCEPTION 'migration 029 blocked: QuickBooks Accounting Case preparation evidence cannot be linked';
  END IF;
END
$$;

ALTER TABLE quickbooks_accounting_case_operations
  DROP CONSTRAINT IF EXISTS quickbooks_accounting_case_preparation_payload_hash_check,
  DROP CONSTRAINT IF EXISTS quickbooks_accounting_case_source_evidence_hash_check,
  DROP CONSTRAINT IF EXISTS quickbooks_accounting_case_source_evidence_consistency;

ALTER TABLE quickbooks_accounting_case_operations
  ADD CONSTRAINT quickbooks_accounting_case_preparation_payload_hash_check CHECK (
    preparation_payload_hash IS NULL OR preparation_payload_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT quickbooks_accounting_case_source_evidence_hash_check CHECK (
    operation_source_evidence_hash IS NULL OR operation_source_evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT quickbooks_accounting_case_source_evidence_consistency CHECK (
    operation_source_evidence_hash IS NULL
    OR operation_json ->> 'sourceEvidenceHash' IS NULL
    OR operation_source_evidence_hash = operation_json ->> 'sourceEvidenceHash'
  );

ALTER TABLE quickbooks_accounting_case_operations
  DROP CONSTRAINT IF EXISTS quickbooks_accounting_case_preparation_fk;

ALTER TABLE quickbooks_accounting_case_operations
  ADD CONSTRAINT quickbooks_accounting_case_preparation_fk
  FOREIGN KEY (preparation_id)
  REFERENCES quickbooks_mutation_preparations(preparation_id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE quickbooks_accounting_case_operations
  VALIDATE CONSTRAINT quickbooks_accounting_case_preparation_fk;

CREATE OR REPLACE FUNCTION quickbooks_accounting_case_preparation_link_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.preparation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM quickbooks_mutation_preparations preparation
    WHERE preparation.preparation_id = NEW.preparation_id
      AND preparation.payload_hash = NEW.preparation_payload_hash
  ) THEN
    RAISE EXCEPTION 'QuickBooks Case preparation payload hash does not match its immutable preparation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quickbooks_accounting_case_preparation_link
  ON quickbooks_accounting_case_operations;
CREATE CONSTRAINT TRIGGER quickbooks_accounting_case_preparation_link
AFTER INSERT OR UPDATE OF preparation_id, preparation_payload_hash
ON quickbooks_accounting_case_operations
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION quickbooks_accounting_case_preparation_link_guard();

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
    OR (OLD.state IN ('WRITE_UNCERTAIN','READBACK_MISMATCH') AND NEW.state='READBACK_VERIFIED')) THEN
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
