export const ERROR_COLUMNS = [
  "source_instance_id", "event_key", "origin_system", "source_transport", "source_native_id", "source_snapshot_sha256", "import_run_id", "subscription_session_id",
  "occurred_at", "received_at", "auth_index", "provider", "model", "status_code", "code", "body", "retryable", "auth_status",
  "quota_exceeded", "quota_reason", "next_retry_after", "next_recover_at", "backoff_level", "cooldown_model",
  "model_quota_exceeded", "model_quota_reason", "model_next_retry_after", "model_next_recover_at", "model_backoff_level", "auth_quota_aggregate", "model_quota_inherited"
];

export async function insertErrorEvent(client, event) {
  const result = await client.query(
    `INSERT INTO cpa_error_events (${ERROR_COLUMNS.join(",")}) VALUES (${ERROR_COLUMNS.map((_, i) => `$${i + 1}`).join(",")})
     ON CONFLICT (source_instance_id,event_key) DO NOTHING RETURNING id`,
    ERROR_COLUMNS.map((key) => event[key] ?? null)
  );
  return result.rowCount;
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function fence(client, lease) {
  const result = await client.query(
    `SELECT source_instance_id FROM cpa_error_collector_state WHERE source_instance_id=$1 AND lease_owner=$2
     AND lease_epoch=$3 AND lease_expires_at > clock_timestamp() FOR UPDATE`,
    [lease.instanceId, lease.workerId, lease.epoch]
  );
  if (!result.rowCount) throw new Error("error_collector_lease_lost");
}

export function createErrorStore(pool, config) {
  let lease;
  const scoped = (work) => transaction(pool, async (client) => { await fence(client, lease); return work(client); });
  return {
    async acquire() {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `INSERT INTO cpa_error_collector_state (source_instance_id,lease_owner,lease_epoch,lease_expires_at,heartbeat_at)
           VALUES ($1,$2,1,clock_timestamp()+$3*interval '1 second',clock_timestamp())
           ON CONFLICT (source_instance_id) DO UPDATE SET enabled=true,state='connecting',lease_owner=$2,
             lease_epoch=cpa_error_collector_state.lease_epoch+1,lease_expires_at=clock_timestamp()+$3*interval '1 second',
             heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),last_error_code=NULL
           WHERE cpa_error_collector_state.lease_expires_at IS NULL OR cpa_error_collector_state.lease_expires_at <= clock_timestamp()
           RETURNING lease_epoch`, [config.instanceId, config.workerId, config.leaseSeconds]
        );
        if (!result.rowCount) return false;
        lease = { ...config, epoch: result.rows[0].lease_epoch };
        await client.query(
          `UPDATE cpa_error_subscription_sessions SET ended_at=clock_timestamp(),end_reason='lease_expired'
           WHERE source_instance_id=$1 AND ended_at IS NULL`, [config.instanceId]
        );
        return true;
      });
    },
    renew() {
      return scoped((client) => client.query(
        `UPDATE cpa_error_collector_state SET heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),
         lease_expires_at=clock_timestamp()+$2*interval '1 second' WHERE source_instance_id=$1`, [config.instanceId, config.leaseSeconds]
      ));
    },
    startSession() {
      return scoped(async (client) => {
        await client.query("UPDATE cpa_error_collector_state SET state='connecting',updated_at=clock_timestamp() WHERE source_instance_id=$1", [config.instanceId]);
        const result = await client.query("INSERT INTO cpa_error_subscription_sessions (source_instance_id,lease_epoch) VALUES ($1,$2) RETURNING id", [config.instanceId, lease.epoch]);
        return result.rows[0].id;
      });
    },
    subscribed(sessionId) {
      return scoped(async (client) => {
        const result = await client.query(`UPDATE cpa_error_subscription_sessions SET subscribed_at=clock_timestamp(),coverage_through=clock_timestamp()
          WHERE id=$1 AND source_instance_id=$2 AND lease_epoch=$3 AND ended_at IS NULL AND subscribed_at IS NULL`, [sessionId, config.instanceId, lease.epoch]);
        if (!result.rowCount) throw new Error("error_session_fenced");
        await client.query("UPDATE cpa_error_collector_state SET state='collecting',last_error_code=NULL,updated_at=clock_timestamp() WHERE source_instance_id=$1", [config.instanceId]);
      });
    },
    confirmCoverage(sessionId, through) {
      return scoped(async (client) => {
        const result = await client.query(
        `UPDATE cpa_error_subscription_sessions SET coverage_through=greatest(coverage_through,least($2::timestamptz,clock_timestamp()))
         WHERE id=$1 AND source_instance_id=$3 AND lease_epoch=$4 AND ended_at IS NULL AND subscribed_at IS NOT NULL`, [sessionId, through, config.instanceId, lease.epoch]
        );
        if (!result.rowCount) throw new Error("error_session_fenced");
      });
    },
    persist(sessionId, event) {
      return scoped(async (client) => {
        const active = await client.query("SELECT id FROM cpa_error_subscription_sessions WHERE id=$1 AND source_instance_id=$2 AND lease_epoch=$3 AND ended_at IS NULL AND subscribed_at IS NOT NULL", [sessionId, config.instanceId, lease.epoch]);
        if (!active.rowCount || event.source_instance_id !== config.instanceId) throw new Error("error_session_fenced");
        const inserted = await insertErrorEvent(client, { ...event, subscription_session_id: sessionId });
        await client.query(`UPDATE cpa_error_subscription_sessions SET received_count=received_count+1,
          inserted_count=inserted_count+$2,duplicate_count=duplicate_count+1-$2 WHERE id=$1`, [sessionId, inserted]);
        await client.query("UPDATE cpa_error_collector_state SET last_event_at=clock_timestamp() WHERE source_instance_id=$1", [config.instanceId]);
        return inserted;
      });
    },
    endSession(sessionId, reason, malformed = false) {
      return scoped(async (client) => {
        // An abnormal end retains the last PONG or durable-message coverage watermark.
        const result = await client.query(`UPDATE cpa_error_subscription_sessions SET ended_at=clock_timestamp(),end_reason=$2,
          malformed_count=malformed_count+$3,received_count=received_count+$3
          WHERE id=$1 AND source_instance_id=$4 AND lease_epoch=$5 AND ended_at IS NULL`, [sessionId, reason, malformed ? 1 : 0, config.instanceId, lease.epoch]);
        if (!result.rowCount) throw new Error("error_session_fenced");
        await client.query(`UPDATE cpa_error_collector_state SET state=$2,last_error_code=$3,updated_at=clock_timestamp()
          WHERE source_instance_id=$1`, [config.instanceId, malformed ? "degraded" : "disconnected", reason]);
      });
    },
    release() {
      return scoped(async (client) => {
        await client.query("UPDATE cpa_error_subscription_sessions SET ended_at=clock_timestamp(),end_reason='shutdown' WHERE source_instance_id=$1 AND ended_at IS NULL", [config.instanceId]);
        await client.query(`UPDATE cpa_error_collector_state SET state='disabled',enabled=false,lease_owner=NULL,
          lease_expires_at=NULL,updated_at=clock_timestamp() WHERE source_instance_id=$1`, [config.instanceId]);
      });
    }
  };
}
