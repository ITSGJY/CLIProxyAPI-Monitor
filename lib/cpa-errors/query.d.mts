import type { CredentialErrorEvidence } from "../types";
import type { Pool } from "pg";
export function getCredentialErrors(pool: Pick<Pool, "connect">, record: { sourceInstanceId?: string; authIndex?: string | null; occurredAt: string | Date; provider?: string | null; model?: string | null }, options?: { now?: number; configured?: boolean }): Promise<CredentialErrorEvidence>;
export function getErrorCollectorHealth(pool: Pick<Pool, "query">, instanceId: string, now?: number): Promise<{ healthy: boolean; status: string }>;
