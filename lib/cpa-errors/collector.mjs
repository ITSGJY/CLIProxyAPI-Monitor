import { setTimeout as sleep } from "node:timers/promises";
import { subscribeErrorsViaResp } from "../collector/resp-client.mjs";
import { normalizeErrorEvent } from "./normalize.mjs";

export const errorReconnectDelay = (failures) => Math.min(30000, 500 * 2 ** Math.min(Math.max(0, failures - 1), 6));
const wait = (ms, signal) => sleep(ms, undefined, { signal }).catch((error) => { if (error.name !== "AbortError") throw error; });

export async function runErrorCollector({ config, store, signal, subscribe = subscribeErrorsViaResp, delay = wait, report = () => {} }) {
  if (!config.enabled) return;
  if (!await store.acquire()) throw new Error("error_collector_lease_held");
  let failures = 0;
  let renewing = Promise.resolve();
  let leaseFailure = false;
  let renewingBusy = false;
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  // This timer only touches error state. It survives reconnect backoff.
  const timer = setInterval(() => {
    if (renewingBusy || lifetime.signal.aborted) return;
    renewingBusy = true;
    renewing = store.renew().catch(() => { leaseFailure = true; lifetime.abort(); }).finally(() => { renewingBusy = false; });
  }, config.heartbeatMs);
  try {
    while (!lifetime.signal.aborted) {
      const session = await store.startSession();
      let malformed = false;
      let reason = "shutdown";
      let confirmed = false;
      try {
        await subscribe({ ...config, signal: lifetime.signal,
          onSubscribed: () => store.subscribed(session),
          onHeartbeat: async () => { await store.confirmCoverage(session); confirmed = true; },
          onMessage: async (raw, receivedAt = new Date()) => {
            let event;
            try { event = normalizeErrorEvent(raw, { instanceId: config.instanceId, receivedAt, secrets: [config.password] }); }
            catch { malformed = true; throw new Error("malformed_error_payload"); }
            await store.persist(session, event);
            // A durable Pub/Sub message also proves liveness. The store advances
            // coverage with PostgreSQL time, avoiding application/database clock skew.
            // PING is intentionally deferred while the bounded queue is busy.
            await store.confirmCoverage(session);
            confirmed = true;
          }
        });
        if (!lifetime.signal.aborted) reason = "stream_ended";
      } catch (error) {
        const knownReasons = { error_stream_backpressure: "backpressure", error_stream_probe_timeout: "probe_timeout",
          error_stream_drain_timeout: "drain_timeout", error_stream_persistence_failed: "persistence_failed" };
        reason = malformed ? "malformed_payload" : knownReasons[error?.message] ?? "stream_interrupted";
        // Fixed metadata only: neither raw errors nor upstream/DB exceptions.
        report({ event: "error_subscription_interrupted", reason });
      } finally {
        await store.endSession(session, reason, malformed);
      }
      if (confirmed) failures = 0;
      if (!lifetime.signal.aborted) await delay(errorReconnectDelay(++failures), lifetime.signal);
    }
    if (leaseFailure) throw new Error("error_collector_lease_lost");
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", stop);
    lifetime.abort();
    await renewing;
    await store.release().catch(() => {}); // Fenced: never releases a replacement worker's lease.
  }
}
