import pg from "pg";
import { loadErrorCollectorConfig } from "../lib/cpa-errors/config.mjs";
import { getErrorCollectorHealth } from "../lib/cpa-errors/query.mjs";

async function main() {
  const config = loadErrorCollectorConfig();
  if (!config.enabled) { console.log('{"healthy":false,"status":"disabled"}'); process.exitCode = 1; return; }
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 3000,
    statement_timeout: 3000, query_timeout: 4000, application_name: "cpa-error-health" });
  pool.on("error", () => { process.exitCode = 1; });
  try {
    const health = await getErrorCollectorHealth(pool, config.instanceId);
    console.log(JSON.stringify(health));
    if (!health.healthy) process.exitCode = 1;
  } finally { await pool.end(); }
}
main().catch(() => { console.error('{"healthy":false,"status":"query_failed"}'); process.exitCode = 1; });
