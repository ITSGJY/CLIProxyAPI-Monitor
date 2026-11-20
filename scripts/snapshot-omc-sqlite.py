#!/usr/bin/env python3
"""Create a consistent SQLite backup without modifying the live OMC database."""
import argparse
import os
import sqlite3
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--event-before-ms", type=int, help="Exclude CPA events whose original event timestamp is after the subscription boundary")
    parser.add_argument("--error-before-ms", type=int, help="Independent error subscription boundary; filters only the snapshot's error_events")
    args = parser.parse_args()
    source = Path(args.source).resolve(strict=True)
    destination = Path(args.destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(destination.parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix=".omc-snapshot-", suffix=".sqlite", dir=destination.parent)
    os.close(fd)
    try:
        src = sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True, timeout=30)
        dst = sqlite3.connect(temporary)
        try:
            src.execute("PRAGMA query_only = ON")
            src.backup(dst, pages=512, sleep=0.05)
            if args.event_before_ms is not None:
                if args.event_before_ms <= 0:
                    raise ValueError("--event-before-ms must be a positive Unix millisecond timestamp")
                columns = {row[1] for row in dst.execute("PRAGMA table_info(usage_events)")}
                if "timestamp_ms" not in columns:
                    raise ValueError("usage_events is missing its original timestamp_ms event-time column")
                dst.execute("BEGIN IMMEDIATE")
                dst.execute("DELETE FROM usage_events WHERE timestamp_ms > ?", (args.event_before_ms,))
                dst.commit()
                dst.execute("VACUUM")
            if args.error_before_ms is not None:
                if args.error_before_ms <= 0:
                    raise ValueError("--error-before-ms must be positive")
                columns = {row[1] for row in dst.execute("PRAGMA table_info(error_events)")}
                if columns:
                    if "timestamp_ms" not in columns:
                        raise ValueError("error_events is missing timestamp_ms")
                    dst.execute("DELETE FROM error_events WHERE timestamp_ms > ?", (args.error_before_ms,))
                    dst.commit()
                    dst.execute("VACUUM")
            result = dst.execute("PRAGMA quick_check").fetchone()[0]
            if result != "ok":
                raise RuntimeError("Snapshot quick_check failed: " + str(result))
            count = dst.execute("SELECT count(*) FROM usage_events").fetchone()[0]
        finally:
            dst.close()
            src.close()
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        cutoff = "none" if args.event_before_ms is None else str(args.event_before_ms)
        print("snapshot_ok rows=" + str(count) + " bytes=" + str(destination.stat().st_size) + " event_before_ms=" + cutoff)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


if __name__ == "__main__":
    main()
