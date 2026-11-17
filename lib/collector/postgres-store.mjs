import { normalizeUsageRecord, hashRawPayload, sanitizeUsagePayload } from "./normalize.mjs";

const SAFE_ERROR_PATTERN = /(Bearer\s+)[^\s,;]+/gi;

function safeError(error) {
  return String(error instanceof Error ? error.message : error ?? "unknown error")
    .replace(SAFE_ERROR_PATTERN, "$1[redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\/@\s]+:)[^@\/\s]+@/gi, "$1[redacted]@")
    .replace(/(api[_-]?key|secret|password|token|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 500);
}

async function withClient(pool, callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function ensureCollectorInstance(pool, config) {
  await pool.query(
    `INSERT INTO usage_collector_instances
      (instance_id, display_name, management_base_url, queue_name, collector_mode, enabled, updated_at)
     VALUES ($1, $2, $3, $4, 'pull_first', false, now())
     ON CONFLICT (instance_id) DO NOTHING`,
    [config.instanceId, config.displayName ?? config.instanceId, config.managementBaseUrl, config.queueName]
  );

  const existing = await pool.query(
    `SELECT management_base_url, queue_name, collector_mode
     FROM usage_collector_instances WHERE instance_id = $1`,
    [config.instanceId]
  );
  const row = existing.rows[0];
  if (!row || row.management_base_url !== config.managementBaseUrl || row.queue_name !== config.queueName || row.collector_mode !== 'pull_first') {
    throw new Error("CPA instance registration does not match the configured endpoint or Pull-first mode; update it only after stopping the existing Collector");
  }

  await pool.query(
    `INSERT INTO usage_collector_state (instance_id, state, updated_at)
     VALUES ($1, 'starting', now())
     ON CONFLICT (instance_id) DO NOTHING`,
    [config.instanceId]
  );
}

export async function acquireCollectorLease(pool, instanceId, workerId, leaseSeconds = 30) {
  const result = await pool.query(
    `WITH acquired AS (
       UPDATE usage_collector_state
       SET lease_owner = $2,
           lease_expires_at = now() + make_interval(secs => $3),
           updated_at = now()
       WHERE instance_id = $1
         AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now() OR lease_owner = $2)
       RETURNING instance_id
     )
     UPDATE usage_collector_instances AS instance
     SET enabled = true, updated_at = now()
     FROM acquired
     WHERE instance.instance_id = acquired.instance_id
     RETURNING instance.instance_id`,
    [instanceId, workerId, leaseSeconds]
  );
  return result.rowCount === 1;
}

export async function heartbeatCollectorState(pool, instanceId, workerId, state = null, leaseSeconds = 30) {
  const result = await pool.query(
    `UPDATE usage_collector_state
     SET state = COALESCE($3, state),
         lease_expires_at = now() + make_interval(secs => $4),
         last_success_at = CASE WHEN $3 = 'receiving' THEN now() ELSE last_success_at END,
         last_error_code = CASE WHEN $3 = 'receiving' THEN NULL ELSE last_error_code END,
         last_error_message = CASE WHEN $3 = 'receiving' THEN NULL ELSE last_error_message END,
         updated_at = now()
     WHERE instance_id = $1 AND lease_owner = $2`,
    [instanceId, workerId, state, leaseSeconds]
  );
  if (result.rowCount !== 1) throw new Error("Collector worker lease was lost");
}

export async function markCollectorStopped(pool, instanceId, workerId) {
  await pool.query(
    `UPDATE usage_collector_state
     SET state = 'stopped', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE instance_id = $1 AND lease_owner = $2`,
    [instanceId, workerId]
  );
  await pool.query(
    `UPDATE usage_collector_instances
     SET enabled = false, updated_at = now()
     WHERE instance_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM usage_collector_state
         WHERE instance_id = $1 AND lease_owner IS NOT NULL AND lease_expires_at > now()
       )`,
    [instanceId]
  );
}

export async function claimCollectorCommands(pool, instanceId, workerId, leaseSeconds = 60) {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const selected = await client.query(
        `SELECT id, command
         FROM usage_collector_commands
         WHERE instance_id = $1
           AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= now()))
         ORDER BY requested_at, id
         LIMIT 10
         FOR UPDATE SKIP LOCKED`,
        [instanceId]
      );
      const ids = selected.rows.map((row) => Number(row.id));
      if (ids.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const claimed = await client.query(
        `UPDATE usage_collector_commands
         SET status = 'claimed', claimed_by = $2, claimed_at = now(),
             lease_expires_at = now() + make_interval(secs => $3)
         WHERE id = ANY($1::bigint[])
         RETURNING id, command`,
        [ids, workerId, leaseSeconds]
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({ id: Number(row.id), command: row.command }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function completeCollectorCommands(pool, commands, workerId, status = "completed", error = null) {
  if (!Array.isArray(commands) || commands.length === 0) return 0;
  if (!['completed', 'failed'].includes(status)) throw new Error("Invalid Collector command completion status");
  const ids = commands.map((command) => command.id);
  const result = await pool.query(
    `UPDATE usage_collector_commands
     SET status = $2, completed_at = now(), last_error = $3,
         claimed_by = NULL, lease_expires_at = NULL
     WHERE id = ANY($1::bigint[]) AND claimed_by = $4 AND status = 'claimed'`,
    [ids, status, error ? safeError(error) : null, workerId]
  );
  return result.rowCount;
}

export async function createPullAttempt(pool, {
  instanceId,
  transport,
  queueName = "usage",
  requestedCount = 100
}) {
  const result = await pool.query(
    `WITH attempt AS (
       INSERT INTO usage_pull_attempts
         (instance_id, transport, queue_name, requested_count, status, started_at)
       VALUES ($1, $2, $3, $4, 'started', now())
       RETURNING id
     ), state_update AS (
       UPDATE usage_collector_state
       SET last_attempt_at = now(), updated_at = now()
       WHERE instance_id = $1
     )
     SELECT id FROM attempt`,
    [instanceId, transport, queueName, requestedCount]
  );
  return Number(result.rows[0].id);
}

export async function pruneEmptyPullAttempts(pool, instanceId, retentionDays = 7) {
  const result = await pool.query(
    `DELETE FROM usage_pull_attempts
     WHERE instance_id = $1
       AND status = 'empty'
       AND completed_at < now() - make_interval(days => $2)`,
    [instanceId, retentionDays]
  );
  return result.rowCount;
}

export async function markPullAttemptFailed(pool, attemptId, error, code = "pull_failed") {
  const message = safeError(error);
  await pool.query(
    `UPDATE usage_pull_attempts
     SET status = 'failed', completed_at = now(), error_code = $2, error_message = $3
     WHERE id = $1 AND status = 'started'`,
    [attemptId, code, message]
  );
  await pool.query(
    `UPDATE usage_collector_state AS state
     SET state = 'degraded', last_error_code = $2, last_error_message = $3, updated_at = now()
     FROM usage_pull_attempts AS attempt
     WHERE attempt.id = $1 AND state.instance_id = attempt.instance_id`,
    [attemptId, code, message]
  );
}

export async function persistPulledBatch(pool, {
  attemptId,
  instanceId,
  transport,
  queueName = "usage",
  items
}) {
  if (!Array.isArray(items)) throw new TypeError("Pulled usage items must be an array");

  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      let persistedCount = 0;
      if (items.length > 0) {
        const batch = items.map((item) => ({
          payload_sha256: hashRawPayload(item),
          payload: sanitizeUsagePayload(item)
        }));
        const inserted = await client.query(
          `INSERT INTO usage_inbox
            (instance_id, pull_attempt_id, transport, queue_name, payload_sha256, payload, status, received_at)
           SELECT $1, $2, $3, $4, batch.payload_sha256, batch.payload, 'pending', now()
           FROM jsonb_to_recordset($5::jsonb) AS batch(payload_sha256 text, payload jsonb)`,
          [instanceId, attemptId, transport, queueName, JSON.stringify(batch)]
        );
        persistedCount = inserted.rowCount ?? 0;
        if (persistedCount !== items.length) {
          throw new Error(`Durable inbox bulk insert count mismatch: expected ${items.length}, inserted ${persistedCount}`);
        }
      }

      const status = items.length === 0 ? "empty" : "completed";
      const completedAttempt = await client.query(
        `UPDATE usage_pull_attempts
         SET status = $2, received_count = $3, persisted_count = $4, completed_at = now()
         WHERE id = $1 AND status = 'started'
         RETURNING id`,
        [attemptId, status, items.length, persistedCount]
      );
      if (completedAttempt.rowCount !== 1) {
        throw new Error("Pull attempt was not in the started state when the inbox batch committed");
      }
      await client.query(
        `INSERT INTO usage_collector_state (instance_id, state, last_attempt_at, last_success_at, last_transport, updated_at)
         VALUES ($1, 'receiving', now(), now(), $2, now())
         ON CONFLICT (instance_id) DO UPDATE SET
           state = 'receiving',
           last_attempt_at = now(),
           last_success_at = now(),
           last_transport = EXCLUDED.last_transport,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = now()`,
        [instanceId, transport]
      );
      await client.query("COMMIT");
      return { persistedCount, status };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function markInterruptedPullAttempts(pool, instanceId, staleSeconds = 30) {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const interrupted = await client.query(
        `UPDATE usage_pull_attempts
         SET status = 'interrupted',
             completed_at = now(),
             error_code = 'collector_interrupted',
             error_message = 'Collector stopped after the queue pull began but before durable inbox commit'
         WHERE instance_id = $1
           AND status = 'started'
           AND started_at < now() - make_interval(secs => $2)
         RETURNING id, started_at`,
        [instanceId, staleSeconds]
      );

      for (const attempt of interrupted.rows) {
        await client.query(
          `INSERT INTO usage_ingest_gaps
            (instance_id, pull_attempt_id, started_at, detected_at, reason, details)
           VALUES ($1, $2, $3, now(), 'pull_interrupted_before_inbox_commit', $4::jsonb)`,
          [instanceId, attempt.id, attempt.started_at, JSON.stringify({ estimated_missing_count: null })]
        );
      }

      if (interrupted.rowCount > 0) {
        await client.query(
          `UPDATE usage_collector_state
           SET state = 'degraded', last_error_code = 'collector_interrupted',
               last_error_message = 'One or more destructive queue pulls did not reach durable inbox commit',
               updated_at = now()
           WHERE instance_id = $1`,
          [instanceId]
        );
      }
      await client.query("COMMIT");
      return interrupted.rowCount;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function ensureUsageEventPartition(client, occurredAt) {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid event timestamp for partition routing");

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const monthNumber = String(month + 1).padStart(2, "0");
  const partitionName = `usage_events_${year}${monthNumber}`;
  const startValue = start.toISOString();
  const endValue = end.toISOString();

  await client.query(
    `CREATE TABLE IF NOT EXISTS "${partitionName}"
     PARTITION OF usage_events
     FOR VALUES FROM ('${startValue}') TO ('${endValue}')`
  );
}

async function processOneInboxRow(pool, row, workerId, maxAttempts) {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const locked = await client.query(
        "SELECT * FROM usage_inbox WHERE id = $1 FOR UPDATE",
        [row.id]
      );
      if (locked.rowCount === 0 || locked.rows[0].status !== "processing" || locked.rows[0].lease_owner !== workerId) {
        await client.query("COMMIT");
        return "skipped";
      }

      const inbox = locked.rows[0];
      let event;
      try {
        event = normalizeUsageRecord(inbox.payload, {
          sourceInstanceId: inbox.instance_id,
          sourceTransport: inbox.transport,
          originSystem: "cpa_live"
        });
      } catch (error) {
        await client.query(
          `UPDATE usage_inbox
           SET status = 'dead_letter', processed_at = now(),
               last_error_code = $2, last_error_message = $3,
               lease_owner = NULL, lease_expires_at = NULL
           WHERE id = $1`,
          [inbox.id, error.code ?? "invalid_usage_record", safeError(error)]
        );
        await client.query("COMMIT");
        return "dead_letter";
      }

      await ensureUsageEventPartition(client, event.occurredAt);
      const cachedForPricing = Math.min(
        event.inputTokens,
        Math.max(event.cachedTokens, event.cacheReadTokens + event.cacheCreationTokens)
      );
      const priceResult = await client.query(
        `SELECT id, currency,
           ROUND((
             (
               GREATEST($1::numeric - $2::numeric, 0) * input_price_per_1m
               + $2::numeric * cached_input_price_per_1m
               + $3::numeric * output_price_per_1m
             ) / 1000000
           ) * 1000000000)::bigint AS cost_nanos
         FROM model_price_versions
         WHERE model = $4
           AND (provider IS NULL OR provider = $5)
           AND (service_tier IS NULL OR service_tier = $6)
           AND valid_from <= $7
           AND (valid_to IS NULL OR valid_to > $7)
         ORDER BY (provider IS NOT NULL) DESC, (service_tier IS NOT NULL) DESC, valid_from DESC
         LIMIT 1`,
        [
          event.inputTokens,
          cachedForPricing,
          event.outputTokens,
          event.model,
          event.provider,
          event.effectiveServiceTier ?? event.serviceTier,
          event.occurredAt
        ]
      );
      const price = priceResult.rows[0] ?? null;
      const priceVersionId = price ? Number(price.id) : null;
      const costNanos = price ? price.cost_nanos : null;
      const costCurrency = price?.currency ?? "USD";
      const pricingStatus = price ? "priced" : "unpriced";

      const insertedEvent = await client.query(
        `INSERT INTO usage_events (
          occurred_at, source_instance_id, origin_system, source_transport, source_native_id, identity_key,
          provider, endpoint, auth_type, request_id, client_ip, x_forwarded_for, user_agent,
          api_group_key, api_group_label, api_key_mask, model, model_alias, response_model, model_substituted,
          reasoning_effort, service_tier, response_service_tier, effective_service_tier, billed_service_tier,
          billed_service_tier_source, executor_type, source, auth_index, access_provider, is_native_key,
          stream, generate, latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens,
          cache_read_tokens, cache_creation_tokens, total_tokens, is_error, status_code, fail_code, fail_body,
          response_headers, token_accounting, structured_usage, raw_payload, price_version_id, cost_nanos,
          cost_currency, pricing_status
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25,
          $26, $27, $28, $29, $30, $31,
          $32, $33, $34, $35, $36, $37, $38, $39,
          $40, $41, $42, $43, $44, $45, $46, $47,
          $48, $49, $50, $51, $52, $53, $54
        )
        RETURNING event_id`,
        [
          event.occurredAt, event.sourceInstanceId, event.originSystem, event.sourceTransport, event.sourceNativeId, event.identityKey,
          event.provider, event.endpoint, event.authType, event.requestId, event.clientIp, event.xForwardedFor, event.userAgent,
          event.apiGroupKey, event.apiGroupLabel, event.apiKeyMask, event.model, event.modelAlias, event.responseModel, event.modelSubstituted,
          event.reasoningEffort, event.serviceTier, event.responseServiceTier, event.effectiveServiceTier, event.billedServiceTier,
          event.billedServiceTierSource, event.executorType, event.source, event.authIndex, event.accessProvider, event.isNativeKey,
          event.stream, event.generate, event.latencyMs, event.ttftMs, event.inputTokens, event.outputTokens, event.reasoningTokens, event.cachedTokens,
          event.cacheReadTokens, event.cacheCreationTokens, event.totalTokens, event.isError, event.statusCode, event.failCode, event.failBody,
          event.responseHeaders ? JSON.stringify(event.responseHeaders) : null,
          event.tokenAccounting ? JSON.stringify(event.tokenAccounting) : null,
          event.structuredUsage ? JSON.stringify(event.structuredUsage) : null,
          JSON.stringify(event.rawPayload), priceVersionId, costNanos, costCurrency, pricingStatus
        ]
      );
      const eventId = Number(insertedEvent.rows[0].event_id);
      const identityInsert = await client.query(
        `INSERT INTO usage_event_identity
          (identity_key, identity_version, identity_kind, source_instance_id, request_id, occurred_at, event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (identity_key) DO NOTHING
         RETURNING identity_key`,
        [event.identityKey, event.identityVersion, event.identityKind, event.sourceInstanceId, event.requestId, event.occurredAt, eventId]
      );

      if (identityInsert.rowCount === 0) {
        await client.query(
          "DELETE FROM usage_events WHERE occurred_at = $1 AND event_id = $2",
          [event.occurredAt, eventId]
        );
        await client.query(
          `UPDATE usage_event_identity
           SET duplicate_count = duplicate_count + 1, last_seen_at = now()
           WHERE identity_key = $1`,
          [event.identityKey]
        );
        await client.query(
          `UPDATE usage_inbox
           SET status = 'processed', processed_at = now(), duplicate_of_identity_key = $2,
               lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, last_error_message = NULL
           WHERE id = $1`,
          [inbox.id, event.identityKey]
        );
        await client.query("COMMIT");
        return "duplicate";
      }

      await client.query(
        `UPDATE usage_inbox
         SET status = 'processed', processed_at = now(),
             usage_event_id = $2, usage_event_occurred_at = $3,
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = NULL, last_error_message = NULL
         WHERE id = $1`,
        [inbox.id, eventId, event.occurredAt]
      );
      await client.query(
        `UPDATE usage_collector_state
         SET state = 'receiving',
             last_event_at = GREATEST(COALESCE(last_event_at, $2::timestamptz), $2::timestamptz),
             updated_at = now()
         WHERE instance_id = $1`,
        [event.sourceInstanceId, event.occurredAt]
      );
      await client.query("COMMIT");
      return "processed";
    } catch (error) {
      await client.query("ROLLBACK");
      const attemptCount = Number(row.attempt_count ?? 1);
      const deadLetter = Boolean(error.permanent) || attemptCount >= maxAttempts;
      const delaySeconds = Math.min(300, 2 ** Math.min(attemptCount, 8));
      await pool.query(
        `UPDATE usage_inbox
         SET status = $2,
             available_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $3) ELSE available_at END,
             last_error_code = $4, last_error_message = $5,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1`,
        [row.id, deadLetter ? "dead_letter" : "pending", delaySeconds, error.code ?? "processing_failed", safeError(error)]
      );
      return deadLetter ? "dead_letter" : "retry";
    }
  });
}

export async function processInboxBatch(pool, {
  instanceId,
  workerId = "collector-worker",
  batchSize = 50,
  leaseSeconds = 60,
  maxAttempts = 8
}) {
  const rows = await withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const selected = await client.query(
        `SELECT id
         FROM usage_inbox
         WHERE instance_id = $1
           AND available_at <= now()
           AND (
             status = 'pending'
             OR (status = 'processing' AND lease_expires_at <= now())
           )
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [instanceId, batchSize]
      );
      const ids = selected.rows.map((row) => Number(row.id));
      if (ids.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const claimed = await client.query(
        `UPDATE usage_inbox
         SET status = 'processing',
             lease_owner = $2,
             lease_expires_at = now() + make_interval(secs => $3),
             attempt_count = attempt_count + 1
         WHERE id = ANY($1::bigint[])
         RETURNING *`,
        [ids, workerId, leaseSeconds]
      );
      await client.query("COMMIT");
      return claimed.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  const summary = { claimed: rows.length, processed: 0, duplicates: 0, deadLettered: 0, retried: 0, skipped: 0 };
  for (const row of rows) {
    const outcome = await processOneInboxRow(pool, row, workerId, maxAttempts);
    if (outcome === "processed") summary.processed += 1;
    else if (outcome === "duplicate") summary.duplicates += 1;
    else if (outcome === "dead_letter") summary.deadLettered += 1;
    else if (outcome === "retry") summary.retried += 1;
    else summary.skipped += 1;
  }
  return summary;
}
