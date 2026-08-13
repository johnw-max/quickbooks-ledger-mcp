SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS quickbooks_mutation_preparations (
  preparation_id text PRIMARY KEY CHECK (preparation_id ~ '^qbm_[a-f0-9]{32}$'),
  actor_id text NOT NULL,
  realm_id text NOT NULL CHECK (realm_id ~ '^[0-9]{3,32}$'),
  connection_ref_safe text NOT NULL,
  bound_target_ref_safe text NOT NULL,
  binding_revision text NOT NULL,
  entity text NOT NULL CHECK (entity IN (
    'Account','Attachable','Bill','BillPayment','Class','CompanyInfo','CreditMemo','Customer',
    'Department','Deposit','Employee','Estimate','Invoice','Item','JournalEntry','Payment',
    'PaymentMethod','Purchase','PurchaseOrder','RefundReceipt','SalesReceipt','Term','TimeActivity',
    'Transfer','Vendor','VendorCredit'
  )),
  operation text NOT NULL CHECK (operation IN ('CREATE','UPDATE','DELETE')),
  risk text NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  execution_mode text NOT NULL CHECK (execution_mode IN (
    'EXPLICIT_CONFIRMATION','HUMAN_REVIEW','RESTRICTED_HUMAN_REVIEW'
  )),
  provider_effect text NOT NULL CHECK (provider_effect IN (
    'NON_POSTING','MASTER_DATA','POSTING_TRANSACTION','CASH_MOVEMENT','LEDGER_ADJUSTMENT',
    'DEACTIVATION','VOID_OR_PERMANENT_DELETE','PERMANENT_DELETE','ATTACHMENT'
  )),
  client_request_id text NOT NULL CHECK (client_request_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  provider_request_id text NOT NULL CHECK (char_length(provider_request_id) BETWEEN 1 AND 50),
  target_id text,
  sync_token text,
  before_image jsonb,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  business_reason text NOT NULL,
  source_ref text,
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[a-f0-9]{64}$'),
  source_digest_provenance text CHECK (source_digest_provenance IS NULL OR source_digest_provenance IN (
    'AGENT_SUPPLIED_TEXT_FINGERPRINT','HOST_PROVIDED_ORIGINAL_FILE_SHA256',
    'EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256'
  )),
  approval_ref text,
  confirmation_phrase_hash text NOT NULL CHECK (confirmation_phrase_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'PREPARED','EXECUTING','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED',
    'READBACK_MISMATCH','BLOCKED_VALIDATION','REJECTED'
  )),
  approved_by text,
  approved_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  provider_entity_id text,
  write_receipt jsonb,
  readback jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (actor_id, realm_id, entity, operation, client_request_id),
  UNIQUE (realm_id, provider_request_id),
  CHECK (
    (operation = 'CREATE' AND target_id IS NULL AND sync_token IS NULL AND before_image IS NULL)
    OR (operation IN ('UPDATE','DELETE') AND target_id IS NOT NULL AND sync_token IS NOT NULL
        AND jsonb_typeof(before_image) = 'object')
  ),
  CHECK (
    (source_ref IS NULL AND source_sha256 IS NULL AND source_digest_provenance IS NULL)
    OR (source_ref IS NOT NULL AND source_sha256 IS NOT NULL AND source_digest_provenance IS NOT NULL)
  ),
  CHECK (
    (state = 'PREPARED' AND approved_by IS NULL AND approved_at IS NULL AND rejected_by IS NULL AND rejected_at IS NULL)
    OR (state = 'REJECTED' AND approved_by IS NULL AND approved_at IS NULL AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL)
    OR (state IN ('EXECUTING','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED','READBACK_MISMATCH','BLOCKED_VALIDATION')
        AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL)
  ),
  CHECK (
    (state = 'POSTED_READBACK_VERIFIED' AND provider_entity_id IS NOT NULL
      AND jsonb_typeof(write_receipt) = 'object' AND jsonb_typeof(readback) = 'object')
    OR (state <> 'POSTED_READBACK_VERIFIED' AND provider_entity_id IS NULL AND write_receipt IS NULL AND readback IS NULL)
  ),
  CHECK (expires_at > created_at AND updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS quickbooks_mutation_actor_created_idx
  ON quickbooks_mutation_preparations (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quickbooks_mutation_recovery_idx
  ON quickbooks_mutation_preparations (state, updated_at)
  WHERE state IN ('EXECUTING','WRITE_RESULT_UNKNOWN');
