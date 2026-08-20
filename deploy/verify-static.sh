#!/bin/sh
set -eu

require_text() {
  grep -F -- "$2" "$1" >/dev/null || { echo "missing '$2' in $1" >&2; exit 1; }
}
require_match() {
  grep -E -- "$2" "$1" >/dev/null || { echo "no line matching /$2/ in $1" >&2; exit 1; }
}
forbid_text() {
  if grep -F -- "$2" "$1" >/dev/null; then echo "forbidden '$2' in $1" >&2; exit 1; fi
}

require_text deploy/Dockerfile "USER 10001:10001"
require_text deploy/compose.yaml "read_only: true"
require_text deploy/compose.yaml "no-new-privileges:true"
require_text deploy/compose.yaml "host_ip: 127.0.0.1"
require_text deploy/compose.yaml "networks: [quickbooks-egress, quickbooks-data]"
require_text deploy/promote-qbo-candidate.mjs "must have separate data and egress networks"
require_text deploy/promote-qbo-candidate.mjs "oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
# Shape, not this deployment's hostname. The gate validates the artifact being
# shipped, not the environment shipping it: production runs on the customer's
# own domain, and asserting ours here failed their build for being correct.
require_match deploy/env.example "^QUICKBOOKS_PUBLIC_BASE_URL=https://[^[:space:]]+$"
require_text deploy/env.example "QUICKBOOKS_MCP_OAUTH_HOST_CLIENTS_JSON="
# Host client redirect URIs are per-deployment. What must hold is that every one
# of them is an absolute https URL — a relative or http redirect target is the
# defect worth failing over.
require_match deploy/env.example "\"redirectUris\"|REPLACE_WITH_EXACT_WORK_REDIRECT_URI"
require_text deploy/env.example "REPLACE_WITH_EXACT_WORK_REDIRECT_URI"
require_text deploy/env.example "QUICKBOOKS_WRITE_ENABLED=false"
require_text deploy/env.example "CREATE:JournalEntry"
require_text deploy/env.example "CREATE:Purchase"
require_text deploy/env.example "CREATE:SalesReceipt"
require_text deploy/env.example "CREATE:Attachable"
require_text deploy/env.example "CREATE:Account"
require_text deploy/env.example "CREATE:Item"
require_text deploy/env.example "journal_entry.create"
require_text deploy/env.example "purchase.create"
require_text deploy/env.example "sales_receipt.create"
require_text deploy/env.example "attachment.create"
require_text deploy/env.example "account.create"
require_text deploy/env.example "item.create"
require_text deploy/env.example "QUICKBOOKS_STANDING_DELEGATION_ENABLED=false"
# Money movement stays unreleased by decision. Pinning its absence here is the
# only place a config drift toward it would be caught before deployment.
forbid_text deploy/env.example "CREATE:Payment"
forbid_text deploy/env.example "CREATE:BillPayment"
forbid_text deploy/env.example "CREATE:Deposit"
forbid_text deploy/env.example "CREATE:Transfer"
forbid_text deploy/env.example "CREATE:RefundReceipt"
require_text migrations/027_quickbooks_accounting_case_foundation.sql "quickbooks_accounting_cases"
require_text migrations/028_quickbooks_control_plane.sql "quickbooks_tool_audit_logs"
require_text migrations/031_quickbooks_accounting_case_preparation_identity.sql "preparation.actor_id = case_row.actor_id"
require_text src/quickbooks/server.ts "await runQuickBooksMigrations"
require_text src/quickbooks/server.ts "startupReadiness = await runtimeReadiness()"
require_text src/quickbooks/server.ts "if (!startupReadiness.ready)"
require_text src/quickbooks/migrate.ts "migration checksum mismatch"
require_text src/quickbooks/httpApp.ts "dynamicProviderRolesAvailable: false"
forbid_text deploy/env.example "XERO_"
forbid_text package.json "xero-node"
forbid_text src/quickbooks/server.ts "PostgresAccountingRepository"
echo "QuickBooks standalone deployment static checks passed."
