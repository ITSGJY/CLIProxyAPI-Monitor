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
            result = dst.execute("PRAGMA quick_check").fetchone()[0]
            if result != "ok":
                raise RuntimeError("Snapshot quick_check failed: " + str(result))
            count = dst.execute("SELECT count(*) FROM usage_events").fetchone()[0]
        finally:
            dst.close()
            src.close()
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        print("snapshot_ok rows=" + str(count) + " bytes=" + str(destination.stat().st_size))
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


if __name__ == "__main__":
    main()
