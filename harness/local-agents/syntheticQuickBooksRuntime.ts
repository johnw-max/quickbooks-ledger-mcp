import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS, QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES } from "../../src/quickbooks/accountingCase.js";
import { QuickBooksAccountingCaseService } from "../../src/quickbooks/accountingCaseService.js";
import { InMemoryQuickBooksAccountingCaseRepository } from "../../src/quickbooks/inMemoryAccountingCaseRepository.js";
import { InMemoryQuickBooksMutationRepository } from "../../src/quickbooks/inMemoryMutationRepository.js";
import { createQuickBooksMcpServer } from "../../src/quickbooks/mcp.js";
import { QuickBooksMutationService } from "../../src/quickbooks/mutationService.js";
import type { QuickBooksProviderResolver } from "../../src/quickbooks/service.js";
import { QuickBooksWorkflowService } from "../../src/quickbooks/service.js";
import { createOAuthRequestContext, type ResolvedMcpAccessToken } from "../../src/security/requestContext.js";
import {
  SYNTHETIC_QUICKBOOKS_REALM_ID,
  SyntheticQuickBooksProvider,
} from "../lib/syntheticQuickBooksProvider.js";

export const SYNTHETIC_TARGET_SESSION_REF = `qbts_v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(64)}`;
export const SYNTHETIC_COMPANY_NAME = "zCloak Accounting Sandbox Pte Ltd";
const BINDING_REVISION = "quickbooks-binding-revision:local-synthetic-v1";

function targetExpiry(): Date {
  return new Date(Date.now() + 60 * 60_000);
}

export function createSyntheticQuickBooksHarnessRuntime(options: { writeEnabled: boolean }) {
  const provider = new SyntheticQuickBooksProvider();
  const resolver: QuickBooksProviderResolver = {
    async connectionStatus() {
      return {
        connected: true,
        company: { realmId: SYNTHETIC_QUICKBOOKS_REALM_ID, name: SYNTHETIC_COMPANY_NAME },
        scopes: ["com.intuit.quickbooks.accounting"],
        connectionRefSafe: "quickbooks-connection:local-synthetic-v1",
        boundTargetRefSafe: "quickbooks-target:local-synthetic-v1",
        bindingRevision: BINDING_REVISION,
      };
    },
    async issueTargetSession() {
      return {
        companyName: SYNTHETIC_COMPANY_NAME,
        connectionRefSafe: "quickbooks-connection:local-synthetic-v1",
        boundTargetRefSafe: "quickbooks-target:local-synthetic-v1",
        bindingRevision: BINDING_REVISION,
        targetSessionRef: SYNTHETIC_TARGET_SESSION_REF,
        expiresAt: targetExpiry().toISOString(),
      };
    },
    async resolve() {
      return {
        realmId: SYNTHETIC_QUICKBOOKS_REALM_ID,
        companyName: SYNTHETIC_COMPANY_NAME,
        connectionRefSafe: "quickbooks-connection:local-synthetic-v1",
        boundTargetRefSafe: "quickbooks-target:local-synthetic-v1",
        bindingRevision: BINDING_REVISION,
        targetSessionId: "local-synthetic-target-session-v1",
        targetSessionExpiresAt: targetExpiry(),
        provider,
      };
    },
  };

  const workflow = new QuickBooksWorkflowService({ resolver });
  const contextToken: ResolvedMcpAccessToken = {
    tokenId: "local-synthetic-token-v1",
    clientId: "local-synthetic-agent-client",
    resource: "http://127.0.0.1/quickbooks/mcp",
    audience: "http://127.0.0.1/quickbooks/mcp",
    grantedScopes: ["quickbooks.read", "quickbooks.mutation.prepare", "quickbooks.mutation.execute"],
    issuedAt: new Date(0),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    installationId: "local-synthetic-installation-v1",
    bindingId: "local-synthetic-binding-v1",
    connectionId: "local-synthetic-connection-v1",
    bindingRevision: 1,
    authorizationId: "local-synthetic-authorization-v1",
    workspaceId: "local-synthetic-workspace",
    subjectType: "USER",
    subjectId: "local-accountant",
    agentId: "local-accounting-agent",
    policyId: "local-synthetic-policy-v1",
    tenantId: SYNTHETIC_QUICKBOOKS_REALM_ID,
    identityAssurance: "TRUSTED_HOST_CONTEXT",
  };
  const context = createOAuthRequestContext({
    issuer: "urn:zcloak:quickbooks:synthetic-local-agent",
    resolvedToken: contextToken,
  });
  const mutations = new QuickBooksMutationService(
    new InMemoryQuickBooksMutationRepository(),
    resolver,
    {
      writeEnabled: options.writeEnabled,
      writeTargetMode: "oauth_bound",
      publicBaseUrl: "https://quickbooks-synthetic-business-uat.invalid",
      allowedCapabilities: [...QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES],
      accountingCaseReleasedCapabilities: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
      standingDelegationProvider: async () => options.writeEnabled ? [{
        delegationId: "local-synthetic-delegation-v1",
        revision: 1,
        status: "ACTIVE",
        providerId: "quickbooks",
        workspaceId: contextToken.workspaceId,
        agentId: contextToken.agentId,
        installationId: contextToken.installationId,
        tenantIds: [SYNTHETIC_QUICKBOOKS_REALM_ID],
        actionIds: [...QUICKBOOKS_ACCOUNTING_CASE_RELEASED_ACTIONS],
      }] : [],
    },
  );
  const accountingCases = new QuickBooksAccountingCaseService(
    new InMemoryQuickBooksAccountingCaseRepository(),
    resolver,
    mutations,
  );
  return {
    provider,
    writeEnabled: options.writeEnabled,
    createServer: () => createQuickBooksMcpServer(workflow, context, accountingCases, mutations),
  };
}
