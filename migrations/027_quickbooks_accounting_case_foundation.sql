CREATE TABLE quickbooks_accounting_cases (
  case_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  actor_id text NOT NULL,
  workspace_id text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('USER','TEAM')),
  subject_id text NOT NULL,
  agent_id text NOT NULL,
  installation_id text NOT NULL,
  binding_id text NOT NULL,
  binding_revision bigint NOT NULL CHECK (binding_revision > 0),
  connection_id text NOT NULL,
  realm_id text NOT NULL CHECK (realm_id ~ '^\d{3,32}$'),
  target_session_hash text NOT NULL CHECK (target_session_hash ~ '^[a-f0-9]{64}$'),
  compiled_case jsonb NOT NULL CHECK (jsonb_typeof(compiled_case) = 'object'),
  compiled_plan_hash text NOT NULL CHECK (compiled_plan_hash ~ '^[a-f0-9]{64}$'),
  source_revision_hash text NOT NULL CHECK (source_revision_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'BLOCKED_COVERAGE','BLOCKED_VALIDATION','PLANNED_NEEDS_PREFLIGHT','PLANNED_WITH_EXCEPTIONS',
    'EXECUTING','RECOVERY_REQUIRED','TERMINAL'
  )),
  execution_request_id text,
  terminal_summary jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, subject_type, subject_id, agent_id, installation_id, binding_id,
    binding_revision, connection_id, realm_id, case_id, version),
  CONSTRAINT quickbooks_accounting_case_identity CHECK (
    compiled_case ->> 'caseId' = case_id
    AND compiled_case ->> 'providerId' = 'quickbooks'
    AND compiled_case ->> 'sourceRevisionHash' = source_revision_hash
    AND CASE WHEN compiled_case ->> 'version' ~ '^[1-9][0-9]*$'
      THEN (compiled_case ->> 'version')::numeric = version ELSE false END
  )
);

CREATE UNIQUE INDEX quickbooks_accounting_case_current_request_uq
  ON quickbooks_accounting_cases(actor_id, realm_id, execution_request_id)
  WHERE execution_request_id IS NOT NULL;

CREATE TABLE quickbooks_accounting_case_operations (
  workspace_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  agent_id text NOT NULL,
  installation_id text NOT NULL,
  binding_id text NOT NULL,
  binding_revision bigint NOT NULL,
  connection_id text NOT NULL,
  realm_id text NOT NULL,
  case_id text NOT NULL,
  case_version bigint NOT NULL,
  operation_id text NOT NULL,
  operation_json jsonb NOT NULL CHECK (jsonb_typeof(operation_json) = 'object'),
  state text NOT NULL CHECK (state IN (
    'PENDING','PREPARED','READBACK_VERIFIED','WRITE_UNCERTAIN','READBACK_MISMATCH',
    'PROVIDER_REJECTED','BLOCKED_VALIDATION'
  )),
  preparation_id text,
  mutation_request_id text,
  provider_entity_id text,
  authorization_receipt jsonb,
  write_receipt jsonb,
  readback jsonb,
  error_receipt jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, subject_type, subject_id, agent_id, installation_id, binding_id,
    binding_revision, connection_id, realm_id, case_id, case_version, operation_id),
  FOREIGN KEY (workspace_id, subject_type, subject_id, agent_id, installation_id, binding_id,
    binding_revision, connection_id, realm_id, case_id, case_version)
    REFERENCES quickbooks_accounting_cases(workspace_id, subject_type, subject_id, agent_id,
      installation_id, binding_id, binding_revision, connection_id, realm_id, case_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT quickbooks_accounting_case_operation_identity CHECK (
    operation_json ->> 'operationId' = operation_id
    AND operation_json ->> 'caseVersion' IS NULL
  )
);

CREATE UNIQUE INDEX quickbooks_accounting_case_operation_preparation_uq
  ON quickbooks_accounting_case_operations(preparation_id) WHERE preparation_id IS NOT NULL;
CREATE UNIQUE INDEX quickbooks_accounting_case_operation_mutation_uq
  ON quickbooks_accounting_case_operations(mutation_request_id) WHERE mutation_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION quickbooks_accounting_case_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.case_id,NEW.version,NEW.actor_id,NEW.workspace_id,NEW.subject_type,NEW.subject_id,
    NEW.agent_id,NEW.installation_id,NEW.binding_id,NEW.binding_revision,NEW.connection_id,
    NEW.realm_id,NEW.target_session_hash)
    IS DISTINCT FROM ROW(OLD.case_id,OLD.version,OLD.actor_id,OLD.workspace_id,OLD.subject_type,OLD.subject_id,
    OLD.agent_id,OLD.installation_id,OLD.binding_id,OLD.binding_revision,OLD.connection_id,
    OLD.realm_id,OLD.target_session_hash) THEN
    RAISE EXCEPTION 'QuickBooks Accounting Case binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.compiled_case, NEW.compiled_plan_hash, NEW.source_revision_hash, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.compiled_case, OLD.compiled_plan_hash, OLD.source_revision_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'QuickBooks Accounting Case plan is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state IN ('PLANNED_NEEDS_PREFLIGHT','PLANNED_WITH_EXCEPTIONS') AND NEW.state = 'EXECUTING')
    OR (OLD.state = 'EXECUTING' AND NEW.state IN ('RECOVERY_REQUIRED','TERMINAL'))
    OR (OLD.state = 'RECOVERY_REQUIRED' AND NEW.state = 'TERMINAL')) THEN
    RAISE EXCEPTION 'invalid QuickBooks Accounting Case state transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.execution_request_id IS NOT NULL AND NEW.execution_request_id IS DISTINCT FROM OLD.execution_request_id THEN
    RAISE EXCEPTION 'QuickBooks Accounting Case execution claim is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'TERMINAL' AND EXISTS (
    SELECT 1 FROM quickbooks_accounting_case_operations operation_row
    WHERE operation_row.workspace_id=NEW.workspace_id AND operation_row.subject_type=NEW.subject_type
      AND operation_row.subject_id=NEW.subject_id AND operation_row.agent_id=NEW.agent_id
      AND operation_row.installation_id=NEW.installation_id AND operation_row.binding_id=NEW.binding_id
      AND operation_row.binding_revision=NEW.binding_revision AND operation_row.connection_id=NEW.connection_id
      AND operation_row.realm_id=NEW.realm_id AND operation_row.case_id=NEW.case_id
      AND operation_row.case_version=NEW.version
      AND operation_row.state IN ('PENDING','PREPARED','WRITE_UNCERTAIN','READBACK_MISMATCH')
  ) THEN
    RAISE EXCEPTION 'QuickBooks Accounting Case cannot terminate with unfinished operations' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quickbooks_accounting_case_immutable
BEFORE UPDATE ON quickbooks_accounting_cases
FOR EACH ROW EXECUTE FUNCTION quickbooks_accounting_case_immutable_guard();

CREATE OR REPLACE FUNCTION quickbooks_accounting_case_operation_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_json IS DISTINCT FROM OLD.operation_json THEN
    RAISE EXCEPTION 'QuickBooks Accounting Case operation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.preparation_id IS NOT NULL AND NEW.preparation_id IS DISTINCT FROM OLD.preparation_id THEN
    RAISE EXCEPTION 'QuickBooks preparation identity is immutable' USING ERRCODE = '23514';
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
    OR (OLD.state='PENDING' AND NEW.state IN ('PREPARED','BLOCKED_VALIDATION'))
    OR (OLD.state='PREPARED' AND NEW.state IN (
      'READBACK_VERIFIED','WRITE_UNCERTAIN','READBACK_MISMATCH','PROVIDER_REJECTED','BLOCKED_VALIDATION'
    ))) THEN
    RAISE EXCEPTION 'invalid QuickBooks Accounting Case operation transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.state='READBACK_VERIFIED' AND (NEW.preparation_id IS NULL OR NEW.mutation_request_id IS NULL
    OR NEW.provider_entity_id IS NULL OR NEW.authorization_receipt IS NULL OR NEW.write_receipt IS NULL OR NEW.readback IS NULL) THEN
    RAISE EXCEPTION 'QuickBooks verified operation requires complete evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('WRITE_UNCERTAIN','READBACK_MISMATCH','PROVIDER_REJECTED','BLOCKED_VALIDATION')
    AND NEW.error_receipt IS NULL THEN
    RAISE EXCEPTION 'QuickBooks failed operation requires error evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quickbooks_accounting_case_operation_immutable
BEFORE UPDATE ON quickbooks_accounting_case_operations
FOR EACH ROW EXECUTE FUNCTION quickbooks_accounting_case_operation_immutable_guard();
