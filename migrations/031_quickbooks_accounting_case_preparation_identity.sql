SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Migration 029 proves preparation existence and payload identity. This
-- follow-up binds that preparation to the same actor and Realm as its parent
-- Case so a valid hash from another OAuth installation cannot be cross-linked.
CREATE OR REPLACE FUNCTION quickbooks_accounting_case_preparation_link_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.preparation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM quickbooks_mutation_preparations preparation
    JOIN quickbooks_accounting_cases case_row
      ON case_row.workspace_id = NEW.workspace_id
      AND case_row.subject_type = NEW.subject_type
      AND case_row.subject_id = NEW.subject_id
      AND case_row.agent_id = NEW.agent_id
      AND case_row.installation_id = NEW.installation_id
      AND case_row.binding_id = NEW.binding_id
      AND case_row.binding_revision = NEW.binding_revision
      AND case_row.connection_id = NEW.connection_id
      AND case_row.realm_id = NEW.realm_id
      AND case_row.case_id = NEW.case_id
      AND case_row.version = NEW.case_version
    WHERE preparation.preparation_id = NEW.preparation_id
      AND preparation.payload_hash = NEW.preparation_payload_hash
      AND preparation.actor_id = case_row.actor_id
      AND preparation.realm_id = NEW.realm_id
  ) THEN
    RAISE EXCEPTION 'QuickBooks Case preparation identity or payload hash does not match its immutable preparation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
