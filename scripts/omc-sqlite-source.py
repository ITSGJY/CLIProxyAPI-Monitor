#!/usr/bin/env python3
"""Read-only, allowlisted exporter for an Oh My CPA SQLite snapshot."""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

REQUIRED = {
    "id", "instance_id", "event_key", "api_group_key", "provider", "endpoint",
    "auth_type", "request_id", "model", "timestamp_ms", "source", "auth_index",
    "failed", "generate", "latency_ms", "ttft_ms", "input_tokens", "output_tokens",
    "reasoning_tokens", "cached_tokens", "cache_read_tokens", "cache_creation_tokens",
    "total_tokens", "created_at_ms", "api_group_label", "api_key_mask", "cost_nanos",
    "price_version_id", "pricing_status", "stream", "response_model", "model_substituted",
    "fail_status_code", "access_provider", "is_native_key", "billed_service_tier",
    "billed_service_tier_source", "effective_service_tier", "fail_code"
}
EXPORT_COLUMNS = [
    "id", "instance_id", "event_key", "api_group_key", "provider", "endpoint",
    "auth_type", "request_id", "model", "model_alias", "reasoning_effort",
    "service_tier", "response_service_tier", "executor_type", "timestamp_ms",
    "source", "auth_index", "failed", "generate", "latency_ms", "ttft_ms",
    "input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens",
    "cache_read_tokens", "cache_creation_tokens", "total_tokens", "created_at_ms",
    "api_group_label", "api_key_mask", "cost_nanos", "price_version_id",
    "pricing_status", "stream", "response_model", "model_substituted",
    "fail_status_code", "access_provider", "is_native_key", "billed_service_tier",
    "billed_service_tier_source", "effective_service_tier", "fail_code",
    "token_accounting", "structured_usage"
]


def connect(path):
    resolved = Path(path).resolve(strict=True)
    uri = "file:" + str(resolved) + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def manifest(conn, path):
    columns = {row[1] for row in conn.execute("PRAGMA table_info(usage_events)")}
    missing = sorted(REQUIRED - columns)
    if missing:
        raise RuntimeError("Unsupported OMC usage_events schema; missing: " + ", ".join(missing))
    integrity = conn.execute("PRAGMA quick_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError("SQLite quick_check failed: " + str(integrity))
    instance_rows = conn.execute(
        "SELECT instance_id, count(*) AS row_count, min(timestamp_ms) AS min_ms, max(timestamp_ms) AS max_ms "
        "FROM usage_events GROUP BY instance_id ORDER BY instance_id"
    ).fetchall()
    if len(instance_rows) != 1:
        raise RuntimeError("Expected exactly one OMC instance in this import snapshot")
    pricing = conn.execute(
        "SELECT pricing_status, count(*) AS row_count, "
        "sum(CASE WHEN cost_nanos IS NOT NULL THEN 1 ELSE 0 END) AS cost_rows "
        "FROM usage_events GROUP BY pricing_status ORDER BY pricing_status"
    ).fetchall()
    duplicate = conn.execute(
        "SELECT count(*) AS groups_count, coalesce(sum(n - 1), 0) AS extra_rows FROM "
        "(SELECT event_key, count(*) AS n FROM usage_events GROUP BY event_key HAVING count(*) > 1)"
    ).fetchone()
    tier_mismatch = conn.execute(
        "SELECT count(*) FROM usage_events WHERE (billed_service_tier IS NULL) <> (billed_service_tier_source IS NULL)"
    ).fetchone()[0]
    invalid_tier_source = conn.execute(
        "SELECT count(*) FROM usage_events WHERE billed_service_tier_source IS NOT NULL AND billed_service_tier_source NOT IN ('request','response','outbound','')"
    ).fetchone()[0]
    price_version_rows = conn.execute("SELECT count(*) FROM model_price_versions").fetchone()[0]
    invalid_price_tiers = 0
    for (raw_tiers,) in conn.execute("SELECT tiers_json FROM model_price_versions"):
        try:
            parsed_tiers = json.loads(raw_tiers)
            if not isinstance(parsed_tiers, list):
                invalid_price_tiers += 1
        except (TypeError, ValueError):
            invalid_price_tiers += 1
    totals = conn.execute(
        "SELECT count(*) AS rows, count(DISTINCT model) AS models, "
        "count(DISTINCT provider) AS providers, count(DISTINCT auth_index) AS auth_indexes, "
        "sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, "
        "sum(reasoning_tokens) AS reasoning_tokens, sum(cached_tokens) AS cached_tokens, "
        "sum(cache_read_tokens) AS cache_read_tokens, sum(cache_creation_tokens) AS cache_creation_tokens, "
        "sum(total_tokens) AS total_tokens, sum(CASE WHEN failed <> 0 THEN 1 ELSE 0 END) AS failures, "
        "sum(CASE WHEN cost_nanos IS NOT NULL THEN cost_nanos ELSE 0 END) AS cost_nanos "
        "FROM usage_events"
    ).fetchone()
    schema_version = conn.execute("PRAGMA user_version").fetchone()[0]
    migration_version = conn.execute("SELECT max(version) FROM schema_migrations").fetchone()[0]
    return {
        "source_name": Path(path).name,
        "source_schema_version": migration_version if migration_version is not None else schema_version,
        "price_version_rows": price_version_rows,
        "invalid_price_tier_rows": invalid_price_tiers,
        "source_instance_id": instance_rows[0]["instance_id"],
        "total_rows": totals["rows"],
        "min_timestamp_ms": instance_rows[0]["min_ms"],
        "max_timestamp_ms": instance_rows[0]["max_ms"],
        "models": totals["models"],
        "providers": totals["providers"],
        "auth_indexes": totals["auth_indexes"],
        "input_tokens": totals["input_tokens"] or 0,
        "output_tokens": totals["output_tokens"] or 0,
        "reasoning_tokens": totals["reasoning_tokens"] or 0,
        "cached_tokens": totals["cached_tokens"] or 0,
        "cache_read_tokens": totals["cache_read_tokens"] or 0,
        "cache_creation_tokens": totals["cache_creation_tokens"] or 0,
        "total_tokens": totals["total_tokens"] or 0,
        "failure_rows": totals["failures"] or 0,
        "cost_nanos": totals["cost_nanos"] or 0,
        "pricing_status": [dict(row) for row in pricing],
        "duplicate_event_key_groups": duplicate["groups_count"],
        "duplicate_event_key_extra_rows": duplicate["extra_rows"],
        "billed_tier_source_mismatch_rows": tier_mismatch,
        "invalid_billed_tier_source_rows": invalid_tier_source,
        "sqlite_quick_check": integrity
    }


def export(conn, after_id):
    cols = ", ".join('"' + col + '"' for col in EXPORT_COLUMNS)
    query = f"SELECT {cols} FROM usage_events WHERE id > ? ORDER BY id"
    cursor = conn.execute(query, (after_id,))
    for row in cursor:
        value = dict(row)
        for key in ("token_accounting", "structured_usage"):
            raw = value.get(key)
            if raw:
                try:
                    value[key] = json.loads(raw)
                except (TypeError, ValueError):
                    value[key] = None
            else:
                value[key] = None
        # These allowlisted fields contain accounting metadata only. Raw JSON,
        # fail_body, headers, client IP, forwarded-for and user-agent are excluded.
        sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n")


def export_price_versions(conn):
    query = ("SELECT id, model, effective_from_ms, available, prompt_price_per_1m, "
             "completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, "
             "price_multiplier, source, tiers_json, upstream_id, channel "
             "FROM model_price_versions ORDER BY id")
    for row in conn.execute(query):
        value = dict(row)
        try:
            value["tiers"] = json.loads(value.pop("tiers_json") or "[]")
        except (TypeError, ValueError):
            raise RuntimeError("Invalid tiers_json in model_price_versions id=" + str(value.get("id")))
        sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["manifest", "export", "price-versions"])
    parser.add_argument("--source", required=True)
    parser.add_argument("--after-id", type=int, default=0)
    args = parser.parse_args()
    conn = connect(args.source)
    try:
        if args.mode == "manifest":
            print(json.dumps(manifest(conn, args.source), separators=(",", ":")))
        elif args.mode == "export":
            export(conn, args.after_id)
        else:
            export_price_versions(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
