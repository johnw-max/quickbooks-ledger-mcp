SET LOCAL lock_timeout = '5s';

ALTER TABLE quickbooks_mutation_preparations
  ADD COLUMN IF NOT EXISTS source_attestation_digest text;

ALTER TABLE quickbooks_mutation_preparations
  DROP CONSTRAINT IF EXISTS quickbooks_mutation_source_attestation_digest_check;

ALTER TABLE quickbooks_mutation_preparations
  ADD CONSTRAINT quickbooks_mutation_source_attestation_digest_check
  CHECK (
    source_attestation_digest IS NULL
    OR (
      source_attestation_digest ~ '^[a-f0-9]{64}$'
      AND source_attestation_digest <> repeat('0', 64)
    )
  );
