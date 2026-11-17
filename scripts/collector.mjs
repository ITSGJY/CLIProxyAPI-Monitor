import { setTimeout as sleep } from "node:timers/promises";
import { loadCollectorConfig } from "../lib/collector/config.mjs";
import { getUsageQueueLengthViaResp, pullUsageViaResp } from "../lib/collector/resp-client.mjs";
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
  processInboxBatch
} from "../lib/collector/postgres-store.mjs";

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\/@\s]+:)[^@\/\s]+@/gi, "$1[redacted]@")
    .replace(/(api[_-]?key|secret|password|token|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 300);
}

async function recordUncertainPull(pool, instanceId, error) {
  await markInterruptedPullAttempts(pool, instanceId, 0);
  console.error("CPA queue pull may have consumed data before durable inbox commit:", safeMessage(error));
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
    application_name: "cliproxyapi-monitor-collector"
  });

  let stopping = false;
  let paused = false;
  let consecutiveFailures = 0;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await pool.query("SELECT 1");
    await ensureCollectorInstance(pool, config);
    const leaseAcquired = await acquireCollectorLease(pool, config.instanceId, config.workerId, config.leaseSeconds);
    if (!leaseAcquired) throw new Error("Another Collector worker already owns this CPA instance lease");
    await markInterruptedPullAttempts(pool, config.instanceId, 0);
    console.log(`Collector ready for instance ${config.instanceId}; mode=pull-first; queue=usage`);

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
        try {
          await processInboxBatch(pool, {
            instanceId: config.instanceId,
            workerId: config.workerId,
            batchSize: config.processorBatchSize
          });
        } catch (error) {
          console.error("Usage inbox processor failed while Collector was paused:", safeMessage(error));
        }
        await sleep(config.pollIntervalMs);
        continue;
      }

      let queueLength = 0;
      let respPreflightError = null;
      try {
        queueLength = await getUsageQueueLengthViaResp({
          address: config.redisAddress,
          password: config.managementKey,
          queue: config.queueName
        });
        await heartbeatCollectorState(pool, config.instanceId, config.workerId, "receiving", config.leaseSeconds);
      } catch (error) {
        respPreflightError = error;
      }

      let items = [];
      let transport = "resp";
      let respAttemptId = null;
      let shouldUseHttp = Boolean(respPreflightError);

      if (!respPreflightError && queueLength > 0) {
        respAttemptId = await createPullAttempt(pool, {
          instanceId: config.instanceId,
          transport: "resp",
          queueName: config.queueName,
          requestedCount: config.batchSize
        });
        try {
          items = await pullUsageViaResp({
            address: config.redisAddress,
            password: config.managementKey,
            queue: config.queueName,
            count: config.batchSize
          });
        } catch (respError) {
          if (respError?.uncertainConsumption) {
            await recordUncertainPull(pool, config.instanceId, respError);
            stopping = true;
            break;
          }
          await markPullAttemptFailed(pool, respAttemptId, respError, "resp_pull_failed");
          shouldUseHttp = true;
        }
      }

      if (shouldUseHttp) {
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
        } catch (httpError) {
          if (httpError?.uncertainConsumption) {
            await recordUncertainPull(pool, config.instanceId, httpError);
            stopping = true;
            break;
          }
          await markPullAttemptFailed(pool, httpAttemptId, httpError, "http_fallback_failed");
          consecutiveFailures += 1;
          const backoff = Math.min(30_000, config.pollIntervalMs * (2 ** Math.min(consecutiveFailures, 5)));
          console.error("CPA Usage Queue pull failed over RESP and HTTP:", safeMessage(httpError));
          await sleep(backoff);
          continue;
        }

        try {
          await persistPulledBatch(pool, {
            attemptId: httpAttemptId,
            instanceId: config.instanceId,
            transport,
            queueName: config.queueName,
            items
          });
        } catch (persistError) {
          await recordUncertainPull(pool, config.instanceId, persistError);
          stopping = true;
          break;
        }
      } else if (respAttemptId !== null) {
        try {
          await persistPulledBatch(pool, {
            attemptId: respAttemptId,
            instanceId: config.instanceId,
            transport,
            queueName: config.queueName,
            items
          });
        } catch (persistError) {
          // LPOP is destructive. Do not attempt HTTP fallback after a successful pop.
          await recordUncertainPull(pool, config.instanceId, persistError);
          stopping = true;
          break;
        }
      }

      if (items.length > 0) consecutiveFailures = 0;

      try {
        const processed = await processInboxBatch(pool, {
          instanceId: config.instanceId,
          workerId: config.workerId,
          batchSize: config.processorBatchSize
        });
        if (items.length > 0 || processed.claimed > 0) {
          console.log(JSON.stringify({
            transport,
            pulled: items.length,
            processed: processed.processed,
            duplicates: processed.duplicates,
            deadLettered: processed.deadLettered,
            retried: processed.retried
          }));
        }
      } catch (error) {
        console.error("Usage inbox processor failed; pending rows remain durable:", safeMessage(error));
      }

      await sleep(config.pollIntervalMs);
    }
  } finally {
    try {
      await markCollectorStopped(pool, config.instanceId, config.workerId);
    } catch (error) {
      console.error("Failed to mark Collector stopped:", safeMessage(error));
    }
    await pool.end();
  }
}

run().catch((error) => {
  console.error("CPA Usage Collector stopped:", safeMessage(error));
  process.exitCode = 1;
});
