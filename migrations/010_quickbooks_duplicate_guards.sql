CREATE UNIQUE INDEX IF NOT EXISTS quickbooks_posting_active_source_unique_idx
  ON quickbooks_posting_requests (actor_id, realm_id, source_sha256)
  WHERE state IN ('PREPARED','POSTING','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED');

CREATE UNIQUE INDEX IF NOT EXISTS quickbooks_posting_active_supplier_doc_unique_idx
  ON quickbooks_posting_requests (
    actor_id,
    realm_id,
    (payload->>'vendorId'),
    (lower(btrim(payload->>'docNumber')))
  )
  WHERE state IN ('PREPARED','POSTING','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED')
    AND payload ? 'docNumber';
