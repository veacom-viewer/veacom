#!/usr/bin/env bash
# Saves the read-only ClickHouse password on this computer, from Secret Manager, readable only
# by you: ~/.config/veacom/clickhouse-agent (what the MCP command in TELEMETRY.md reads).
# With your own Google login: GCP_ACCOUNT=you@example.com telemetry/agent-access.sh
set -euo pipefail
source "$(dirname "$0")/gcp/env.sh"
umask 077
mkdir -p "$HOME/.config/veacom"
g secrets versions access latest --secret ch-agent-password > "$HOME/.config/veacom/clickhouse-agent"
echo "Saved: ~/.config/veacom/clickhouse-agent"
