import type { Server } from "node:http";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createLogger } from "../logging.js";
import { Aes256GcmTokenCipher } from "../security/tokenCipher.js";
import { QuickBooksClientManager } from "./clientManager.js";
import { QuickBooksPostgresConnectionRepository } from "./connections.js";
import { QuickBooksConnectionTicketService } from "./connectionTicketService.js";
import { loadQuickBooksConfig } from "./config.js";
import { createQuickBooksHttpApp } from "./httpApp.js";
import { QuickBooksOAuthService } from "./oauthService.js";
import { QuickBooksMcpOAuthService } from "./mcpOAuthService.js";
import { QuickBooksPostgresMcpOAuthRepository } from "./mcpOAuthRepository.js";
import { QuickBooksPostgresPostingRepository } from "./postgresRepository.js";
import { QuickBooksPostgresMutationRepository } from "./postgresMutationRepository.js";
import { ServerBoundQuickBooksProviderResolver } from "./providerResolver.js";
import { QuickBooksReviewService } from "./reviewService.js";
import { QuickBooksWorkflowService } from "./service.js";
import { QuickBooksMutationService } from "./mutationService.js";
import { QuickBooksTargetSessionService } from "./targetSession.js";
import { QuickBooksAccountingCaseService } from "./accountingCaseService.js";
import { QuickBooksPostgresAccountingCaseRepository } from "./postgresAccountingCaseRepository.js";
import { QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES } from "./accountingCase.js";
import { QuickBooksPostgresControlRepository } from "./postgresControlRepository.js";
import { runQuickBooksMigrations } from "./migrate.js";
import { inspectQuickBooksRuntimeReadiness } from "./runtimeReadiness.js";
import { QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS } from "./mutationExecutionAttempt.js";

async function main(): Promise<void> {
  const config = loadQuickBooksConfig();
  const logger = createLogger(config);
  const migrationsDirectory = resolve(process.cwd(), "migrations");
  await runQuickBooksMigrations(config.databaseUrl, migrationsDirectory);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const controlRepository = new QuickBooksPostgresControlRepository(pool);
  const connectionRepository = new QuickBooksPostgresConnectionRepository(pool);
  const postingRepository = new QuickBooksPostgresPostingRepository(pool);
  const mutationRepository = new QuickBooksPostgresMutationRepository(pool);
  const accountingCaseRepository = new QuickBooksPostgresAccountingCaseRepository(pool);
  const mcpOAuthRepository = config.mcpOAuth ? new QuickBooksPostgresMcpOAuthRepository(pool) : undefined;
  const executeScopeAuthorizer = mcpOAuthRepository
    ? (actorId: string, requiredScope: string) => mcpOAuthRepository.actorHasScope(actorId, requiredScope, new Date())
    : undefined;
  const cipher = new Aes256GcmTokenCipher(config.tokenEncryptionKey);
  const managerConfig = { ...config.oauth };
  const manager = new QuickBooksClientManager({
    repository: connectionRepository,
    cipher,
    config: managerConfig,
    logger,
  });
  const tickets = new QuickBooksConnectionTicketService(controlRepository, config.publicBaseUrl);
  const targetSessions = new QuickBooksTargetSessionService({
    cipher,
    ttlSeconds: config.targetSessionTtlSeconds,
  });
  const resolver = new ServerBoundQuickBooksProviderResolver({
    manager,
    connectUrl: (actorId) => tickets.issue(actorId),
    targetSessions,
  });
  const workflow = new QuickBooksWorkflowService({
    repository: postingRepository,
    resolver,
    publicBaseUrl: config.publicBaseUrl,
    writeEnabled: config.writeEnabled,
    writeTargetMode: config.writeTargetMode,
    ...(config.allowedRealmId ? { allowedRealmId: config.allowedRealmId } : {}),
    ...(executeScopeAuthorizer ? { executeScopeAuthorizer } : {}),
  });
  const mutations = new QuickBooksMutationService(mutationRepository, resolver, {
    writeEnabled: config.writeEnabled,
    writeTargetMode: config.writeTargetMode,
    publicBaseUrl: config.publicBaseUrl,
    ...(config.allowedRealmId ? { allowedRealmId: config.allowedRealmId } : {}),
    ...(config.allowedWriteCapabilities.length ? { allowedCapabilities: config.allowedWriteCapabilities } : {}),
    ...(config.restrictedReviewerActors.length ? { restrictedReviewerActors: config.restrictedReviewerActors } : {}),
    accountingCaseReleasedCapabilities: QUICKBOOKS_ACCOUNTING_CASE_RELEASED_CAPABILITIES,
    ...(executeScopeAuthorizer ? { executeScopeAuthorizer } : {}),
    ...(config.standingDelegationEnabled ? {
      standingDelegationProvider: async (context, realmId) => {
        if (!context.workspaceId || !context.agentId || !context.oauthInstallationId) return [];
        return [{
          delegationId: `qbo-default-${context.oauthInstallationId}`,
          revision: 1,
          status: "ACTIVE" as const,
          providerId: "quickbooks",
          workspaceId: context.workspaceId,
          agentId: context.agentId,
          installationId: context.oauthInstallationId,
          tenantIds: [realmId],
          actionIds: config.standingDelegationActions,
        }];
      },
    } : {}),
  }, controlRepository);
  const accountingCases = new QuickBooksAccountingCaseService(accountingCaseRepository, resolver, mutations);
  const oauth = new QuickBooksOAuthService({
    states: controlRepository,
    manager,
    config: managerConfig,
  });
  const reviews = new QuickBooksReviewService({
    postings: postingRepository,
    mutations: mutationRepository,
    security: controlRepository,
  });
  const mcpOAuth = config.mcpOAuth && mcpOAuthRepository ? new QuickBooksMcpOAuthService({
    repository: mcpOAuthRepository,
    manager,
    qbo: managerConfig,
    config: config.mcpOAuth,
    cipher,
    onActorSecurityRevoked: async (actorId) => {
      await reviews.revokeActorSessions(actorId);
    },
  }) : undefined;
  const runtimeReadiness = () => inspectQuickBooksRuntimeReadiness({
    pool,
    migrationsDirectory,
    controlRepositoryReady: () => controlRepository.readiness(),
    mutationRepositoryReady: () => mutationRepository.readiness(),
    accountingCaseRepositoryReady: () => accountingCaseRepository.readiness(),
  });
  const reconcileExecutionAttempts = async () => {
    const reconciliation = await mutationRepository.reconcileStaleExecutionAttempts(new Date());
    if (reconciliation.stalePreDispatchReclaimable > 0 || reconciliation.transitionedToUnknownNoId > 0) {
      logger.info("QuickBooks mutation execution attempts reconciled.", {
        stalePreDispatchReclaimable: reconciliation.stalePreDispatchReclaimable,
        transitionedToUnknownNoId: reconciliation.transitionedToUnknownNoId,
        oldestStaleAt: reconciliation.oldestStaleAt?.toISOString(),
      });
    }
  };
  let startupReadiness: Awaited<ReturnType<typeof runtimeReadiness>>;
  try {
    startupReadiness = await runtimeReadiness();
  } catch (error) {
    await pool.end();
    throw error;
  }
  if (!startupReadiness.ready) {
    await pool.end();
    throw new Error(`QuickBooks startup readiness failed: ${JSON.stringify({
      persistence: startupReadiness.persistence.status,
      migrations: startupReadiness.migrations.status,
      missingMigrations: startupReadiness.migrations.missingCount,
      unexpectedMigrations: startupReadiness.migrations.unexpectedCount,
      checksumMismatches: startupReadiness.migrations.checksumMismatchCount,
      legacyCompilerRows: startupReadiness.migrations.legacyCompilerRowCount,
    })}`);
  }
  await reconcileExecutionAttempts();
  const app = createQuickBooksHttpApp({
    config,
    workflow,
    mutations,
    accountingCases,
    oauth,
    ...(mcpOAuth ? { mcpOAuth } : {}),
    reviews,
    tickets,
    readiness: runtimeReadiness,
    logger,
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(config.port, config.host);
    const onError = (error: Error) => {
      candidate.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      candidate.off("error", onError);
      resolve(candidate);
    };
    candidate.once("error", onError);
    candidate.once("listening", onListening);
  });
  logger.info("QuickBooks Accounting MCP server started.", { host: config.host, port: config.port });

  const executionReconciler = setInterval(() => {
    void reconcileExecutionAttempts().catch((error: unknown) => {
      logger.error("QuickBooks mutation execution reconciliation failed.", {
        errorClass: error instanceof Error ? error.name : "ExecutionReconciliationError",
      });
    });
  }, Math.max(30_000, Math.floor(QUICKBOOKS_MUTATION_EXECUTION_LEASE_MS / 2)));
  executionReconciler.unref();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(executionReconciler);
    logger.info("QuickBooks Accounting MCP server stopping.");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
  };
  const requestShutdown = () => {
    void shutdown().catch((error: unknown) => {
      logger.error("QuickBooks Accounting MCP shutdown failed.", {
        errorClass: error instanceof Error ? error.name : "ShutdownError",
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
}

main().catch((error: unknown) => {
  const errorClass = error instanceof Error ? error.name : "StartupError";
  const errorMessage = error instanceof Error
    ? error.message
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
      .slice(0, 1_024)
    : "QuickBooks startup failed with a non-Error value.";
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    message: "QuickBooks startup failed.",
    errorClass,
    errorMessage,
  }));
  process.exitCode = 1;
});
