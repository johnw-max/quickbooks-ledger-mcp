DROP INDEX IF EXISTS quickbooks_posting_active_source_unique_idx;
DROP INDEX IF EXISTS quickbooks_posting_active_supplier_doc_unique_idx;

CREATE UNIQUE INDEX quickbooks_posting_active_source_unique_idx
  ON quickbooks_posting_requests (realm_id, source_sha256)
  WHERE state IN ('PREPARED','POSTING','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED');

CREATE UNIQUE INDEX quickbooks_posting_active_supplier_doc_unique_idx
  ON quickbooks_posting_requests (
    realm_id,
    (payload->>'vendorId'),
    (lower(btrim(payload->>'docNumber')))
  )
  WHERE state IN ('PREPARED','POSTING','WRITE_RESULT_UNKNOWN','POSTED_READBACK_VERIFIED')
    AND payload ? 'docNumber';
