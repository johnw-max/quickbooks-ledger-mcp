import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg, { type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const hash = "a".repeat(64);

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function sql(name: string): Promise<string> {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function install027Era(client: PoolClient, schema: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(await sql("025_quickbooks_generic_mutations.sql"));
    await client.query(await sql("027_quickbooks_accounting_case_foundation.sql"));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertCase(client: PoolClient, schema: string, options: {
  caseId: string;
  actorId: string;
  realmId: string;
  compilerVersion: string;
  state: "PLANNED_NEEDS_PREFLIGHT" | "TERMINAL";
}): Promise<void> {
  const compiled = {
    caseId: options.caseId,
    providerId: "quickbooks",
    sourceRevisionHash: hash,
    version: 1,
    compilerVersion: options.compilerVersion,
  };
  await client.query(`INSERT INTO "${schema}".quickbooks_accounting_cases(
    case_id,version,actor_id,workspace_id,subject_type,subject_id,agent_id,installation_id,
    binding_id,binding_revision,connection_id,realm_id,target_session_hash,compiled_case,
    compiled_plan_hash,source_revision_hash,state,created_at,updated_at
  ) VALUES($1,1,$2,'workspace','USER','subject','agent','installation','binding',1,
    'connection',$3,$4,$5::jsonb,$4,$4,$6,now(),now())`, [
    options.caseId,
    options.actorId,
    options.realmId,
    hash,
    JSON.stringify(compiled),
    options.state,
  ]);
}

describeWithPostgres("QuickBooks migration 029 real PostgreSQL upgrade safety", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
  afterAll(async () => { await pool?.end(); });

  it.each(["PLANNED_NEEDS_PREFLIGHT", "TERMINAL"] as const)(
    "blocks a 027-era compiler 0.1 %s row without silently transforming it",
    async (state) => {
      if (!pool) throw new Error("TEST_DATABASE_URL is required");
      const schema = identifier("qbo_legacy_upgrade");
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await install027Era(client, schema);
        await insertCase(client, schema, {
          caseId: `case-${state.toLowerCase()}`,
          actorId: "actor-a",
          realmId: "9341457701636490",
          compilerVersion: "0.1.0",
          state,
        });

        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        await expect(client.query(await sql("029_quickbooks_accounting_case_evidence_linkage.sql")))
          .rejects.toThrow(/legacy QuickBooks Accounting Case requires external audit archive/u);
        await client.query("ROLLBACK");

        const unchanged = await client.query<{ compiler_version: string; state: string }>(
          `SELECT compiled_case->>'compilerVersion' AS compiler_version,state
           FROM "${schema}".quickbooks_accounting_cases`,
        );
        expect(unchanged.rows).toEqual([{ compiler_version: "0.1.0", state }]);
        const columns = await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema=$1 AND table_name='quickbooks_accounting_case_operations'
             AND column_name IN ('preparation_payload_hash','operation_source_evidence_hash')`,
          [schema],
        );
        expect(columns.rows).toEqual([]);
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
      }
    },
  );

  it("enforces preparation actor, realm, and payload-hash linkage after a clean 0.2 upgrade", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const schema = identifier("qbo_linkage_guard");
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await install027Era(client, schema);
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      await client.query(await sql("029_quickbooks_accounting_case_evidence_linkage.sql"));
      await client.query(await sql("031_quickbooks_accounting_case_preparation_identity.sql"));
      await client.query("COMMIT");
      await client.query(`SET search_path TO "${schema}", public`);
      await insertCase(client, schema, {
        caseId: "case-linkage",
        actorId: "actor-a",
        realmId: "9341457701636490",
        compilerVersion: "0.2.0",
        state: "PLANNED_NEEDS_PREFLIGHT",
      });

      const insertPreparation = async (preparationId: string, actorId: string, realmId: string, payloadHash: string) => {
        await client.query(`INSERT INTO "${schema}".quickbooks_mutation_preparations(
          preparation_id,actor_id,realm_id,connection_ref_safe,bound_target_ref_safe,binding_revision,
          entity,operation,risk,execution_mode,provider_effect,client_request_id,provider_request_id,
          payload,payload_hash,business_reason,confirmation_phrase_hash,state,created_at,expires_at,updated_at
        ) VALUES($1,$2,$3,'connection-safe','target-safe','binding-revision','Customer','CREATE','LOW',
          'EXPLICIT_CONFIRMATION','MASTER_DATA',$4,$5,'{}'::jsonb,$6,'migration linkage test',$7,
          'PREPARED',now(),now()+interval '10 minutes',now())`, [
          preparationId,
          actorId,
          realmId,
          `client-${preparationId.slice(-12)}`,
          `provider-${preparationId.slice(-12)}`,
          payloadHash,
          hash,
        ]);
      };
      const insertOperation = (operationId: string, preparationId: string, payloadHash: string) =>
        client.query(`INSERT INTO "${schema}".quickbooks_accounting_case_operations(
          workspace_id,subject_type,subject_id,agent_id,installation_id,binding_id,binding_revision,
          connection_id,realm_id,case_id,case_version,operation_id,operation_json,state,preparation_id,
          preparation_payload_hash,operation_source_evidence_hash,created_at,updated_at
        ) VALUES('workspace','USER','subject','agent','installation','binding',1,'connection',
          '9341457701636490','case-linkage',1,$1,$2::jsonb,'PREPARED',$3,$4,$5,now(),now())`, [
          operationId,
          JSON.stringify({ operationId }),
          preparationId,
          payloadHash,
          hash,
        ]);

      const wrongActor = `qbm_${"1".repeat(32)}`;
      await insertPreparation(wrongActor, "actor-b", "9341457701636490", hash);
      await expect(insertOperation("operation-wrong-actor", wrongActor, hash))
        .rejects.toThrow(/preparation identity or payload hash/u);

      const wrongHash = `qbm_${"2".repeat(32)}`;
      await insertPreparation(wrongHash, "actor-a", "9341457701636490", "b".repeat(64));
      await expect(insertOperation("operation-wrong-hash", wrongHash, hash))
        .rejects.toThrow(/preparation identity or payload hash/u);

      const valid = `qbm_${"3".repeat(32)}`;
      await insertPreparation(valid, "actor-a", "9341457701636490", hash);
      await expect(insertOperation("operation-valid", valid, hash)).resolves.toBeDefined();
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
    }
  });

  it.each(["WRITE_RESULT_UNKNOWN", "READBACK_MISMATCH"] as const)(
    "fails a legacy %s row without an exact Provider checkpoint closed to operator resolution",
    async (legacyState) => {
      if (!pool) throw new Error("TEST_DATABASE_URL is required");
      const schema = identifier("qbo_execution_upgrade");
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        await client.query(await sql("025_quickbooks_generic_mutations.sql"));
        await client.query(await sql("026_quickbooks_source_attestation.sql"));
        await client.query(await sql("030_quickbooks_mutation_recovery.sql"));
        await client.query(`INSERT INTO quickbooks_mutation_preparations(
          preparation_id,actor_id,realm_id,connection_ref_safe,bound_target_ref_safe,binding_revision,
          entity,operation,risk,execution_mode,provider_effect,client_request_id,provider_request_id,
          payload,payload_hash,business_reason,confirmation_phrase_hash,state,approved_by,approved_at,
          created_at,expires_at,updated_at
        ) VALUES(
          'qbm_${"7".repeat(32)}','actor-legacy','9341457701636490','qbc-safe','qbt-safe','qbr-safe',
          'Customer','CREATE','LOW','EXPLICIT_CONFIRMATION','MASTER_DATA','legacy.request.033',
          'zc.legacy.033','{}'::jsonb,$1,'legacy uncertain row',$1,$2,'actor-legacy',now()-interval '5 minutes',
          now()-interval '10 minutes',now()+interval '10 minutes',now()-interval '5 minutes'
        )`, [hash, legacyState]);
        await client.query(await sql("033_quickbooks_mutation_execution_fencing.sql"));
        const migrated = await client.query<{
          state: string;
          execution_attempt_state: string;
          provider_entity_id: string | null;
          automatic_rearm: string;
          operator_resolution: string;
          reason_code: string;
        }>(`SELECT state,execution_attempt_state,provider_entity_id,
          execution_resolution_receipt->>'automaticRearmAllowed' AS automatic_rearm,
          execution_resolution_receipt->>'operatorResolutionRequired' AS operator_resolution,
          execution_resolution_receipt->>'reasonCode' AS reason_code
          FROM quickbooks_mutation_preparations`);
        expect(migrated.rows).toEqual([{
          state: "WRITE_RESULT_UNKNOWN_NO_ID",
          execution_attempt_state: "WRITE_RESULT_UNKNOWN_NO_ID",
          provider_entity_id: null,
          automatic_rearm: "false",
          operator_resolution: "true",
          reason_code: "LEGACY_RECOVERY_WITHOUT_EXACT_ID_MIGRATED_FAIL_CLOSED",
        }]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
      }
    },
  );
});
