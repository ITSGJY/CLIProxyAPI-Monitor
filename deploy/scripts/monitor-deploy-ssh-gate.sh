#!/usr/bin/env bash
set -euo pipefail
[[ -n "${SSH_ORIGINAL_COMMAND:-}" ]] || exit 1
exec sudo -n /usr/local/sbin/cliproxyapi-monitor-deploy "$SSH_ORIGINAL_COMMAND"
