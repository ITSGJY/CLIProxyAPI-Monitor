export function validateImportTarget(databaseUrl, options = {}) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new TypeError("DATABASE_URL must be a valid PostgreSQL URL");
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const isTestTarget = loopbackHosts.has(url.hostname) && database.toLowerCase().includes("test");
  if (isTestTarget) return { mode: "test", database, hostname: url.hostname };

  const explicitCliOptIn = options.allowProductionTarget === true;
  const explicitEnvironmentOptIn = options.productionEnvironmentOptIn === true;
  const isExactProductionTarget =
    url.protocol === "postgresql:" &&
    url.hostname === "postgres" &&
    (url.port === "" || url.port === "5432") &&
    decodeURIComponent(url.username) === "cliproxyapi_monitor" &&
    database === "cliproxyapi_monitor";

  if (explicitCliOptIn && explicitEnvironmentOptIn && isExactProductionTarget) {
    return { mode: "production", database, hostname: url.hostname };
  }

  throw new Error(
    "Import target rejected. Default imports require loopback PostgreSQL with a test database name. " +
    "Production imports require --allow-production-target, PHASE6_IMPORT_ALLOW_PRODUCTION_TARGET=true, " +
    "and the exact cliproxyapi_monitor role/database on Docker host 'postgres'."
  );
}
