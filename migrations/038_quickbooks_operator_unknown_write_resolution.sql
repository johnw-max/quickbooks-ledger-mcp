SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- WRITE_RESULT_UNKNOWN_NO_ID is the one reachable state with no exit. It is
-- entered when no Provider response ever completed (5xx, timeout, transport
-- loss), so the row honestly records the only thing that was known: an object
-- may exist in QuickBooks for which we hold no id. Nothing downstream can
-- decide that. The id is not derivable, automatic re-arm is forbidden because a
-- second POST could double post, and a Case operation's request id is a content
-- hash of the document, so no correction ever routes around the poisoned row.
-- Two production rows (DocNumber MBC-2026-0819 and MBC-2026-0820) are stranded
-- there today.
--
-- The exit is a person: someone opens QuickBooks, looks, and takes
-- responsibility for what is there. This column is that attestation.
--
-- It deliberately does not touch execution_resolution_receipt. Migration 033
-- makes that receipt immutable and that is load-bearing: it is the record of
-- what the machine itself knew at the time, and an attestation is not an
-- amendment to it. Evidence accretes instead of being overwritten — the row
-- keeps saying "the outcome was unknown", and gains "an operator checked and
-- attested ABSENT/PRESENT". Neither statement can later be edited into the
-- other.
--
-- What the database enforces, rather than trusting the application:
--
--   1. Only a row that reached unknown-no-Id may carry an attestation. That is
--      expressed against columns that are immutable once written (the dispatch
--      marker and the execution resolution receipt) rather than against `state`,
--      because a PRESENT attestation legitimately moves the state onwards; the
--      trigger below additionally pins the state at the moment of attestation.
--   2. The attestation is immutable once set (trigger), like every other
--      receipt in this table.
--   3. Authority. There is exactly one accepted authority value,
--      HUMAN_EXPLICIT_CONFIRMATION, and the attesting actor may never be a
--      standing delegation identity. Standing delegation is representable here
--      only as `standing:<delegationId>` (see 034), so an attestation carrying
--      delegated authority is not storable — there is no column value that
--      could express it. The kernel is never consulted by this path either: a
--      delegation authorises `actionIds` for compiled Case operations, and an
--      attestation is not one.
--   4. The confirmation is bound to what was confirmed. The receipt must carry
--      the SHA-256 of the exact sentence derived from this row's own immutable
--      identity plus the finding and, for PRESENT, the adopted id — recomputed
--      here rather than believed. A confirmation for another row, another
--      finding or another id cannot be replayed onto this one.
--   5. The dangerous direction is vetoed durably. An ABSENT attestation is only
--      storable together with the natural-key search that found nothing, and a
--      row attested ABSENT may never afterwards acquire a Provider id: the one
--      error that causes a double post cannot be committed and then quietly
--      contradicted.
--   6. A PRESENT attestation pins which id may ever be adopted. The id is still
--      absent when the attestation is written (it is adopted only after exact
--      read-back), so the clause admits NULL and forbids any other value.
--
-- Every clause is folded through COALESCE(..., false): `->>` on a missing key
-- yields NULL, a NULL conjunct makes the whole conjunction NULL, and a CHECK
-- admits NULL. A receipt that omits a field must be refused, not admitted.

ALTER TABLE quickbooks_mutation_preparations
  ADD COLUMN IF NOT EXISTS operator_resolution_receipt jsonb;

ALTER TABLE quickbooks_mutation_preparations
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_operator_resolution_shape;

ALTER TABLE quickbooks_mutation_preparations
  ADD CONSTRAINT quickbooks_mutation_operator_resolution_shape CHECK (
    operator_resolution_receipt IS NULL OR COALESCE((
      jsonb_typeof(operator_resolution_receipt) = 'object'
      AND operator_resolution_receipt->>'evidenceType' = 'QUICKBOOKS_OPERATOR_RESOLUTION'
      AND operator_resolution_receipt->>'evidenceVersion' = '1.0'
      AND operator_resolution_receipt->>'preparationId' = preparation_id
      AND operator_resolution_receipt->>'providerRequestId' = provider_request_id
      AND execution_attempt_id IS NOT NULL
      AND operator_resolution_receipt->>'attemptId' = execution_attempt_id

      -- (1) the row must carry the machine's own immutable proof that it ended
      -- with a dispatched write of unknown outcome
      AND dispatch_started_at IS NOT NULL
      AND jsonb_typeof(execution_resolution_receipt) = 'object'
      AND execution_resolution_receipt->>'resolution' = 'WRITE_RESULT_UNKNOWN_NO_ID'

      -- (3) authority: human, explicit, never a standing delegation
      AND operator_resolution_receipt->>'attestationAuthority' = 'HUMAN_EXPLICIT_CONFIRMATION'
      AND btrim(operator_resolution_receipt->>'attestedBy') <> ''
      AND operator_resolution_receipt->>'attestedBy' NOT LIKE 'standing:%'
      AND operator_resolution_receipt->>'attestedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND btrim(operator_resolution_receipt->>'operatorNote') <> ''

      -- (4) the confirmation phrase, recomputed from this row's own identity
      AND operator_resolution_receipt->>'confirmationPhraseHash' = encode(sha256(convert_to(
        'CONFIRM QUICKBOOKS OPERATOR RESOLUTION '
          || (operator_resolution_receipt->>'finding')
          || CASE WHEN operator_resolution_receipt->>'finding' = 'PRESENT'
               THEN ' ' || (operator_resolution_receipt->>'providerEntityId')
               ELSE '' END
          || ' FOR ' || preparation_id
          || ' IN ' || bound_target_ref_safe
          || ' PAYLOAD ' || payload_hash,
        'UTF8')), 'hex')

      AND (
        -- (5) attested absent: the search evidence travels with the claim, and
        -- the row can never acquire a Provider id afterwards
        (operator_resolution_receipt->>'finding' = 'ABSENT'
          AND provider_entity_id IS NULL
          AND provider_outcome_receipt IS NULL
          AND operator_resolution_receipt->>'providerMutationPossible' = 'false'
          AND NOT operator_resolution_receipt ? 'providerEntityId'
          AND jsonb_typeof(operator_resolution_receipt->'naturalKeySearch') = 'object'
          AND jsonb_typeof(operator_resolution_receipt->'naturalKeySearch'->'checked') = 'boolean'
          AND jsonb_typeof(operator_resolution_receipt->'naturalKeySearch'->'matchCount') = 'number'
          AND operator_resolution_receipt->'naturalKeySearch'->>'matchCount' = '0'
          AND btrim(operator_resolution_receipt->'naturalKeySearch'->>'method') <> ''
          -- an unchecked natural key must say so; it may never pass as checked
          AND (operator_resolution_receipt->'naturalKeySearch'->>'checked' = 'true'
            OR btrim(operator_resolution_receipt->'naturalKeySearch'->>'reasonCode') <> ''))
        OR
        -- (6) attested present: only the attested id may ever be adopted
        (operator_resolution_receipt->>'finding' = 'PRESENT'
          AND btrim(operator_resolution_receipt->>'providerEntityId') <> ''
          AND operator_resolution_receipt->>'readbackVerification' = 'OPERATOR_ATTESTED_EXACT_ID_READBACK'
          AND (provider_entity_id IS NULL
            OR provider_entity_id = operator_resolution_receipt->>'providerEntityId'))
      )
    ), false)
  );

-- The attestation is a one-way, one-time write. Everything that decides whether
-- it may be made is read from OLD, so no statement can both create the
-- conditions for an attestation and take advantage of them.
CREATE OR REPLACE FUNCTION quickbooks_mutation_operator_resolution_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operator_resolution_receipt IS NOT NULL
    AND NEW.operator_resolution_receipt IS DISTINCT FROM OLD.operator_resolution_receipt THEN
    RAISE EXCEPTION 'QuickBooks operator resolution receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.operator_resolution_receipt IS NULL AND NEW.operator_resolution_receipt IS NOT NULL THEN
    IF OLD.state <> 'WRITE_RESULT_UNKNOWN_NO_ID'
      OR OLD.execution_attempt_state <> 'WRITE_RESULT_UNKNOWN_NO_ID'
      OR OLD.provider_entity_id IS NOT NULL THEN
      RAISE EXCEPTION 'QuickBooks operator resolution may only attest a write whose durable outcome is unknown'
        USING ERRCODE = '23514';
    END IF;
    -- Recording what an operator found is not itself a state transition. A
    -- PRESENT finding moves the row on afterwards, through the same exact-Id
    -- Provider outcome checkpoint every other recovery uses, never here.
    IF NEW.state IS DISTINCT FROM OLD.state
      OR NEW.execution_attempt_state IS DISTINCT FROM OLD.execution_attempt_state
      OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
      OR NEW.provider_outcome_receipt IS DISTINCT FROM OLD.provider_outcome_receipt
      OR NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'QuickBooks operator resolution must not alter the recorded write outcome'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quickbooks_mutation_operator_resolution_immutable
  ON quickbooks_mutation_preparations;
CREATE TRIGGER quickbooks_mutation_operator_resolution_immutable
BEFORE UPDATE OF operator_resolution_receipt
ON quickbooks_mutation_preparations
FOR EACH ROW EXECUTE FUNCTION quickbooks_mutation_operator_resolution_guard();
