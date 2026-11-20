import pg from "pg";
import { loadErrorCollectorConfig } from "../lib/cpa-errors/config.mjs";
import { runErrorCollector } from "../lib/cpa-errors/collector.mjs";
import { createErrorStore } from "../lib/cpa-errors/store.mjs";

async function main() {
  const config = loadErrorCollectorConfig();
  if (!config.enabled) { console.log('{"event":"error_collector_disabled"}'); return; }
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 8000, query_timeout: 10000, application_name: "cpa-error-collector" });
  const controller = new AbortController();
  let shutdownDeadline;
  const stop = () => {
    controller.abort();
    // A stuck driver must not outlive the Compose grace period. An expired lease
    // retains only the last confirmed session watermark after a forced exit.
    shutdownDeadline ??= setTimeout(() => process.exit(1), 25000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  pool.on("error", stop);
  try {
    await runErrorCollector({ config, store: createErrorStore(pool, config), signal: controller.signal,
      report: (metadata) => console.log(JSON.stringify(metadata)) });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await pool.end();
    clearTimeout(shutdownDeadline);
  }
}
main().catch(() => { console.error('{"event":"error_collector_stopped","reason":"collector_failed"}'); process.exitCode = 1; });
