import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

export async function errorTestDatabase(t) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.ok(decodeURIComponent(url.pathname).toLowerCase().includes("test"));
  const admin = new pg.Pool({ connectionString: url.toString(), max: 1 });
  assert.match((await admin.query("SHOW server_version")).rows[0].server_version, /^17\./);
  const schema = "phase55_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const { tag } of journal.entries) await pool.query(await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8"));
  return { pool, url: url.toString(), schema };
}
