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
    parser.add_argument("--created-before-ms", type=int, help="Exclude events recorded by OMC after this Unix millisecond cutoff")
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
            if args.created_before_ms is not None:
                if args.created_before_ms <= 0:
                    raise ValueError("--created-before-ms must be a positive Unix millisecond timestamp")
                columns = {row[1] for row in dst.execute("PRAGMA table_info(usage_events)")}
                time_column = "created_at_ms" if "created_at_ms" in columns else "timestamp_ms"
                dst.execute("BEGIN IMMEDIATE")
                dst.execute(f"DELETE FROM usage_events WHERE COALESCE({time_column}, timestamp_ms) > ?", (args.created_before_ms,))
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
        cutoff = "none" if args.created_before_ms is None else str(args.created_before_ms)
        print("snapshot_ok rows=" + str(count) + " bytes=" + str(destination.stat().st_size) + " created_before_ms=" + cutoff)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


if __name__ == "__main__":
    main()
