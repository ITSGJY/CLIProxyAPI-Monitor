import { setTimeout as sleep } from "node:timers/promises";
import { getPullBackoffMs } from "../lib/collector/retry.mjs";
import { loadCollectorConfig } from "../lib/collector/config.mjs";
import { pullUsageViaResp, subscribeUsageViaResp } from "../lib/collector/resp-client.mjs";
import { pullUsageViaHttp } from "../lib/collector/http-queue.mjs";
import {
  acquireCollectorLease,
  claimCollectorCommands,
  completeCollectorCommands,
  createPullAttempt,
  ensureCollectorInstance,
  heartbeatCollectorState,
  markCollectorStopped,
  markInterruptedPullAttempts,
  markPullAttemptFailed,
  persistPulledBatch,
  persistSubscribedUsageEvent,
  completeSubscriptionAttempt,
  interruptSubscriptionAttempt,
  pruneEmptyPullAttempts
} from "../lib/collector/postgres-store.mjs";

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\/@\s]+:)[^@\/\s]+@/gi, "$1[redacted]@")
    .replace(/(api[_-]?key|secret|password|token|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 300);
}

async function stopAfterUncertainPull(pool, instanceId, error) {
  await markInterruptedPullAttempts(pool, instanceId, 0);
  console.error("CPA queue pull may have consumed data before durable inbox commit:", safeMessage(error));
  const fatal = new Error("Collector stopped after an uncertain destructive pull; inspect usage_ingest_gaps before restarting");
  fatal.code = "CPA_USAGE_PULL_UNCERTAIN";
  throw fatal;
}

async function waitForNextCycle(milliseconds, signal, refreshLease) {
  const deadline = Date.now() + milliseconds;
  while (!signal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    try {
      await sleep(Math.min(10_000, remaining), undefined, { signal });
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw error;
    }
    if (Date.now() < deadline && !signal.aborted) await refreshLease();
  }
}

async function runSubscriptionSession(pool, config, stopSignal, refreshLease) {
  const attemptId = await createPullAttempt(pool, {
    instanceId: config.instanceId,
    transport: "resp-subscribe",
    queueName: config.queueName,
    requestedCount: 1
  });
  const startedAt = new Date();
  await pool.query(
    `UPDATE usage_pull_attempts SET metadata = metadata || $2::jsonb WHERE id = $1`,
    [attemptId, JSON.stringify({ mode: "subscribe", channel: "usage" })]
  );

  const sessionController = new AbortController();
  const stopHandler = () => sessionController.abort();
  stopSignal.addEventListener("abort", stopHandler, { once: true });
  let paused = false;
  let controlError = null;
  let controlBusy = false;

  const controlTimer = setInterval(async () => {
    if (controlBusy || sessionController.signal.aborted) return;
    controlBusy = true;
    try {
      await heartbeatCollectorState(pool, config.instanceId, config.workerId, "receiving", config.leaseSeconds);
      const commands = await claimCollectorCommands(pool, config.instanceId, config.workerId);
      for (const command of commands) {
        if (command.command === "pause") {
          paused = true;
          sessionController.abort();
        }
        if (command.command === "resume") paused = false;
      }
      if (commands.length > 0) {
        await completeCollectorCommands(pool, commands, config.workerId, "completed");
      }
    } catch (error) {
      controlError = error;
      sessionController.abort();
    } finally {
      controlBusy = false;
    }
  }, Math.max(5_000, Math.min(10_000, config.pollIntervalMs)));

  try {
    const result = await subscribeUsageViaResp({
      address: config.redisAddress,
      password: config.managementKey,
      channel: config.queueName,
      timeoutMs: config.respTimeoutMs,
      signal: sessionController.signal,
      onSubscribed: async () => {
        await heartbeatCollectorState(pool, config.instanceId, config.workerId, "receiving", config.leaseSeconds);
      },
      onMessage: async (payload) => {
        await persistSubscribedUsageEvent(pool, {
          attemptId,
          instanceId: config.instanceId,
          queueName: config.queueName,
          item: payload
        });
      }
    });
    if (controlError) {
      controlError.subscriptionEstablished = true;
      throw controlError;
    }
    const summary = await completeSubscriptionAttempt(pool, attemptId);
    return { paused, stopped: stopSignal.aborted, messages: result.messages, ...summary };
  } catch (error) {
    if (error?.subscriptionEstablished) {
      await interruptSubscriptionAttempt(pool, {
        attemptId,
        instanceId: config.instanceId,
        startedAt,
        error,
        reason: "resp_subscription_disconnected"
      });
    } else {
      await markPullAttemptFailed(pool, attemptId, error, error?.respSubscribeRejected ? "resp_subscribe_rejected" : "resp_subscribe_connect_failed");
    }
    throw error;
  } finally {
    clearInterval(controlTimer);
    stopSignal.removeEventListener("abort", stopHandler);
  }
}

async function run() {
  const config = loadCollectorConfig();
  if (!config.enabled) {
    console.log("CPA Usage Collector disabled; no database or CPA connection opened.");
    return;
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    application_name: "cliproxyapi-monitor-collector"
  });

  let stopping = false;
  let paused = false;
  let consecutiveFailures = 0;
  const stopController = new AbortController();
  const stop = () => {
    stopping = true;
    stopController.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await pool.query("SELECT 1");
    await ensureCollectorInstance(pool, config);
    const leaseAcquired = await acquireCollectorLease(pool, config.instanceId, config.workerId, config.leaseSeconds);
    if (!leaseAcquired) throw new Error("Another Collector worker already owns this CPA instance lease");
    await markInterruptedPullAttempts(pool, config.instanceId, 0);
    await pruneEmptyPullAttempts(pool, config.instanceId, 7);
    let lastEmptyAttemptCleanupAt = Date.now();
    let runtimeMode = config.mode;
    console.log(`Collector ready for instance ${config.instanceId}; mode=${runtimeMode}; queue=usage`);
    const refreshLease = () => heartbeatCollectorState(pool, config.instanceId, config.workerId, null, config.leaseSeconds);

    while (!stopping) {
      const commands = await claimCollectorCommands(pool, config.instanceId, config.workerId);
      for (const command of commands) {
        if (command.command === "pause") paused = true;
        if (command.command === "resume") paused = false;
      }
      if (commands.length > 0) {
        await completeCollectorCommands(pool, commands, config.workerId, "completed");
      }

      await heartbeatCollectorState(
        pool,
        config.instanceId,
        config.workerId,
        paused ? "paused" : "checking",
        config.leaseSeconds
      );
      if (paused) {
        await waitForNextCycle(config.pollIntervalMs, stopController.signal, refreshLease);
        continue;
      }

      if (runtimeMode === "auto" || runtimeMode === "subscribe") {
        await heartbeatCollectorState(pool, config.instanceId, config.workerId, "checking", config.leaseSeconds);
        try {
          const summary = await runSubscriptionSession(pool, config, stopController.signal, refreshLease);
          consecutiveFailures = 0;
          if (summary.messages > 0) {
            console.log(JSON.stringify({ event: "usage_subscription_session_closed", messages: summary.messages, persisted: summary.persisted_count ?? summary.persistedCount ?? summary.persisted_count }));
          }
          if (summary.paused) paused = true;
          if (stopping || summary.stopped) break;
          if (paused) continue;
        } catch (subscribeError) {
          if (runtimeMode === "auto" && subscribeError?.respSubscribeRejected) {
            runtimeMode = "pull";
            console.warn("CPA RESP SUBSCRIBE was explicitly rejected; switching to FIFO pull mode because the server did not accept a subscriber.");
            continue;
          }
          if (stopping) break;
          consecutiveFailures += 1;
          const backoff = getPullBackoffMs(consecutiveFailures, config.pollIntervalMs);
          console.error("CPA RESP subscription disconnected; reconnecting (a Pub/Sub gap was recorded):", safeMessage(subscribeError));
          await waitForNextCycle(backoff, stopController.signal, refreshLease);
        }
        continue;
      }

      const respAttemptId = await createPullAttempt(pool, {
        instanceId: config.instanceId,
        transport: "resp",
        queueName: config.queueName,
        requestedCount: config.batchSize
      });

      let items = [];
      let transport = "resp";
      let attemptId = respAttemptId;

      try {
        items = await pullUsageViaResp({
          address: config.redisAddress,
          password: config.managementKey,
          queue: config.queueName,
          count: config.batchSize
        });
      } catch (respError) {
        if (respError?.uncertainConsumption) {
          await stopAfterUncertainPull(pool, config.instanceId, respError);
        }

        await markPullAttemptFailed(pool, respAttemptId, respError, "resp_pull_failed");
        const httpAttemptId = await createPullAttempt(pool, {
          instanceId: config.instanceId,
          transport: "http",
          queueName: config.queueName,
          requestedCount: config.batchSize
        });

        try {
          items = await pullUsageViaHttp({
            baseUrl: config.managementBaseUrl,
            managementKey: config.managementKey,
            count: config.batchSize
          });
          transport = "http";
          attemptId = httpAttemptId;
        } catch (httpError) {
          if (httpError?.uncertainConsumption) {
            await stopAfterUncertainPull(pool, config.instanceId, httpError);
          }
          await markPullAttemptFailed(pool, httpAttemptId, httpError, "http_fallback_failed");
          consecutiveFailures += 1;
          const backoff = getPullBackoffMs(consecutiveFailures, config.pollIntervalMs);
          console.error("CPA Usage Queue pull failed over RESP and HTTP:", safeMessage(httpError));
          await waitForNextCycle(backoff, stopController.signal, refreshLease);
          continue;
        }
      }

      let persisted;
      try {
        persisted = await persistPulledBatch(pool, {
          attemptId,
          instanceId: config.instanceId,
          transport,
          queueName: config.queueName,
          items
        });
      } catch (persistError) {
        // Both RESP LPOP and the HTTP queue endpoint are destructive.
        await stopAfterUncertainPull(pool, config.instanceId, persistError);
      }

      if (Date.now() - lastEmptyAttemptCleanupAt >= 6 * 60 * 60 * 1000) {
        await pruneEmptyPullAttempts(pool, config.instanceId, 7);
        lastEmptyAttemptCleanupAt = Date.now();
      }

      consecutiveFailures = 0;
      if (items.length > 0) {
        console.log(JSON.stringify({
          event: "usage_batch_persisted",
          transport,
          pulled: items.length,
          persisted: persisted.persistedCount,
          attemptId
        }));
      }

      await waitForNextCycle(config.pollIntervalMs, stopController.signal, refreshLease);
    }
  } finally {
    try {
      await markCollectorStopped(pool, config.instanceId, config.workerId);
    } catch (error) {
      process.exitCode = 1;
      console.error("Failed to mark Collector stopped:", safeMessage(error));
    }
    await pool.end();
  }
}

run().catch((error) => {
  console.error("CPA Usage Collector stopped:", safeMessage(error));
  process.exitCode = 1;
});
