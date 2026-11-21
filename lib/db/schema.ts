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
    inputPricePer1M: numeric("input_price_per_1m", { precision: 30, scale: 12 }).notNull(),
    cachedInputPricePer1M: numeric("cached_input_price_per_1m", { precision: 30, scale: 12 }).default("0").notNull(),
    outputPricePer1M: numeric("output_price_per_1m", { precision: 30, scale: 12 }).notNull(),
    cacheWritePricePer1M: numeric("cache_write_price_per_1m", { precision: 30, scale: 12 }).default("0").notNull(),
    priceMultiplier: numeric("price_multiplier", { precision: 30, scale: 12 }).default("1").notNull(),
    tiers: jsonb("tiers").notNull().default(sql`'[]'::jsonb`),
    upstreamProviderId: text("upstream_provider_id"),
    upstreamModelId: text("upstream_model_id"),
    matchKind: text("match_kind"),
    mode: text("mode").notNull().default("custom"),
    available: boolean("available").notNull().default(true),
    sourceSnapshotSha: text("source_snapshot_sha"),
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
    validRangeCheck: check("model_price_versions_valid_range_check", sql`${table.validTo} IS NULL OR ${table.validTo} > ${table.validFrom}`),
    modeCheck: check("model_price_versions_mode_check", sql`${table.mode} IN ('auto', 'linked', 'custom')`)
  })
);

export const modelPrices = pgTable(
  "model_prices",
  {
    id: serial("id").primaryKey(),
    model: text("model").notNull(),
    provider: text("provider").notNull().default(""),
    serviceTier: text("service_tier").notNull().default(""),
    inputPricePer1M: numeric("input_price_per_1m", { precision: 30, scale: 12 }).notNull(),
    cachedInputPricePer1M: numeric("cached_input_price_per_1m", { precision: 30, scale: 12 }).default("0").notNull(),
    outputPricePer1M: numeric("output_price_per_1m", { precision: 30, scale: 12 }).notNull(),
    cacheWritePricePer1M: numeric("cache_write_price_per_1m", { precision: 30, scale: 12 }).default("0").notNull(),
    priceMultiplier: numeric("price_multiplier", { precision: 30, scale: 12 }).default("1").notNull(),
    tiers: jsonb("tiers").notNull().default(sql`'[]'::jsonb`),
    source: text("source").notNull().default("manual"),
    sourceVersion: text("source_version"),
    upstreamProviderId: text("upstream_provider_id"),
    upstreamModelId: text("upstream_model_id"),
    matchKind: text("match_kind"),
    mode: text("mode").notNull().default("custom"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    available: boolean("available").notNull().default(true),
    createdBy: text("created_by"),
    priceVersionId: bigint("price_version_id", { mode: "number" }).references(() => modelPriceVersions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    scopeUnique: uniqueIndex("model_prices_model_provider_tier_unique_idx").on(table.model, table.provider, table.serviceTier),
    modeSourceIdx: index("model_prices_mode_source_idx").on(table.mode, table.source, table.available)
  })
);

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
  collectorMode: text("collector_mode").notNull().default("subscribe"),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const usageImportRuns = pgTable(
  "usage_import_runs",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    sourceKey: text("source_key").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceName: text("source_name").notNull(),
    sourceSchemaVersion: integer("source_schema_version"),
    status: text("status").notNull().default("planned"),
    totalRows: bigint("total_rows", { mode: "number" }).notNull().default(0),
    processedRows: bigint("processed_rows", { mode: "number" }).notNull().default(0),
    insertedRows: bigint("inserted_rows", { mode: "number" }).notNull().default(0),
    skippedRows: bigint("skipped_rows", { mode: "number" }).notNull().default(0),
    lastSourceId: bigint("last_source_id", { mode: "number" }).notNull().default(0),
    minOccurredAt: timestamp("min_occurred_at", { withTimezone: true }),
    maxOccurredAt: timestamp("max_occurred_at", { withTimezone: true }),
    sourceDuplicateKeyGroups: bigint("source_duplicate_key_groups", { mode: "number" }).notNull().default(0),
    sourceDuplicateKeyRows: bigint("source_duplicate_key_rows", { mode: "number" }).notNull().default(0),
    pricedRows: bigint("priced_rows", { mode: "number" }).notNull().default(0),
    unpricedRows: bigint("unpriced_rows", { mode: "number" }).notNull().default(0),
    sourcePriceVersionRows: bigint("source_price_version_rows", { mode: "number" }).notNull().default(0),
    importedPriceVersionRows: bigint("imported_price_version_rows", { mode: "number" }).notNull().default(0),
    manifest: jsonb("manifest").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error")
  },
  (table) => ({
    sourceHashUnique: uniqueIndex("usage_import_runs_source_hash_idx").on(table.sourceKey, table.sourceSha256),
    statusUpdatedIdx: index("usage_import_runs_status_updated_idx").on(table.status, table.updatedAt),
    statusCheck: check("usage_import_runs_status_check", sql`${table.status} IN ('planned', 'running', 'completed', 'failed')`),
    sourceHashCheck: check("usage_import_runs_source_sha_check", sql`${table.sourceSha256} ~ '^[0-9a-f]{64}$'`)
  })
);

export const usageImportSourcePriceVersions = pgTable(
  "usage_import_source_price_versions",
  {
    sourceKey: text("source_key").notNull(),
    sourcePriceVersionId: bigint("source_price_version_id", { mode: "number" }).notNull(),
    sourceSha256: text("source_sha256").notNull(),
    model: text("model").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    available: boolean("available").notNull(),
    promptPricePer1M: numeric("prompt_price_per_1m", { precision: 20, scale: 10 }).notNull(),
    completionPricePer1M: numeric("completion_price_per_1m", { precision: 20, scale: 10 }).notNull(),
    cacheReadPricePer1M: numeric("cache_read_price_per_1m", { precision: 20, scale: 10 }).notNull(),
    cacheWritePricePer1M: numeric("cache_write_price_per_1m", { precision: 20, scale: 10 }).notNull(),
    priceMultiplier: numeric("price_multiplier", { precision: 20, scale: 10 }).notNull(),
    source: text("source").notNull(),
    currency: text("currency").notNull().default("USD"),
    tiers: jsonb("tiers").notNull().default(sql`'[]'::jsonb`),
    upstreamId: text("upstream_id").notNull().default(""),
    channel: text("channel").notNull().default("")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sourceKey, table.sourcePriceVersionId] }),
    modelEffectiveIdx: index("usage_import_source_price_versions_model_effective_idx").on(table.sourceKey, table.model, table.effectiveFrom),
    sourceHashCheck: check("usage_import_source_price_versions_sha_check", sql`${table.sourceSha256} ~ '^[0-9a-f]{64}$'`)
  })
);

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
    sourceEventKey: text("source_event_key"),
    sourcePriceVersionId: bigint("source_price_version_id", { mode: "number" }),
    identityKey: text("identity_key").notNull(),
    provider: text("provider"),
    endpoint: text("endpoint"),
    authType: text("auth_type"),
    requestId: text("request_id"),
    clientIp: text("client_ip"),
    xForwardedFor: text("x_forwarded_for"),
    userAgent: text("user_agent"),
    sessionId: text("session_id"),
    parentSessionId: text("parent_session_id"),
    executionId: text("execution_id"),
    traceId: text("trace_id"),
    nodeKind: text("node_kind"),
    isFork: boolean("is_fork"),
    isCompaction: boolean("is_compaction"),
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
    channelVersionId: bigint("channel_version_id", { mode: "number" }).references(() => pricingChannelVersions.id, { onDelete: "set null" }),
    priceTierIndex: integer("price_tier_index"),
    resolvedServiceTier: text("resolved_service_tier"),
    pricingPolicyVersion: integer("pricing_policy_version").notNull().default(1),
    costBreakdown: jsonb("cost_breakdown"),
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

export const pricingUpstreamCatalog = pgTable(
  "pricing_upstream_catalog",
  {
    source: text("source").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    name: text("name").notNull().default(""),
    canonicalId: text("canonical_id"),
    contextLength: bigint("context_length", { mode: "number" }),
    inputPricePer1M: numeric("input_price_per_1m", { precision: 30, scale: 12 }),
    outputPricePer1M: numeric("output_price_per_1m", { precision: 30, scale: 12 }),
    cacheReadPricePer1M: numeric("cache_read_price_per_1m", { precision: 30, scale: 12 }),
    cacheWritePricePer1M: numeric("cache_write_price_per_1m", { precision: 30, scale: 12 }),
    tiers: jsonb("tiers").notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    sourceVersion: text("source_version"),
    snapshotSha: text("snapshot_sha").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.source, table.providerId, table.modelId], name: "pricing_upstream_catalog_pkey" }),
    modelIdx: index("pricing_upstream_catalog_model_idx").on(table.source, table.modelId),
    providerIdx: index("pricing_upstream_catalog_provider_idx").on(table.source, table.providerId)
  })
);

export const pricingCatalogSnapshots = pgTable(
  "pricing_catalog_snapshots",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    source: text("source").notNull(),
    snapshotSha: text("snapshot_sha").notNull(),
    sourceVersion: text("source_version"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    status: text("status").notNull(),
    providerCount: integer("provider_count").notNull().default(0),
    modelCount: integer("model_count").notNull().default(0),
    matchedCount: integer("matched_count").notNull().default(0),
    ambiguousCount: integer("ambiguous_count").notNull().default(0),
    updatedPriceCount: integer("updated_price_count").notNull().default(0),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    sourceTimeIdx: index("pricing_catalog_snapshots_source_time_idx").on(table.source, table.fetchedAt),
    sourceSnapshotFetchedUnique: uniqueIndex("pricing_catalog_snapshots_source_snapshot_sha_fetched_at_key").on(table.source, table.snapshotSha, table.fetchedAt)
  })
);

export const pricingSyncState = pgTable("pricing_sync_state", {
  source: text("source").primaryKey(),
  etag: text("etag"),
  lastModified: text("last_modified"),
  lastHash: text("last_hash"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  autoSyncIntervalHours: integer("auto_sync_interval_hours").notNull().default(24),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const pricingModelLinks = pgTable(
  "pricing_model_links",
  {
    model: text("model").notNull(),
    provider: text("provider").notNull().default(""),
    source: text("source").notNull().default("models.dev"),
    upstreamProviderId: text("upstream_provider_id").notNull(),
    upstreamModelId: text("upstream_model_id").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.model, table.provider], name: "pricing_model_links_pkey" }),
    upstreamIdx: index("pricing_model_links_upstream_idx").on(table.source, table.upstreamProviderId, table.upstreamModelId)
  })
);

export const pricingChannels = pgTable("pricing_channels", {
  channel: text("channel").primaryKey(),
  multiplier: numeric("multiplier", { precision: 30, scale: 12 }).notNull(),
  note: text("note").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: text("created_by")
});

export const pricingChannelVersions = pgTable(
  "pricing_channel_versions",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    channel: text("channel").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    available: boolean("available").notNull().default(true),
    multiplier: numeric("multiplier", { precision: 30, scale: 12 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    lookupIdx: index("pricing_channel_versions_lookup_idx").on(table.channel, table.effectiveFrom),
    channelEffectiveUnique: uniqueIndex("pricing_channel_versions_channel_effective_from_key").on(table.channel, table.effectiveFrom)
  })
);

// Phase 5.5: separate credential error stream and audit history.
export const cpaErrorCollectorState = pgTable("cpa_error_collector_state", {
  sourceInstanceId: text("source_instance_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  state: text("state").notNull().default("connecting"),
  leaseOwner: text("lease_owner"),
  leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull().default(0),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [check("cpa_error_collector_state_state_check", sql`${t.state} IN ('connecting','collecting','disconnected','degraded','disabled')`)]);

export const cpaErrorSubscriptionSessions = pgTable("cpa_error_subscription_sessions", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  sourceInstanceId: text("source_instance_id").notNull().references(() => cpaErrorCollectorState.sourceInstanceId),
  leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true }),
  coverageThrough: timestamp("coverage_through", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
  receivedCount: bigint("received_count", { mode: "number" }).notNull().default(0),
  insertedCount: bigint("inserted_count", { mode: "number" }).notNull().default(0),
  duplicateCount: bigint("duplicate_count", { mode: "number" }).notNull().default(0),
  malformedCount: bigint("malformed_count", { mode: "number" }).notNull().default(0)
}, (t) => [
  index("cpa_error_sessions_window_idx").on(t.sourceInstanceId, t.subscribedAt, t.coverageThrough),
  uniqueIndex("cpa_error_sessions_open_idx").on(t.sourceInstanceId).where(sql`${t.endedAt} IS NULL`),
  check("cpa_error_subscription_sessions_check", sql`${t.coverageThrough} IS NULL OR (${t.subscribedAt} IS NOT NULL AND ${t.coverageThrough} >= ${t.subscribedAt})`)
]);

export const cpaErrorImportRuns = pgTable("cpa_error_import_runs", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  sourceInstanceId: text("source_instance_id").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  sourceSchemaVersion: text("source_schema_version"),
  status: text("status").notNull(),
  expectedCount: bigint("expected_count", { mode: "number" }),
  processedCount: bigint("processed_count", { mode: "number" }).notNull().default(0),
  insertedCount: bigint("inserted_count", { mode: "number" }).notNull().default(0),
  skippedCount: bigint("skipped_count", { mode: "number" }).notNull().default(0),
  failedCount: bigint("failed_count", { mode: "number" }).notNull().default(0),
  reconciledCount: bigint("reconciled_count", { mode: "number" }).notNull().default(0),
  minOccurredAt: timestamp("min_occurred_at", { withTimezone: true }),
  maxOccurredAt: timestamp("max_occurred_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true })
}, (t) => [
  index("cpa_error_import_runs_snapshot_idx").on(t.sourceInstanceId, t.sourceSha256),
  check("cpa_error_import_runs_status_check", sql`${t.status} IN ('running','completed','failed','unavailable')`),
  check("cpa_error_import_runs_expected_count_check", sql`${t.expectedCount} IS NULL OR ${t.expectedCount} >= 0`),
  check("cpa_error_import_runs_check", sql`${t.processedCount} = ${t.insertedCount} + ${t.skippedCount} + ${t.failedCount}`),
  check("cpa_error_import_runs_check1", sql`${t.status} <> 'completed' OR (${t.processedCount} = ${t.expectedCount} AND ${t.reconciledCount} = ${t.expectedCount} AND ${t.failedCount} = 0)`)
]);

export const cpaErrorEvents = pgTable("cpa_error_events", {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    sourceInstanceId: text("source_instance_id").notNull(),
    eventKey: text("event_key").notNull(),
    originSystem: text("origin_system").notNull(),
    sourceTransport: text("source_transport").notNull(),
    sourceNativeId: text("source_native_id"),
    sourceSnapshotSha256: text("source_snapshot_sha256"),
    importRunId: bigint("import_run_id", { mode: "number" }).references(() => cpaErrorImportRuns.id),
    subscriptionSessionId: bigint("subscription_session_id", { mode: "number" }).references(() => cpaErrorSubscriptionSessions.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    authIndex: text("auth_index"),
    provider: text("provider"),
    model: text("model"),
    statusCode: integer("status_code"),
    code: text("code"),
    body: text("body"),
    retryable: boolean("retryable"),
    authStatus: jsonb("auth_status").notNull().default(sql`'{}'::jsonb`),
    quotaExceeded: boolean("quota_exceeded"),
    quotaReason: text("quota_reason"),
    nextRetryAfter: timestamp("next_retry_after", { withTimezone: true }),
    nextRecoverAt: timestamp("next_recover_at", { withTimezone: true }),
    backoffLevel: integer("backoff_level"),
    cooldownModel: text("cooldown_model"),
    modelQuotaExceeded: boolean("model_quota_exceeded"),
    modelQuotaReason: text("model_quota_reason"),
    modelNextRetryAfter: timestamp("model_next_retry_after", { withTimezone: true }),
    modelNextRecoverAt: timestamp("model_next_recover_at", { withTimezone: true }),
    modelBackoffLevel: integer("model_backoff_level"),
    authQuotaAggregate: boolean("auth_quota_aggregate"),
    modelQuotaInherited: boolean("model_quota_inherited"),
}, (t) => [
  uniqueIndex("cpa_error_events_instance_key_unique").on(t.sourceInstanceId, t.eventKey),
  index("cpa_error_events_correlation_idx").on(t.sourceInstanceId, t.authIndex, t.occurredAt, t.id).where(sql`${t.authIndex} IS NOT NULL AND ${t.authIndex} <> ''`),
  check("cpa_error_events_origin_system_check", sql`${t.originSystem} IN ('cpa','oh_my_cpa')`),
  check("cpa_error_events_source_transport_check", sql`${t.sourceTransport} IN ('resp-subscribe','legacy_import')`)
]);

export const cpaErrorImportItems = pgTable("cpa_error_import_items", {
  runId: bigint("run_id", { mode: "number" }).notNull().references(() => cpaErrorImportRuns.id),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => cpaErrorEvents.id, { onDelete: "cascade" })
}, (t) => [primaryKey({ columns: [t.runId, t.eventId] })]);
