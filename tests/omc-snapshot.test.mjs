import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const snapshotScript = new URL("../scripts/snapshot-omc-sqlite.py", import.meta.url).pathname;

test("OMC snapshot cutoff uses original CPA event time, not delayed OMC insertion time", () => {
  const directory = mkdtempSync(join(tmpdir(), "monitor-omc-cutoff-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "snapshot.sqlite");
  try {
    const fixture = spawnSync("python3", ["-c", `
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("CREATE TABLE usage_events (id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, created_at_ms INTEGER)")
connection.executemany("INSERT INTO usage_events VALUES (?, ?, ?)", [(1, 900, 1000), (2, 1900, 2500), (3, 2900, 3000)])
connection.commit()
connection.close()
`, source], { encoding: "utf8" });
    assert.equal(fixture.status, 0, fixture.stderr);

    const snapshot = spawnSync("python3", [snapshotScript, "--source", source, "--destination", destination, "--event-before-ms", "2000"], { encoding: "utf8" });
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.match(snapshot.stdout, /snapshot_ok rows=2 .*event_before_ms=2000/);

    const verify = spawnSync("python3", ["-c", `
import sqlite3, sys
for path in sys.argv[1:]:
 connection = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
 print(connection.execute("SELECT count(*) FROM usage_events").fetchone()[0])
 if path == sys.argv[2]:
  print(connection.execute("SELECT max(created_at_ms) FROM usage_events").fetchone()[0])
 connection.close()
`, source, destination], { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout.trim(), /^3\s+2\s+2500$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});