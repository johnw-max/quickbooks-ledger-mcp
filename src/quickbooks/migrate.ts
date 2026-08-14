import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { sha256 } from "../security/hash.js";

const { Pool } = pg;

export async function runQuickBooksMigrations(databaseUrl: string, migrationsDirectory: string): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations(
      version text PRIMARY KEY,
      checksum_sha256 text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 text");
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      const sql = await readFile(resolve(migrationsDirectory, file), "utf8");
      const checksum = sha256(sql);
      const present = await client.query<{ checksum_sha256: string | null }>(
        "SELECT checksum_sha256 FROM schema_migrations WHERE version=$1",
        [file],
      );
      const recordedChecksum = present.rows[0]?.checksum_sha256;
      if (present.rows.length > 0) {
        if (recordedChecksum !== null && recordedChecksum !== checksum) {
          throw new Error(`QuickBooks migration checksum mismatch for ${file}`);
        }
        // Older deployments predate checksums. Keep that history explicitly
        // unverified instead of backfilling a checksum we cannot prove.
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version,checksum_sha256) VALUES($1,$2)", [file, checksum]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const applied = await runQuickBooksMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  console.log(JSON.stringify({ applied }));
}
