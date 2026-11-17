import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const modelPriceVersions = pgTable(
  "model_price_versions",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    model: text("model").notNull(),
    provider: text("provider"),
    serviceTier: text("service_tier"),
    inputPricePer1M: numeric("input_price_per_1m", { precision: 20, scale: 10 }).notNull(),
    cachedInputPricePer1M: numeric("cached_input_price_per_1m", { precision: 20, scale: 10 }).default("0").notNull(),
    outputPricePer1M: numeric("output_price_per_1m", { precision: 20, scale: 10 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    source: text("source").notNull().default("manual"),
    sourceVersion: text("source_version"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: text("created_by")
  },
  (table) => ({
    modelValidFromIdx: index("model_price_versions_model_valid_from_idx").on(table.model, table.validFrom),
    modelProviderTierValidFromUnique: uniqueIndex("model_price_versions_model_provider_tier_from_idx").on(
      table.model,
      sql`coalesce(${table.provider}, '')`,
      sql`coalesce(${table.serviceTier}, '')`,
      table.validFrom
    ),
    validRangeCheck: check("model_price_versions_valid_range_check", sql`${table.validTo} IS NULL OR ${table.validTo} > ${table.validFrom}`)
  })
);

export const modelPrices = pgTable("model_prices", {
  id: serial("id").primaryKey(),
  model: text("model").notNull().unique(),
  inputPricePer1M: numeric("input_price_per_1m", { precision: 10, scale: 4 }).notNull(),
  cachedInputPricePer1M: numeric("cached_input_price_per_1m", { precision: 10, scale: 4 }).default("0").notNull(),
  outputPricePer1M: numeric("output_price_per_1m", { precision: 10, scale: 4 }).notNull(),
  priceVersionId: bigint("price_version_id", { mode: "number" }).references(() => modelPriceVersions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const usageRecords = pgTable(
  "usage_records",
  {
    id: serial("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    route: text("route").notNull(),
    source: text("source").notNull().default(""),
    authIndex: text("auth_index"),
    model: text("model").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").default(0).notNull(),
    cachedTokens: integer("cached_tokens").default(0).notNull(),
    isError: boolean("is_error").notNull().default(false),
    raw: text("raw").notNull()
  },
  (table) => ({
    uniq: uniqueIndex("usage_records_occurred_route_model_source_idx").on(table.occurredAt, table.route, table.model, table.source)
  })
);

export const authFileMappings = pgTable("auth_file_mappings", {
  authId: text("auth_id").primaryKey(),
  name: text("name").notNull().default(""),
  label: text("label"),
  provider: text("provider"),
  source: text("source"),
  email: text("email"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull()
});

export const usageCollectorInstances = pgTable("usage_collector_instances", {
  instanceId: text("instance_id").primaryKey(),
  displayName: text("display_name").notNull(),
  managementBaseUrl: text("management_base_url").notNull(),
  queueName: text("queue_name").notNull().default("usage"),
  collectorMode: text("collector_mode").notNull().default("pull_first"),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const usagePullAttempts = pgTable(
  "usage_pull_attempts",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    instanceId: text("instance_id").notNull().references(() => usageCollectorInstances.instanceId, { onDelete: "restrict" }),
    transport: text("transport").notNull(),
    queueName: text("queue_name").notNull().default("usage"),
    requestedCount: integer("requested_count").notNull(),
    receivedCount: integer("received_count").notNull().default(0),
    persistedCount: integer("persisted_count").notNull().default(0),
    status: text("status").notNull().default("started"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default({})
  },
  (table) => ({
    instanceStartedIdx: index("usage_pull_attempts_instance_started_idx").on(table.instanceId, table.startedAt),
    emptyCleanupIdx: index("usage_pull_attempts_empty_cleanup_idx").on(table.completedAt).where(sql`${table.status} = 'empty'`)
  })
);

export const usageEvents = pgTable(
  "usage_events",
  {
    eventId: bigint("event_id", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
    sourceInstanceId: text("source_instance_id").notNull(),
    originSystem: text("origin_system").notNull().default("cpa_live"),
    sourceTransport: text("source_transport").notNull(),
    sourceNativeId: text("source_native_id"),
    identityKey: text("identity_key").notNull(),
    provider: text("provider"),
    endpoint: text("endpoint"),
    authType: text("auth_type"),
    requestId: text("request_id"),
    clientIp: text("client_ip"),
    xForwardedFor: text("x_forwarded_for"),
    userAgent: text("user_agent"),
    apiGroupKey: text("api_group_key"),
    apiGroupLabel: text("api_group_label"),
    apiKeyMask: text("api_key_mask"),
    model: text("model").notNull(),
    modelAlias: text("model_alias"),
    responseModel: text("response_model"),
    modelSubstituted: boolean("model_substituted"),
    reasoningEffort: text("reasoning_effort"),
    serviceTier: text("service_tier"),
    responseServiceTier: text("response_service_tier"),
    effectiveServiceTier: text("effective_service_tier"),
    billedServiceTier: text("billed_service_tier"),
    billedServiceTierSource: text("billed_service_tier_source"),
    executorType: text("executor_type"),
    source: text("source"),
    authIndex: text("auth_index"),
    accessProvider: text("access_provider"),
    isNativeKey: boolean("is_native_key"),
    stream: boolean("stream"),
    generate: boolean("generate"),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    ttftMs: bigint("ttft_ms", { mode: "number" }),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    isError: boolean("is_error").notNull().default(false),
    statusCode: integer("status_code"),
    failCode: text("fail_code"),
    failBody: text("fail_body"),
    responseHeaders: jsonb("response_headers"),
    tokenAccounting: jsonb("token_accounting"),
    structuredUsage: jsonb("structured_usage"),
    rawPayload: jsonb("raw_payload").notNull().default({}),
    priceVersionId: bigint("price_version_id", { mode: "number" }).references(() => modelPriceVersions.id, { onDelete: "set null" }),
    costNanos: bigint("cost_nanos", { mode: "number" }),
    costCurrency: text("cost_currency").notNull().default("USD"),
    pricingStatus: text("pricing_status").notNull().default("unpriced"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()  },
  (table) => ({
    pk: primaryKey({ columns: [table.occurredAt, table.eventId], name: "usage_events_pkey" }),
    occurredAtIdx: index("usage_events_occurred_at_idx").on(table.occurredAt),
    modelOccurredAtIdx: index("usage_events_model_occurred_at_idx").on(table.model, table.occurredAt),
    identityKeyIdx: index("usage_events_identity_key_idx").on(table.identityKey, table.occurredAt)
  })
);

export const usageEventIdentity = pgTable(
  "usage_event_identity",
  {
    identityKey: text("identity_key").primaryKey(),
    identityVersion: integer("identity_version").notNull().default(1),
    identityKind: text("identity_kind").notNull(),
    sourceInstanceId: text("source_instance_id").notNull(),
    requestId: text("request_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    duplicateCount: bigint("duplicate_count", { mode: "number" }).notNull().default(0)
  },
  (table) => ({
    eventFk: foreignKey({
      columns: [table.occurredAt, table.eventId],
      foreignColumns: [usageEvents.occurredAt, usageEvents.eventId],
      name: "usage_event_identity_event_fk"
    }).onDelete("restrict"),
    eventIdx: uniqueIndex("usage_event_identity_event_idx").on(table.occurredAt, table.eventId),
    requestIdIdx: index("usage_event_identity_request_id_idx").on(table.sourceInstanceId, table.requestId)
  })
);

export const usageInbox = pgTable(
  "usage_inbox",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    instanceId: text("instance_id").notNull().references(() => usageCollectorInstances.instanceId, { onDelete: "restrict" }),
    pullAttemptId: bigint("pull_attempt_id", { mode: "number" }).references(() => usagePullAttempts.id, { onDelete: "set null" }),
    transport: text("transport").notNull(),
    queueName: text("queue_name").notNull().default("usage"),
    payloadSha256: text("payload_sha256").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    usageEventId: bigint("usage_event_id", { mode: "number" }),
    usageEventOccurredAt: timestamp("usage_event_occurred_at", { withTimezone: true }),
    duplicateOfIdentityKey: text("duplicate_of_identity_key"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message")
  },
  (table) => ({
    pendingIdx: index("usage_inbox_pending_idx").on(table.instanceId, table.status, table.availableAt, table.id),
    pullAttemptIdx: index("usage_inbox_pull_attempt_idx").on(table.pullAttemptId),
    eventFk: foreignKey({
      columns: [table.usageEventOccurredAt, table.usageEventId],
      foreignColumns: [usageEvents.occurredAt, usageEvents.eventId],
      name: "usage_inbox_event_fk"
    }).onDelete("set null"),
    statusCheck: check("usage_inbox_status_check", sql`${table.status} IN ('pending', 'processing', 'processed', 'dead_letter')`)
  })
);

export const usageCollectorState = pgTable("usage_collector_state", {
  instanceId: text("instance_id").primaryKey().references(() => usageCollectorInstances.instanceId, { onDelete: "cascade" }),
  state: text("state").notNull().default("idle"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  lastTransport: text("last_transport"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const usageCollectorCommands = pgTable(
  "usage_collector_commands",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    instanceId: text("instance_id").notNull().references(() => usageCollectorInstances.instanceId, { onDelete: "cascade" }),
    command: text("command").notNull().default("pull_now"),
    status: text("status").notNull().default("pending"),
    requestedBy: text("requested_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error")
  },
  (table) => ({
    pendingIdx: index("usage_collector_commands_pending_idx").on(table.instanceId, table.status, table.requestedAt)
  })
);

export const usageIngestGaps = pgTable(
  "usage_ingest_gaps",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    instanceId: text("instance_id").notNull().references(() => usageCollectorInstances.instanceId, { onDelete: "restrict" }),
    pullAttemptId: bigint("pull_attempt_id", { mode: "number" }).references(() => usagePullAttempts.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
    reason: text("reason").notNull(),
    estimatedMissingCount: integer("estimated_missing_count"),
    details: jsonb("details").notNull().default({})
  },
  (table) => ({
    instanceDetectedIdx: index("usage_ingest_gaps_instance_detected_idx").on(table.instanceId, table.detectedAt)
  })
);

export const usageImportBatches = pgTable("usage_import_batches", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  sourceSystem: text("source_system").notNull(),
  sourceVersion: text("source_version"),
  sourceFingerprint: text("source_fingerprint"),
  status: text("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  rowsScanned: bigint("rows_scanned", { mode: "number" }).notNull().default(0),
  eventsInserted: bigint("events_inserted", { mode: "number" }).notNull().default(0),
  duplicatesSkipped: bigint("duplicates_skipped", { mode: "number" }).notNull().default(0),
  rowsRejected: bigint("rows_rejected", { mode: "number" }).notNull().default(0),
  details: jsonb("details").notNull().default({})
});

export const usageRollupCheckpoints = pgTable(
  "usage_rollup_checkpoints",
  {
    rollupName: text("rollup_name").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    watermarkOccurredAt: timestamp("watermark_occurred_at", { withTimezone: true }),
    watermarkEventId: bigint("watermark_event_id", { mode: "number" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    state: text("state").notNull().default("pending"),
    lastError: text("last_error")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.rollupName, table.timezone], name: "usage_rollup_checkpoints_pkey" })
  })
);

function createRollupColumns() {
  return {
    timezone: text("timezone").notNull().default("UTC"),
    provider: text("provider").notNull().default(""),
    model: text("model").notNull(),
    source: text("source").notNull().default(""),
    apiGroupKey: text("api_group_key").notNull().default(""),
    apiKeyMask: text("api_key_mask").notNull().default(""),
    serviceTier: text("service_tier").notNull().default(""),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }).notNull().default(0),
    pricedRequestCount: bigint("priced_request_count", { mode: "number" }).notNull().default(0),
    unpricedRequestCount: bigint("unpriced_request_count", { mode: "number" }).notNull().default(0),
    requestCount: bigint("request_count", { mode: "number" }).notNull().default(0),
    errorCount: bigint("error_count", { mode: "number" }).notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    costNanos: bigint("cost_nanos", { mode: "number" }).notNull().default(0),
    costCurrency: text("cost_currency").notNull().default("USD"),
    pricingStatus: text("pricing_status").notNull().default("unpriced"),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).defaultNow().notNull()
  };
}

export const usageRollupsHourly = pgTable(
  "usage_rollups_hourly",
  {
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    ...createRollupColumns()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bucketStart, table.timezone, table.provider, table.model, table.source, table.apiGroupKey, table.apiKeyMask, table.serviceTier, table.costCurrency], name: "usage_rollups_hourly_pkey" })
  })
);

export const usageRollupsDaily = pgTable(
  "usage_rollups_daily",
  {
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    ...createRollupColumns()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bucketStart, table.timezone, table.provider, table.model, table.source, table.apiGroupKey, table.apiKeyMask, table.serviceTier, table.costCurrency], name: "usage_rollups_daily_pkey" })
  })
);