import assert from "node:assert/strict";
import { test } from "node:test";
import { validateImportTarget } from "../scripts/import-target-policy.mjs";

test("historical importer defaults to loopback test databases", () => {
  assert.equal(
    validateImportTarget("postgresql://tester:secret@127.0.0.1:5432/monitor_phase7_test").mode,
    "test"
  );
  assert.equal(
    validateImportTarget("postgresql://tester:secret@localhost/test_db").mode,
    "test"
  );
});

test("production import requires both explicit gates and the exact dedicated target", () => {
  const productionUrl = "postgresql://cliproxyapi_monitor:secret@postgres:5432/cliproxyapi_monitor";
  assert.throws(() => validateImportTarget(productionUrl), /Import target rejected/);
  assert.throws(
    () => validateImportTarget(productionUrl, { allowProductionTarget: true }),
    /Import target rejected/
  );
  assert.throws(
    () => validateImportTarget(productionUrl, { productionEnvironmentOptIn: true }),
    /Import target rejected/
  );
  assert.equal(
    validateImportTarget(productionUrl, {
      allowProductionTarget: true,
      productionEnvironmentOptIn: true
    }).mode,
    "production"
  );
});

test("production opt-in cannot target another host, role or database", () => {
  const options = { allowProductionTarget: true, productionEnvironmentOptIn: true };
  assert.throws(
    () => validateImportTarget("postgresql://cliproxyapi_monitor:secret@other-host:5432/cliproxyapi_monitor", options),
    /Import target rejected/
  );
  assert.throws(
    () => validateImportTarget("postgresql://postgres:secret@postgres:5432/cloudreve", options),
    /Import target rejected/
  );
  assert.throws(
    () => validateImportTarget("postgresql://postgres:secret@postgres:5432/cliproxyapi_monitor", options),
    /Import target rejected/
  );
});
