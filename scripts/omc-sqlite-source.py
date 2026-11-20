#!/usr/bin/env python3
"""Read-only, allowlisted exporter for an Oh My CPA SQLite snapshot."""
import argparse
import json
import re
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

ERROR_REQUIRED = {"id", "instance_id", "timestamp_ms", "created_at_ms", "auth_index"}
ERROR_COLUMNS = ["id", "instance_id", "event_key", "timestamp_ms", "created_at_ms", "auth_index",
                 "provider", "model", "status_code", "code", "body", "retryable", "auth_status",
                 "auth_disabled", "auth_unavailable", "quota_exceeded", "quota_reason",
                 "next_retry_after_ms", "next_recover_at_ms", "backoff_level", "cooldown_model",
                 "model_quota_exceeded", "model_quota_reason", "model_next_retry_after_ms",
                 "model_next_recover_at_ms", "model_backoff_level", "auth_quota_aggregate", "model_quota_inherited"]


def error_manifest(conn):
    columns = {row[1] for row in conn.execute("PRAGMA table_info(error_events)")}
    if not columns:
        return {"available": False, "expected_count": None, "reason": "source_error_table_unavailable"}
    if ERROR_REQUIRED - columns:
        raise RuntimeError("Unsupported OMC error_events schema")
    if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise RuntimeError("SQLite quick_check failed")
    if conn.execute("SELECT count(*) FROM error_events WHERE instance_id IS NULL OR instance_id <> 'default'").fetchone()[0]:
        raise RuntimeError("Unexpected OMC error source instance")
    stats = conn.execute("SELECT count(*) AS expected_count, min(timestamp_ms) AS min_timestamp_ms, max(timestamp_ms) AS max_timestamp_ms FROM error_events").fetchone()
    has_migrations = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").fetchone()
    version = conn.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] if has_migrations else conn.execute("PRAGMA user_version").fetchone()[0]
    return {"available": True, **dict(stats), "source_schema_version": version,
            "missing_optional_columns": sorted(set(ERROR_COLUMNS) - columns)}


def redact_error_text(value, auth_id):
    if not isinstance(value, str):
        return value
    if auth_id:
        value = value.replace(auth_id, "[redacted]")
    value = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)", "[redacted]", value, flags=re.I)
    value = re.sub(r"\b(?:Bearer|Basic)\s+[^\s,;\"'<>]+", "[redacted]", value, flags=re.I)
    value = re.sub(r"\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]+", "[redacted-header]", value, flags=re.I)
    value = re.sub(r"((?:full[_-]?name|user[_-]?name|first[_-]?name|last[_-]?name|address|姓名|地址|电话|手机号)\s*[:=：]\s*)[^\r\n,;}]+", r"\1[redacted]", value, flags=re.I)
    value = re.sub(r'''(["']?(?:[\w-]*(?:token|secret|password|api[_-]?key)|authorization|cookie|auth[_-]?id|email|phone|address|full[_-]?name|user[_-]?name|first[_-]?name|last[_-]?name)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)''', r"\1[redacted]", value, flags=re.I)
    value = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[redacted]", value, flags=re.I)
    value = re.sub(r'''https?://[^\s<>"']+''', "[redacted-url]", value, flags=re.I)
    value = re.sub(r"\b(?:sk-|gh[pousr]_|github_pat_|AIza|AKIA)[A-Za-z0-9_-]+", "[redacted]", value)
    value = re.sub(r"\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?", "[redacted]", value)
    value = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[redacted-ip]", value)
    value = re.sub(r"\b(?:[a-f\d]{1,4}:){2,}[a-f\d:]+\b", "[redacted-ip]", value, flags=re.I)
    value = re.sub(r"(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)", "[redacted-number]", value)
    value = re.sub(r"\b[A-Za-z0-9_+/=]{24,}\b", "[redacted]", value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    return value.strip()[:4096]


def export_errors(conn, after_id):
    if not error_manifest(conn)["available"]:
        raise RuntimeError("source_error_table_unavailable")
    columns = {row[1] for row in conn.execute("PRAGMA table_info(error_events)")}
    expressions = ['"' + col + '"' if col in columns else 'NULL AS "' + col + '"' for col in ERROR_COLUMNS]
    # Read auth_id only to remove exact occurrences from free text. Never export it.
    expressions.append('auth_id AS redaction_identity' if 'auth_id' in columns else 'NULL AS redaction_identity')
    for row in conn.execute('SELECT ' + ','.join(expressions) + ' FROM error_events WHERE id > ? ORDER BY id', (after_id,)):
        value = dict(row)
        auth_id = value.pop('redaction_identity')
        for key in ['event_key', 'provider', 'model', 'code', 'body', 'auth_status', 'quota_reason', 'cooldown_model', 'model_quota_reason']:
            value[key] = redact_error_text(value[key], auth_id)
        # Auth index is needed for correlation; reject unexpected PII instead of changing its identity.
        auth_index = value['auth_index']
        if not isinstance(auth_index, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,256}', auth_index.strip()) or re.match(r'^(sk-|eyJ|ghp_|github_pat_)', auth_index.strip()):
            value['auth_index'] = None
        sys.stdout.write(json.dumps(value, separators=(',', ':'), ensure_ascii=False) + '\n')


def connect(path, immutable=False):
    resolved = Path(path).resolve(strict=True)
    if immutable and any(Path(str(resolved) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise RuntimeError("Error export requires a standalone SQLite backup snapshot")
    uri = resolved.as_uri() + "?mode=ro" + ("&immutable=1" if immutable else "")
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
    parser.add_argument("mode", choices=["manifest", "export", "price-versions", "errors-manifest", "errors"])
    parser.add_argument("--source", required=True)
    parser.add_argument("--after-id", type=int, default=0)
    args = parser.parse_args()
    conn = connect(args.source, immutable=args.mode in ("errors", "errors-manifest"))
    try:
        if args.mode == "errors-manifest":
            print(json.dumps(error_manifest(conn), separators=(",", ":")))
        elif args.mode == "errors":
            export_errors(conn, args.after_id)
        elif args.mode == "manifest":
            print(json.dumps(manifest(conn, args.source), separators=(",", ":")))
        elif args.mode == "export":
            export(conn, args.after_id)
        else:
            export_price_versions(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
