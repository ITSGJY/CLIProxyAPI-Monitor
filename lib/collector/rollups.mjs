function validateTimezone(timezone) {
  const value = String(timezone ?? "UTC").trim();
  if (!value || value.length > 64) throw new RangeError("timezone must be a non-empty IANA timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new RangeError(`Invalid IANA timezone: ${value}`);
  }
  return value;
}

function validateLookback(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

async function refreshRollup(pool, { name, table, unit, lookback, timezone }) {
  const intervalUnit = unit === "hour" ? "hours" : "days";
  const truncUnit = unit;
  const startSql = `date_trunc('${truncUnit}', now() AT TIME ZONE $1) - make_interval(${intervalUnit} => $2)`;
  const bucketSql = `date_trunc('${truncUnit}', event.occurred_at AT TIME ZONE $1) AT TIME ZONE $1`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS acquired",
      [name, timezone]
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("COMMIT");
      return { rollup: name, timezone, refreshedGroups: 0, lookback, skipped: true };
    }
    await client.query(
      `INSERT INTO usage_rollup_checkpoints (rollup_name, timezone, state)
       VALUES ($1, $2, 'running')
       ON CONFLICT (rollup_name, timezone) DO UPDATE
       SET state = 'running', last_error = NULL`,
      [name, timezone]
    );
    await client.query(
      `DELETE FROM ${table}
       WHERE timezone = $1 AND bucket_start >= (${startSql}) AT TIME ZONE $1`,
      [timezone, lookback]
    );
    const result = await client.query(
      `INSERT INTO ${table} (
         bucket_start, timezone, provider, model, source, api_group_key,
         request_count, error_count, input_tokens, output_tokens, reasoning_tokens,
         cached_tokens, total_tokens, cost_nanos, cost_currency, pricing_status, refreshed_at
       )
       SELECT
         ${bucketSql} AS bucket_start,
         $1 AS timezone,
         COALESCE(event.provider, '') AS provider,
         event.model,
         COALESCE(event.source, '') AS source,
         COALESCE(event.api_group_key, '') AS api_group_key,
         count(*)::bigint AS request_count,
         count(*) FILTER (WHERE event.is_error)::bigint AS error_count,
         sum(event.input_tokens)::bigint AS input_tokens,
         sum(event.output_tokens)::bigint AS output_tokens,
         sum(event.reasoning_tokens)::bigint AS reasoning_tokens,
         sum(event.cached_tokens)::bigint AS cached_tokens,
         sum(event.total_tokens)::bigint AS total_tokens,
         sum(COALESCE(event.cost_nanos, 0))::bigint AS cost_nanos,
         event.cost_currency,
         CASE
           WHEN bool_and(event.pricing_status = 'priced') THEN 'priced'
           WHEN bool_or(event.pricing_status = 'priced') THEN 'partial'
           ELSE 'unpriced'
         END AS pricing_status,
         now()
       FROM usage_events event
       WHERE event.occurred_at >= ((${startSql}) AT TIME ZONE $1)
       GROUP BY 1, 2, 3, 4, 5, 6, event.cost_currency`,
      [timezone, lookback]
    );
    await client.query(
      `UPDATE usage_rollup_checkpoints
       SET state = 'completed', completed_at = now(), last_error = NULL
       WHERE rollup_name = $1 AND timezone = $2`,
      [name, timezone]
    );
    await client.query("COMMIT");
    return { rollup: name, timezone, refreshedGroups: result.rowCount ?? 0, lookback, skipped: false };
  } catch (error) {
    await client.query("ROLLBACK");
    await pool.query(
      `INSERT INTO usage_rollup_checkpoints (rollup_name, timezone, state, last_error, completed_at)
       VALUES ($1, $2, 'failed', $3, now())
       ON CONFLICT (rollup_name, timezone) DO UPDATE
       SET state = 'failed', last_error = EXCLUDED.last_error, completed_at = now()`,
      [name, timezone, String(error instanceof Error ? error.message : error).slice(0, 500)]
    );
    throw error;
  } finally {
    client.release();
  }
}

export async function refreshUsageHourlyRollups(pool, options = {}) {
  const timezone = validateTimezone(options.timezone ?? "UTC");
  const lookbackHours = validateLookback(options.hourlyLookbackHours ?? 48, "hourlyLookbackHours", 24 * 366);
  return refreshRollup(pool, {
    name: "usage_hourly",
    table: "usage_rollups_hourly",
    unit: "hour",
    lookback: lookbackHours,
    timezone
  });
}

export async function refreshUsageDailyRollups(pool, options = {}) {
  const timezone = validateTimezone(options.timezone ?? "UTC");
  const lookbackDays = validateLookback(options.dailyLookbackDays ?? 90, "dailyLookbackDays", 3660);
  return refreshRollup(pool, {
    name: "usage_daily",
    table: "usage_rollups_daily",
    unit: "day",
    lookback: lookbackDays,
    timezone
  });
}

export async function refreshUsageRollups(pool, options = {}) {
  const hourly = await refreshUsageHourlyRollups(pool, options);
  const daily = await refreshUsageDailyRollups(pool, options);
  return { hourly, daily };
}
